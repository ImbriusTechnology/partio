# Contributing to Partio Inventory

Thanks for helping. This page covers how the code is laid out and the rules it keeps.

## Layout

| Path | Contents |
| --- | --- |
| `migrations/*.sql` | The database schema. Every change is a new numbered file, also listed in `src-tauri/src/db.rs` (a test checks the two lists match) |
| `src-tauri/src/db.rs` | Opens the library, applies migrations, runs SQL sent from TypeScript, writes backups |
| `src-tauri/src/secrets.rs` | API keys in the system's secure storage |
| `src/lib/db.ts` | `query`, `execute`, `transaction`: how TypeScript talks to the database |
| `src/lib/platform.ts` | Platform detection and keyboard shortcuts |
| `src/` | The interface (React + TypeScript) |
| `tests/` | Tests, run with `npm test` |

Application logic lives in TypeScript. Rust only does what a web page can't: files, the database, secure storage, printing, network requests that carry API keys.

## Rules the code keeps

- **Stock only changes by inserting into `stock_txn`.** A trigger keeps `stock` in step. Never update `stock` directly, and never edit or delete a `stock_txn` row: add a correcting one.
- **PNs are text.** `'00042'`, never `42`.
- **Costs are stored in the base currency** (setting `base_currency`). Vendor prices keep their own currency and convert through `fx_rate`.
- **Keep the search index current.** After changing a part, or its manufacturer or vendor parts, re-index that part.
- **Nothing platform-specific.** No calling `open`, `curl`, `lpr` or any other system tool. Use a Rust crate or a Tauri plugin that works on macOS, Windows and Linux.
- **Shortcuts go through `src/lib/platform.ts`**, so they're ⌘ on macOS and Ctrl elsewhere, and their labels match.
- **API keys never reach the page.** The page can store a key and ask whether one is stored; Rust adds keys to requests itself.
- **Demo rows carry `source = 'demo'`**, so "Remove demo data" can find them.

## Before you open a pull request

```sh
npm run typecheck
npm test
```

CI runs both, then builds for macOS, Windows and Linux. If you changed the interface, please say which platforms you tried it on.

## Schema changes

Add `migrations/NNN_what_it_does.sql` and list it in `MIGRATIONS` in `src-tauri/src/db.rs`. Never edit a migration that has been released: people's libraries have already applied it.
