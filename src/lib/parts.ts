// Reading and changing parts, with their manufacturer parts, vendor parts and price breaks.
import { batchId, execute, query, queryOne, ref, transaction, type Param, type Statement } from './db.ts';
import { manufacturerIdFor, peekNextPn, type Series } from './reference.ts';
import { ftsQuery, reindexPart } from './search.ts';
import { packageKey, parseValue, unitForCategory } from './values.ts';

// ------------------------------------------------------------------ types

export const KINDS = ['component', 'pcb', 'assembly', 'mechanical', 'consumable'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = {
  component: 'Component', pcb: 'PCB', assembly: 'Assembly', mechanical: 'Mechanical', consumable: 'Consumable',
};

export const STATUSES = ['active', 'obsolete', 'archived'] as const;
export type PartStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<PartStatus, string> = { active: 'Active', obsolete: 'Obsolete', archived: 'Archived' };

export interface PartListRow {
  id: number; pn: string; name: string | null; description: string; kind: Kind; status: PartStatus;
  value_text: string | null; value_num: number | null; value_unit: string | null; tolerance_pct: number | null;
  package: string | null; category: string | null; on_hand: number; location: string | null; location_id: number | null;
}

export interface VendorPart {
  id: number; vendor_id: number; vendor: string; sku: string; url: string | null; packaging: string | null;
  moq: number | null; order_multiple: number | null; currency: string | null; preferred: number;
  prices_checked_at: string | null; notes: string | null;
  breaks: Array<{ qty: number; unit_price: number }>;
}

export interface MfrPart {
  id: number; manufacturer_id: number; manufacturer: string; mpn: string | null; description: string | null;
  datasheet_url: string | null; lifecycle: string; preferred: number; notes: string | null;
  vendorParts: VendorPart[];
}

export interface PartDetail extends PartListRow {
  category_id: number | null; package_id: number | null; default_location_id: number | null;
  preferred_vendor_id: number | null; preferred_vendor: string | null; standard_cost: number | null; unit: string;
  notes: string | null; series_id: number | null; created_at: string; updated_at: string;
  merged_into_id: number | null; merged_into_pn: string | null;
  mergedFrom: Array<{ id: number; pn: string }>;
  stock: Array<{ location_id: number; path: string; code: string; qty: number }>;
  mfrParts: MfrPart[];
  usedIn: Array<{ assembly_id: number; assembly_pn: string; assembly_desc: string; rev: string; qty: number; designators: string | null }>;
  bomRevs: Array<{ id: number; rev: string; status: string; project_code: string | null; lines: number }>;
  history: Array<{ at: string; kind: string; qty_delta: number; path: string; note: string | null; order_ref: string | null; vendor: string | null }>;
}

// ------------------------------------------------------------------ lists

const PART_LIST_SELECT = `
  SELECT p.id, p.pn, p.name, p.description, p.kind, p.status, p.value_text, p.value_num, p.value_unit, p.tolerance_pct,
         pk.name AS package, c.path AS category,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.part_id = p.id), 0) AS on_hand,
         l.path AS location, l.id AS location_id
  FROM part p
  LEFT JOIN package pk ON pk.id = p.package_id
  LEFT JOIN category c ON c.id = p.category_id
  LEFT JOIN location l ON l.id = p.default_location_id`;

export interface PartFilter { text?: string; categoryId?: number | null; showArchived?: boolean; inStockOnly?: boolean; limit?: number }

export async function listParts(f: PartFilter = {}): Promise<PartListRow[]> {
  const where: string[] = [];
  const params: Param[] = [];
  const fts = f.text ? ftsQuery(f.text) : null;
  if (fts) { where.push('p.id IN (SELECT part_id FROM part_fts WHERE part_fts MATCH ?)'); params.push(fts); }
  if (f.categoryId) {
    where.push(`p.category_id IN (SELECT id FROM category WHERE path = (SELECT path FROM category WHERE id = ?)
                 OR path LIKE (SELECT path FROM category WHERE id = ?) || ' > %')`);
    params.push(f.categoryId, f.categoryId);
  }
  if (!f.showArchived) where.push("p.status <> 'archived'");
  if (f.inStockOnly) where.push('EXISTS (SELECT 1 FROM stock s WHERE s.part_id = p.id AND s.qty > 0)');
  const sql = `${PART_LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.path, p.value_num, p.pn LIMIT ${Math.max(1, Math.floor(f.limit ?? 5000))}`;
  return query<PartListRow>(sql, params);
}

// ------------------------------------------------------------------ quick find ("10k 0603 1%")

export interface QuickQuery {
  value?: { num: number; unit: string | null; text: string };
  tolerance?: number;
  packages?: { text: string; ids: number[] };
  words: string[];
}

async function packageLookup(): Promise<Map<string, number[]>> {
  const rows = await query<{ alias: string; package_id: number }>('SELECT alias, package_id FROM package_alias UNION SELECT name, id FROM package');
  const m = new Map<string, number[]>();
  for (const r of rows) {
    const k = packageKey(r.alias);
    const ids = m.get(k) ?? [];
    if (!ids.includes(r.package_id)) ids.push(r.package_id);
    m.set(k, ids);
  }
  return m;
}

/** "10k 0603 1%" → value 10 k, package 0603, tolerance ≤ 1 %; anything else is searched as text. */
export async function parseQuickQuery(q: string): Promise<QuickQuery> {
  const pk = await packageLookup();
  const out: QuickQuery = { words: [] };
  for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
    const tol = /^±?(\d+(?:\.\d+)?)%$/.exec(raw);
    if (tol && out.tolerance === undefined) { out.tolerance = Number(tol[1]); continue; }
    const ids = pk.get(packageKey(raw));
    if (ids && !out.packages) { out.packages = { text: raw, ids }; continue; }
    if (/\d/.test(raw) && /[a-zµΩ]/i.test(raw) && !out.value) {
      const v = parseValue(raw);
      if (v) { out.value = { num: v.num, unit: v.unit, text: raw }; continue; }
    }
    out.words.push(raw);
  }
  return out;
}

export async function quickFind(q: string, limit = 60): Promise<{ parsed: QuickQuery; rows: PartListRow[] }> {
  const parsed = await parseQuickQuery(q);
  const where: string[] = ["p.status <> 'archived'"];
  const params: Param[] = [];
  const fts = ftsQuery(parsed.words.join(' '));
  if (fts) { where.push('p.id IN (SELECT part_id FROM part_fts WHERE part_fts MATCH ?)'); params.push(fts); }
  if (parsed.value) {
    where.push('p.value_num BETWEEN ? AND ?');
    params.push(parsed.value.num * 0.999, parsed.value.num * 1.001);
    if (parsed.value.unit) { where.push('(p.value_unit = ? OR p.value_unit IS NULL)'); params.push(parsed.value.unit); }
  }
  if (parsed.tolerance !== undefined) { where.push('p.tolerance_pct <= ?'); params.push(parsed.tolerance); }
  if (parsed.packages) { where.push(`p.package_id IN (${parsed.packages.ids.map(() => '?').join(',')})`); params.push(...parsed.packages.ids); }
  if (where.length === 1) return { parsed, rows: [] };
  const rows = await query<PartListRow>(`${PART_LIST_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY (on_hand > 0) DESC, p.tolerance_pct, p.pn LIMIT ${Math.max(1, Math.floor(limit))}`, params);
  return { parsed, rows };
}

/** Find a part by PN, MPN or vendor SKU (for barcode scans and imports). A merged part leads to the one it went into. */
export async function resolveCode(code: string): Promise<{ id: number; pn: string; via: 'pn' | 'mpn' | 'sku' } | undefined> {
  const hit = await queryOne<{ id: number; pn: string; via: 'pn' | 'mpn' | 'sku'; merged_into_id: number | null }>(`
    SELECT id, pn, 'pn' AS via, merged_into_id FROM part WHERE pn = ?1
    UNION ALL SELECT p.id, p.pn, 'mpn', p.merged_into_id FROM mfr_part m JOIN part p ON p.id = m.part_id WHERE m.mpn = ?1 COLLATE NOCASE
    UNION ALL SELECT p.id, p.pn, 'sku', p.merged_into_id FROM vendor_part v JOIN mfr_part m ON m.id = v.mfr_part_id JOIN part p ON p.id = m.part_id
      WHERE v.sku = ?1 COLLATE NOCASE
    LIMIT 1`, [code.trim()]);
  if (!hit) return undefined;
  if (hit.merged_into_id) {
    const s = await queryOne<{ id: number; pn: string }>('SELECT id, pn FROM part WHERE id = ?', [hit.merged_into_id]);
    if (s) return { id: s.id, pn: s.pn, via: hit.via };
  }
  return { id: hit.id, pn: hit.pn, via: hit.via };
}

// ------------------------------------------------------------------ one part

export async function getPart(id: number): Promise<PartDetail | undefined> {
  const p = await queryOne<PartDetail>(`
    SELECT p.*, pk.name AS package, c.path AS category, l.path AS location, l.id AS location_id, v.name AS preferred_vendor,
           mi.pn AS merged_into_pn,
           COALESCE((SELECT SUM(qty) FROM stock s WHERE s.part_id = p.id), 0) AS on_hand
    FROM part p LEFT JOIN package pk ON pk.id = p.package_id LEFT JOIN category c ON c.id = p.category_id
    LEFT JOIN location l ON l.id = p.default_location_id LEFT JOIN vendor v ON v.id = p.preferred_vendor_id
    LEFT JOIN part mi ON mi.id = p.merged_into_id
    WHERE p.id = ?`, [id]);
  if (!p) return undefined;
  const [stock, mfr, vparts, breaks, mergedFrom, usedIn, bomRevs, history] = await Promise.all([
    query<PartDetail['stock'][number]>(`SELECT s.location_id, l.path, l.code, s.qty FROM stock s JOIN location l ON l.id = s.location_id
           WHERE s.part_id = ? ORDER BY s.qty DESC`, [id]),
    query<MfrPart>(`SELECT m.*, mf.name AS manufacturer FROM mfr_part m JOIN manufacturer mf ON mf.id = m.manufacturer_id
           WHERE m.part_id = ? ORDER BY m.preferred DESC, mf.name, m.mpn`, [id]),
    query<VendorPart & { mfr_part_id: number }>(`SELECT vp.*, v.name AS vendor FROM vendor_part vp JOIN vendor v ON v.id = vp.vendor_id
           JOIN mfr_part m ON m.id = vp.mfr_part_id WHERE m.part_id = ? ORDER BY vp.preferred DESC, v.name`, [id]),
    query<{ vendor_part_id: number; qty: number; unit_price: number }>(`SELECT pb.* FROM price_break pb
           JOIN vendor_part vp ON vp.id = pb.vendor_part_id JOIN mfr_part m ON m.id = vp.mfr_part_id
           WHERE m.part_id = ? ORDER BY pb.qty`, [id]),
    query<{ id: number; pn: string }>('SELECT id, pn FROM part WHERE merged_into_id = ? ORDER BY pn', [id]),
    query<PartDetail['usedIn'][number]>(`SELECT a.id AS assembly_id, a.pn AS assembly_pn, a.description AS assembly_desc, r.rev, bl.qty, bl.designators
           FROM bom_line bl JOIN bom_rev r ON r.id = bl.bom_rev_id JOIN part a ON a.id = r.part_id
           WHERE bl.part_id = ? ORDER BY a.pn, r.rev`, [id]),
    query<PartDetail['bomRevs'][number]>(`SELECT r.id, r.rev, r.status, r.project_code, (SELECT COUNT(*) FROM bom_line WHERE bom_rev_id = r.id) AS lines
           FROM bom_rev r WHERE r.part_id = ? ORDER BY r.rev`, [id]),
    query<PartDetail['history'][number]>(`SELECT t.at, t.kind, t.qty_delta, l.path, t.note, t.order_ref, v.name AS vendor
           FROM stock_txn t JOIN location l ON l.id = t.location_id LEFT JOIN vendor v ON v.id = t.vendor_id
           WHERE t.part_id = ? ORDER BY t.at DESC, t.id DESC LIMIT 100`, [id]),
  ]);
  const byVp = new Map<number, Array<{ qty: number; unit_price: number }>>();
  for (const b of breaks) byVp.set(b.vendor_part_id, [...(byVp.get(b.vendor_part_id) ?? []), { qty: b.qty, unit_price: b.unit_price }]);
  for (const m of mfr) m.vendorParts = vparts.filter((v) => v.mfr_part_id === m.id).map((v) => ({ ...v, breaks: byVp.get(v.id) ?? [] }));
  return { ...p, stock, mfrParts: mfr, mergedFrom, usedIn, bomRevs, history };
}

// ------------------------------------------------------------------ saving a part with its sources

export interface PartFields {
  name: string | null; description: string; category_id: number | null; kind: Kind; value_text: string | null; tolerance_pct: number | null;
  package_id: number | null; default_location_id: number | null; preferred_vendor_id: number | null;
  standard_cost: number | null; unit: string; notes: string | null; status: PartStatus;
}

export const emptyPartFields = (): PartFields => ({
  name: null, description: '', category_id: null, kind: 'component', value_text: null, tolerance_pct: null, package_id: null,
  default_location_id: null, preferred_vendor_id: null, standard_cost: null, unit: 'each', notes: null, status: 'active',
});

export interface VendorDraft { id?: number; vendor_id: number | null; sku: string; url: string; packaging: string; moq: string; currency: string; breaks: string; notes: string; origBreaks?: string }
export interface SourceDraft { id?: number; manufacturer: string; mpn: string; description: string; datasheet_url: string; lifecycle: string; notes: string; preferred: boolean; vendors: VendorDraft[] }

export const emptyVendorDraft = (): VendorDraft => ({ vendor_id: null, sku: '', url: '', packaging: '', moq: '', currency: '', breaks: '', notes: '' });
export const emptySourceDraft = (): SourceDraft => ({ manufacturer: '', mpn: '', description: '', datasheet_url: '', lifecycle: 'active', notes: '', preferred: false, vendors: [] });

/**
 * Price breaks as typed: pairs of quantity and unit price, in any layout — one per line, separated by commas,
 * or all on one line ("1 3.59 10 3.20 100 2.85"), or as "1:0.10; 100:0.021" (the CSV format).
 * "$", "@", "+", "x" and currency codes are ignored.
 */
export function parseBreaks(text: string): Array<{ qty: number; unit_price: number }> {
  const nums = text.replace(/[A-Za-z]{3}\b|[$@+×x:=]/g, ' ').split(/[\s,;]+/).filter(Boolean);
  if (nums.some((n) => !Number.isFinite(Number(n)))) throw new Error('Price breaks should be numbers: quantity then price, e.g. “1 0.10, 100 0.045”');
  if (nums.length % 2) throw new Error('Price breaks come in pairs: a quantity and its unit price');
  const out: Array<{ qty: number; unit_price: number }> = [];
  for (let i = 0; i < nums.length; i += 2) {
    const qty = Number(nums[i]);
    const unit_price = Number(nums[i + 1]);
    if (qty <= 0 || !Number.isInteger(qty)) throw new Error(`“${nums[i]} ${nums[i + 1]}” should be a whole quantity then a price, e.g. “100 0.045”`);
    if (unit_price < 0) throw new Error(`The price for ${qty} can’t be negative`);
    out.push({ qty, unit_price });
  }
  return out.sort((a, b) => a.qty - b.qty);
}

export const formatBreaks = (b: Array<{ qty: number; unit_price: number }>) => b.map((x) => `${x.qty} ${x.unit_price}`).join(', ');

/** Sources as the editor edits them. */
export function sourcesOf(p: PartDetail): SourceDraft[] {
  return p.mfrParts.map((m) => ({
    id: m.id, manufacturer: m.manufacturer, mpn: m.mpn ?? '', description: m.description ?? '', datasheet_url: m.datasheet_url ?? '',
    lifecycle: m.lifecycle, notes: m.notes ?? '', preferred: !!m.preferred,
    vendors: m.vendorParts.map((v) => {
      const b = formatBreaks(v.breaks);
      return { id: v.id, vendor_id: v.vendor_id, sku: v.sku, url: v.url ?? '', packaging: v.packaging ?? '', moq: v.moq ? String(v.moq) : '',
        currency: v.currency ?? '', breaks: b, notes: v.notes ?? '', origBreaks: b };
    }),
  }));
}

/** Value text → numeric value and unit, using the category to decide the unit. */
async function valueColumns(valueText: string | null, categoryId: number | null): Promise<[number | null, string | null]> {
  if (!valueText?.trim()) return [null, null];
  const cat = categoryId ? await queryOne<{ path: string }>('SELECT path FROM category WHERE id = ?', [categoryId]) : undefined;
  const v = parseValue(valueText, unitForCategory(cat?.path));
  return v ? [v.num, v.unit] : [null, null];
}

/**
 * Create or update a part together with its manufacturer and vendor parts (and, for a new part, its opening stock),
 * all in one transaction. Sources missing from `sources` are removed.
 */
export async function savePart(input: {
  partId: number | null; seriesId?: number | null; manualPn?: string | null; fields: PartFields; sources: SourceDraft[];
  initialStock?: { qty: number; locationId: number; unitCost: number | null } | null; source?: string | null;
}): Promise<number> {
  const { partId, fields: f } = input;
  if (!f.description.trim()) throw new Error('A description is needed');
  if (!f.unit.trim()) throw new Error('A unit is needed (usually “each”)');
  const sources = input.sources.filter((s) => s.manufacturer.trim() || s.mpn.trim() || s.vendors.length);
  for (const s of sources) {
    if (!s.manufacturer.trim()) throw new Error(`Manufacturer part ${s.mpn || '(no MPN)'} needs a manufacturer`);
    for (const v of s.vendors) {
      if (!v.vendor_id) throw new Error(`Choose a vendor for ${s.manufacturer} ${s.mpn}`.trim());
      if (!v.sku.trim()) throw new Error(`Enter the vendor part number for ${s.manufacturer} ${s.mpn}`.trim());
    }
  }

  // Clashes with other parts, checked up front so the message can name the other part
  const mids: number[] = [];
  for (const s of sources) mids.push(await manufacturerIdFor(s.manufacturer));
  for (const [i, s] of sources.entries()) {
    if (!s.mpn.trim()) continue;
    const hit = await queryOne<{ pn: string; part_id: number }>(
      'SELECT p.pn, m.part_id FROM mfr_part m JOIN part p ON p.id = m.part_id WHERE m.manufacturer_id = ? AND m.mpn = ?', [mids[i], s.mpn.trim()]);
    if (hit && hit.part_id !== partId) throw new Error(`${s.manufacturer} ${s.mpn} is already a source of ${hit.pn}`);
    if (sources.some((o, j) => j < i && mids[j] === mids[i] && o.mpn.trim() === s.mpn.trim())) throw new Error(`${s.manufacturer} ${s.mpn} is listed twice`);
  }
  const seenSku = new Set<string>();
  for (const s of sources) for (const v of s.vendors) {
    const key = `${v.vendor_id}|${v.sku.trim().toLowerCase()}`;
    if (seenSku.has(key)) throw new Error(`Vendor part ${v.sku} is listed twice`);
    seenSku.add(key);
    const hit = await queryOne<{ pn: string; part_id: number }>(`SELECT p.pn, m.part_id FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id
      JOIN part p ON p.id = m.part_id WHERE vp.vendor_id = ? AND vp.sku = ?`, [v.vendor_id, v.sku.trim()]);
    if (hit && hit.part_id !== partId) throw new Error(`Vendor part ${v.sku} is already listed on ${hit.pn}`);
  }

  const [num, unit] = await valueColumns(f.value_text, f.category_id);
  const stmts: Statement[] = [];
  const push = (st: Statement) => { stmts.push(st); return stmts.length - 1; };
  let partRef: Param;

  if (partId === null) {
    let pn = input.manualPn?.trim() || null;
    let series: Series | undefined;
    if (!pn) ({ pn, series } = await peekNextPn(input.seriesId));
    if (await queryOne('SELECT 1 FROM part WHERE pn = ?', [pn])) throw new Error(`${pn} is already used`);
    partRef = ref(push({
      sql: `INSERT INTO part (pn, series_id, kind, category_id, name, description, value_text, value_num, value_unit, tolerance_pct,
            package_id, default_location_id, preferred_vendor_id, standard_cost, unit, notes, status, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [pn, series?.id ?? null, f.kind, f.category_id, f.name?.trim() || null, f.description.trim(), f.value_text?.trim() || null, num, unit,
        f.tolerance_pct, f.package_id, f.default_location_id ?? input.initialStock?.locationId ?? null, f.preferred_vendor_id, f.standard_cost,
        f.unit.trim(), f.notes?.trim() || null, f.status, input.source ?? null],
    }));
    if (series) {
      push({ sql: 'UPDATE pn_series SET next_value = MAX(next_value, ?) WHERE id = ?',
        params: [Number(pn.slice(series.prefix.length)) + 1, series.id] });
    }
    push({ sql: `INSERT INTO audit_log (entity, entity_id, action, changes) VALUES ('part', ?, 'create', ?)`, params: [partRef, JSON.stringify({ pn, ...f })] });
  } else {
    partRef = partId;
    push({ sql: `UPDATE part SET name = ?, description = ?, category_id = ?, kind = ?, value_text = ?, value_num = ?, value_unit = ?,
        tolerance_pct = ?, package_id = ?, default_location_id = ?, preferred_vendor_id = ?, standard_cost = ?, unit = ?, notes = ?, status = ?,
        updated_at = datetime('now') WHERE id = ?`,
      params: [f.name?.trim() || null, f.description.trim(), f.category_id, f.kind, f.value_text?.trim() || null, num, unit, f.tolerance_pct,
        f.package_id, f.default_location_id, f.preferred_vendor_id, f.standard_cost, f.unit.trim(), f.notes?.trim() || null, f.status, partId] });
    push({ sql: `INSERT INTO audit_log (entity, entity_id, action, changes) VALUES ('part', ?, 'update', ?)`, params: [partId, JSON.stringify(f)] });
    // Removals first, so a re-entered MPN or SKU does not collide with the old row
    const keepM = new Set(sources.filter((s) => s.id).map((s) => s.id!));
    const keepV = new Set(sources.flatMap((s) => s.vendors.filter((v) => v.id).map((v) => v.id!)));
    const existing = await query<{ id: number; kind: string }>(`SELECT id, 'm' AS kind FROM mfr_part WHERE part_id = ?1
       UNION ALL SELECT vp.id, 'v' FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id WHERE m.part_id = ?1`, [partId]);
    for (const e of existing) if (e.kind === 'v' && !keepV.has(e.id)) push({ sql: 'DELETE FROM vendor_part WHERE id = ?', params: [e.id] });
    for (const e of existing) if (e.kind === 'm' && !keepM.has(e.id)) push({ sql: 'DELETE FROM mfr_part WHERE id = ?', params: [e.id] });
    push({ sql: 'UPDATE mfr_part SET preferred = 0 WHERE part_id = ?', params: [partId] });
  }

  let prefIdx = sources.findIndex((s) => s.preferred);
  if (prefIdx < 0 && sources.length) prefIdx = 0;
  let preferredRef: Param | null = null;
  for (const [i, s] of sources.entries()) {
    const mpn = s.mpn.trim() || null;
    const cols = [mids[i], mpn, s.description.trim() || null, s.datasheet_url.trim() || null, s.lifecycle, s.notes.trim() || null, i === prefIdx ? 1 : 0];
    const mref: Param = s.id
      ? (push({ sql: 'UPDATE mfr_part SET manufacturer_id = ?, mpn = ?, description = ?, datasheet_url = ?, lifecycle = ?, notes = ?, preferred = ? WHERE id = ?',
          params: [...cols, s.id] }), s.id)
      : ref(push({ sql: 'INSERT INTO mfr_part (part_id, manufacturer_id, mpn, description, datasheet_url, lifecycle, notes, preferred) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          params: [partRef, ...cols] }));
    if (i === prefIdx) preferredRef = mref;
    for (const v of s.vendors) {
      const breaksChanged = v.id === undefined || v.breaks.trim() !== (v.origBreaks ?? '').trim();
      const breaks = parseBreaks(v.breaks);
      const moq = v.moq.trim() ? Number(v.moq) : null;
      if (moq !== null && !(Number.isInteger(moq) && moq > 0)) throw new Error(`Minimum order for ${v.sku || 'a vendor part'} should be a whole number`);
      const currency = v.currency.trim().toUpperCase() || null;
      if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error(`Currency for ${v.sku} should be a three-letter code such as USD`);
      const vals = [mref, v.vendor_id, v.sku.trim(), v.url.trim() || null, v.packaging.trim() || null, moq, currency, v.notes.trim() || null];
      const vref: Param = v.id
        ? (push({ sql: `UPDATE vendor_part SET mfr_part_id = ?, vendor_id = ?, sku = ?, url = ?, packaging = ?, moq = ?, currency = ?, notes = ?
              ${breaksChanged ? ", prices_checked_at = date('now')" : ''} WHERE id = ?`, params: [...vals, v.id] }), v.id)
        : ref(push({ sql: `INSERT INTO vendor_part (mfr_part_id, vendor_id, sku, url, packaging, moq, currency, notes, prices_checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${breaks.length ? "date('now')" : 'NULL'})`, params: vals }));
      if (breaksChanged) {
        if (v.id) push({ sql: 'DELETE FROM price_break WHERE vendor_part_id = ?', params: [vref] });
        for (const b of breaks) push({ sql: 'INSERT OR REPLACE INTO price_break (vendor_part_id, qty, unit_price) VALUES (?, ?, ?)', params: [vref, b.qty, b.unit_price] });
      }
    }
  }

  const st = input.initialStock;
  if (partId === null && st && st.qty > 0) {
    push({ sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, unit_cost, mfr_part_id, note)
      VALUES (?, 'opening', ?, ?, ?, ?, ?, 'Opening stock')`, params: [batchId(), partRef, st.locationId, st.qty, st.unitCost, preferredRef] });
  }

  let res: Array<{ lastInsertId: number }>;
  try {
    res = (await transaction(stmts)) as Array<{ lastInsertId: number }>;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/FOREIGN KEY/i.test(msg)) throw new Error('A source you removed has stock receipts recorded against it. Keep it (you can mark it obsolete) instead.');
    throw e;
  }
  const id = partId ?? res[0].lastInsertId;
  await reindexPart(id);
  return id;
}

/** Set just the short name (inline editing in the parts list). */
export async function setPartName(id: number, name: string | null): Promise<void> {
  await execute("UPDATE part SET name = ?, updated_at = datetime('now') WHERE id = ?", [name?.trim() || null, id]);
  await reindexPart(id);
}

/** Make one vendor part the one to buy from (★); the part's other vendor parts lose their star. */
export async function setPreferredVendorPart(partId: number, vendorPartId: number): Promise<void> {
  await execute('UPDATE vendor_part SET preferred = (id = ?) WHERE mfr_part_id IN (SELECT id FROM mfr_part WHERE part_id = ?)', [vendorPartId, partId]);
}

// ------------------------------------------------------------------ status, deleting, merging

export async function setPartsStatus(ids: number[], status: PartStatus): Promise<void> {
  if (!ids.length) return;
  const merged = await queryOne<{ pn: string }>(
    `SELECT pn FROM part WHERE merged_into_id IS NOT NULL AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, ids);
  if (merged && status !== 'archived') throw new Error(`${merged.pn} was merged into another part, so it stays archived`);
  await transaction(ids.flatMap((id) => [
    { sql: "UPDATE part SET status = ?, updated_at = datetime('now') WHERE id = ?", params: [status, id] },
    { sql: `INSERT INTO audit_log (entity, entity_id, action, changes) VALUES ('part', ?, ?, ?)`,
      params: [id, status === 'archived' ? 'archive' : 'update', JSON.stringify({ status })] },
  ]));
}

/** Why a part can't be deleted outright (null = it can). Parts with history or uses are archived instead. */
export async function deleteBlocker(id: number): Promise<string | null> {
  const r = await queryOne<{ txns: number; on_hand: number; bom: number; asm: number; builds: number; shop: number; merged: number }>(`
    SELECT (SELECT COUNT(*) FROM stock_txn WHERE part_id = ?1) AS txns,
           (SELECT COALESCE(SUM(qty), 0) FROM stock WHERE part_id = ?1) AS on_hand,
           (SELECT COUNT(*) FROM bom_line WHERE part_id = ?1) AS bom,
           (SELECT COUNT(*) FROM bom_rev WHERE part_id = ?1) AS asm,
           (SELECT COUNT(*) FROM build_line WHERE part_id = ?1 OR bom_part_id = ?1) AS builds,
           (SELECT COUNT(*) FROM shopping_item WHERE part_id = ?1) AS shop,
           (SELECT COUNT(*) FROM part WHERE merged_into_id = ?1) AS merged`, [id]);
  if (!r) return 'not found';
  const why: string[] = [];
  if (r.on_hand) why.push(`${r.on_hand} in stock`);
  else if (r.txns) why.push('has stock history');
  if (r.bom) why.push(`used in ${r.bom} BOM line${r.bom === 1 ? '' : 's'}`);
  if (r.asm) why.push('has its own BOM');
  if (r.builds) why.push('used in builds');
  if (r.shop) why.push('on the shopping list');
  if (r.merged) why.push('other parts were merged into it');
  return why.length ? why.join(', ') : null;
}

/** Delete a part that has never been used: its manufacturer and vendor parts go with it. */
export async function deletePart(id: number): Promise<void> {
  const blocker = await deleteBlocker(id);
  if (blocker) throw new Error(`Can’t delete: ${blocker}. Archive it instead.`);
  const p = await queryOne('SELECT pn, name, description FROM part WHERE id = ?', [id]);
  await transaction([
    { sql: 'DELETE FROM part_fts WHERE part_id = ?', params: [id] },
    { sql: 'DELETE FROM document_link WHERE part_id = ?', params: [id] },
    { sql: 'DELETE FROM document_link WHERE mfr_part_id IN (SELECT id FROM mfr_part WHERE part_id = ?)', params: [id] },
    { sql: 'DELETE FROM part WHERE id = ?', params: [id] },            // manufacturer/vendor parts and price breaks cascade
    { sql: `INSERT INTO audit_log (entity, entity_id, action, changes) VALUES ('part', ?, 'delete', ?)`, params: [id, JSON.stringify(p ?? {})] },
  ]);
}

/** Delete what can be deleted and archive the rest, reporting which were archived and why. */
export async function deleteOrArchiveParts(ids: number[]): Promise<{ deleted: number; archived: Array<{ id: number; pn: string; reason: string }> }> {
  const archived: Array<{ id: number; pn: string; reason: string }> = [];
  let deleted = 0;
  for (const id of ids) {
    const reason = await deleteBlocker(id);
    if (reason) {
      const pn = (await queryOne<{ pn: string }>('SELECT pn FROM part WHERE id = ?', [id]))?.pn ?? String(id);
      archived.push({ id, pn, reason });
    } else {
      await deletePart(id);
      deleted++;
    }
  }
  await setPartsStatus(archived.map((a) => a.id), 'archived');
  return { deleted, archived };
}

/**
 * Merge a duplicate into the part being kept. The duplicate's stock moves across (as ledger moves, so its
 * history stays true), and its sources, BOM lines, open shopping items and documents move to the kept part.
 * The duplicate stays, archived, pointing at the kept part; scanning or searching its PN leads there.
 */
export async function mergeParts(keepId: number, duplicateId: number): Promise<void> {
  if (keepId === duplicateId) throw new Error('Choose a different part');
  const [keep, dup] = await Promise.all([
    queryOne<{ pn: string; status: string; merged_into_id: number | null }>('SELECT pn, status, merged_into_id FROM part WHERE id = ?', [keepId]),
    queryOne<{ pn: string; merged_into_id: number | null }>('SELECT pn, merged_into_id FROM part WHERE id = ?', [duplicateId]),
  ]);
  if (!keep || !dup) throw new Error('Part not found');
  if (keep.merged_into_id) throw new Error(`${keep.pn} was itself merged into another part`);
  if (dup.merged_into_id) throw new Error(`${dup.pn} has already been merged`);
  if (await queryOne('SELECT 1 FROM bom_rev WHERE part_id = ?', [duplicateId])) {
    throw new Error(`${dup.pn} has its own BOM; parts with BOMs can’t be merged`);
  }

  // Sources move as they are: MPNs and vendor SKUs are unique across the library, so the two parts can't share one.
  // Receipts in the ledger keep pointing at the same manufacturer part, which now belongs to the kept part.
  const stmts: Statement[] = [
    { sql: 'UPDATE mfr_part SET part_id = ?, preferred = 0 WHERE part_id = ?', params: [keepId, duplicateId] },
  ];
  // Stock: move every quantity across with a pair of ledger rows per location.
  const held = await query<{ location_id: number; qty: number }>('SELECT location_id, qty FROM stock WHERE part_id = ? AND qty <> 0', [duplicateId]);
  const b = batchId();
  for (const h of held) {
    stmts.push(
      { sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'move', ?, ?, ?, ?)`,
        params: [b, duplicateId, h.location_id, -h.qty, `Merged into ${keep.pn}`] },
      { sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'move', ?, ?, ?, ?)`,
        params: [b, keepId, h.location_id, h.qty, `Merged from ${dup.pn}`] },
    );
  }
  stmts.push(
    { sql: 'UPDATE bom_line SET part_id = ? WHERE part_id = ?', params: [keepId, duplicateId] },
    { sql: "UPDATE shopping_item SET part_id = ? WHERE part_id = ? AND status = 'open'", params: [keepId, duplicateId] },
    { sql: 'UPDATE document_link SET part_id = ? WHERE part_id = ?', params: [keepId, duplicateId] },
    { sql: `UPDATE part SET default_location_id = COALESCE(default_location_id, (SELECT default_location_id FROM part WHERE id = ?)),
            updated_at = datetime('now') WHERE id = ?`, params: [duplicateId, keepId] },
    { sql: "UPDATE part SET status = 'archived', merged_into_id = ?, updated_at = datetime('now') WHERE id = ?", params: [keepId, duplicateId] },
    { sql: `INSERT INTO audit_log (entity, entity_id, action, changes) VALUES ('part', ?, 'merge', ?)`, params: [keepId, JSON.stringify({ merged: dup.pn })] },
  );
  await transaction(stmts);
  await reindexPart(keepId);
  await reindexPart(duplicateId);
}
