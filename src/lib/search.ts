// The full-text search index (table part_fts): one row per part, covering its PN, name, description,
// manufacturer names and MPNs, vendor SKUs, value, package and category.
import { execute, query, queryOne, transaction } from './db.ts';
import { formatValue } from './values.ts';

/** Bump when what goes into the index changes; the app rebuilds it on start when the stored version differs. */
export const SEARCH_INDEX_VERSION = '1';

/** Free text → an FTS5 query: every word must match, as a prefix. */
export function ftsQuery(text: string): string | null {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : null;
}

// The value is indexed both as typed ('4K7') and formatted without spaces ('4.7kΩ'), so either finds it.
const INDEX_SELECT = `
  SELECT p.id, p.pn, COALESCE(p.name, ''), p.description,
    (SELECT group_concat(COALESCE(mf.name, '') || ' ' || COALESCE(mp.mpn, ''), ' ')
       FROM mfr_part mp JOIN manufacturer mf ON mf.id = mp.manufacturer_id WHERE mp.part_id = p.id),
    (SELECT group_concat(vp.sku, ' ') FROM vendor_part vp JOIN mfr_part mp ON mp.id = vp.mfr_part_id WHERE mp.part_id = p.id),
    COALESCE(p.value_text, ''), COALESCE(pk.name, ''), COALESCE(c.path, '')
  FROM part p LEFT JOIN package pk ON pk.id = p.package_id LEFT JOIN category c ON c.id = p.category_id`;

const formatted = (num: number | null, unit: string | null) => (num === null ? '' : formatValue(num, unit).replace(/\s+/g, ''));

/** Rebuild one part's search row. Call after any change to the part or its manufacturer or vendor parts. */
export async function reindexPart(partId: number): Promise<void> {
  const p = await queryOne<{ value_num: number | null; value_unit: string | null }>('SELECT value_num, value_unit FROM part WHERE id = ?', [partId]);
  await transaction([
    { sql: 'DELETE FROM part_fts WHERE part_id = ?', params: [partId] },
    { sql: `INSERT INTO part_fts (part_id, pn, name, description, mpns, skus, value_text, package, category) ${INDEX_SELECT} WHERE p.id = ?`, params: [partId] },
    { sql: "UPDATE part_fts SET value_text = trim(value_text || ' ' || ?) WHERE part_id = ?", params: [formatted(p?.value_num ?? null, p?.value_unit ?? null), partId] },
  ]);
}

/** Rebuild the whole index (after renaming a category or package, or a change to what's indexed). */
export async function rebuildSearchIndex(): Promise<void> {
  await transaction([
    { sql: 'DELETE FROM part_fts' },
    { sql: `INSERT INTO part_fts (part_id, pn, name, description, mpns, skus, value_text, package, category) ${INDEX_SELECT}` },
  ]);
  const valued = await query<{ id: number; value_num: number; value_unit: string | null }>(
    'SELECT id, value_num, value_unit FROM part WHERE value_num IS NOT NULL');
  if (valued.length) {
    await transaction(valued.map((r) => ({
      sql: "UPDATE part_fts SET value_text = trim(value_text || ' ' || ?) WHERE part_id = ?",
      params: [formatted(r.value_num, r.value_unit), r.id],
    })));
  }
  await execute("INSERT INTO setting (key, value) VALUES ('search_index_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [SEARCH_INDEX_VERSION]);
}

/** Rebuild the index if it was built by an older version of the app. */
export async function ensureSearchIndex(): Promise<void> {
  const v = await queryOne<{ value: string }>("SELECT value FROM setting WHERE key = 'search_index_version'");
  if (v?.value !== SEARCH_INDEX_VERSION) await rebuildSearchIndex();
}
