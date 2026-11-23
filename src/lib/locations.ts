// Storage locations: a tree (Cabinet A > Drawer 1 > Bin 01), each with a short barcode code (L0001).
// A location that has ever held stock is archived when removed, never deleted, so stock history keeps its meaning.
import { execute, query, queryOne, transaction, type Statement } from './db.ts';
import type { PartListRow } from './parts.ts';

export interface Location {
  id: number; parent_id: number | null; name: string; path: string; code: string;
  description: string | null; archived: number; parts: number;
}

/** Locations in path order; archived ones only when asked for. `parts` is how many parts are held there. */
export const listLocations = (includeArchived = false) => query<Location>(
  `SELECT l.*, (SELECT COUNT(*) FROM stock s WHERE s.location_id = l.id) AS parts FROM location l
   ${includeArchived ? '' : 'WHERE l.archived = 0'} ORDER BY l.path`);

/** What's held at one location. */
export const partsInLocation = (locationId: number) => query<PartListRow & { qty: number }>(`
  SELECT st.qty, p.id, p.pn, p.name, p.description, p.kind, p.status, p.value_text, p.value_num, p.value_unit, p.tolerance_pct,
         pk.name AS package, c.path AS category,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.part_id = p.id), 0) AS on_hand,
         l.path AS location, l.id AS location_id
  FROM stock st
  JOIN part p ON p.id = st.part_id
  LEFT JOIN package pk ON pk.id = p.package_id
  LEFT JOIN category c ON c.id = p.category_id
  LEFT JOIN location l ON l.id = p.default_location_id
  WHERE st.location_id = ? ORDER BY c.path, p.value_num, p.pn`, [locationId]);

function checkName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error('Give the location a name');
  if (n.includes('>')) throw new Error('A location name can’t contain “>”');
  return n;
}

/** The next free code: L0001, L0002… */
async function nextCode(): Promise<string> {
  const last = await queryOne<{ n: number | null }>(`SELECT MAX(CAST(substr(code, 2) AS INTEGER)) AS n FROM location WHERE code GLOB 'L[0-9]*'`);
  return `L${String((last?.n ?? 0) + 1).padStart(4, '0')}`;
}

/** Add a location. A code may be given (it must be unused); otherwise the next L-number is used. */
export async function addLocation(parentId: number | null, name: string, description: string | null, code?: string | null, source?: string | null): Promise<number> {
  const n = checkName(name);
  const parent = parentId ? await queryOne<{ path: string; archived: number }>('SELECT path, archived FROM location WHERE id = ?', [parentId]) : undefined;
  if (parentId && !parent) throw new Error('Parent location not found');
  const path = parent ? `${parent.path} > ${n}` : n;
  const existing = await queryOne<{ id: number; archived: number }>('SELECT id, archived FROM location WHERE path = ?', [path]);
  if (existing && !existing.archived) throw new Error(`${path} already exists`);
  if (existing) { await restoreLocation(existing.id); return existing.id; }   // bring back the removed one
  const c = code?.trim() || await nextCode();
  if (await queryOne('SELECT 1 FROM location WHERE code = ? COLLATE NOCASE', [c])) throw new Error(`Code ${c} is already used`);
  const stmts: Statement[] = [];
  if (parent?.archived) stmts.push(...await restoreStatements(parentId!));
  stmts.push({ sql: 'INSERT INTO location (parent_id, name, path, code, description, source) VALUES (?, ?, ?, ?, ?, ?)',
    params: [parentId, n, path, c, description?.trim() || null, source ?? null] });
  const res = (await transaction(stmts)) as Array<{ lastInsertId: number }>;
  return res[res.length - 1].lastInsertId;
}

/** Find a location by path ('Cabinet A > Drawer 1'), creating it and any missing parents. */
export async function ensureLocationPath(path: string, source?: string | null): Promise<number> {
  const names = path.split('>').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('Empty location path');
  let parentId: number | null = null;
  let sofar = '';
  for (const name of names) {
    sofar = sofar ? `${sofar} > ${name}` : name;
    const hit: { id: number; archived: number } | undefined = await queryOne('SELECT id, archived FROM location WHERE path = ? COLLATE NOCASE', [sofar]);
    if (hit?.archived) await restoreLocation(hit.id);
    parentId = hit ? hit.id : await addLocation(parentId, name, null, null, source);
  }
  return parentId!;
}

/** Find a location by its code (L0001) or full path. */
export async function findLocation(text: string): Promise<{ id: number; path: string; archived: number } | undefined> {
  const t = text.trim();
  return queryOne(`SELECT id, path, archived FROM location WHERE code = ?1 COLLATE NOCASE
    UNION ALL SELECT id, path, archived FROM location WHERE path = ?1 COLLATE NOCASE LIMIT 1`, [t]);
}

/** Rename a location, change its description, or move it inside another one. Everything inside it moves with it. */
export async function updateLocation(id: number, f: { name: string; description: string | null; parent_id: number | null }): Promise<void> {
  const loc = await queryOne<{ path: string }>('SELECT path FROM location WHERE id = ?', [id]);
  if (!loc) throw new Error('Location not found');
  const n = checkName(f.name);
  const parent = f.parent_id ? await queryOne<{ path: string }>('SELECT path FROM location WHERE id = ?', [f.parent_id]) : undefined;
  if (f.parent_id && !parent) throw new Error('Parent location not found');
  if (f.parent_id === id || (parent && `${parent.path} > `.startsWith(`${loc.path} > `))) throw new Error('A location can’t go inside itself');
  const newPath = parent ? `${parent.path} > ${n}` : n;
  if (newPath !== loc.path && await queryOne('SELECT 1 FROM location WHERE path = ? COLLATE NOCASE AND id <> ?', [newPath, id])) {
    throw new Error(`${newPath} already exists`);
  }
  await transaction([
    { sql: 'UPDATE location SET name = ?, description = ?, parent_id = ?, path = ? WHERE id = ?', params: [n, f.description?.trim() || null, f.parent_id, newPath, id] },
    { sql: 'UPDATE location SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?',
      params: [newPath, loc.path.length + 1, loc.path.length + 3, `${loc.path} > `] },
  ]);
}

/** Why a location can't be removed yet (null = it can). */
export async function removeBlocker(id: number): Promise<string | null> {
  const r = await queryOne<{ parts: number; kids: number }>(`SELECT
      (SELECT COUNT(*) FROM stock WHERE location_id = ?1) AS parts,
      (SELECT COUNT(*) FROM location WHERE parent_id = ?1 AND archived = 0) AS kids`, [id]);
  if (!r) return 'not found';
  if (r.parts) return `still holds ${r.parts} part${r.parts === 1 ? '' : 's'}: move or remove the stock first`;
  if (r.kids) return `has ${r.kids} location${r.kids === 1 ? '' : 's'} inside: remove those first`;
  return null;
}

/** Remove an empty location: deleted if it was never used, otherwise archived so stock history keeps its meaning. */
export async function removeLocation(id: number): Promise<'deleted' | 'archived'> {
  const blocker = await removeBlocker(id);
  if (blocker) throw new Error(`Can’t remove: ${blocker}`);
  const used = await queryOne(`SELECT 1 FROM stock_txn WHERE location_id = ?1 UNION ALL SELECT 1 FROM location WHERE parent_id = ?1
     UNION ALL SELECT 1 FROM build WHERE output_location_id = ?1 UNION ALL SELECT 1 FROM build_line WHERE location_id = ?1 LIMIT 1`, [id]);
  const stmts: Statement[] = [{ sql: 'UPDATE part SET default_location_id = NULL WHERE default_location_id = ?', params: [id] }];
  stmts.push(used
    ? { sql: 'UPDATE location SET archived = 1 WHERE id = ?', params: [id] }
    : { sql: 'DELETE FROM location WHERE id = ?', params: [id] });
  await transaction(stmts);
  return used ? 'archived' : 'deleted';
}

async function restoreStatements(id: number): Promise<Statement[]> {
  const stmts: Statement[] = [];
  let cur: number | null = id;
  while (cur) {
    const loc: { parent_id: number | null } | undefined = await queryOne('SELECT parent_id FROM location WHERE id = ?', [cur]);
    stmts.push({ sql: 'UPDATE location SET archived = 0 WHERE id = ?', params: [cur] });
    cur = loc?.parent_id ?? null;
  }
  return stmts;
}

/** Bring back an archived location (and any archived locations above it). */
export async function restoreLocation(id: number): Promise<void> {
  await transaction(await restoreStatements(id));
}

/** Set the usual location of several parts. */
export async function setUsualLocation(partIds: number[], locationId: number | null): Promise<void> {
  if (!partIds.length) return;
  await execute(`UPDATE part SET default_location_id = ?, updated_at = datetime('now') WHERE id IN (${partIds.map(() => '?').join(',')})`,
    [locationId, ...partIds]);
}
