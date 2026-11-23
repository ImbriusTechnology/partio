# Partio Inventory

An open-source desktop app for keeping track of electronic parts: what you have, where it's stored, how many, the assemblies they go into, and what to order next. It runs on macOS, Windows and Linux.

Partio is local-only. Your library is one SQLite file on your own computer: no account, no server, no telemetry. The only time it talks to the internet is when you turn on vendor lookups (DigiKey, Mouser, element14) with your own API keys.

> **Status:** early development (phase 1 of 7). The app builds and runs, but most screens are still empty. See [the roadmap](#roadmap).

## Installing

Download the installer for your platform from [Releases](https://github.com/ImbriusTechnology/partio/releases).

The builds are **not code-signed**, so your system will warn you the first time you open Partio:

- **macOS:** right-click (or Control-click) Partio in Applications and choose **Open**, then **Open** again. If that doesn't appear, open **System Settings → Privacy & Security** and click **Open Anyway** next to the message about Partio.
- **Windows:** when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** use the `.AppImage` (make it executable, then run it) or install the `.deb`. No extra step is needed.

You only need to do this once.

## Where your data lives

| Platform | Library folder |
| --- | --- |
| macOS | `~/Library/Application Support/io.github.imbriustechnology.partio/` |
| Windows | `%APPDATA%\io.github.imbriustechnology.partio\` |
| Linux | `~/.local/share/io.github.imbriustechnology.partio/` |

- `library.db` is the database. **Don't put the library folder in Dropbox, iCloud or OneDrive:** syncing a live database can corrupt it.
- `backups/` gets one backup a day, written when the app opens. The newest 30 are kept. Backups are ordinary SQLite files and are safe to sync. To restore one, quit Partio and copy it over `library.db`.

## Building from source

You need [Node.js](https://nodejs.org) 22.18 or later, [Rust](https://rustup.rs) (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
npm install
npx tauri icon app-icon.png   # first time only: makes the icon set from app-icon.png
npm run tauri dev             # run with live reload
npm run tauri build           # build an installer for this platform
```

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Run the app in development mode |
| `npm run tauri build` | Build an installer into `src-tauri/target/release/bundle/` |
| `npm run typecheck` | Check the TypeScript |
| `npm test` | Run the tests (Node's built-in test runner and SQLite) |

## Roadmap

1. **Project setup:** repo, schema, app shell, CI builds for all three platforms *(in progress)*
2. **Core inventory:** parts, manufacturer and vendor parts, categories, locations, stock, search, merging duplicates
3. **First run and demo library**
4. **CSV import and export** for locations, parts, stock and sources, with downloadable templates *(done early: see [the format](docs/csv-format.md))*
5. **Assemblies and purchasing:** BOMs (with `bom.csv` import), builds, shopping list, vendor lookups
6. **Labels on every platform:** QR labels for parts and locations
7. **Release 1.0**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and suggestions are welcome as GitHub issues.

## Licence

MIT. See [LICENSE](LICENSE).
