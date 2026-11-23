// The first-run screen: base currency, starter data, then start empty, load the demo, or import CSV files.
import { useState } from 'react';
import { demoFiles } from '../demo/index.ts';
import { libraryInfo } from '../lib/db.ts';
import { CURRENCIES, completeSetup, currencyForLocale, loadDemo } from '../lib/setup.ts';
import { ImportDialog } from './ImportExport.tsx';
import { Field, Select, useAction, useLoad } from './ui.tsx';

export function FirstRun({ onDone }: { onDone: () => void }) {
  const act = useAction();
  const info = useLoad(libraryInfo, []);
  const guessed = currencyForLocale(navigator.language);
  const [currency, setCurrency] = useState<string>(guessed);
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const options = [...new Set([guessed, ...CURRENCIES])].sort().map((c) => ({ value: c, label: c }));

  const go = (then: 'empty' | 'demo' | 'import') => act(async () => {
    setBusy(true);
    try {
      await completeSetup({ currency, starter });
      if (then === 'demo') await loadDemo(demoFiles());
      if (then === 'import') setImporting(true);
      else onDone();
    } finally {
      setBusy(false);
    }
  }, then === 'demo' ? 'Demo library loaded' : undefined);

  return (
    <div className="first-run" data-tauri-drag-region>
      <div className="first-run-card">
        <h1>Welcome to Partio Inventory</h1>
        <p className="muted">Partio keeps track of your electronic parts: what you have, where it is, and where to buy more.
          Your library stays on this computer.</p>

        <div className="form-grid">
          <Field label="Your currency" hint="Costs are kept in this currency. You can change it in Settings.">
            <Select value={currency} onChange={(v) => setCurrency(v ?? guessed)} options={options} />
          </Field>
          <Field label="Starter data">
            <label className="check"><input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
              Add common categories (resistors, capacitors, ICs…) and vendors (DigiKey, Mouser, element14, LCSC)</label>
          </Field>
        </div>

        <div className="first-run-choices">
          <button className="choice" disabled={busy} onClick={() => void go('demo')}>
            <b>Try the demo library</b>
            <span>About 25 example parts, with locations, stock and suppliers. Remove it in Settings when you’re done.</span>
          </button>
          <button className="choice" disabled={busy} onClick={() => void go('import')}>
            <b>Import my parts</b>
            <span>From CSV files: parts, and optionally locations, stock and sources. Templates are in Settings.</span>
          </button>
          <button className="choice" disabled={busy} onClick={() => void go('empty')}>
            <b>Start empty</b>
            <span>Add parts and locations yourself as you go.</span>
          </button>
        </div>
        <p className="small muted">Library: <span className="mono">{info.data?.database ?? '…'}</span></p>
      </div>
      {importing && <ImportDialog onClose={() => { setImporting(false); onDone(); }} onDone={() => { setImporting(false); onDone(); }} />}
    </div>
  );
}
