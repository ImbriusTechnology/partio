# Changelog

All notable changes to Partio Inventory are recorded here. Dates are in YYYY-MM-DD form.

## Unreleased

### Added
- Assemblies screen: assemblies with their BOM revisions (draft, released, obsolete). Add, edit and delete lines; move designators to another part; resolve lines whose part wasn't found; copy a revision to change it; check stock for a build quantity.
- bom.csv, a fifth CSV file: import BOMs with the same preview as the other files (a line whose part isn't found is kept unresolved, as a warning), and BOMs are included in exports.
- Import BOM… on the Assemblies screen takes a simpler single-BOM file (line, pn and/or mpn, qty, designators, dnp, note) for the assembly on screen, imported as the revision chosen in the dialog. It has its own template.
- A not-fitted (DNP) line whose part isn't in the library isn't flagged: no import warning, and it doesn't count as unresolved.
- The demo blinky board has a released BOM.
- Builds: plan a build of an assembly from a draft or released BOM revision. The build keeps its own copy of the BOM (and says when the BOM has changed, with a refresh). Shortfalls count what earlier planned builds need first; a line can use a substitute part for one build. The pick list is sorted by location, with editable quantities, and can be copied or saved as CSV (a PDF comes with label printing). Completing a build takes the parts out of stock and puts the finished assemblies in, records what was used and the cost per unit in parts, and notes when it was built from a draft BOM. Building fewer than planned can plan the rest as a new build.
- Planned builds are listed on the Assemblies screen; an assembly's builds are shown on its BOM and on its part page. Stock history names each kind of entry in words.
- Single files (a pick list, the single-BOM template) are saved with the system's Save dialog, which starts in the folder last saved to. Exports and the set of templates still go into a new folder.
- Settings → Exchange rates: add, change and remove rates to your base currency.
- First-run screen: choose your currency (guessed from your system), add starter categories and vendors, then try the demo library, import your parts from CSV, or start empty.
- Demo library: 27 example parts (PNs from 90001) with locations, stock and suppliers. Settings can load it later or remove it; demo parts you've used since are kept.
- Changing the base currency clears exchange rates, which were relative to the old one.
- CSV import and export (format version 1, see docs/csv-format.md): locations, parts, stock and sources.
  Check shows exactly what an import will do, file by file and line by line, without changing anything;
  the import itself is all or nothing, with a backup first. Templates and a full library export are in Settings.
- Barcode scanning: scan a part label (PN, MPN or vendor part number) or a location label (L-code) with a USB or Bluetooth scanner to open it.
- Locations screen: a tree of storage locations with L-codes; add, rename, move inside another location, remove (archived if ever used) and restore; see what's held where, and move several parts at once.
- Stock on the part page: receive (with vendor, vendor part number, price and order number), move, count and remove, all recorded in the stock ledger. Receiving with a new vendor part number adds it to the part.
- Parts screen: category tree, searchable parts list (PN, name, description, MPN, SKU, value, package, category), inline name editing, and bulk archive, obsolete, recategorise and delete.
- Part editor: one form for a part with its manufacturer parts, vendor parts and price breaks; next 5-digit PN by default; suggested names for resistors, capacitors and semiconductors.
- Part page: details, stock, sources with a default vendor (★), where used, and history.
- Merging duplicates: stock moves across as ledger moves, sources and BOM lines follow, and the duplicate is archived; its PN still leads to the kept part.
- Quick find (⌘K / Ctrl+K): "10k 0603 1%" finds by value, package (including metric names) and tolerance.
- Settings: base currency, vendors, and packages with metric names and other aliases.
- Categories: add, rename, move and delete, with designator prefixes.
- Tests for parts, sources, search and merging, run against a real in-memory library.
- Project setup: Tauri 2 + React + TypeScript app shell with Parts, Locations, Assemblies, Purchasing and Settings screens.
- Library database in the system's app data folder, with schema migrations and a daily backup (newest 30 kept).
- Initial schema: parts, manufacturer and vendor parts, price breaks, categories, packages (with metric aliases), locations, stock ledger, BOMs, builds, shopping list, documents and search.
- API key storage in the system's secure storage (Keychain, Credential Manager, Secret Service).
- Schema tests, and CI that builds for macOS, Windows and Linux.
