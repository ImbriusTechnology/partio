// Importing the Partio CSV files (locations, parts, stock, sources; see csvFormat.ts and docs/csv-format.md).
//
// The whole import runs as one transaction, using the same functions the screens use to save things. A preview
// is the import run for real and then rolled back, so it reports exactly what would happen, row by row, and
// changes nothing. Committing runs it again and keeps it, but only if no row had an error: all or nothing.
import { batchId, execute, query, queryOne, savepoint, withTransaction } from './db.ts';
import { COLUMNS, FILE_LABEL, FILE_ORDER, columnNames, guessKind, type FileKind } from './csvFormat.ts';
import { parseCsv } from './csv.ts';
import { addLocation, ensureLocationPath, findLocation, restoreLocation } from './locations.ts';
import {
  KINDS, STATUSES, emptyPartFields, emptySourceDraft, emptyVendorDraft, getPart, parseBreaks, savePart, sourcesOf,
  type Kind, type PartDetail, type PartFields, type PartStatus, type SourceDraft,
} from './parts.ts';
import { addPackage, addVendor, ensureCategoryPath, findVendor, getSetting, manufacturerIdFor } from './reference.ts';
import { rebuildSearchIndex } from './search.ts';
import { countStock } from './stock.ts';
import { packageKey } from './values.ts';

export interface ImportFile { name: string; text: string; kind?: FileKind | null }

export interface ImportOptions {
  /** add: rows for things that already exist are skipped. update: they update what's there (blank cells leave a value alone). */
  mode: 'add' | 'update';
  /** add: stock rows add to what's there. set: they are counts, and the stock is set to them. */
  stockMode: 'add' | 'set';
  /** Tag for everything created, e.g. 'demo' for the demo library. */
  source?: string | null;
}

export interface RowError { line: number; message: string }

export interface FileReport {
  name: string; kind: FileKind | null; rows: number;
  created: number; updated: number; unchanged: number;
  unknownColumns: string[];
  /** A problem with the file as a whole (unreadable, unknown kind, missing columns). */
  problem: string | null;
  errors: RowError[];
}

export interface ImportReport {
  files: FileReport[];
  /** Things created along the way that weren't rows of their own file. */
  alsoCreated: { categories: string[]; packages: string[]; manufacturers: string[]; vendors: string[]; locations: string[] };
  errorCount: number;
  unknownColumnCount: number;
  committed: boolean;
}

// ------------------------------------------------------------------ cells

type Row = { get: (col: string) => string; line: number };

const yes = (v: string) => /^(y|yes|true|1)$/i.test(v.trim());
const isBool = (v: string) => /^(y|yes|true|1|n|no|false|0)$/i.test(v.trim());

function number(v: string, what: string, opts: { integer?: boolean; min?: number; above?: number } = {}): number | null {
  const t = v.trim();
  if (!t) return null;
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) throw new Error(`${what} should be a number written like 1234.5 (no thousands separators), not “${t}”`);
  const n = Number(t);
  if (opts.integer && !Number.isInteger(n)) throw new Error(`${what} should be a whole number, not ${t}`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${what} can’t be less than ${opts.min}`);
  if (opts.above !== undefined && n <= opts.above) throw new Error(`${what} should be more than ${opts.above}`);
  return n;
}

// ------------------------------------------------------------------ shared lookups, created as needed

class Context {
  base = 'USD';
  rates = new Map<string, number>();
  packages = new Map<string, number>();     // packageKey(name or alias) -> id
  explicitLocations = new Set<number>();
  /** Manufacturer parts created earlier in this import: later rows may fill them in even in add mode. */
  newMfrParts = new Set<number>();
  opts: ImportOptions;
  constructor(opts: ImportOptions) { this.opts = opts; }

  async load(): Promise<void> {
    this.base = (await getSetting('base_currency')) ?? 'USD';
    for (const r of await query<{ currency: string; to_base: number }>('SELECT currency, to_base FROM fx_rate')) this.rates.set(r.currency, r.to_base);
    for (const r of await query<{ name: string; id: number }>('SELECT name, id FROM package UNION ALL SELECT alias, package_id FROM package_alias')) {
      this.packages.set(packageKey(r.name), r.id);
    }
  }

  /** An amount in `currency` converted to the base currency. */
  toBase(amount: number | null, currency: string): number | null {
    if (amount === null) return null;
    const c = currency.trim().toUpperCase();
    if (!c || c === this.base) return amount;
    const rate = this.rates.get(c);
    if (!rate) throw new Error(`No exchange rate from ${c} to ${this.base} (add it in Settings → Exchange rates), or leave currency blank to mean ${this.base}`);
    return Math.round(amount * rate * 1e6) / 1e6;
  }

  async packageId(name: string): Promise<number | null> {
    const t = name.trim();
    if (!t) return null;
    const hit = this.packages.get(packageKey(t));
    if (hit) return hit;
    const id = await addPackage(t, null);
    this.packages.set(packageKey(t), id);
    return id;
  }

  /** A vendor by name or alias. A new one is priced in `currency` if given (the currency of the row naming it), else the base currency. */
  async vendorId(name: string, currency?: string | null): Promise<number> {
    return (await findVendor(name)) ?? addVendor(name.trim(), currency || this.base, null);
  }

  /** A location by code or path. A path that doesn't exist yet is created; an unknown code is an error. */
  async locationId(text: string): Promise<number> {
    const t = text.trim();
    const hit = await findLocation(t);
    if (hit) {
      if (hit.archived) await restoreLocation(hit.id);
      return hit.id;
    }
    if (/^L\d+$/i.test(t)) throw new Error(`No location has the code ${t}`);
    return ensureLocationPath(t, this.opts.source);
  }

  /** A part by PN, following a merged duplicate to the part it went into. */
  async partByPn(pn: string): Promise<{ id: number; pn: string } | undefined> {
    const p = await queryOne<{ id: number; pn: string; merged_into_id: number | null }>('SELECT id, pn, merged_into_id FROM part WHERE pn = ?', [pn.trim()]);
    if (p?.merged_into_id) return queryOne('SELECT id, pn FROM part WHERE id = ?', [p.merged_into_id]);
    return p ?? undefined;
  }

  /** A part by MPN (any manufacturer); an MPN used by two manufacturers on different parts is ambiguous. */
  async partByMpn(mpn: string, manufacturer?: string): Promise<{ id: number; pn: string } | undefined> {
    const rows = await query<{ id: number; pn: string; manufacturer: string }>(`
      SELECT p.id, p.pn, mf.name AS manufacturer FROM mfr_part m JOIN part p ON p.id = m.part_id JOIN manufacturer mf ON mf.id = m.manufacturer_id
      WHERE m.mpn = ? COLLATE NOCASE`, [mpn.trim()]);
    const pick = manufacturer?.trim()
      ? rows.filter((r) => r.manufacturer.toLowerCase() === manufacturer.trim().toLowerCase())
      : rows;
    const ids = new Set(pick.map((r) => r.id));
    if (ids.size > 1) throw new Error(`MPN ${mpn} belongs to more than one part (${pick.map((r) => r.pn).join(', ')}); use pn instead`);
    return pick[0] ? { id: pick[0].id, pn: pick[0].pn } : undefined;
  }
}

type Outcome = 'created' | 'updated' | 'unchanged';

// ------------------------------------------------------------------ locations.csv

async function importLocation(ctx: Context, r: Row): Promise<Outcome> {
  const path = r.get('path').split('>').map((s) => s.trim()).filter(Boolean).join(' > ');
  if (!path) throw new Error('path is empty');
  const code = r.get('code').trim();
  const description = r.get('description').trim();
  const existing = await queryOne<{ id: number; code: string; description: string | null; archived: number }>(
    'SELECT id, code, description, archived FROM location WHERE path = ? COLLATE NOCASE', [path]);
  if (existing) {
    ctx.explicitLocations.add(existing.id);
    if (code && code.toUpperCase() !== existing.code.toUpperCase()) {
      const other = await queryOne<{ path: string }>('SELECT path FROM location WHERE code = ? COLLATE NOCASE', [code]);
      if (other) throw new Error(`Code ${code} is already used by ${other.path}`);
    }
    if (ctx.opts.mode === 'add') return 'unchanged';
    const changes: string[] = [];
    const params: Array<string | number> = [];
    if (code && code.toUpperCase() !== existing.code.toUpperCase()) { changes.push('code = ?'); params.push(code.toUpperCase()); }
    if (description && description !== (existing.description ?? '')) { changes.push('description = ?'); params.push(description); }
    if (existing.archived) await restoreLocation(existing.id);
    if (!changes.length) return existing.archived ? 'updated' : 'unchanged';
    await execute(`UPDATE location SET ${changes.join(', ')} WHERE id = ?`, [...params, existing.id]);
    return 'updated';
  }
  const names = path.split(' > ');
  const parentId = names.length > 1 ? await ensureLocationPath(names.slice(0, -1).join(' > '), ctx.opts.source) : null;
  const id = await addLocation(parentId, names[names.length - 1], description || null, code ? code.toUpperCase() : null, ctx.opts.source);
  ctx.explicitLocations.add(id);
  return 'created';
}

// ------------------------------------------------------------------ parts.csv

function fieldsOf(p: PartDetail): PartFields {
  return {
    name: p.name, description: p.description, category_id: p.category_id, kind: p.kind, value_text: p.value_text,
    tolerance_pct: p.tolerance_pct, package_id: p.package_id, default_location_id: p.default_location_id,
    preferred_vendor_id: p.preferred_vendor_id, standard_cost: p.standard_cost, unit: p.unit, notes: p.notes, status: p.status,
  };
}

async function importPart(ctx: Context, r: Row): Promise<Outcome> {
  const pn = r.get('pn').trim();
  const manufacturer = r.get('manufacturer').trim();
  const mpn = r.get('mpn').trim();
  const vendor = r.get('vendor').trim();
  const sku = r.get('sku').trim();
  if (mpn && !manufacturer) throw new Error('mpn needs a manufacturer');
  if (vendor && !sku) throw new Error('vendor needs a sku (the vendor’s part number)');
  if (sku && !vendor) throw new Error('sku needs a vendor');
  if (sku && !manufacturer) throw new Error('A vendor part needs a manufacturer (use “Unknown” if you don’t know it)');

  // Which existing part this row is about, if any: by PN, else by manufacturer + MPN.
  let existing = pn ? await ctx.partByPn(pn) : undefined;
  if (pn && existing && existing.pn !== pn) throw new Error(`${pn} was merged into ${existing.pn}; use ${existing.pn}`);
  if (!pn && mpn) existing = await ctx.partByMpn(mpn, manufacturer);
  if (existing && ctx.opts.mode === 'add') return 'unchanged';

  const detail = existing ? await getPart(existing.id) : undefined;
  const f: PartFields = detail ? fieldsOf(detail) : emptyPartFields();
  const before = JSON.stringify({ f, s: detail ? sourcesOf(detail) : [] });

  const set = <K extends keyof PartFields>(col: string, k: K, v: PartFields[K] | undefined) => {
    if (r.get(col).trim() && v !== undefined) f[k] = v;
  };
  set('name', 'name', r.get('name').trim());
  set('description', 'description', r.get('description').trim());
  if (!f.description) throw new Error('description is needed for a new part');
  const kind = r.get('kind').trim().toLowerCase();
  if (kind && !KINDS.includes(kind as Kind)) throw new Error(`kind should be one of ${KINDS.join(', ')}, not “${kind}”`);
  set('kind', 'kind', kind as Kind);
  const status = r.get('status').trim().toLowerCase();
  if (status && !STATUSES.includes(status as PartStatus)) throw new Error(`status should be one of ${STATUSES.join(', ')}, not “${status}”`);
  set('status', 'status', status as PartStatus);
  set('value', 'value_text', r.get('value').trim());
  set('tolerance_pct', 'tolerance_pct', number(r.get('tolerance_pct'), 'tolerance_pct', { min: 0 }));
  set('unit', 'unit', r.get('unit').trim());
  set('notes', 'notes', r.get('notes').trim());
  set('standard_cost', 'standard_cost', ctx.toBase(number(r.get('standard_cost'), 'standard_cost', { min: 0 }), r.get('currency')));
  if (r.get('category').trim()) f.category_id = await ensureCategoryPath(r.get('category'));
  if (r.get('package').trim()) f.package_id = await ctx.packageId(r.get('package'));
  if (r.get('location').trim()) f.default_location_id = await ctx.locationId(r.get('location'));

  const sources: SourceDraft[] = detail ? sourcesOf(detail) : [];
  if (manufacturer) {
    const mid = await manufacturerIdFor(manufacturer);
    const mname = (await queryOne<{ name: string }>('SELECT name FROM manufacturer WHERE id = ?', [mid]))!.name;
    let s = sources.find((x) => x.manufacturer.toLowerCase() === mname.toLowerCase() && x.mpn.toLowerCase() === mpn.toLowerCase());
    if (!s) {
      s = { ...emptySourceDraft(), manufacturer: mname, mpn, preferred: sources.length === 0 };
      sources.push(s);
    }
    if (r.get('datasheet_url').trim() && !s.datasheet_url) s.datasheet_url = r.get('datasheet_url').trim();
    if (sku) {
      const vid = await ctx.vendorId(vendor);
      if (!s.vendors.some((v) => v.vendor_id === vid && v.sku.toLowerCase() === sku.toLowerCase())) {
        s.vendors.push({ ...emptyVendorDraft(), vendor_id: vid, sku });
      }
    }
  }

  if (existing && JSON.stringify({ f, s: sources }) === before) return 'unchanged';
  const known = new Set(sources.filter((s) => s.id).map((s) => s.id!));
  const id = await savePart({ partId: existing?.id ?? null, manualPn: existing ? null : pn || null, fields: f, sources, source: ctx.opts.source, reindex: false });
  for (const m of await query<{ id: number }>('SELECT id FROM mfr_part WHERE part_id = ?', [id])) if (!known.has(m.id)) ctx.newMfrParts.add(m.id);
  return existing ? 'updated' : 'created';
}

// ------------------------------------------------------------------ stock.csv

async function importStock(ctx: Context, r: Row): Promise<Outcome> {
  const pn = r.get('pn').trim();
  const mpn = r.get('mpn').trim();
  if (!pn && !mpn) throw new Error('Give the part’s pn or mpn');
  const part = pn ? await ctx.partByPn(pn) : await ctx.partByMpn(mpn);
  if (!part) throw new Error(`No part ${pn || `with MPN ${mpn}`}`);
  const locationId = await ctx.locationId(r.get('location'));
  const qty = number(r.get('qty'), 'qty', { min: 0 });
  if (qty === null) throw new Error('qty is empty');
  const unitCost = ctx.toBase(number(r.get('unit_cost'), 'unit_cost', { min: 0 }), r.get('currency'));
  const note = r.get('note').trim() || null;
  if (ctx.opts.stockMode === 'set') {
    const delta = await countStock(part.id, locationId, qty, note ?? 'Imported count');
    return delta === 0 ? 'unchanged' : 'updated';
  }
  if (qty === 0) return 'unchanged';
  // Stock brought in by a tagged import (the demo) is tagged too, so it can be told apart from yours later.
  const batch = ctx.opts.source ? `${ctx.opts.source}:${batchId()}` : batchId();
  await execute(`INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, unit_cost, note) VALUES (?, 'opening', ?, ?, ?, ?, ?)`,
    [batch, part.id, locationId, qty, unitCost, note ?? (ctx.opts.source ? `Opening stock (${ctx.opts.source})` : 'Imported')]);
  await execute('UPDATE part SET default_location_id = ? WHERE id = ? AND default_location_id IS NULL', [locationId, part.id]);
  return 'created';
}

// ------------------------------------------------------------------ sources.csv

const LIFECYCLES = ['active', 'nrnd', 'obsolete', 'unknown'];

async function importSource(ctx: Context, r: Row): Promise<Outcome> {
  const pn = r.get('pn').trim();
  if (!pn) throw new Error('pn is empty');
  const part = await ctx.partByPn(pn);
  if (!part) throw new Error(`No part ${pn}`);
  const manufacturer = r.get('manufacturer').trim();
  if (!manufacturer) throw new Error('manufacturer is empty');
  const mpn = r.get('mpn').trim() || null;
  const vendor = r.get('vendor').trim();
  const sku = r.get('sku').trim();
  if (vendor && !sku) throw new Error('vendor needs a sku (the vendor’s part number)');
  if (sku && !vendor) throw new Error('sku needs a vendor');
  const lifecycle = r.get('lifecycle').trim().toLowerCase();
  if (lifecycle && !LIFECYCLES.includes(lifecycle)) throw new Error(`lifecycle should be one of ${LIFECYCLES.join(', ')}, not “${lifecycle}”`);
  if (r.get('preferred').trim() && !isBool(r.get('preferred'))) throw new Error(`preferred should be yes or no, not “${r.get('preferred')}”`);
  const preferred = yes(r.get('preferred'));
  const datasheet = r.get('datasheet_url').trim();
  let update = ctx.opts.mode === 'update';
  let outcome: Outcome = 'unchanged';

  const mid = await manufacturerIdFor(manufacturer);
  // The manufacturer part: on this part already, on another part (an error), or new.
  let m = mpn
    ? await queryOne<{ id: number; part_id: number; datasheet_url: string | null; lifecycle: string; preferred: number }>(
      'SELECT id, part_id, datasheet_url, lifecycle, preferred FROM mfr_part WHERE manufacturer_id = ? AND mpn = ? COLLATE NOCASE', [mid, mpn])
    : await queryOne<{ id: number; part_id: number; datasheet_url: string | null; lifecycle: string; preferred: number }>(
      'SELECT id, part_id, datasheet_url, lifecycle, preferred FROM mfr_part WHERE manufacturer_id = ? AND mpn IS NULL AND part_id = ?', [mid, part.id]);
  if (m && m.part_id !== part.id) {
    const other = await queryOne<{ pn: string }>('SELECT pn FROM part WHERE id = ?', [m.part_id]);
    throw new Error(`${manufacturer} ${mpn} is already a source of ${other?.pn}`);
  }
  const hasAny = !!(await queryOne('SELECT 1 FROM mfr_part WHERE part_id = ?', [part.id]));
  // Something this import created (e.g. by parts.csv) isn't "already in the library": this row may fill it in.
  if (m && ctx.newMfrParts.has(m.id)) update = true;
  if (!m) {
    const id = (await execute('INSERT INTO mfr_part (part_id, manufacturer_id, mpn, datasheet_url, lifecycle, preferred) VALUES (?, ?, ?, ?, ?, 0)',
      [part.id, mid, mpn, datasheet || null, lifecycle || 'active'])).lastInsertId;
    ctx.newMfrParts.add(id);
    m = { id, part_id: part.id, datasheet_url: datasheet || null, lifecycle: lifecycle || 'active', preferred: 0 };
    outcome = 'created';
    if (preferred || !hasAny) {
      await execute('UPDATE mfr_part SET preferred = (id = ?) WHERE part_id = ?', [id, part.id]);
    }
  } else if (update) {
    if ((datasheet && datasheet !== m.datasheet_url) || (lifecycle && lifecycle !== m.lifecycle)) {
      await execute('UPDATE mfr_part SET datasheet_url = COALESCE(?, datasheet_url), lifecycle = COALESCE(?, lifecycle) WHERE id = ?',
        [datasheet || null, lifecycle || null, m.id]);
      outcome = 'updated';
    }
    if (preferred && !m.preferred) {
      await execute('UPDATE mfr_part SET preferred = (id = ?) WHERE part_id = ?', [m.id, part.id]);
      outcome = 'updated';
    }
  }

  if (sku) {
    const currency = r.get('currency').trim().toUpperCase() || null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error(`currency should be a three-letter code such as USD, not “${currency}”`);
    const vid = await ctx.vendorId(vendor, currency);
    const breaksText = r.get('price_breaks').trim();
    const breaks = breaksText ? parseBreaks(breaksText) : null;
    const moq = number(r.get('moq'), 'moq', { integer: true, above: 0 });
    const multiple = number(r.get('order_multiple'), 'order_multiple', { integer: true, above: 0 });
    const url = r.get('url').trim() || null;
    const packaging = r.get('packaging').trim() || null;
    const vp = await queryOne<{ id: number; mfr_part_id: number; part_id: number; pn: string }>(`
      SELECT vp.id, vp.mfr_part_id, m.part_id, p.pn FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id JOIN part p ON p.id = m.part_id
      WHERE vp.vendor_id = ? AND vp.sku = ? COLLATE NOCASE`, [vid, sku]);
    if (vp && vp.part_id !== part.id) throw new Error(`${vendor} ${sku} is already listed on ${vp.pn}`);
    if (vp && vp.mfr_part_id !== m.id) throw new Error(`${vendor} ${sku} is already listed under a different manufacturer part of ${pn}`);
    let vpId = vp?.id;
    if (!vp) {
      vpId = (await execute(`INSERT INTO vendor_part (mfr_part_id, vendor_id, sku, url, packaging, moq, order_multiple, currency, prices_checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${breaks?.length ? "date('now')" : 'NULL'})`, [m.id, vid, sku, url, packaging, moq, multiple, currency])).lastInsertId;
      outcome = 'created';
    } else if (update) {
      const res = await execute(`UPDATE vendor_part SET url = COALESCE(?, url), packaging = COALESCE(?, packaging), moq = COALESCE(?, moq),
          order_multiple = COALESCE(?, order_multiple), currency = COALESCE(?, currency)
        WHERE id = ? AND (url IS NOT COALESCE(?, url) OR packaging IS NOT COALESCE(?, packaging) OR moq IS NOT COALESCE(?, moq)
          OR order_multiple IS NOT COALESCE(?, order_multiple) OR currency IS NOT COALESCE(?, currency))`,
      [url, packaging, moq, multiple, currency, vpId!, url, packaging, moq, multiple, currency]);
      if (res.changes) outcome = outcome === 'created' ? outcome : 'updated';
    }
    if (breaks && (!vp || update)) {
      const old = await query<{ qty: number; unit_price: number }>('SELECT qty, unit_price FROM price_break WHERE vendor_part_id = ? ORDER BY qty', [vpId!]);
      if (JSON.stringify(old) !== JSON.stringify(breaks)) {
        await execute('DELETE FROM price_break WHERE vendor_part_id = ?', [vpId!]);
        for (const b of breaks) await execute('INSERT INTO price_break (vendor_part_id, qty, unit_price) VALUES (?, ?, ?)', [vpId!, b.qty, b.unit_price]);
        await execute("UPDATE vendor_part SET prices_checked_at = date('now') WHERE id = ?", [vpId!]);
        if (outcome === 'unchanged') outcome = 'updated';
      }
    }
  }
  return outcome;
}

const HANDLERS: Record<FileKind, (ctx: Context, r: Row) => Promise<Outcome>> = {
  locations: importLocation, parts: importPart, stock: importStock, sources: importSource,
};

// ------------------------------------------------------------------ the import

interface Prepared { report: FileReport; rows: Row[] }

function prepare(file: ImportFile): Prepared {
  const report: FileReport = { name: file.name, kind: null, rows: 0, created: 0, updated: 0, unchanged: 0, unknownColumns: [], problem: null, errors: [] };
  let table;
  try {
    table = parseCsv(file.text);
  } catch (e) {
    report.problem = (e as Error).message;
    return { report, rows: [] };
  }
  const headers = table.headers.map((h) => h.trim().toLowerCase());
  const kind = file.kind ?? guessKind(file.name, headers);
  report.kind = kind;
  if (!kind) { report.problem = 'Can’t tell what this file holds. Name it locations.csv, parts.csv, stock.csv or sources.csv.'; return { report, rows: [] }; }
  if (!headers.length) { report.problem = 'The file is empty'; return { report, rows: [] }; }
  const dup = headers.find((h, i) => h && headers.indexOf(h) !== i);
  if (dup) { report.problem = `The column ${dup} appears twice`; return { report, rows: [] }; }
  const known = columnNames(kind);
  report.unknownColumns = table.headers.filter((_, i) => headers[i] && !known.includes(headers[i]));
  const missing = COLUMNS[kind].columns.filter((c) => c.required && !headers.includes(c.name)).map((c) => c.name);
  if (missing.length) { report.problem = `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`; return { report, rows: [] }; }
  const oneOf = COLUMNS[kind].oneOf;
  if (oneOf && !oneOf.some((c) => headers.includes(c))) { report.problem = `Needs a ${oneOf.join(' or ')} column`; return { report, rows: [] }; }
  const index = new Map(headers.map((h, i) => [h, i]));
  const rows = table.rows.map((cells, i) => ({
    line: table.lines[i],
    get: (col: string) => { const j = index.get(col); return j === undefined ? '' : cells[j] ?? ''; },
  }));
  report.rows = rows.length;
  return { report, rows };
}

/**
 * Import CSV files. With `commit` false this is a preview: everything is done and then undone.
 * With `commit` true the import is kept, but only if there are no errors; otherwise nothing changes.
 */
export async function importCsv(files: ImportFile[], opts: ImportOptions, commit: boolean): Promise<ImportReport> {
  const prepared = files.map(prepare);
  const ordered = [...prepared].sort((a, b) => FILE_ORDER.indexOf(a.report.kind ?? 'sources') - FILE_ORDER.indexOf(b.report.kind ?? 'sources'));
  const before = await query<{ t: string; n: number }>(`
    SELECT 'category' AS t, COALESCE(MAX(id), 0) AS n FROM category UNION ALL SELECT 'package', COALESCE(MAX(id), 0) FROM package
    UNION ALL SELECT 'manufacturer', COALESCE(MAX(id), 0) FROM manufacturer UNION ALL SELECT 'vendor', COALESCE(MAX(id), 0) FROM vendor
    UNION ALL SELECT 'location', COALESCE(MAX(id), 0) FROM location`);
  const maxId = (t: string) => before.find((b) => b.t === t)?.n ?? 0;
  const ctx = new Context(opts);
  const alsoCreated: ImportReport['alsoCreated'] = { categories: [], packages: [], manufacturers: [], vendors: [], locations: [] };
  let errorCount = 0;

  const run = async () => {
    await ctx.load();
    for (const { report, rows } of ordered) {
      if (!report.kind || report.problem) continue;
      const handle = HANDLERS[report.kind];
      for (const r of rows) {
        try {
          const outcome = await savepoint('import_row', () => handle(ctx, r));
          report[outcome]++;
        } catch (e) {
          report.errors.push({ line: r.line, message: String((e as Error)?.message ?? e) });
        }
      }
    }
    const names = async (table: string, col: string) =>
      (await query<{ id: number; name: string }>(`SELECT id, ${col} AS name FROM ${table} WHERE id > ? ORDER BY ${col}`, [maxId(table)]));
    alsoCreated.categories = (await names('category', 'path')).map((x) => x.name);
    alsoCreated.packages = (await names('package', 'name')).map((x) => x.name);
    alsoCreated.manufacturers = (await names('manufacturer', 'name')).map((x) => x.name);
    alsoCreated.vendors = (await names('vendor', 'name')).map((x) => x.name);
    alsoCreated.locations = (await names('location', 'path')).filter((x) => !ctx.explicitLocations.has(x.id)).map((x) => x.name);
    errorCount = prepared.reduce((n, p) => n + p.report.errors.length + (p.report.problem ? 1 : 0), 0);
    if (commit && errorCount === 0) await rebuildSearchIndex();
  };

  let committed = false;
  // Keep the work only when committing and nothing went wrong.
  await withTransaction(async () => {
    await run();
    committed = commit && errorCount === 0;
    if (!committed) throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

  return {
    files: prepared.map((p) => p.report),
    alsoCreated,
    errorCount,
    unknownColumnCount: prepared.reduce((n, p) => n + p.report.unknownColumns.length, 0),
    committed,
  };
}

class Rollback extends Error {}

/** A one-line summary of a file's outcome, for the preview and the result. */
export function describeFile(f: FileReport, done: boolean): string {
  if (f.problem) return f.problem;
  const kind = f.kind ? FILE_LABEL[f.kind].toLowerCase() : 'rows';
  const will = done ? '' : 'will be ';
  const parts = [
    f.created && `${f.created} ${will}${f.kind === 'stock' ? 'added' : 'new'}`,
    f.updated && `${f.updated} ${will}updated`,
    f.unchanged && `${f.unchanged} unchanged`,
  ].filter(Boolean);
  return `${f.rows} ${kind} row${f.rows === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}
