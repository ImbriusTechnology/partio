// The fields for a manufacturer part and a vendor part, used by the part editor.
import type { ReactNode } from 'react';
import type { Vendor } from '../lib/reference.ts';
import { Combo, Field, Select } from './ui.tsx';

export const LIFECYCLES = [
  { value: 'active', label: 'Active' }, { value: 'nrnd', label: 'Not recommended for new designs' },
  { value: 'obsolete', label: 'Obsolete' }, { value: 'unknown', label: 'Unknown' },
];

export interface MfrForm { manufacturer: string; mpn: string; description: string; datasheet_url: string; lifecycle: string; notes: string }
export interface VendorForm { vendor_id: number | null; sku: string; url: string; packaging: string; moq: string; currency: string; breaks: string; notes: string }

export const BREAKS_HINT = 'Quantity then unit price, as many as you like: “1 0.10, 10 0.08, 100 0.045”, or one per line';

export function MfrFields({ s, onChange, manufacturers, preferred, autoFocus }: {
  s: MfrForm; onChange: (patch: Partial<MfrForm>) => void; manufacturers: string[]; preferred?: ReactNode; autoFocus?: boolean;
}) {
  return (
    <div className="form-grid">
      <Field label="Manufacturer"><Combo value={s.manufacturer} onChange={(v) => onChange({ manufacturer: v })} options={manufacturers} autoFocus={autoFocus} /></Field>
      <Field label="MPN"><input value={s.mpn} onChange={(e) => onChange({ mpn: e.target.value })} className="mono" /></Field>
      <Field label="Lifecycle"><Select value={s.lifecycle} onChange={(v) => onChange({ lifecycle: v ?? 'active' })} options={LIFECYCLES} /></Field>
      {preferred ?? <span />}
      <Field label="Datasheet" wide><input value={s.datasheet_url} onChange={(e) => onChange({ datasheet_url: e.target.value })} placeholder="https://…" /></Field>
      <Field label="Description" wide><input value={s.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="The maker’s description, if it differs from the part’s" /></Field>
      <Field label="Notes" wide><input value={s.notes} onChange={(e) => onChange({ notes: e.target.value })} /></Field>
    </div>
  );
}

export function VendorFields({ v, onChange, vendors, autoFocus }: {
  v: VendorForm; onChange: (patch: Partial<VendorForm>) => void; vendors: Vendor[]; autoFocus?: boolean;
}) {
  const vendorCurrency = vendors.find((x) => x.id === v.vendor_id)?.currency ?? 'USD';
  const currencies = [...new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'CNY', 'JPY', ...vendors.map((x) => x.currency)])]
    .filter((c) => c && c !== vendorCurrency);
  return (
    <div className="form-grid">
      <Field label="Vendor" hint={vendors.length ? undefined : 'Add vendors in Settings first'}>
        <Select value={v.vendor_id} onChange={(x) => onChange({ vendor_id: x })} empty="Choose…" options={vendors.map((x) => ({ value: x.id, label: x.name }))} />
      </Field>
      <Field label="Vendor part number">
        <input value={v.sku} className="mono" autoFocus={autoFocus} onChange={(e) => onChange({ sku: e.target.value })} />
      </Field>
      <Field label="Packaging"><input value={v.packaging} onChange={(e) => onChange({ packaging: e.target.value })} placeholder="Cut tape, reel, bag" /></Field>
      <Field label="Minimum order"><input value={v.moq} onChange={(e) => onChange({ moq: e.target.value })} inputMode="numeric" /></Field>
      <Field label="Prices in">
        <Select value={v.currency || null} onChange={(x) => onChange({ currency: x ?? '' })} empty={`${vendorCurrency} (the vendor’s currency)`}
          options={currencies.map((c) => ({ value: c, label: c }))} />
      </Field>
      <span />
      <Field label="Price breaks" hint={BREAKS_HINT} wide>
        <textarea rows={2} value={v.breaks} onChange={(e) => onChange({ breaks: e.target.value })} className="mono" placeholder="1 0.10, 100 0.045" />
      </Field>
      <Field label="Product page" wide><input value={v.url} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://…" /></Field>
      <Field label="Notes" wide><input value={v.notes} onChange={(e) => onChange({ notes: e.target.value })} /></Field>
    </div>
  );
}
