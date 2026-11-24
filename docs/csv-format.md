# Partio CSV format (version 1)

Partio imports and exports its library as up to five CSV files. Use them to bring a parts list in from a spreadsheet or another tool, to move a library between computers, or as a readable backup. **Settings → Import and export** has blank templates with an example row in each.

| File | Holds | Needed? |
| --- | --- | --- |
| `locations.csv` | Storage locations | Optional |
| `parts.csv` | Parts, each with up to one manufacturer part and vendor part | The usual starting point |
| `stock.csv` | How many of each part are where | Optional |
| `sources.csv` | Further manufacturer parts and vendor parts, with price breaks | Optional |
| `bom.csv` | Bills of materials: the lines of each assembly's BOM revisions | Optional |

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

1. Choose one or more files. Partio works out which is which from the file name (`locations`, `parts`, `stock`, `sources`, `bom`), then from the columns.
2. Choose what happens to rows for things that already exist:
   - **Add new only** skips them.
   - **Add and update** updates them with the cells that are filled in.
   - For `stock.csv`, choose **Add to stock** (quantities are added) or **Set stock to these counts** (quantities are counts, and stock is set to them).
3. **Check** runs the whole import and then undoes it, changing nothing. It shows, for each file, how many rows are new, updated or unchanged; what else will be created; every error, by file and line; and warnings, which don't stop the import (such as a BOM line whose part isn't found).
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

## bom.csv

There are two BOM formats:

- **Library `bom.csv`**: any number of assemblies and revisions in one file, with `assembly_pn` and `rev` on every row. It's what **Export library…** writes, and what **Settings → Import CSV files…** reads. Use it for moving a whole library.
- **Single BOM**: one assembly and revision per file, without the `assembly_pn`, `rev`, `status` and `project` columns. Import it with **Import BOM…** on the Assemblies screen (see below). The dialog has a **Download template…** button.

### Library bom.csv

One row per BOM line.

| Column | Required | Meaning |
| --- | --- | --- |
| `assembly_pn` | yes | PN of the assembly the BOM belongs to. It must already exist (add it in `parts.csv`, or on the Parts screen). A part of another kind becomes an assembly. |
| `rev` | yes | BOM revision, e.g. `A`. |
| `status` | | `draft` (default), `released` or `obsolete`. |
| `project` | | Your project reference, if any. |
| `line` | | Line number. Blank: the next one. |
| `pn` | `pn` or `mpn` | The part used, by PN. A short number like `42` is also tried as `00042`. |
| `mpn` | `pn` or `mpn` | Or the part by MPN. |
| `qty` | | Quantity per assembly. Blank: the number of designators. |
| `designators` | | Reference designators, separated by commas or spaces: `R1, R3, R9`. |
| `dnp` | | `yes` if the part is not fitted. |
| `note` | | Free text. |

- Each assembly and revision in the file becomes a new BOM revision. **A revision already in the library is never changed** by an import; its rows count as unchanged. To change a BOM, copy the revision on the Assemblies screen, or import it under a new revision letter.
- A line whose part isn't in the library yet doesn't stop the import. It's kept as an **unresolved** line, listed as a warning, and can be matched to a part later on the Assemblies screen. A revision with unresolved lines can't be released until they're matched.

```csv
assembly_pn,rev,status,project,line,pn,mpn,qty,designators,dnp,note
00100,A,draft,,1,,AC0805FR-0710KL,,"R1, R2, R3",,
00100,A,draft,,2,,AC0805FR-0710KL,1,R4,yes,Fit only for the 5 V version
```

## Exporting

**Settings → Import and export → Export library** writes all five files to a folder you choose. Importing them into an empty library gives the same parts, sources, locations and stock. Stock history, builds, archived locations, merged duplicates and BOM revisions with no lines aren't exported; use the backups for a complete copy.

### Single BOM (Assemblies → Import BOM…)

One row per BOM line, for one assembly and revision: the assembly is the one on screen, and the revision is chosen in the dialog (the next letter, by default). It comes in as a new **draft** revision; release it on the Assemblies screen. Importing as a revision the assembly already has is an error.

| Column | Required | Meaning |
| --- | --- | --- |
| `line` | | Line number. Blank: the next one. |
| `pn` | `pn` or `mpn` | The part used, by PN. A short number like `42` is also tried as `00042`. |
| `mpn` | `pn` or `mpn` | Or the part by MPN. |
| `qty` | | Quantity per assembly. Blank: the number of designators. |
| `designators` | | Reference designators, separated by commas or spaces. |
| `dnp` | | `yes` if the part is not fitted. |
| `note` | | Free text. |

A file with `assembly_pn` or `rev` columns is a library `bom.csv` and is refused here. Other columns are reported as unknown, and can be ignored.

BOMs exported from Altium, KiCad or Eagle can be imported by renaming their columns to match: usually `Designator` → `designators`, `Quantity` → `qty`, and your part-number column → `pn`.

```csv
line,pn,mpn,qty,designators,dnp,note
1,,AC0805FR-0710KL,,"R1, R2, R3",,
2,,AC0805FR-0710KL,1,R4,yes,Fit only for the 5 V version
```
