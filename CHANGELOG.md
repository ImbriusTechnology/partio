# Changelog

All notable changes to Partio Inventory are recorded here. Dates are in YYYY-MM-DD form.

## Unreleased

### Added
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
