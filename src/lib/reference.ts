// Reference data the parts screens pick from: categories, packages, manufacturers, vendors,
// the PN series, and settings.
import { execute, query, queryOne, transaction, type Statement } from './db.ts';
import { rebuildSearchIndex } from './search.ts';
import { packageKey } from './values.ts';

export interface Named { id: number; name: string }

// ------------------------------------------------------------------ settings

export async function getSetting(key: string): Promise<string | null> {
  return (await queryOne<{ value: string | null }>('SELECT value FROM setting WHERE key = ?', [key]))?.value ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  await execute('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
}

// ------------------------------------------------------------------ exchange rates

/** A rate says what one unit of `currency` is worth in the base currency (to_base). 0 means not set yet. */
export interface Rate { currency: string; to_base: number; updated_at: string | null }

export async function listRates(): Promise<Rate[]> {
  return query<Rate>('SELECT currency, to_base, updated_at FROM fx_rate ORDER BY currency');
}

/** Add or change the rate for a currency: 1 `currency` = `toBase` of the base currency. */
export async function setRate(currency: string, toBase: number): Promise<void> {
  const c = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('Use a three-letter currency code such as USD or EUR');
  const base = (await getSetting('base_currency')) ?? 'USD';
  if (c === base) throw new Error(`${c} is the base currency; its rate is always 1`);
  if (!Number.isFinite(toBase) || toBase <= 0) throw new Error('The rate should be a number above zero');
  await execute(`INSERT INTO fx_rate (currency, to_base, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT (currency) DO UPDATE SET to_base = excluded.to_base, updated_at = excluded.updated_at`, [c, toBase]);
}

export async function deleteRate(currency: string): Promise<void> {
  const base = (await getSetting('base_currency')) ?? 'USD';
  if (currency === base) throw new Error('The base currency’s rate can’t be removed');
  await execute('DELETE FROM fx_rate WHERE currency = ?', [currency]);
}

// ------------------------------------------------------------------ PN series

export interface Series { id: number; name: string; prefix: string; width: number; range_start: number; range_end: number; next_value: number; retired: number }

export const listSeries = () => query<Series>('SELECT * FROM pn_series WHERE retired = 0 ORDER BY id');

export function formatPn(s: Series, n: number): string {
  return `${s.prefix}${String(n).padStart(s.width, '0')}`;
}

/** The next unused PN in a series (skipping any already taken by hand). */
export async function peekNextPn(seriesId?: number | null): Promise<{ pn: string; series: Series }> {
  const s = seriesId
    ? await queryOne<Series>('SELECT * FROM pn_series WHERE id = ?', [seriesId])
    : await queryOne<Series>('SELECT * FROM pn_series WHERE retired = 0 ORDER BY id LIMIT 1');
  if (!s) throw new Error('There is no part number series');
  for (let n = s.next_value; n <= s.range_end; n++) {
    const pn = formatPn(s, n);
    if (!(await queryOne('SELECT 1 FROM part WHERE pn = ?', [pn]))) return { pn, series: s };
  }
  throw new Error(`Series ${s.name} is full`);
}

// ------------------------------------------------------------------ categories

export interface Category { id: number; parent_id: number | null; name: string; path: string; ref_prefix: string | null; parts: number }
export interface CategoryFields { name: string; parent_id: number | null; ref_prefix: string | null }

export const listCategories = () => query<Category>(
  `SELECT c.*, (SELECT COUNT(*) FROM part p WHERE p.category_id = c.id AND p.status <> 'archived') AS parts
   FROM category c ORDER BY c.path`);

async function categoryPath(name: string, parentId: number | null): Promise<string> {
  const n = name.trim();
  if (!n) throw new Error('Give the category a name');
  if (n.includes('>')) throw new Error('A category name can’t contain “>”');
  const parent = parentId ? await queryOne<{ path: string }>('SELECT path FROM category WHERE id = ?', [parentId]) : undefined;
  if (parentId && !parent) throw new Error('Parent category not found');
  return parent ? `${parent.path} > ${n}` : n;
}

export async function addCategory(f: CategoryFields): Promise<number> {
  const path = await categoryPath(f.name, f.parent_id);
  if (await queryOne('SELECT 1 FROM category WHERE path = ?', [path])) throw new Error(`${path} already exists`);
  return (await execute('INSERT INTO category (parent_id, name, path, ref_prefix) VALUES (?, ?, ?, ?)',
    [f.parent_id, f.name.trim(), path, f.ref_prefix?.trim() || null])).lastInsertId;
}

/** Find a category by path ('Passive > Resistor'), creating it and any missing parents. */
export async function ensureCategoryPath(path: string): Promise<number> {
  const parts = path.split('>').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Empty category path');
  let parentId: number | null = null;
  let sofar = '';
  for (const name of parts) {
    sofar = sofar ? `${sofar} > ${name}` : name;
    const hit: { id: number } | undefined = await queryOne<{ id: number }>('SELECT id FROM category WHERE path = ? COLLATE NOCASE', [sofar]);
    parentId = hit ? hit.id : await addCategory({ name, parent_id: parentId, ref_prefix: null });
  }
  return parentId!;
}

/** Rename or move a category; its subcategories move with it. */
export async function updateCategory(id: number, f: CategoryFields): Promise<void> {
  const cat = await queryOne<{ path: string }>('SELECT path FROM category WHERE id = ?', [id]);
  if (!cat) throw new Error('Category not found');
  if (f.parent_id !== null) {
    const parent = await queryOne<{ path: string }>('SELECT path FROM category WHERE id = ?', [f.parent_id]);
    if (f.parent_id === id || (parent && `${parent.path} > `.startsWith(`${cat.path} > `))) throw new Error('A category can’t go inside itself');
  }
  const path = await categoryPath(f.name, f.parent_id);
  if (path !== cat.path && await queryOne('SELECT 1 FROM category WHERE path = ?', [path])) throw new Error(`${path} already exists`);
  await transaction([
    { sql: 'UPDATE category SET name = ?, parent_id = ?, path = ?, ref_prefix = ? WHERE id = ?', params: [f.name.trim(), f.parent_id, path, f.ref_prefix?.trim() || null, id] },
    { sql: 'UPDATE category SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?', params: [path, cat.path.length + 1, cat.path.length + 3, `${cat.path} > `] },
  ]);
  if (path !== cat.path) await rebuildSearchIndex();   // search covers the category path
}

/** Delete a category. Its parts and subcategories go to its parent (or to no category at the top level). */
export async function deleteCategory(id: number): Promise<void> {
  const cat = await queryOne<{ parent_id: number | null; path: string }>('SELECT parent_id, path FROM category WHERE id = ?', [id]);
  if (!cat) return;
  const parentPath = cat.parent_id ? (await queryOne<{ path: string }>('SELECT path FROM category WHERE id = ?', [cat.parent_id]))?.path ?? null : null;
  const kids = await query<{ id: number; name: string }>('SELECT id, name FROM category WHERE parent_id = ?', [id]);
  for (const k of kids) {
    const p = parentPath ? `${parentPath} > ${k.name}` : k.name;
    if (await queryOne('SELECT 1 FROM category WHERE path = ?', [p])) throw new Error(`Can’t move ${k.name} up: ${p} already exists. Rename one of them first.`);
  }
  const stmts: Statement[] = [{ sql: 'UPDATE part SET category_id = ? WHERE category_id = ?', params: [cat.parent_id, id] }];
  for (const k of kids) {
    const old = `${cat.path} > ${k.name}`;
    const p = parentPath ? `${parentPath} > ${k.name}` : k.name;
    stmts.push({ sql: 'UPDATE category SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?', params: [p, old.length + 1, old.length + 3, `${old} > `] });
    stmts.push({ sql: 'UPDATE category SET parent_id = ?, path = ? WHERE id = ?', params: [cat.parent_id, p, k.id] });
  }
  stmts.push({ sql: 'DELETE FROM attribute_def WHERE category_id = ?', params: [id] }, { sql: 'DELETE FROM category WHERE id = ?', params: [id] });
  await transaction(stmts);
  await rebuildSearchIndex();
}

/** Put several parts in one category. */
export async function setPartsCategory(ids: number[], categoryId: number | null): Promise<void> {
  if (!ids.length) return;
  await execute(`UPDATE part SET category_id = ?, updated_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`, [categoryId, ...ids]);
  await rebuildSearchIndex();
}

// ------------------------------------------------------------------ packages

export interface PackageRow { id: number; name: string; mount: string | null; metric: string | null; aliases: string | null; parts: number }

/** Every package with its metric name (if it has one), its other aliases, and how many parts use it. */
export const listPackages = () => query<PackageRow>(`
  SELECT k.id, k.name, k.mount,
    (SELECT replace(a.alias, 'M', '') FROM package_alias a WHERE a.package_id = k.id AND a.is_metric AND a.alias LIKE '%M' LIMIT 1) AS metric,
    (SELECT group_concat(a.alias, ', ') FROM package_alias a WHERE a.package_id = k.id AND NOT a.is_metric) AS aliases,
    (SELECT COUNT(*) FROM part p WHERE p.package_id = k.id) AS parts
  FROM package k ORDER BY k.name COLLATE NOCASE`);

/** How a package is shown: '0805 (2012 metric)', or just 'SOIC-8'. */
export const packageLabel = (p: { name: string; metric: string | null }) => (p.metric ? `${p.name} (${p.metric} metric)` : p.name);

/** Find a package by its name or any alias, ignoring case and punctuation ('sot23', '2012M', 'SO-8'). */
export async function findPackage(text: string): Promise<number | null> {
  const key = packageKey(text);
  if (!key) return null;
  const rows = await query<{ id: number; name: string }>(
    'SELECT id, name FROM package UNION ALL SELECT package_id, alias FROM package_alias');
  return rows.find((r) => packageKey(r.name) === key)?.id ?? null;
}

export async function addPackage(name: string, mount: string | null): Promise<number> {
  const n = name.trim();
  if (!n) throw new Error('Give the package a name');
  if (await findPackage(n)) throw new Error(`${n} already exists (or is another name for an existing package)`);
  return (await execute('INSERT INTO package (name, mount) VALUES (?, ?)', [n, mount])).lastInsertId;
}

/** Rename a package (or change how it mounts); its parts follow, and search picks up the new name. */
export async function updatePackage(id: number, name: string, mount: string | null): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error('Give the package a name');
  if (await queryOne('SELECT 1 FROM package WHERE name = ? COLLATE NOCASE AND id <> ?', [n, id])) throw new Error(`${n} already exists`);
  const old = await queryOne<{ name: string }>('SELECT name FROM package WHERE id = ?', [id]);
  await execute('UPDATE package SET name = ?, mount = ? WHERE id = ?', [n, mount, id]);
  if (old && old.name !== n) await rebuildSearchIndex();
}

/** Replace a package's aliases. `metric` is its metric size without the M ('2012'), or empty for none. */
export async function setPackageAliases(id: number, metric: string, aliases: string[]): Promise<void> {
  const stmts: Statement[] = [{ sql: 'DELETE FROM package_alias WHERE package_id = ?', params: [id] }];
  const name = (await queryOne<{ name: string }>('SELECT name FROM package WHERE id = ?', [id]))?.name ?? '';
  const m = metric.trim().replace(/m$/i, '');
  if (m) {
    stmts.push({ sql: 'INSERT INTO package_alias (alias, package_id, is_metric) VALUES (?, ?, 1)', params: [`${m}M`, id] });
    // The bare metric number works too, unless it's also an imperial size name.
    if (!(await queryOne('SELECT 1 FROM package WHERE name = ? AND id <> ?', [m, id]))) {
      stmts.push({ sql: 'INSERT INTO package_alias (alias, package_id, is_metric) VALUES (?, ?, 1)', params: [m, id] });
    }
  }
  for (const a of new Set(aliases.map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== name.toLowerCase()))) {
    const other = await queryOne<{ name: string }>(
      'SELECT p.name FROM package_alias a JOIN package p ON p.id = a.package_id WHERE a.alias = ? AND a.package_id <> ?', [a, id]);
    if (other) throw new Error(`“${a}” is already another name for ${other.name}`);
    stmts.push({ sql: 'INSERT INTO package_alias (alias, package_id) VALUES (?, ?)', params: [a, id] });
  }
  await transaction(stmts);
}

/** Delete a package. Parts that used it are left with no package. */
export async function deletePackage(id: number): Promise<void> {
  await transaction([
    { sql: 'UPDATE part SET package_id = NULL WHERE package_id = ?', params: [id] },
    { sql: 'DELETE FROM package WHERE id = ?', params: [id] },
  ]);
  await rebuildSearchIndex();
}

// ------------------------------------------------------------------ manufacturers

export const listManufacturers = () => query<Named & { parts: number }>(
  `SELECT m.id, m.name, (SELECT COUNT(DISTINCT part_id) FROM mfr_part mp WHERE mp.manufacturer_id = m.id) AS parts
   FROM manufacturer m ORDER BY m.name COLLATE NOCASE`);

/** The manufacturer with this name or alias, created if new. */
export async function manufacturerIdFor(name: string): Promise<number> {
  const n = name.trim();
  if (!n) throw new Error('Manufacturer name is empty');
  const hit = await queryOne<{ id: number }>(`SELECT id FROM manufacturer WHERE name = ?1
     UNION ALL SELECT manufacturer_id FROM manufacturer_alias WHERE alias = ?1 LIMIT 1`, [n]);
  if (hit) return hit.id;
  return (await execute('INSERT INTO manufacturer (name) VALUES (?)', [n])).lastInsertId;
}

// ------------------------------------------------------------------ vendors

export interface Vendor { id: number; name: string; currency: string; website: string | null; api_connector: string | null; active: number }

export const listVendors = (includeInactive = false) => query<Vendor>(
  `SELECT id, name, currency, website, api_connector, active FROM vendor ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`);

export async function addVendor(name: string, currency: string, website: string | null): Promise<number> {
  const n = name.trim();
  if (!n) throw new Error('Give the vendor a name');
  const c = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('Currency should be a three-letter code such as USD or AUD');
  if (await queryOne('SELECT 1 FROM vendor WHERE name = ?1 UNION ALL SELECT 1 FROM vendor_alias WHERE alias = ?1', [n])) throw new Error(`${n} already exists`);
  return (await execute('INSERT INTO vendor (name, currency, website) VALUES (?, ?, ?)', [n, c, website?.trim() || null])).lastInsertId;
}

export async function updateVendor(id: number, f: { name: string; currency: string; website: string | null; active: boolean }): Promise<void> {
  const n = f.name.trim();
  if (!n) throw new Error('Give the vendor a name');
  const c = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error('Currency should be a three-letter code such as USD or AUD');
  if (await queryOne('SELECT 1 FROM vendor WHERE name = ? AND id <> ?', [n, id])) throw new Error(`${n} already exists`);
  await execute('UPDATE vendor SET name = ?, currency = ?, website = ?, active = ? WHERE id = ?', [n, c, f.website?.trim() || null, f.active ? 1 : 0, id]);
}

/** Delete a vendor nothing refers to; otherwise say why not (it can be made inactive instead). */
export async function deleteVendor(id: number): Promise<void> {
  const used = await queryOne<{ vp: number; tx: number; shop: number }>(`SELECT
    (SELECT COUNT(*) FROM vendor_part WHERE vendor_id = ?1) AS vp, (SELECT COUNT(*) FROM stock_txn WHERE vendor_id = ?1) AS tx,
    (SELECT COUNT(*) FROM shopping_item WHERE vendor_id = ?1) AS shop`, [id]);
  if (used && (used.vp || used.tx || used.shop)) {
    throw new Error(`It’s used by ${used.vp} vendor part${used.vp === 1 ? '' : 's'} and ${used.tx + used.shop} other record${used.tx + used.shop === 1 ? '' : 's'}. Make it inactive instead.`);
  }
  await transaction([
    { sql: 'UPDATE part SET preferred_vendor_id = NULL WHERE preferred_vendor_id = ?', params: [id] },
    { sql: 'DELETE FROM vendor WHERE id = ?', params: [id] },
  ]);
}

/** The vendor with this name or alias, or null. */
export async function findVendor(name: string): Promise<number | null> {
  return (await queryOne<{ id: number }>(`SELECT id FROM vendor WHERE name = ?1
     UNION ALL SELECT vendor_id FROM vendor_alias WHERE alias = ?1 LIMIT 1`, [name.trim()]))?.id ?? null;
}
