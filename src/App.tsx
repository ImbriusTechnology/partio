// The app shell: navigation, quick find, new part, and the screens.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { IconAssemblies, IconCart, IconLocations, IconParts, IconSearch, IconSettings } from './components/icons.tsx';
import { FirstRun } from './components/FirstRun.tsx';
import { LocationsView } from './components/LocationsView.tsx';
import { PartEditor } from './components/PartEditor.tsx';
import { PartsView } from './components/PartsView.tsx';
import { QuickFind } from './components/QuickFind.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { ToastHost, useLoad, useToast } from './components/ui.tsx';
import { queryOne } from './lib/db.ts';
import { findLocation } from './lib/locations.ts';
import { resolveCode } from './lib/parts.ts';
import { modKey, shortcutLabel } from './lib/platform.ts';
import { listenForScans, scanTarget } from './lib/scanner.ts';
import { ensureSearchIndex } from './lib/search.ts';
import { needsSetup } from './lib/setup.ts';

type View = 'parts' | 'locations' | 'assemblies' | 'purchasing' | 'settings';
const NAV: Array<{ view: View; label: string; Icon: typeof IconParts }> = [
  { view: 'parts', label: 'Parts', Icon: IconParts },
  { view: 'locations', label: 'Locations', Icon: IconLocations },
  { view: 'assemblies', label: 'Assemblies', Icon: IconAssemblies },
  { view: 'purchasing', label: 'Purchasing', Icon: IconCart },
  { view: 'settings', label: 'Settings', Icon: IconSettings },
];

export default function App() {
  return <ToastHost><Shell /></ToastHost>;
}

function Shell() {
  const [view, setView] = useState<View>('parts');
  const [partId, setPartId] = useState<number | null>(null);
  const [quick, setQuick] = useState(false);
  const [newPart, setNewPart] = useState<{ text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const changed = useCallback(() => setRefreshKey((k) => k + 1), []);
  const toast = useToast();
  const counts = useLoad(() => queryOne<{ parts: number }>("SELECT COUNT(*) AS parts FROM part WHERE status <> 'archived'"), [refreshKey]);
  const setup = useLoad(needsSetup, []);

  const openPart = useCallback((id: number | null) => { setPartId(id); setView('parts'); }, []);
  const [locFocus, setLocFocus] = useState<{ id: number; n: number } | null>(null);
  const openLocation = useCallback((id: number) => { setLocFocus((f) => ({ id, n: (f?.n ?? 0) + 1 })); setView('locations'); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modKey(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); setQuick(true); }
      else if (k === 'n') { e.preventDefault(); setNewPart({ text: '' }); }
      else if (/^[1-5]$/.test(k)) { e.preventDefault(); setView(NAV[Number(k) - 1].view); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A scanned label opens what it names: a part label holds the PN, a location label its code (L0042).
  useEffect(() => listenForScans({
    onScan: (code) => void (async () => {
      if (document.querySelector('.modal-backdrop')) return;   // a dialog is open: leave it alone
      const t = scanTarget(code);
      if (t.kind === 'location') {
        const loc = await findLocation(t.code);
        if (loc && !loc.archived) { openLocation(loc.id); return; }
        toast(`Scanned ${t.code}: no location with that code`, 'error');
        return;
      }
      for (const c of t.codes) {
        const hit = await resolveCode(c);
        if (hit) { openPart(hit.id); toast(`Scanned ${hit.pn}`); return; }
      }
      toast(`Scanned “${code}”: no part or location with that code`, 'error');
    })().catch((e) => toast(String(e?.message ?? e), 'error')),
  }), [openPart, openLocation, toast]);

  // A new version of the app may index search differently: rebuild once if so.
  useEffect(() => {
    ensureSearchIndex().then(changed, (e) => toast(`Search index rebuild failed: ${e?.message ?? e}`, 'error'));
  }, [changed, toast]);

  if (setup.data === undefined && !setup.error) return <div className="app" />;
  if (setup.data) return <FirstRun onDone={() => { setup.reload(); changed(); }} />;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="titlebar-space" data-tauri-drag-region />
        <button className="find" onClick={() => setQuick(true)}><IconSearch /> <span>Find a part</span> <kbd>{shortcutLabel('K')}</kbd></button>
        <div className="nav-group">
          {NAV.map(({ view: v, label, Icon }, i) => (
            <button key={v} className={`nav ${view === v ? 'sel' : ''}`} onClick={() => setView(v)} title={`${label} (${shortcutLabel(String(i + 1))})`}>
              <Icon /> <span>{label}</span>
            </button>
          ))}
        </div>
        <span className="spacer" data-tauri-drag-region />
        <div className="sidebar-foot">{counts.data ? `${counts.data.parts.toLocaleString()} parts` : ''}</div>
      </nav>
      <main className="content">
        <header className="window-bar" data-tauri-drag-region>
          <span className="window-title" data-tauri-drag-region>{NAV.find((n) => n.view === view)?.label}</span>
        </header>
        {/* All views stay mounted, so each keeps its place (selection, filters, scroll) when you switch away and back. */}
        <Pane on={view === 'parts'}>
          <PartsView selectedId={partId} onSelect={setPartId} onNewPart={() => setNewPart({ text: '' })} onOpenLocation={openLocation}
            refreshKey={refreshKey} onChanged={changed} />
        </Pane>
        <Pane on={view === 'locations'}><LocationsView onOpenPart={openPart} focus={locFocus} refreshKey={refreshKey} onChanged={changed} /></Pane>
        <Pane on={view === 'assemblies'}><ComingSoon what="BOMs and builds" when="phase 5" /></Pane>
        <Pane on={view === 'purchasing'}><ComingSoon what="The shopping list and vendor lookups" when="phase 5" /></Pane>
        <Pane on={view === 'settings'}><SettingsView refreshKey={refreshKey} onChanged={changed} /></Pane>
      </main>
      {quick && <QuickFind onClose={() => setQuick(false)} onOpenPart={openPart} onNewPart={(text) => setNewPart({ text })} />}
      {newPart && (
        <PartEditor initialText={newPart.text} onClose={() => setNewPart(null)}
          onSaved={(id) => { setNewPart(null); changed(); openPart(id); }} />
      )}
    </div>
  );
}

/** A view that stays laid out while hidden, so its scroll positions survive switching. */
function Pane({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={`view-pane ${on ? '' : 'off'}`} inert={!on}>{children}</div>;
}

function ComingSoon({ what, when }: { what: string; when: string }) {
  return <div className="coming-soon"><p className="muted">{what} arrive in {when}.</p></div>;
}
