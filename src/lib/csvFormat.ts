// The Partio CSV format, version 1: the columns of each file. The importer, the exporter and the templates all
// use these lists, and a test checks docs/csv-format.md describes every column, so they stay in step.
// Within version 1, columns are only ever added; renaming or removing one means version 2.

export const CSV_FORMAT_VERSION = 1;

export type FileKind = 'locations' | 'parts' | 'stock' | 'sources';

/** The order files are imported in: later files refer to things the earlier ones create. */
export const FILE_ORDER: FileKind[] = ['locations', 'parts', 'stock', 'sources'];

export const FILE_LABEL: Record<FileKind, string> = {
  locations: 'Locations', parts: 'Parts', stock: 'Stock', sources: 'Sources',
};

export interface Column { name: string; required?: boolean; help: string }

/** Columns per file. `oneOf` lists columns of which at least one is needed. */
export const COLUMNS: Record<FileKind, { columns: Column[]; oneOf?: string[] }> = {
  locations: {
    columns: [
      { name: 'path', required: true, help: 'Full path, levels separated by " > ", e.g. Cabinet A > Drawer 1 > Bin 01. Missing parents are created.' },
      { name: 'code', help: 'Barcode code, e.g. L0001. Blank: the next free L-number.' },
      { name: 'description', help: 'Free text.' },
    ],
  },
  parts: {
    columns: [
      { name: 'pn', help: 'Your part number. Blank: the next free 5-digit number.' },
      { name: 'name', help: 'Short name: a generic number (LM358) or a brief label.' },
      { name: 'description', required: true, help: 'Full description. Required for new parts.' },
      { name: 'category', help: 'Category path, e.g. Passive > Resistor. Missing categories are created.' },
      { name: 'kind', help: 'component (default), pcb, assembly, mechanical or consumable.' },
      { name: 'value', help: 'As typed: 10k, 4K7, 100n, 2.2uF.' },
      { name: 'tolerance_pct', help: 'Tolerance in percent: 1, 5, 0.1.' },
      { name: 'package', help: 'Package name or any other name for it, e.g. 0805, 2012M, SOT-23-3. New names are created.' },
      { name: 'unit', help: 'each (default), m, g…' },
      { name: 'location', help: 'Usual location: its code (L0001) or path. A new path is created.' },
      { name: 'standard_cost', help: 'Cost per unit.' },
      { name: 'currency', help: 'Currency of standard_cost. Blank: the base currency.' },
      { name: 'status', help: 'active (default), obsolete or archived.' },
      { name: 'notes', help: 'Free text.' },
      { name: 'manufacturer', help: 'Manufacturer of the part’s first source. New manufacturers are created.' },
      { name: 'mpn', help: 'Manufacturer part number. Needs a manufacturer.' },
      { name: 'datasheet_url', help: 'Link to the datasheet.' },
      { name: 'vendor', help: 'A vendor that sells this MPN. New vendors are created, priced in the base currency.' },
      { name: 'sku', help: 'The vendor’s part number. Needs a vendor.' },
    ],
  },
  stock: {
    columns: [
      { name: 'pn', help: 'The part, by PN.' },
      { name: 'mpn', help: 'Or the part by an MPN.' },
      { name: 'location', required: true, help: 'Location code (L0001) or path. A new path is created.' },
      { name: 'qty', required: true, help: 'Quantity.' },
      { name: 'unit_cost', help: 'Cost per unit.' },
      { name: 'currency', help: 'Currency of unit_cost. Blank: the base currency.' },
      { name: 'note', help: 'Goes on the stock record.' },
    ],
    oneOf: ['pn', 'mpn'],
  },
  sources: {
    columns: [
      { name: 'pn', required: true, help: 'The part these sources belong to.' },
      { name: 'manufacturer', required: true, help: 'Manufacturer. New manufacturers are created.' },
      { name: 'mpn', help: 'Manufacturer part number. Blank: not known yet.' },
      { name: 'datasheet_url', help: 'Link to the datasheet.' },
      { name: 'lifecycle', help: 'active (default), nrnd, obsolete or unknown.' },
      { name: 'preferred', help: 'yes to make this the part’s usual manufacturer part.' },
      { name: 'vendor', help: 'A vendor that sells it. A new vendor is priced in this row’s currency (or the base currency).' },
      { name: 'sku', help: 'The vendor’s part number. Needs a vendor.' },
      { name: 'url', help: 'The vendor’s product page.' },
      { name: 'packaging', help: 'Cut tape, reel, bag…' },
      { name: 'moq', help: 'Minimum order quantity.' },
      { name: 'order_multiple', help: 'Order in multiples of this.' },
      { name: 'currency', help: 'Currency of the prices. Blank: the vendor’s currency.' },
      { name: 'price_breaks', help: 'Quantity:price pairs, e.g. 1:0.10; 100:0.021.' },
    ],
  },
};

export const columnNames = (kind: FileKind) => COLUMNS[kind].columns.map((c) => c.name);

/** Example rows for the templates (also used by tests, so they must import cleanly). */
export const EXAMPLES: Record<FileKind, string[][]> = {
  locations: [
    ['Cabinet A', '', 'Grey steel cabinet'],
    ['Cabinet A > Drawer 1', '', ''],
    ['Cabinet A > Drawer 1 > Bin 01', 'L0101', '0805 resistors'],
  ],
  parts: [
    ['', '', 'Resistor 10k 1% 0805', 'Passive > Resistor', 'component', '10k', '1', '0805', 'each', 'L0101', '', '', 'active', '',
      'Yageo', 'AC0805FR-0710KL', '', 'DigiKey', '311-10.0KCRCT-ND'],
  ],
  stock: [
    ['', 'AC0805FR-0710KL', 'L0101', '250', '0.012', '', 'Opening count'],
  ],
  sources: [
    ['00001', 'Vishay', 'CRCW080510K0FKEA', '', 'active', 'no', 'Mouser', '71-CRCW080510K0FKEA', '', 'Cut tape', '1', '', '', '1:0.10; 100:0.021'],
  ],
};

/** Guess what a file holds from its name, then from its columns. */
export function guessKind(fileName: string, headers: string[]): FileKind | null {
  const n = fileName.toLowerCase();
  if (n.includes('location')) return 'locations';
  if (n.includes('stock')) return 'stock';
  if (n.includes('source')) return 'sources';
  if (n.includes('part')) return 'parts';
  const h = new Set(headers.map((x) => x.trim().toLowerCase()));
  if (h.has('path')) return 'locations';
  if (h.has('qty')) return 'stock';
  if (h.has('price_breaks') || (h.has('sku') && !h.has('description'))) return 'sources';
  if (h.has('description')) return 'parts';
  return null;
}
