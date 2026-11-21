# Changelog

All notable changes to Partio Inventory are recorded here. Dates are in YYYY-MM-DD form.

## Unreleased

### Added
- Project setup: Tauri 2 + React + TypeScript app shell with Parts, Locations, Assemblies, Purchasing and Settings screens.
- Library database in the system's app data folder, with schema migrations and a daily backup (newest 30 kept).
- Initial schema: parts, manufacturer and vendor parts, price breaks, categories, packages (with metric aliases), locations, stock ledger, BOMs, builds, shopping list, documents and search.
- API key storage in the system's secure storage (Keychain, Credential Manager, Secret Service).
- Schema tests, and CI that builds for macOS, Windows and Linux.
