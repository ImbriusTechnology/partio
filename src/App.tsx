// The app shell: a sidebar with the five screens, and the screen itself.
// Phase 1 only proves the plumbing (database, migrations, backups, shortcuts) on every platform;
// the screens are filled in by later phases.
import { useCallback, useEffect, useState } from 'react';
import { backupLibrary, libraryInfo, query, type LibraryInfo } from './lib/db';
import { isMac, modKey, shortcutLabel } from './lib/platform';

type View = 'parts' | 'locations' | 'assemblies' | 'purchasing' | 'settings';

const NAV: Array<{ view: View; label: string; phase: string }> = [
  { view: 'parts', label: 'Parts', phase: 'Parts, sources, categories and search arrive in phase 2.' },
  { view: 'locations', label: 'Locations', phase: 'Locations and stock arrive in phase 2.' },
  { view: 'assemblies', label: 'Assemblies', phase: 'BOMs and builds arrive in phase 5.' },
  { view: 'purchasing', label: 'Purchasing', phase: 'The shopping list and vendor lookups arrive in phase 5.' },
  { view: 'settings', label: 'Settings', phase: '' },
];

export default function App() {
  const [view, setView] = useState<View>('parts');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modKey(e)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault();
        setView(NAV[n - 1].view);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = NAV.find((n) => n.view === view)!;

  return (
    <div className="app">
      <nav className="sidebar">
        {isMac && <div className="titlebar-space" data-tauri-drag-region />}
        <div className="brand">Partio</div>
        {NAV.map((n, i) => (
          <button key={n.view} className={`nav ${view === n.view ? 'sel' : ''}`} onClick={() => setView(n.view)}
            title={`${n.label} (${shortcutLabel(String(i + 1))})`}>
            {n.label}
          </button>
        ))}
      </nav>
      <main className="pane">
        {isMac && <div className="titlebar-space" data-tauri-drag-region />}
        <h1>{current.label}</h1>
        {view === 'settings' ? <SettingsView /> : <p className="muted">{current.phase}</p>}
      </main>
    </div>
  );
}

interface Counts { packages: number; aliases: number; migrations: string }

function SettingsView() {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [message, setMessage] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setInfo(await libraryInfo());
      const [c] = await query<Counts>(
        `SELECT (SELECT COUNT(*) FROM package) AS packages,
                (SELECT COUNT(*) FROM package_alias) AS aliases,
                (SELECT group_concat(name, ', ') FROM (SELECT name FROM _migrations ORDER BY name)) AS migrations`);
      setCounts(c);
    } catch (e) {
      setMessage(`Couldn't read the library: ${String(e)}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const backUp = async () => {
    try {
      setMessage(`Backed up to ${await backupLibrary()}`);
    } catch (e) {
      setMessage(`Backup failed: ${String(e)}`);
    }
  };

  return (
    <div className="settings">
      <h2>Library</h2>
      <dl>
        <dt>Database</dt><dd><code>{info?.database ?? '…'}</code></dd>
        <dt>Backups</dt><dd><code>{info?.backupDir ?? '…'}</code></dd>
        <dt>Platform</dt><dd>{info?.platform ?? '…'}</dd>
        <dt>Schema</dt><dd>{counts?.migrations ?? '…'}</dd>
        <dt>Packages</dt><dd>{counts ? `${counts.packages} packages, ${counts.aliases} aliases` : '…'}</dd>
      </dl>
      <button onClick={() => void backUp()}>Back up now</button>
      {message && <p className="message">{message}</p>}
    </div>
  );
}
