# Partio CSV format (version 1)

Partio imports and exports its library as up to four CSV files. Use them to bring a parts list in from a spreadsheet or another tool, to move a library between computers, or as a readable backup. **Settings → Import and export** has blank templates with an example row in each.

| File | Holds | Needed? |
| --- | --- | --- |
| `locations.csv` | Storage locations | Optional |
| `parts.csv` | Parts, each with up to one manufacturer part and vendor part | The usual starting point |
| `stock.csv` | How many of each part are where | Optional |
| `sources.csv` | Further manufacturer parts and vendor parts, with price breaks | Optional |

Files are imported in that order, so a later file can refer to what an earlier one creates. Files refer to each other by things people can read (PNs, MPNs, location codes and paths), never by internal ids.

Within version 1, columns are only ever added. Renaming or removing one would make it version 2.

## General rules

- **Encoding:** UTF-8. The byte-order mark Excel adds when it saves "CSV UTF-8" is accepted, and exports include one so Excel shows µ, Ω and ± correctly.
- **Layout:** comma-separated, with a header row. Fields containing commas, quotes or line breaks are wrapped in double quotes, with `""` for a quote inside.
- **Columns:** header names are case-insensitive and can be in any order. Columns you don't need can be left out, except the required ones below.
- **Unknown columns** stop the import with a warning naming them. You can choose to ignore them and carry on, or cancel.
- **Blank cells** mean "not set". When updating something that already exists, a blank cell leaves its value alone.
- **Numbers** use `.` for decimals and no thousands separators: `1234.5`, not `1,234.5`.
- **Paths** separate levels with ` > `: `Cabinet A > Drawer 1 > Bin 01`, `Passive > Resistor`. Missing levels are created.
- **Names** of categories, packages, manufacturers and vendors are matched to what's already in the library, including other names (aliases), ignoring case. Names that don't match are created. The preview lists everything that will be created, so typos are easy to spot.
- **Currencies** are three-letter codes (USD, AUD, EUR). A blank currency means your base currency (Settings → Library).

## How an import runs

1. Choose one or more files. Partio works out which is which from the file name (`locations`, `parts`, `stock`, `sources`), then from the columns.
2. Choose what happens to rows for things that already exist:
   - **Add new only** skips them.
   - **Add and update** updates them with the cells that are filled in.
   - For `stock.csv`, choose **Add to stock** (quantities are added) or **Set stock to these counts** (quantities are counts, and stock is set to them).
3. **Check** runs the whole import and then undoes it, changing nothing. It shows, for each file, how many rows are new, updated or unchanged; what else will be created; and every error, by file and line.
4. **Import** is only possible when there are no errors. A backup is written first. Then everything is imported as one step: it all goes in, or none of it does.

Parts match existing parts by `pn`. A row with no `pn` matches by manufacturer and MPN; if there's no match, it becomes a new part with the next free 5-digit number.

## locations.csv

| Column | Required | Meaning |
| --- | --- | --- |
| `path` | yes | Full path, e.g. `Cabinet A > Drawer 1 > Bin 01`. Missing parents are created. |
| `code` | | Barcode code, e.g. `L0001`. Blank: the next free L-number. |
| `description` | | Free text. |

```csv
path,code,description
Cabinet A,,Grey steel cabinet
Cabinet A > Drawer 1,,
Cabinet A > Drawer 1 > Bin 01,L0101,0805 resistors
```

## parts.csv

| Column | Required | Meaning |
| --- | --- | --- |
| `pn` | | Your part number. Blank: the next free 5-digit number. |
| `name` | | Short name: a generic number (`LM358`) or a brief label. |
| `description` | for new parts | Full description. |
| `category` | | Category path, e.g. `Passive > Resistor`. |
| `kind` | | `component` (default), `pcb`, `assembly`, `mechanical` or `consumable`. |
| `value` | | As typed: `10k`, `4K7`, `100n`, `2.2uF`. Stored as a number too, so parts sort and search by value. |
| `tolerance_pct` | | Tolerance in percent: `1`, `5`, `0.1`. |
| `package` | | Package name or another name for it: `0805`, `2012M`, `SOT-23-3`, `SO-8`. |
| `unit` | | `each` (default), `m`, `g`… |
| `location` | | Usual location: its code (`L0001`) or path. |
| `standard_cost` | | Cost per unit. |
| `currency` | | Currency of `standard_cost`. Converted to the base currency using Partio's exchange rates. |
| `status` | | `active` (default), `obsolete` or `archived`. |
| `notes` | | Free text. |
| `manufacturer` | | Manufacturer of the part's first source. |
| `mpn` | | Manufacturer part number. Needs a `manufacturer`. |
| `datasheet_url` | | Link to the datasheet. |
| `vendor` | | A vendor that sells this MPN. New vendors are priced in the base currency. |
| `sku` | | The vendor's part number. Needs a `vendor`. |

```csv
pn,name,description,category,kind,value,tolerance_pct,package,unit,location,standard_cost,currency,status,notes,manufacturer,mpn,datasheet_url,vendor,sku
,,Resistor 10k 1% 0805,Passive > Resistor,component,10k,1,0805,each,L0101,,,active,,Yageo,AC0805FR-0710KL,,DigiKey,311-10.0KCRCT-ND
```

## stock.csv

| Column | Required | Meaning |
| --- | --- | --- |
| `pn` | `pn` or `mpn` | The part, by PN. |
| `mpn` | `pn` or `mpn` | Or the part by an MPN. |
| `location` | yes | Location code (`L0001`) or path. A new path is created; an unknown code is an error. |
| `qty` | yes | Quantity. |
| `unit_cost` | | Cost per unit. |
| `currency` | | Currency of `unit_cost`. |
| `note` | | Goes on the stock record. |

Every row becomes an entry in the stock history: an opening balance when adding, or a count when setting.

```csv
pn,mpn,location,qty,unit_cost,currency,note
,AC0805FR-0710KL,L0101,250,0.012,,Opening count
```

## sources.csv

One row per manufacturer part and vendor part. A manufacturer part sold by three vendors is three rows; one with no vendors is a single row with the vendor columns blank.

| Column | Required | Meaning |
| --- | --- | --- |
| `pn` | yes | The part these sources belong to. |
| `manufacturer` | yes | Manufacturer. |
| `mpn` | | Manufacturer part number. Blank: not known yet. |
| `datasheet_url` | | Link to the datasheet. |
| `lifecycle` | | `active` (default), `nrnd`, `obsolete` or `unknown`. |
| `preferred` | | `yes` to make this the part's usual manufacturer part. |
| `vendor` | | A vendor that sells it. A new vendor is priced in this row's `currency`, or the base currency if that's blank. |
| `sku` | | The vendor's part number. Needs a `vendor`. |
| `url` | | The vendor's product page. |
| `packaging` | | Cut tape, reel, bag… |
| `moq` | | Minimum order quantity. |
| `order_multiple` | | Order in multiples of this. |
| `currency` | | Currency of the prices. Blank: the vendor's currency. Exports always fill it in. |
| `price_breaks` | | Quantity:price pairs separated by semicolons: `1:0.10; 100:0.021`. |

An MPN, and a vendor's part number, can belong to only one part. A row that would give one to a second part is an error.

```csv
pn,manufacturer,mpn,datasheet_url,lifecycle,preferred,vendor,sku,url,packaging,moq,order_multiple,currency,price_breaks
00001,Vishay,CRCW080510K0FKEA,,active,no,Mouser,71-CRCW080510K0FKEA,,Cut tape,1,,,1:0.10; 100:0.021
```

## Exporting

**Settings → Import and export → Export library** writes all four files to a folder you choose. Importing them into an empty library gives the same parts, sources, locations and stock. Stock history, archived locations and merged duplicates aren't exported; use the backups for a complete copy.
