// One form for a whole part: its own fields, its manufacturer parts with their vendor parts, and (when new) opening stock.
// Used for New part, Edit, and New similar part (pre-filled from another part).
import { useEffect, useMemo, useState } from 'react';
import { listLocations } from '../lib/locations.ts';
import { suggestName } from '../lib/names.ts';
import {
  KINDS, KIND_LABEL, STATUS_LABEL, emptyPartFields, emptySourceDraft, emptyVendorDraft, savePart, sourcesOf,
  type PartDetail, type PartFields, type PartStatus, type SourceDraft, type VendorDraft,
} from '../lib/parts.ts';
import { getSetting, listCategories, listManufacturers, listPackages, listVendors, packageLabel, peekNextPn } from '../lib/reference.ts';
import { parseValue, unitForCategory } from '../lib/values.ts';
import { LocationPicker } from './LocationPicker.tsx';
import { MfrFields, VendorFields } from './SourceFields.tsx';
import { Field, Modal, Select, num, useAction, useLoad } from './ui.tsx';

const KIND_OPTIONS = KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }));
const STATUS_OPTIONS: Array<{ value: PartStatus; label: string }> = [
  { value: 'active', label: STATUS_LABEL.active },
  { value: 'obsolete', label: 'Obsolete (not for new designs)' },
  { value: 'archived', label: 'Archived (hidden from lists)' },
];

const newSource = (preferred: boolean): SourceDraft => ({ ...emptySourceDraft(), preferred, vendors: [emptyVendorDraft()] });

function fieldsOf(p: PartDetail): PartFields {
  return {
    name: p.name, description: p.description, category_id: p.category_id, kind: p.kind, value_text: p.value_text,
    tolerance_pct: p.tolerance_pct, package_id: p.package_id, default_location_id: p.default_location_id,
    preferred_vendor_id: p.preferred_vendor_id, standard_cost: p.standard_cost, unit: p.unit, notes: p.notes, status: p.status,
  };
}

export function PartEditor({ part, template, initialText, preset, onClose, onSaved }: {
  part?: PartDetail;            // editing this part
  template?: PartDetail;        // new part pre-filled from this one
  initialText?: string;         // a new part's description to start with
  preset?: Partial<PartFields>; // a new part's fields to start with (e.g. kind: 'assembly')
  onClose: () => void; onSaved: (id: number) => void;
}) {
  const act = useAction();
  const lists = useLoad(() => Promise.all([listCategories(), listPackages(), listLocations(), listVendors(), listManufacturers(), getSetting('base_currency')]), []);
  const [cats, pkgs, locs, vendors, mfrs, base] = lists.data ?? [[], [], [], [], [], 'USD'];
  const currency = base ?? 'USD';

  const [f, setF] = useState<PartFields>(() => {
    if (part) return fieldsOf(part);
    if (template) return { ...fieldsOf(template), name: null, value_text: null, standard_cost: null, notes: null, status: 'active' };
    return { ...emptyPartFields(), ...preset, description: initialText ?? preset?.description ?? '' };
  });
  const [sources, setSources] = useState<SourceDraft[]>(() => {
    if (part) return sourcesOf(part);
    if (template) {
      return sourcesOf(template).map((s) => ({ ...s, id: undefined, mpn: '', datasheet_url: '', lifecycle: 'active',
        vendors: s.vendors.map((v) => ({ ...v, id: undefined, sku: '', url: '', breaks: '', origBreaks: undefined })) }));
    }
    return preset?.kind === 'assembly' ? [] : [newSource(true)];
  });
  const [manualPn, setManualPn] = useState('');
  const [nextPn, setNextPn] = useState('');
  const [stockQty, setStockQty] = useState('');
  const [stockLoc, setStockLoc] = useState<number | null>(null);
  const [stockCost, setStockCost] = useState('');
  const isNew = !part;
  const set = <K extends keyof PartFields>(k: K, v: PartFields[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (isNew) peekNextPn().then((r) => setNextPn(r.pn), () => setNextPn(''));
  }, [isNew]);

  // The name the part gets if Name is left blank
  const suggestion = useMemo(() => {
    const cat = cats.find((c) => c.id === f.category_id)?.path ?? null;
    const v = parseValue(f.value_text, unitForCategory(cat));
    return suggestName({ category: cat, value_num: v?.num ?? null, tolerance_pct: f.tolerance_pct,
      package: pkgs.find((p) => p.id === f.package_id)?.name ?? null, description: f.description,
      mpn: (sources.find((s) => s.preferred) ?? sources[0])?.mpn || null });
  }, [cats, pkgs, f, sources]);

  // ---- source editing helpers
  const updSource = (i: number, patch: Partial<SourceDraft>) => setSources((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const updVendor = (i: number, k: number, patch: Partial<VendorDraft>) =>
    setSources((ss) => ss.map((s, j) => (j === i ? { ...s, vendors: s.vendors.map((v, m) => (m === k ? { ...v, ...patch } : v)) } : s)));
  const setPreferred = (i: number) => setSources((ss) => ss.map((s, j) => ({ ...s, preferred: j === i })));
  const removeSource = (i: number) => setSources((ss) => {
    const next = ss.filter((_, j) => j !== i);
    if (next.length && !next.some((s) => s.preferred)) next[0] = { ...next[0], preferred: true };
    return next;
  });

  const save = () => act(async () => {
    const fields = { ...f, name: f.name?.trim() || suggestion || null };
    const qty = num(stockQty);
    if (isNew && qty && !(stockLoc ?? f.default_location_id)) throw new Error('Choose where the opening stock is');
    const id = await savePart({
      partId: part?.id ?? null, manualPn: manualPn.trim() || null, fields,
      sources: sources.map((s) => ({ ...s, vendors: s.vendors.filter((v) => v.vendor_id || v.sku.trim()) })),
      initialStock: isNew && qty ? { qty, locationId: (stockLoc ?? f.default_location_id)!, unitCost: num(stockCost) } : null,
    });
    onSaved(id);
  }, part ? 'Saved' : 'Part created');

  const title = part ? `Edit ${part.pn}` : template ? `New part like ${template.pn}` : preset?.kind === 'assembly' ? 'New assembly' : 'New part';
  return (
    <Modal title={title} onClose={onClose} xwide sticky
      footer={<>
        <span className="muted small">Everything here is saved together.</span>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => void save()}>{part ? 'Save' : 'Create part'}</button>
      </>}>
      <h3 className="form-section">Part</h3>
      <div className="form-grid three">
        {isNew && (
          <>
            <Field label="PN" hint={nextPn ? `Leave blank for the next number: ${nextPn}` : 'Leave blank for the next number'}>
              <input value={manualPn} onChange={(e) => setManualPn(e.target.value)} placeholder={nextPn} className="mono" />
            </Field>
            <span /><span />
          </>
        )}
        <Field label="Name" hint={!f.name && suggestion ? `Leave blank for: ${suggestion}` : 'Generic number or short name, e.g. LM358, BAV70'}>
          <input value={f.name ?? ''} onChange={(e) => set('name', e.target.value || null)} placeholder={suggestion ?? ''} autoFocus={!template} />
        </Field>
        <Field label="Description" wide2>
          <input value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="Category" hint={cats.length ? undefined : 'Add categories from the Parts screen'}>
          <Select value={f.category_id} onChange={(v) => set('category_id', v)} empty="—" options={cats.map((c) => ({ value: c.id, label: c.path }))} />
        </Field>
        <Field label="Value" hint="e.g. 4K7, 100n, 2.2 µF, 12 MHz">
          <input value={f.value_text ?? ''} onChange={(e) => set('value_text', e.target.value || null)} autoFocus={!!template} />
        </Field>
        <Field label="Tolerance %">
          <input value={f.tolerance_pct ?? ''} onChange={(e) => set('tolerance_pct', num(e.target.value))} inputMode="decimal" />
        </Field>
        <Field label="Package">
          <Select value={f.package_id} onChange={(v) => set('package_id', v)} empty="—" options={pkgs.map((p) => ({ value: p.id, label: packageLabel(p) }))} />
        </Field>
        <Field label="Usual location" hint={locs.length ? undefined : 'Add locations on the Locations screen'}>
          <LocationPicker value={f.default_location_id} onChange={(v) => set('default_location_id', v)} locations={locs} allowEmpty emptyLabel="None" />
        </Field>
        <Field label="Kind"><Select value={f.kind} onChange={(v) => set('kind', v ?? 'component')} options={KIND_OPTIONS} /></Field>
        <Field label={`Standard cost (${currency})`}>
          <input value={f.standard_cost ?? ''} onChange={(e) => set('standard_cost', num(e.target.value))} inputMode="decimal" />
        </Field>
        <Field label="Unit" hint="each, m, g…"><input value={f.unit} onChange={(e) => set('unit', e.target.value)} /></Field>
        <Field label="Status"><Select value={f.status} onChange={(v) => set('status', v ?? 'active')} options={STATUS_OPTIONS} /></Field>
        <span />
        <Field label="Notes" wide3><textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} /></Field>
      </div>

      <h3 className="form-section">Manufacturer parts and where to buy them</h3>
      {sources.length === 0 && <p className="muted small">No manufacturer parts.</p>}
      {sources.map((s, i) => (
        <div key={i} className="source-card">
          <div className="source-head">
            <span className="small muted">Manufacturer part {sources.length > 1 ? i + 1 : ''}</span>
            <span className="spacer" />
            <button className="icon" title="Remove this manufacturer part and its vendor parts" onClick={() => removeSource(i)}>×</button>
          </div>
          <MfrFields s={s} onChange={(patch) => updSource(i, patch)} manufacturers={mfrs.map((m) => m.name)}
            preferred={<Field label="Preferred">
              <label className="check"><input type="radio" name="preferred-source" checked={s.preferred} onChange={() => setPreferred(i)} /> The usual one to buy</label>
            </Field>} />
          {s.vendors.map((v, k) => (
            <div key={k} className="vendor-card">
              <div className="source-head">
                <span className="small muted">Vendor part{s.vendors.length > 1 ? ` ${k + 1}` : ''}</span>
                <span className="spacer" />
                <button className="icon" title="Remove this vendor part" onClick={() => updSource(i, { vendors: s.vendors.filter((_, m) => m !== k) })}>×</button>
              </div>
              <VendorFields v={v} vendors={vendors} onChange={(patch) => updVendor(i, k, patch)} />
            </div>
          ))}
          <button className="link small" onClick={() => updSource(i, { vendors: [...s.vendors, emptyVendorDraft()] })}>+ Add a vendor part</button>
        </div>
      ))}
      <button className="link" onClick={() => setSources((ss) => [...ss, newSource(ss.length === 0)])}>+ Add a manufacturer part</button>

      {isNew && locs.length > 0 && (
        <>
          <h3 className="form-section">Opening stock <span className="muted small">(optional)</span></h3>
          <div className="form-grid three">
            <Field label="Quantity"><input value={stockQty} onChange={(e) => setStockQty(e.target.value)} inputMode="decimal" /></Field>
            <Field label="Location" hint={!stockLoc && f.default_location_id ? 'Defaults to the usual location' : undefined}>
              <LocationPicker value={stockLoc ?? f.default_location_id} onChange={setStockLoc} locations={locs} />
            </Field>
            <Field label={`Unit price (${currency})`}><input value={stockCost} onChange={(e) => setStockCost(e.target.value)} inputMode="decimal" /></Field>
          </div>
        </>
      )}
    </Modal>
  );
}
