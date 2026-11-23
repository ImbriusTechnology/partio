// Settings: the library (where it is, backups, base currency), vendors, and packages.
import { useState } from 'react';
import { backupLibrary, libraryInfo, query } from '../lib/db.ts';
import {
  addPackage, addVendor, deletePackage, deleteVendor, getSetting, listPackages, listVendors, packageLabel, setPackageAliases,
  setSetting, updatePackage, updateVendor, type PackageRow, type Vendor,
} from '../lib/reference.ts';
import { ConfirmButton, Field, Modal, SearchInput, Select, useAction, useLoad } from './ui.tsx';

export function SettingsView({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  return (
    <div className="settings-view">
      <LibrarySection refreshKey={refreshKey} />
      <VendorsSection refreshKey={refreshKey} onChanged={onChanged} />
      <PackagesSection refreshKey={refreshKey} onChanged={onChanged} />
    </div>
  );
}

// ------------------------------------------------------------------ library

function LibrarySection({ refreshKey }: { refreshKey: number }) {
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
      <dl className="facts">
        <div><dt>Database</dt><dd className="mono small">{info.data?.database ?? '…'}</dd></div>
        <div><dt>Backups</dt><dd className="mono small">{info.data?.backupDir ?? '…'}</dd></div>
        <div><dt>Schema</dt><dd className="small">{schema.data?.map((m) => m.name.replace(/\.sql$/, '')).join(', ') ?? '…'}</dd></div>
      </dl>
      <p className="small muted">A backup is written the first time Partio opens each day; the newest 30 are kept.</p>
      <div className="row">
        <button onClick={() => void act(async () => { const path = await backupLibrary(); return path; }, 'Backed up')}>Back up now</button>
        <span className="spacer" />
        <Field label="Base currency" hint="Costs are stored in this currency">
          <div className="row">
            <input value={shown} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} style={{ width: 70 }} className="mono" />
            <button disabled={currency === null || currency === base.data}
              onClick={() => void act(async () => {
                if (!/^[A-Z]{3}$/.test(shown)) throw new Error('Use a three-letter code such as USD or AUD');
                await setSetting('base_currency', shown);
                setCurrency(null);
                setTick((t) => t + 1);
              }, 'Base currency saved')}>Save</button>
          </div>
        </Field>
      </div>
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
