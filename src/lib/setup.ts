// Setting up a new library: base currency, starter categories and vendors, and the demo library.
// The demo is loaded through the CSV importer, tagged source = 'demo', and can be removed again.
import { execute, query, queryOne, transaction, type Statement } from './db.ts';
import { importCsv, type ImportFile, type ImportReport } from './importer.ts';
import { addCategory, getSetting, setSetting } from './reference.ts';
import { rebuildSearchIndex } from './search.ts';

export const DEMO = 'demo';

// ------------------------------------------------------------------ currency

/** Common currencies, offered on first run (any three-letter code can be typed in Settings). */
export const CURRENCIES = ['AUD', 'CAD', 'CHF', 'CNY', 'DKK', 'EUR', 'GBP', 'HKD', 'INR', 'JPY', 'KRW', 'NOK', 'NZD', 'PLN', 'SEK', 'SGD', 'TWD', 'USD', 'ZAR'];

const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
const BY_REGION: Record<string, string> = {
  AU: 'AUD', CA: 'CAD', CH: 'CHF', CN: 'CNY', DK: 'DKK', GB: 'GBP', HK: 'HKD', IN: 'INR', JP: 'JPY', KR: 'KRW',
  NO: 'NOK', NZ: 'NZD', PL: 'PLN', SE: 'SEK', SG: 'SGD', TW: 'TWD', US: 'USD', ZA: 'ZAR',
};

/** The currency a locale such as "en-AU" most likely uses; USD when unsure. */
export function currencyForLocale(locale: string | undefined): string {
  const region = (locale ?? '').split(/[-_]/).slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase();
  if (!region) return 'USD';
  if (EURO.has(region)) return 'EUR';
  return BY_REGION[region] ?? 'USD';
}

// ------------------------------------------------------------------ starter data

/** The starter category tree: path and designator prefix. */
export const STARTER_CATEGORIES: Array<[string, string | null]> = [
  ['Passive', null],
  ['Passive > Resistor', 'R'], ['Passive > Capacitor', 'C'], ['Passive > Inductor', 'L'],
  ['Passive > Ferrite bead', 'FB'], ['Passive > Crystal', 'Y'],
  ['Discrete', null],
  ['Discrete > Diode', 'D'], ['Discrete > BJT', 'Q'], ['Discrete > MOSFET', 'Q'],
  ['Opto', null],
  ['Opto > LED', 'D'], ['Opto > Optocoupler', 'U'],
  ['IC', 'U'],
  ['IC > Op-amp', 'U'], ['IC > Regulator', 'U'], ['IC > Microcontroller', 'U'], ['IC > Logic', 'U'],
  ['IC > Timer', 'U'], ['IC > Interface', 'U'], ['IC > Memory', 'U'], ['IC > Sensor', 'U'],
  ['Connector', 'J'],
  ['Electromechanical', null],
  ['Electromechanical > Switch', 'S'], ['Electromechanical > Relay', 'K'], ['Electromechanical > Fuse', 'F'],
  ['Mechanical', null],
  ['Mechanical > Fastener', null], ['Mechanical > Enclosure', null],
];

/** Common vendors. The big distributors price in local currency, so they start in the base currency. */
export function starterVendors(base: string): Array<{ name: string; currency: string; website: string; api: string | null; aliases: string[] }> {
  return [
    { name: 'DigiKey', currency: base, website: 'https://www.digikey.com', api: 'digikey', aliases: ['Digi-Key'] },
    { name: 'Mouser', currency: base, website: 'https://www.mouser.com', api: 'mouser', aliases: ['Mouser Electronics'] },
    { name: 'element14', currency: base, website: 'https://www.element14.com', api: 'element14', aliases: ['Farnell', 'Newark'] },
    { name: 'LCSC', currency: 'USD', website: 'https://www.lcsc.com', api: 'lcsc', aliases: [] },
  ];
}

/** Add the starter categories and vendors that aren't there yet. Returns how many of each were added. */
export async function addStarterData(base: string): Promise<{ categories: number; vendors: number }> {
  let categories = 0;
  for (const [path, prefix] of STARTER_CATEGORIES) {
    if (await queryOne('SELECT 1 FROM category WHERE path = ? COLLATE NOCASE', [path])) continue;
    const names = path.split(' > ');
    const parent = names.length > 1
      ? (await queryOne<{ id: number }>('SELECT id FROM category WHERE path = ? COLLATE NOCASE', [names.slice(0, -1).join(' > ')]))?.id ?? null
      : null;
    await addCategory({ name: names[names.length - 1], parent_id: parent, ref_prefix: prefix });
    categories++;
  }
  let vendors = 0;
  for (const v of starterVendors(base)) {
    const exists = await queryOne(`SELECT 1 FROM vendor WHERE name = ?1 UNION ALL SELECT 1 FROM vendor_alias WHERE alias = ?1`, [v.name]);
    if (exists) continue;
    const stmts: Statement[] = [{ sql: 'INSERT INTO vendor (name, currency, website, api_connector) VALUES (?, ?, ?, ?)', params: [v.name, v.currency, v.website, v.api] }];
    for (const a of v.aliases) stmts.push({ sql: 'INSERT OR IGNORE INTO vendor_alias (alias, vendor_id) VALUES (?, ?)', params: [a, { $ref: 0 }] });
    await transaction(stmts);
    vendors++;
  }
  return { categories, vendors };
}

// ------------------------------------------------------------------ first run

/**
 * Whether the first-run screen should show. A library that already has parts (for example one made before
 * this screen existed) counts as set up.
 */
export async function needsSetup(): Promise<boolean> {
  if (await getSetting('setup_done')) return false;
  const parts = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM part');
  if (parts?.n) {
    await setSetting('setup_done', new Date().toISOString());
    return false;
  }
  return true;
}

/**
 * Set the base currency. Exchange rates are relative to it, so the new base becomes 1 and every other
 * currency (the old base included) stays listed at 0, meaning "not set", until its rate is entered again.
 */
export async function setBaseCurrency(code: string): Promise<void> {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('Use a three-letter currency code such as USD or AUD');
  const old = (await getSetting('base_currency')) ?? 'USD';
  if (old === c) return;
  await transaction([
    { sql: "INSERT INTO setting (key, value) VALUES ('base_currency', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [c] },
    { sql: "INSERT OR IGNORE INTO fx_rate (currency, to_base, updated_at) VALUES (?, 0, NULL)", params: [old] },
    { sql: 'UPDATE fx_rate SET to_base = 0, updated_at = NULL WHERE currency <> ?', params: [c] },
    { sql: `INSERT INTO fx_rate (currency, to_base, updated_at) VALUES (?, 1, datetime('now'))
            ON CONFLICT (currency) DO UPDATE SET to_base = 1, updated_at = excluded.updated_at`, params: [c] },
  ]);
}

/** Finish first-run setup: base currency, optionally the starter data. */
export async function completeSetup(opts: { currency: string; starter: boolean }): Promise<void> {
  await setBaseCurrency(opts.currency);
  if (opts.starter) await addStarterData(opts.currency.trim().toUpperCase());
  await setSetting('setup_done', new Date().toISOString());
}

// ------------------------------------------------------------------ demo library

/** How many demo parts and locations are in the library. */
export async function demoCounts(): Promise<{ parts: number; locations: number }> {
  const r = await queryOne<{ parts: number; locations: number }>(`SELECT
    (SELECT COUNT(*) FROM part WHERE source = ?1) AS parts, (SELECT COUNT(*) FROM location WHERE source = ?1) AS locations`, [DEMO]);
  return r ?? { parts: 0, locations: 0 };
}

/** Load the demo library from its CSV files. It fails, changing nothing, if it clashes with what's there. */
export async function loadDemo(files: ImportFile[]): Promise<ImportReport> {
  const counts = await demoCounts();
  if (counts.parts || counts.locations) throw new Error('The demo library is already loaded');
  const r = await importCsv(files, { mode: 'add', stockMode: 'add', source: DEMO }, true);
  if (!r.committed) {
    const first = r.files.flatMap((f) => (f.problem ? [`${f.name}: ${f.problem}`] : f.errors.map((e) => `${f.name} line ${e.line}: ${e.message}`)))[0];
    throw new Error(`The demo library couldn’t be loaded${first ? `: ${first}` : ''}`);
  }
  return r;
}

/**
 * Remove the demo library. A demo part you've used since (stock changes, your own BOMs or BOM revisions,
 * builds, the shopping list, a merge) is kept and becomes yours, along with the demo parts a kept assembly's
 * BOM needs; so is a demo location that still holds kept stock or has your locations inside it.
 * Everything else the demo added goes, including its own stock records and BOM revisions.
 */
export async function removeDemo(): Promise<{ removedParts: number; keptParts: number; removedLocations: number; keptLocations: number }> {
  const parts = await query<{ id: number; used: number }>(`
    SELECT p.id,
      (EXISTS (SELECT 1 FROM stock_txn t WHERE t.part_id = p.id AND t.batch_id NOT LIKE 'demo:%')
       OR EXISTS (SELECT 1 FROM bom_line b JOIN bom_rev r ON r.id = b.bom_rev_id JOIN part a ON a.id = r.part_id
                  WHERE b.part_id = p.id AND COALESCE(a.source, '') <> ?1)
       OR EXISTS (SELECT 1 FROM bom_rev r WHERE r.part_id = p.id AND COALESCE(r.source_file, '') NOT LIKE 'demo:%')
       OR EXISTS (SELECT 1 FROM build b JOIN bom_rev r ON r.id = b.bom_rev_id WHERE r.part_id = p.id)
       OR EXISTS (SELECT 1 FROM build_line l WHERE l.part_id = p.id OR l.bom_part_id = p.id)
       OR EXISTS (SELECT 1 FROM shopping_item s WHERE s.part_id = p.id)
       OR EXISTS (SELECT 1 FROM part m WHERE m.merged_into_id = p.id)
       OR p.merged_into_id IS NOT NULL) AS used
    FROM part p WHERE p.source = ?1`, [DEMO]);
  const keepSet = new Set(parts.filter((p) => p.used).map((p) => p.id));
  // A kept assembly keeps the demo parts on its BOMs (repeat, since those may be assemblies too).
  for (let grew = true; grew;) {
    grew = false;
    if (!keepSet.size) break;
    const kept = [...keepSet];
    const needed = await query<{ id: number }>(`SELECT DISTINCT b.part_id AS id FROM bom_line b JOIN bom_rev r ON r.id = b.bom_rev_id
      WHERE r.part_id IN (${kept.map(() => '?').join(',')}) AND b.part_id IS NOT NULL`, kept);
    for (const n of needed) if (parts.some((p) => p.id === n.id) && !keepSet.has(n.id)) { keepSet.add(n.id); grew = true; }
  }
  const remove = parts.filter((p) => !keepSet.has(p.id)).map((p) => p.id);
  const keep = [...keepSet];
  const ids = (list: number[]) => list.map(() => '?').join(',');
  const stmts: Statement[] = [];
  if (remove.length) {
    // The demo's own BOM revisions go first (their lines refer to the parts being removed).
    stmts.push({ sql: `DELETE FROM bom_rev WHERE part_id IN (${ids(remove)})`, params: remove });
    // Demo data is the one exception to "the stock ledger is never deleted": it was never real.
    stmts.push(
      { sql: `DELETE FROM stock WHERE part_id IN (${ids(remove)})`, params: remove },
      { sql: `DELETE FROM stock_txn WHERE part_id IN (${ids(remove)})`, params: remove },
      { sql: `DELETE FROM part_fts WHERE part_id IN (${ids(remove)})`, params: remove },
      { sql: `DELETE FROM document_link WHERE part_id IN (${ids(remove)})`, params: remove },
      { sql: `DELETE FROM part WHERE id IN (${ids(remove)})`, params: remove },
    );
  }
  if (keep.length) stmts.push({ sql: `UPDATE part SET source = NULL WHERE id IN (${ids(keep)})`, params: keep });
  if (stmts.length) await transaction(stmts);

  // Locations, deepest first: a demo location goes if nothing is left in it and nothing of yours ever used it.
  const locs = await query<{ id: number; path: string }>('SELECT id, path FROM location WHERE source = ? ORDER BY length(path) DESC', [DEMO]);
  let removedLocations = 0;
  let keptLocations = 0;
  for (const l of locs) {
    const busy = await queryOne(`SELECT 1 FROM stock WHERE location_id = ?1
      UNION ALL SELECT 1 FROM location WHERE parent_id = ?1
      UNION ALL SELECT 1 FROM stock_txn WHERE location_id = ?1
      UNION ALL SELECT 1 FROM build WHERE output_location_id = ?1
      UNION ALL SELECT 1 FROM build_line WHERE location_id = ?1 LIMIT 1`, [l.id]);
    if (busy) {
      await execute('UPDATE location SET source = NULL WHERE id = ?', [l.id]);
      keptLocations++;
    } else {
      await transaction([
        { sql: 'UPDATE part SET default_location_id = NULL WHERE default_location_id = ?', params: [l.id] },
        { sql: 'DELETE FROM location WHERE id = ?', params: [l.id] },
      ]);
      removedLocations++;
    }
  }
  await rebuildSearchIndex();
  return { removedParts: remove.length, keptParts: keep.length, removedLocations, keptLocations };
}
