// Settings: the library (where it is, backups, base currency), vendors, and packages.
import { useState } from 'react';
import { backupLibrary, libraryInfo, query } from '../lib/db.ts';
import {
  addPackage, addVendor, deletePackage, deleteRate, deleteVendor, getSetting, listPackages, listRates, listVendors, packageLabel,
  setPackageAliases, setRate, updatePackage, updateVendor, type PackageRow, type Rate, type Vendor,
} from '../lib/reference.ts';
import { demoFiles } from '../demo/index.ts';
import { DEMO, demoCounts, loadDemo, removeDemo, setBaseCurrency } from '../lib/setup.ts';
import { ImportExportSection } from './ImportExport.tsx';
import { ConfirmButton, Field, Modal, SearchInput, Select, useAction, useLoad, useToast } from './ui.tsx';

export function SettingsView({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  return (
    <div className="settings-view">
      <LibrarySection refreshKey={refreshKey} onChanged={onChanged} />
      <RatesSection refreshKey={refreshKey} onChanged={onChanged} />
      <ImportExportSection onChanged={onChanged} />
      <DemoSection refreshKey={refreshKey} onChanged={onChanged} />
      <VendorsSection refreshKey={refreshKey} onChanged={onChanged} />
      <PackagesSection refreshKey={refreshKey} onChanged={onChanged} />
    </div>
  );
}

// ------------------------------------------------------------------ library

/** A file path that may wrap after any slash (and only there), so a long path breaks between folders. */
function breakable(path: string | undefined) {
  if (!path) return '…';
  return path.split(/(?<=[/\\])/).map((seg, i) => <span key={i}>{seg}<wbr /></span>);
}

function LibrarySection({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const act = useAction();
  const info = useLoad(libraryInfo, [refreshKey]);
  const [tick, setTick] = useState(0);
  const base = useLoad(() => getSetting('base_currency'), [tick]);
  const schema = useLoad(() => query<{ name: string }>('SELECT name FROM _migrations ORDER BY name'), []);
  const [currency, setCurrency] = useState<string | null>(null);
  const shown = currency ?? base.data ?? '';
  return (
    <section className="card">
      <h3>Library</h3>
      <dl className="path-list">
        <dt>Database</dt><dd className="mono">{breakable(info.data?.database)}</dd>
        <dt>Backups</dt><dd className="mono">{breakable(info.data?.backupDir)}</dd>
        <dt>Schema</dt><dd>{schema.data?.map((m) => m.name.replace(/\.sql$/, '')).join(', ') ?? '…'}</dd>
      </dl>
      <p className="small muted">A backup is written the first time Partio opens each day; the newest 30 are kept.</p>
      <div className="row">
        <button onClick={() => void act(async () => { const path = await backupLibrary(); return path; }, 'Backed up')}>Back up now</button>
        <span className="spacer" />
        <Field label="Base currency" hint="Costs are stored in this currency. Changing it sets the other exchange rates to 0 until you enter them again; existing costs aren’t converted.">
          <div className="row">
            <input value={shown} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} style={{ width: 70 }} className="mono" />
            <button disabled={currency === null || currency === base.data}
              onClick={() => void act(async () => {
                await setBaseCurrency(shown);
                setCurrency(null);
                setTick((t) => t + 1);
                onChanged();   // the exchange rates below are relative to the base, so they reload too
              }, 'Base currency saved')}>Save</button>
          </div>
        </Field>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ exchange rates

function RatesSection({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const act = useAction();
  const [tick, setTick] = useState(0);
  const rates = useLoad(listRates, [refreshKey, tick]);
  const base = useLoad(async () => (await getSetting('base_currency')) ?? 'USD', [refreshKey, tick]);
  const [currency, setCurrency] = useState('');
  const [value, setValue] = useState('');
  const b = base.data ?? 'USD';
  const done = () => { setTick((t) => t + 1); onChanged(); };
  const add = () => act(async () => {
    await setRate(currency, Number(value));
    setCurrency('');
    setValue('');
    done();
  }, `${currency.toUpperCase()} rate saved`);
  return (
    <section className="card">
      <h3>Exchange rates</h3>
      <p className="small muted">How much one unit of each currency is worth in your base currency ({b}). Used to convert costs
        given in other currencies, for example in CSV imports. Rates aren’t updated automatically: check them now and then.</p>
      <table className="grid compact rates">
        <thead><tr><th>Currency</th><th>Rate</th><th>Updated</th><th /></tr></thead>
        <tbody>
          {(rates.data ?? []).map((r) => <RateRow key={`${r.currency}:${r.to_base}:${b}`} rate={r} base={b} onSaved={done} />)}
          <tr>
            <td><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} placeholder="EUR" className="mono" style={{ width: 70 }} /></td>
            <td>1 {currency || '…'} = <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="1.08" style={{ width: 90 }}
              onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} /> {b}</td>
            <td />
            <td className="row-actions"><button disabled={!currency || !value} onClick={() => void add()}>Add</button></td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function RateRow({ rate, base, onSaved }: { rate: Rate; base: string; onSaved: () => void }) {
  const act = useAction();
  const unset = rate.to_base <= 0;
  const [value, setValue] = useState(unset ? '' : String(rate.to_base));
  const isBase = rate.currency === base;
  const changed = value.trim() !== (unset ? '' : String(rate.to_base)) && value.trim() !== '';
  const save = () => act(async () => { await setRate(rate.currency, Number(value)); onSaved(); }, `${rate.currency} rate saved`);
  const inverse = rate.to_base > 0 ? Number((1 / rate.to_base).toPrecision(4)) : null;
  return (
    <tr className={unset && !isBase ? 'unset' : ''}>
      <td className="mono">{rate.currency}{isBase && <span className="muted small"> (base)</span>}</td>
      <td>
        {isBase ? <>1 {base} = 1 {base}</> : <>
          1 {rate.currency} = <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" style={{ width: 90 }}
            placeholder={unset ? 'not set' : ''} onKeyDown={(e) => { if (e.key === 'Enter' && changed) void save(); }} /> {base}
          {inverse !== null
            ? <span className="muted small"> · 1 {base} = {inverse} {rate.currency}</span>
            : <span className="warn-text small"> · not set: enter a rate</span>}
        </>}
      </td>
      <td className="small muted">{unset && !isBase ? '' : rate.updated_at?.slice(0, 10) ?? ''}</td>
      <td className="row-actions">
        {!isBase && changed && <button onClick={() => void save()}>Save</button>}
        {!isBase && !changed && <ConfirmButton className="link" label="Remove" confirmLabel="Remove?"
          onConfirm={() => void act(async () => { await deleteRate(rate.currency); onSaved(); }, `${rate.currency} rate removed`)} />}
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ demo library

function DemoSection({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const act = useAction();
  const toast = useToast();
  const counts = useLoad(demoCounts, [refreshKey]);
  const loaded = !!(counts.data && (counts.data.parts || counts.data.locations));
  return (
    <section className="card">
      <h3>Demo library</h3>
      {loaded ? (
        <>
          <p className="small">The demo library is loaded: {counts.data!.parts} parts and {counts.data!.locations} locations, marked “{DEMO}”.
            Removing it keeps any demo part you’ve used since (stock changes, BOMs, the shopping list) and any location still holding them; they become yours.</p>
          <ConfirmButton className="danger" label="Remove demo data" confirmLabel="Remove the demo library?"
            onConfirm={() => void act(async () => {
              const r = await removeDemo();
              onChanged();
              toast(`Removed ${r.removedParts} demo parts and ${r.removedLocations} locations${r.keptParts ? `; kept ${r.keptParts} parts you’ve used` : ''}`);
            })} />
        </>
      ) : (
        <>
          <p className="small muted">About 25 example parts, with locations, stock and suppliers, to try things out on. Their PNs start at 90001.</p>
          <button onClick={() => void act(async () => { await loadDemo(demoFiles()); onChanged(); }, 'Demo library loaded')}>Load the demo library</button>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ vendors

function VendorsSection({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const vendors = useLoad(() => listVendors(true), [refreshKey, tick]);
  const counts = useLoad(() => query<{ vendor_id: number; n: number }>('SELECT vendor_id, COUNT(*) AS n FROM vendor_part GROUP BY vendor_id'), [refreshKey, tick]);
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);
  const used = (id: number) => counts.data?.find((c) => c.vendor_id === id)?.n ?? 0;
  const done = () => { setEditing(null); setTick((t) => t + 1); onChanged(); };
  return (
    <section className="card">
      <div className="section-head">
        <h3>Vendors</h3>
        <div className="actions"><button onClick={() => setEditing('new')}>Add vendor</button></div>
      </div>
      {vendors.data?.length === 0 && <p className="muted small">No vendors yet. Add the distributors you buy from, such as DigiKey, Mouser or LCSC.</p>}
      {!!vendors.data?.length && (
        <table className="grid compact">
          <thead><tr><th>Name</th><th>Currency</th><th>Website</th><th className="num">Vendor parts</th><th /></tr></thead>
          <tbody>
            {vendors.data.map((v) => (
              <tr key={v.id} className={v.active ? '' : 'dim'}>
                <td>{v.name}{v.active ? '' : <span className="muted small"> (inactive)</span>}</td>
                <td className="mono">{v.currency}</td>
                <td className="small">{v.website ?? ''}</td>
                <td className="num">{used(v.id) || ''}</td>
                <td className="row-actions"><button className="link" onClick={() => setEditing(v)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <VendorDialog vendor={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={done} />}
    </section>
  );
}

function VendorDialog({ vendor, onClose, onDone }: { vendor: Vendor | null; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [name, setName] = useState(vendor?.name ?? '');
  const [currency, setCurrency] = useState(vendor?.currency ?? 'USD');
  const [website, setWebsite] = useState(vendor?.website ?? '');
  const [active, setActive] = useState(vendor ? !!vendor.active : true);
  const save = () => act(async () => {
    if (vendor) await updateVendor(vendor.id, { name, currency, website, active });
    else await addVendor(name, currency, website);
    onDone();
  }, vendor ? 'Vendor saved' : `${name.trim()} added`);
  return (
    <Modal title={vendor ? `Edit ${vendor.name}` : 'Add a vendor'} onClose={onClose}
      footer={<>
        {vendor && <ConfirmButton className="danger quiet" label="Delete" confirmLabel="Delete this vendor?"
          onConfirm={() => void act(async () => { await deleteVendor(vendor.id); onDone(); }, 'Vendor deleted')} />}
        <span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void save()}>Save</button>
      </>}>
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Currency" hint="The currency its prices are in"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} className="mono" /></Field>
        <Field label="Website" wide><input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" /></Field>
        {vendor && <Field label="Active"><label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Offered when adding vendor parts</label></Field>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ packages

function PackagesSection({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const pkgs = useLoad(listPackages, [refreshKey, tick]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<PackageRow | 'new' | null>(null);
  const done = () => { setEditing(null); setTick((t) => t + 1); onChanged(); };
  const f = filter.trim().toLowerCase();
  const rows = (pkgs.data ?? []).filter((p) => !f || [p.name, p.metric, p.aliases].some((x) => x?.toLowerCase().includes(f)));
  return (
    <section className="card">
      <div className="section-head">
        <h3>Packages <span className="muted">{pkgs.data?.length ?? ''}</span></h3>
        <div className="actions">
          <SearchInput value={filter} onChange={setFilter} placeholder="Filter" />
          <button onClick={() => setEditing('new')}>Add package</button>
        </div>
      </div>
      <p className="small muted">Chip sizes carry their metric name, so searching or importing “2012M” finds 0805.
        Other names (aliases) are matched too, ignoring case and punctuation.</p>
      <table className="grid compact">
        <thead><tr><th>Package</th><th>Mount</th><th>Other names</th><th className="num">Parts</th><th /></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{packageLabel(p)}</td>
              <td>{p.mount ?? ''}</td>
              <td className="small muted">{p.aliases ?? ''}</td>
              <td className="num">{p.parts || ''}</td>
              <td className="row-actions"><button className="link" onClick={() => setEditing(p)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <PackageDialog pkg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={done} />}
    </section>
  );
}

const MOUNTS = [{ value: 'SMD', label: 'Surface mount' }, { value: 'TH', label: 'Through hole' }, { value: 'other', label: 'Other' }];

function PackageDialog({ pkg, onClose, onDone }: { pkg: PackageRow | null; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [name, setName] = useState(pkg?.name ?? '');
  const [mount, setMount] = useState<string | null>(pkg?.mount ?? 'SMD');
  const [metric, setMetric] = useState(pkg?.metric ?? '');
  const [aliases, setAliases] = useState(pkg?.aliases ?? '');
  const save = () => act(async () => {
    const id = pkg ? (await updatePackage(pkg.id, name, mount), pkg.id) : await addPackage(name, mount);
    await setPackageAliases(id, metric, aliases.split(','));
    onDone();
  }, pkg ? 'Package saved' : `${name.trim()} added`);
  return (
    <Modal title={pkg ? `Edit ${pkg.name}` : 'Add a package'} onClose={onClose}
      footer={<>
        {pkg && <ConfirmButton className="danger quiet" label="Delete" confirmLabel={pkg.parts ? `Delete? ${pkg.parts} parts lose their package` : 'Delete this package?'}
          onConfirm={() => void act(async () => { await deletePackage(pkg.id); onDone(); }, 'Package deleted')} />}
        <span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void save()}>Save</button>
      </>}>
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Mount"><Select value={mount} onChange={setMount} empty="—" options={MOUNTS} /></Field>
        <Field label="Metric size" hint="For chip sizes, e.g. 2012 for 0805"><input value={metric} onChange={(e) => setMetric(e.target.value)} className="mono" /></Field>
        <span />
        <Field label="Other names" hint="Comma-separated, e.g. SO-8, SOIC8" wide><input value={aliases} onChange={(e) => setAliases(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
