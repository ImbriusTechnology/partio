// Exporting the library as Partio CSV files, and the blank templates. An export imports back into an empty
// library as the same parts, sources, locations and stock (tests/importexport.test.ts checks this).
import { query } from './db.ts';
import { COLUMNS, EXAMPLES, FILE_ORDER, columnNames, type FileKind } from './csvFormat.ts';
import { writeCsv } from './csv.ts';
import { getSetting } from './reference.ts';

export interface CsvFile { name: string; text: string }

const fileName = (kind: FileKind) => `${kind}.csv`;

/** One empty file per kind, with the header row and an example row. */
export function templates(): CsvFile[] {
  return FILE_ORDER.map((kind) => ({ name: fileName(kind), text: writeCsv(columnNames(kind), EXAMPLES[kind]) }));
}

/** Pick the columns of a row object in the order the format lists them. */
function rowsFor(kind: FileKind, objects: Array<Record<string, string | number | null>>): Array<Array<string | number | null>> {
  const cols = columnNames(kind);
  return objects.map((o) => cols.map((c) => o[c] ?? null));
}

const formatBreaks = (b: string | null) => b ?? '';

export async function exportLibrary(): Promise<CsvFile[]> {
  const base = (await getSetting('base_currency')) ?? 'USD';

  const locations = await query<Record<string, string | number | null>>(
    'SELECT path, code, description FROM location WHERE archived = 0 ORDER BY path');

  // Merged duplicates are left out: their stock and sources now belong to the part they went into.
  const parts = await query<Record<string, string | number | null>>(`
    SELECT p.pn, p.name, p.description, c.path AS category, p.kind, p.value_text AS value, p.tolerance_pct, pk.name AS package,
      p.unit, l.code AS location, p.standard_cost, CASE WHEN p.standard_cost IS NULL THEN NULL ELSE ? END AS currency, p.status, p.notes,
      mf.name AS manufacturer, m.mpn, m.datasheet_url, v.name AS vendor, vp.sku
    FROM part p
    LEFT JOIN category c ON c.id = p.category_id
    LEFT JOIN package pk ON pk.id = p.package_id
    LEFT JOIN location l ON l.id = p.default_location_id
    LEFT JOIN mfr_part m ON m.id = (SELECT id FROM mfr_part WHERE part_id = p.id ORDER BY preferred DESC, id LIMIT 1)
    LEFT JOIN manufacturer mf ON mf.id = m.manufacturer_id
    LEFT JOIN vendor_part vp ON vp.id = (SELECT id FROM vendor_part WHERE mfr_part_id = m.id ORDER BY preferred DESC, id LIMIT 1)
    LEFT JOIN vendor v ON v.id = vp.vendor_id
    WHERE p.merged_into_id IS NULL
    ORDER BY p.pn`, [base]);

  const stock = await query<Record<string, string | number | null>>(`
    SELECT p.pn, NULL AS mpn, l.code AS location, s.qty FROM stock s JOIN part p ON p.id = s.part_id JOIN location l ON l.id = s.location_id
    WHERE s.qty <> 0 ORDER BY p.pn, l.path`);

  // Every manufacturer part, once per vendor part (or once with no vendor).
  const sources = await query<Record<string, string | number | null>>(`
    SELECT p.pn, mf.name AS manufacturer, m.mpn, m.datasheet_url, m.lifecycle, CASE WHEN m.preferred THEN 'yes' ELSE 'no' END AS preferred,
      v.name AS vendor, vp.sku, vp.url, vp.packaging, vp.moq, vp.order_multiple,
      CASE WHEN vp.id IS NULL THEN NULL ELSE COALESCE(vp.currency, v.currency) END AS currency,
      (SELECT group_concat(qty || ':' || unit_price, '; ') FROM (SELECT qty, unit_price FROM price_break WHERE vendor_part_id = vp.id ORDER BY qty)) AS price_breaks
    FROM mfr_part m JOIN part p ON p.id = m.part_id JOIN manufacturer mf ON mf.id = m.manufacturer_id
    LEFT JOIN vendor_part vp ON vp.mfr_part_id = m.id LEFT JOIN vendor v ON v.id = vp.vendor_id
    WHERE p.merged_into_id IS NULL
    ORDER BY p.pn, m.preferred DESC, m.id, vp.preferred DESC, vp.id`);
  for (const s of sources) s.price_breaks = formatBreaks(s.price_breaks as string | null);

  const data: Record<FileKind, Array<Record<string, string | number | null>>> = { locations, parts, stock, sources };
  return FILE_ORDER.map((kind) => ({ name: fileName(kind), text: writeCsv(columnNames(kind), rowsFor(kind, data[kind])) }));
}

/** Column names and help, for showing the format in the app. */
export const formatSummary = () => FILE_ORDER.map((kind) => ({ kind, columns: COLUMNS[kind].columns }));
