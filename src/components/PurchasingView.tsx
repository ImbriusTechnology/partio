// Purchasing: what to buy (grouped by vendor), what's on order (by vendor and order), and what has arrived.
import { useEffect, useMemo, useState } from 'react';
import { findPartForLine } from '../lib/bom.ts';
import { saveFile } from '../lib/db.ts';
import { listLocations } from '../lib/locations.ts';
import { getPart } from '../lib/parts.ts';
import {
  addToList, baseRates, cartCsv, cheaperQuantities, listShopping, markOrdered, orderText, receiveItem, removeItems, sourceOptions,
  stockByLocation, toBase, unitPrice, unorder, updateItem, type ShopItem, type ShopStatus, type SourceOption,
} from '../lib/purchasing.ts';
import { listVendors } from '../lib/reference.ts';
import { LocationPicker } from './LocationPicker.tsx';
import { ConfirmButton, Field, Modal, Select, copyText, fmtMoney, fmtQty, num, useAction, useLoad, useToast } from './ui.tsx';

type Tab = 'open' | 'ordered' | 'received';
const itemTitle = (i: ShopItem) => (i.part_id ? [i.name, i.part_description].filter(Boolean).join(' — ') : i.description ?? '');
const shortDate = (at: string | null) => (at ? new Date(`${at.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** "AUD 12.40 + USD 3.10 · ≈ AUD 17.10": totals per currency, and in the base currency when they differ. */
function Totals({ items, rates }: { items: ShopItem[]; rates: Awaited<ReturnType<typeof baseRates>> | undefined }) {
  const per = new Map<string, number>();
  let base = 0, unpriced = 0, unconverted = 0;
  for (const i of items) {
    if (i.unit_price == null) { unpriced++; continue; }
    const cur = i.currency ?? rates?.base ?? '';
    per.set(cur, (per.get(cur) ?? 0) + i.unit_price * i.qty);
    const b = rates ? toBase(i.unit_price * i.qty, cur, rates) : null;
    if (b == null) unconverted++; else base += b;
  }
  if (!per.size) return unpriced ? <span className="muted small">not priced</span> : null;
  const parts = [...per].map(([c, t]) => fmtMoney(t, c));
  const showBase = rates && (per.size > 1 || !per.has(rates.base));
  return (
    <span className="small">
      {parts.join(' + ')}
      {showBase && <span className="muted">{unconverted ? ' · set exchange rates to see the total in ' + rates.base : ` · ≈ ${fmtMoney(base, rates.base)}`}</span>}
      {unpriced > 0 && <span className="muted"> · {unpriced} not priced</span>}
    </span>
  );
}

export function PurchasingView({ onOpenPart, refreshKey, onChanged }: { onOpenPart: (id: number) => void; refreshKey: number; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('open');
  const [adding, setAdding] = useState(false);
  const open = useLoad(() => listShopping('open'), [refreshKey]);
  const ordered = useLoad(() => listShopping('ordered'), [refreshKey]);
  const label = (t: Tab, s: string) => {
    const n = t === 'open' ? open.data?.length : t === 'ordered' ? ordered.data?.length : 0;
    return `${s}${n ? ` (${n})` : ''}`;
  };
  return (
    <div className="main-pane purchasing">
      <div className="toolbar">
        <div className="tabs">
          {([['open', 'To buy'], ['ordered', 'On order'], ['received', 'Received']] as const).map(([t, s]) => (
            <button key={t} className={tab === t ? 'tab sel' : 'tab'} onClick={() => setTab(t)}>{label(t, s)}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="primary" onClick={() => setAdding(true)}>+ Add item</button>
      </div>
      <div className="purchasing-body">
        {tab === 'received'
          ? <ReceivedList refreshKey={refreshKey} onOpenPart={onOpenPart} />
          : <VendorGroups status={tab} items={(tab === 'open' ? open : ordered).data} onOpenPart={onOpenPart} onChanged={onChanged} />}
      </div>
      {adding && <ItemDialog onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setTab('open'); onChanged(); }} />}
    </div>
  );
}

function VendorGroups({ status, items, onOpenPart, onChanged }: { status: ShopStatus; items: ShopItem[] | undefined; onOpenPart: (id: number) => void; onChanged: () => void }) {
  const act = useAction();
  const toast = useToast();
  const rates = useLoad(baseRates, [items]);
  const hints = useLoad(() => (status === 'open' && items ? cheaperQuantities(items) : Promise.resolve(new Map())), [items, status]);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<ShopItem | null>(null);
  const [ordering, setOrdering] = useState<ShopItem[] | null>(null);
  const [receiving, setReceiving] = useState<ShopItem[] | null>(null);
  useEffect(() => { setTicked(new Set()); }, [status]);

  // To buy: one group per vendor. On order: one group per vendor and order.
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; vendor: string; connector: string | null; orderRef: string | null; orderedAt: string | null; items: ShopItem[] }>();
    for (const i of items ?? []) {
      const key = status === 'ordered' ? `${i.vendor_id ?? 0}|${i.order_ref ?? ''}` : `${i.vendor_id ?? 0}`;
      if (!m.has(key)) m.set(key, { key, vendor: i.vendor ?? 'No vendor chosen', connector: i.connector, orderRef: i.order_ref, orderedAt: i.ordered_at, items: [] });
      m.get(key)!.items.push(i);
    }
    return [...m.values()];
  }, [items, status]);

  const toggle = (id: number) => setTicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = (g: { items: ShopItem[] }) => { const t = g.items.filter((i) => ticked.has(i.id)); return t.length ? t : g.items; };
  const done = () => { setTicked(new Set()); onChanged(); };

  if (items && !items.length) {
    return <p className="empty">{status === 'open'
      ? 'Nothing to buy. Add items with + Add item, from a part’s page, or from a build’s shortages.'
      : 'Nothing on order.'}</p>;
  }
  return (
    <>
      {groups.map((g) => {
        const sel = chosen(g);
        const someTicked = g.items.some((i) => ticked.has(i.id));
        const which = someTicked ? `${sel.length} ticked ` : '';
        const noSku = sel.filter((i) => !i.sku).length;
        return (
          <section key={g.key} className="card vendor-group">
            <div className="section-head">
              <h3>{g.vendor}{g.orderRef ? ` · ${g.orderRef}` : ''}</h3>
              <span className="muted small">
                {g.items.length} item{g.items.length === 1 ? '' : 's'} · <Totals items={g.items} rates={rates.data} />
                {status === 'ordered' && g.orderedAt ? ` · ordered ${shortDate(g.orderedAt)}` : ''}
              </span>
              <span className="spacer" />
              <button className="link" title="Quantity, their part number and our PN, one item per line, for a vendor’s quick-add box"
                onClick={() => void act(async () => { await copyText(orderText(sel)); toast(`Copied ${which || 'the list'}`.trim()); })}>Copy list</button>
              <button className="link" title="Their part number, quantity and our PN as a CSV file, for a vendor’s cart or BOM upload"
                onClick={() => void act(async () => {
                  const where = await saveFile(`Save the cart for ${g.vendor}`, { name: `Cart ${g.vendor} ${new Date().toISOString().slice(0, 10)}.csv`.replace(/[/\\:]/g, '-'), text: cartCsv(sel) });
                  if (where) toast(`Saved ${where}${noSku ? `. ${noSku} item${noSku === 1 ? ' has' : 's have'} no vendor part number.` : ''}`);
                })}>Save cart CSV…</button>
              {status === 'open' && <button onClick={() => setReceiving(sel)} title="Bought over the counter: book it in straight away">Received…</button>}
              {status === 'open' && <button className="primary" onClick={() => setOrdering(sel)}>Mark {which}ordered…</button>}
              {status === 'ordered' && <button className="link" onClick={() => void act(async () => { await unorder(sel.map((i) => i.id)); done(); }, 'Moved back to To buy')}>Not ordered</button>}
              {status === 'ordered' && <button className="primary" onClick={() => setReceiving(sel)}>Receive {which}…</button>}
            </div>
            <table className="grid shop-grid">
              <colgroup><col style={{ width: 34 }} /><col style={{ width: 62 }} /><col /><col style={{ width: 150 }} /><col style={{ width: 70 }} /><col style={{ width: 96 }} /><col style={{ width: 100 }} /><col style={{ width: 76 }} /><col style={{ width: 50 }} /></colgroup>
              <thead><tr><th /><th>PN</th><th>Item</th><th>Vendor part no.</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th><th className="num">In stock</th><th /></tr></thead>
              <tbody>
                {g.items.map((i) => {
                  const hint = hints.data?.get(i.id);
                  return (
                    <tr key={i.id} className={ticked.has(i.id) ? 'sel' : ''}>
                      <td><input type="checkbox" checked={ticked.has(i.id)} onChange={() => toggle(i.id)} /></td>
                      <td className="mono">{i.part_id ? <button className="link mono" onClick={() => onOpenPart(i.part_id!)}>{i.pn}</button> : <span className="muted small">other</span>}</td>
                      <td className="clip" title={[itemTitle(i), i.reason, i.note].filter(Boolean).join(' · ')}>
                        {itemTitle(i)}
                        {(i.reason && i.reason !== 'manual') || i.note ? <span className="muted small"> · {[i.reason !== 'manual' ? i.reason : null, i.note].filter(Boolean).join(' · ')}</span> : null}
                        {hint && (
                          <div className="small ok">
                            {fmtQty(hint.qty)} cost {fmtMoney(hint.total, i.currency ?? '')}, {hint.total < (i.unit_price ?? 0) * i.qty ? 'less than' : 'about the same as'} {fmtQty(i.qty)}.{' '}
                            <button className="link" onClick={() => void act(async () => {
                              await updateItem(i.id, { qty: hint.qty, vendor_id: i.vendor_id, sku: i.sku, unit_price: hint.unit, note: i.note });
                              onChanged();
                            }, `Buying ${fmtQty(hint.qty)}`)}>Buy {fmtQty(hint.qty)}</button>
                          </div>
                        )}
                      </td>
                      <td className="mono clip">{i.sku ?? <span className="muted">—</span>}</td>
                      <td className="num">{fmtQty(i.qty)}</td>
                      <td className="num">{i.unit_price != null ? fmtMoney(i.unit_price, i.currency ?? '') : ''}</td>
                      <td className="num">{i.unit_price != null ? fmtMoney(i.unit_price * i.qty, i.currency ?? '') : ''}</td>
                      <td className="num muted">{i.on_hand != null ? fmtQty(i.on_hand) : ''}</td>
                      <td className="row-actions"><button className="link" onClick={() => setEditing(i)}>Edit</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
      {editing && (
        <ItemDialog item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }}
          onRemove={() => void act(async () => { await removeItems([editing.id]); setEditing(null); done(); }, editing.status === 'open' ? 'Removed' : 'Cancelled')} />
      )}
      {ordering && (
        <OrderDialog items={ordering} onClose={() => setOrdering(null)}
          onSave={(ref) => void act(async () => { await markOrdered(ordering.map((i) => i.id), ref); setOrdering(null); done(); }, `${ordering.length} item${ordering.length === 1 ? '' : 's'} on order`)} />
      )}
      {receiving && <ReceiveDialog items={receiving} onClose={() => setReceiving(null)} onDone={() => { setReceiving(null); done(); }} />}
    </>
  );
}

function OrderDialog({ items, onClose, onSave }: { items: ShopItem[]; onClose: () => void; onSave: (ref: string | null) => void }) {
  const [ref, setRef] = useState('');
  return (
    <Modal title={`Mark ${items.length} item${items.length === 1 ? '' : 's'} ordered from ${items[0]?.vendor ?? 'no vendor'}`} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(ref || null)}>Mark ordered</button></>}>
      <Field label="Order number" hint="Optional. It's kept with the stock when it arrives" wide>
        <input value={ref} autoFocus onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSave(ref || null); }} />
      </Field>
    </Modal>
  );
}

/** Receive several items: how many arrived, what they cost, and where each part goes. */
function ReceiveDialog({ items, onClose, onDone }: { items: ShopItem[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const toast = useToast();
  const locs = useLoad(() => listLocations(), []);
  const [rows, setRows] = useState(() => items.map((i) => ({
    item: i, qty: String(i.qty), price: i.unit_price != null ? String(i.unit_price) : '', loc: i.receive_location_id as number | null,
  })));
  const notesFor = useLoad(async () => {
    const m = new Map<number, Map<number, string>>();
    for (const r of await stockByLocation(items.flatMap((i) => (i.part_id ? [i.part_id] : [])))) {
      if (!m.has(r.part_id)) m.set(r.part_id, new Map());
      m.get(r.part_id)!.set(r.location_id, `has ${fmtQty(r.qty)}${r.usual ? ' · usual' : ''}`);
    }
    for (const i of items) if (i.part_id && i.default_location_id && !m.get(i.part_id)?.has(i.default_location_id)) {
      if (!m.has(i.part_id)) m.set(i.part_id, new Map());
      m.get(i.part_id)!.set(i.default_location_id, 'usual');
    }
    return m;
  }, [items]);
  const set = (k: number, patch: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, i) => (i === k ? { ...x, ...patch } : x)));
  const missing = rows.filter((r) => r.item.part_id && (num(r.qty) ?? 0) > 0 && !r.loc);
  const save = () => act(async () => {
    let partial = 0, got = 0;
    for (const r of rows) {
      const q = num(r.qty) ?? 0;
      if (q <= 0) continue;
      const res = await receiveItem(r.item.id, { qty: q, locationId: r.loc, unitPrice: r.price.trim() ? num(r.price) : null });
      if (res.addedVendorPart) toast(`${r.item.sku} added to ${r.item.pn}’s sources`);
      if (res.rest > 0) partial++;
      got++;
    }
    toast(got ? `Received ${got} item${got === 1 ? '' : 's'}${partial ? `; ${partial} still partly on order` : ''}` : 'Nothing received');
    onDone();
  });
  return (
    <Modal title={`Receive from ${items[0]?.vendor ?? 'no vendor'}${items[0]?.order_ref ? ` · ${items[0].order_ref}` : ''}`} onClose={onClose} xwide sticky
      footer={<>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={missing.length > 0} title={missing.length ? 'Choose a location for every part' : undefined} onClick={() => void save()}>Receive</button>
      </>}>
      <table className="grid">
        <thead><tr><th style={{ width: 62 }}>PN</th><th>Item</th><th className="num" style={{ width: 70 }}>Ordered</th><th className="num" style={{ width: 84 }}>Arrived</th>
          <th className="num" style={{ width: 110 }}>Unit price</th><th style={{ width: 280 }}>Put in</th></tr></thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={r.item.id}>
              <td className="mono">{r.item.pn ?? <span className="muted small">other</span>}</td>
              <td className="clip">{itemTitle(r.item)}</td>
              <td className="num">{fmtQty(r.item.qty)}</td>
              <td className="num"><input className="qty-input" value={r.qty} inputMode="decimal" onChange={(e) => set(k, { qty: e.target.value })} /></td>
              <td className="num"><input className="qty-input" style={{ width: 80 }} value={r.price} inputMode="decimal" onChange={(e) => set(k, { price: e.target.value })} />
                <span className="muted small"> {r.item.currency ?? ''}</span></td>
              <td>{r.item.part_id
                ? <LocationPicker value={r.loc} onChange={(v) => set(k, { loc: v })} locations={locs.data ?? []} notes={notesFor.data?.get(r.item.part_id)} />
                : <span className="muted small">Not stocked</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Set Arrived to 0 for anything that hasn’t come yet; anything short stays on order. The price paid is kept with the stock, in your base currency.</p>
    </Modal>
  );
}

function ReceivedList({ refreshKey, onOpenPart }: { refreshKey: number; onOpenPart: (id: number) => void }) {
  const items = useLoad(() => listShopping('received'), [refreshKey]);
  if (items.data && !items.data.length) return <p className="empty">Nothing received yet.</p>;
  return (
    <section className="card">
      <table className="grid shop-grid">
        <thead><tr><th style={{ width: 110 }}>Received</th><th style={{ width: 140 }}>Vendor</th><th style={{ width: 110 }}>Order</th><th style={{ width: 62 }}>PN</th><th>Item</th><th className="num" style={{ width: 70 }}>Qty</th><th className="num" style={{ width: 96 }}>Unit</th></tr></thead>
        <tbody>
          {(items.data ?? []).map((i) => (
            <tr key={i.id}>
              <td>{shortDate(i.received_at)}</td>
              <td className="clip">{i.vendor ?? ''}</td>
              <td className="clip mono">{i.order_ref ?? ''}</td>
              <td className="mono">{i.part_id ? <button className="link mono" onClick={() => onOpenPart(i.part_id!)}>{i.pn}</button> : ''}</td>
              <td className="clip">{itemTitle(i)}</td>
              <td className="num">{fmtQty(i.qty)}</td>
              <td className="num">{i.unit_price != null ? fmtMoney(i.unit_price, i.currency ?? '') : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ------------------------------------------------------------------ adding and editing items

/**
 * Add an item (a stocked part or anything else), or change one on the list. For a part, every vendor that has
 * a part number for it is listed, priced for the quantity, so you can choose where to buy it.
 */
export function ItemDialog({ item, partId: presetPart, qty: presetQty, onClose, onSaved, onRemove }: {
  item?: ShopItem; partId?: number; qty?: number; onClose: () => void; onSaved: () => void; onRemove?: () => void;
}) {
  const act = useAction();
  const vendors = useLoad(() => listVendors(), []);
  const [kind, setKind] = useState<'part' | 'other'>(item && !item.part_id ? 'other' : 'part');
  const [pnText, setPnText] = useState(item?.pn ?? '');
  const [part, setPart] = useState<{ id: number; pn: string; title: string } | null>(item?.part_id ? { id: item.part_id, pn: item.pn ?? '', title: itemTitle(item) } : null);
  const [description, setDescription] = useState(item?.description ?? '');
  const [qty, setQty] = useState(String(item?.qty ?? presetQty ?? 1));
  const [choice, setChoice] = useState<number | 'other' | null>(item ? (item.vendor_part_id ?? 'other') : null);   // a vendor part, or another vendor
  const [vendorId, setVendorId] = useState<number | null>(item?.vendor_id ?? null);
  const [sku, setSku] = useState(item?.sku ?? '');
  const [price, setPrice] = useState(item?.unit_price != null ? String(item.unit_price) : '');
  const [priceEdited, setPriceEdited] = useState(!!item);
  const [note, setNote] = useState(item?.note ?? '');
  const [orderRef, setOrderRef] = useState(item?.order_ref ?? '');
  const n = num(qty) ?? 0;
  const options = useLoad(() => (part && kind === 'part' ? sourceOptions(part.id, n > 0 ? n : 1) : Promise.resolve([] as SourceOption[])), [part?.id, kind, n]);
  const rates = useLoad(baseRates, []);
  const opt = typeof choice === 'number' ? options.data?.find((o) => o.vendor_part_id === choice) : undefined;
  const currency = opt?.currency ?? vendors.data?.find((v) => v.id === vendorId)?.currency ?? item?.currency ?? rates.data?.base ?? '';

  // A new part starts with the best source; a chosen source's price follows the quantity until the price is typed.
  useEffect(() => {
    if (!options.data || item) return;
    if (choice === null) setChoice(options.data[0]?.vendor_part_id ?? 'other');
  }, [options.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!opt || priceEdited) return;
    const u = unitPrice(opt.breaks, n);
    setPrice(u != null ? String(u) : '');
  }, [opt?.vendor_part_id, n, priceEdited]);   // eslint-disable-line react-hooks/exhaustive-deps

  const choosePart = (code: string) => act(async () => {
    const c = code.trim();
    if (!c) { setPart(null); return; }
    const hit = await findPartForLine(c);
    if (!hit) { setPart(null); throw new Error(`No part found for ${c}`); }
    const p = await getPart(hit.id);
    setPart({ id: hit.id, pn: hit.pn, title: [p?.name, p?.description].filter(Boolean).join(' — ') });
    setPnText(hit.pn);
    setChoice(null);
    setPriceEdited(false);
  });
  useEffect(() => { if (presetPart && !item) void getPart(presetPart).then((p) => p && choosePart(p.pn)); }, [presetPart]);   // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => act(async () => {
    if (!(n > 0)) throw new Error('Enter a quantity');
    const unit = price.trim() ? num(price) : null;
    const v = opt ? opt.vendor_id : vendorId;
    const s = opt ? opt.sku : sku.trim() || null;
    if (item) {
      await updateItem(item.id, { qty: n, vendor_id: v, sku: s, unit_price: unit, description: kind === 'other' ? description : undefined, note: note || null,
        order_ref: item.status === 'ordered' ? orderRef : undefined });
    } else if (kind === 'part') {
      if (!part) throw new Error('Choose the part');
      await addToList(opt
        ? { partId: part.id, qty: n, vendorPartId: opt.vendor_part_id, unitPrice: unit, note }
        : { partId: part.id, qty: n, vendorId: v, sku: s, unitPrice: unit, note });
    } else {
      await addToList({ description, qty: n, vendorId: v, sku: s, unitPrice: unit, note });
    }
    onSaved();
  }, item ? 'Saved' : 'Added to the shopping list');

  return (
    <Modal title={item ? 'Shopping list item' : 'Add to the shopping list'} onClose={onClose} xwide
      footer={<>
        {onRemove && <ConfirmButton className="danger quiet" label={item?.status === 'ordered' ? 'Cancel item' : 'Remove'} confirmLabel="Sure?" onConfirm={onRemove} />}
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => void save()}>{item ? 'Save' : 'Add'}</button>
      </>}>
      {!item && (
        <div className="tabs" style={{ marginBottom: 12, display: 'inline-flex' }}>
          <button className={kind === 'part' ? 'tab sel' : 'tab'} onClick={() => setKind('part')}>A stocked part</button>
          <button className={kind === 'other' ? 'tab sel' : 'tab'} onClick={() => setKind('other')}>Something else</button>
        </div>
      )}
      <div className="form-grid">
        {kind === 'part' ? (
          <Field label="Part" hint={part ? `${part.pn} ${part.title}` : 'PN, MPN or vendor part number; Enter to look it up'} wide>
            <input value={pnText} autoFocus={!item && !presetPart} disabled={!!item} onChange={(e) => setPnText(e.target.value)}
              onBlur={() => { if (pnText.trim() && pnText.trim() !== part?.pn) void choosePart(pnText); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void choosePart(pnText); }} />
          </Field>
        ) : (
          <Field label="What is it" hint="Tools, consumables, a stencil, anything not kept in stock" wide>
            <input value={description} autoFocus={!item} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        )}
        <Field label="Quantity"><input className="qty-input" value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} /></Field>
        {item?.status === 'ordered' && <Field label="Order number"><input value={orderRef} onChange={(e) => setOrderRef(e.target.value)} /></Field>}
      </div>

      {kind === 'part' && part && (
        <>
          <h4 className="sub-head">Buy from</h4>
          <table className="grid compact sources-choice">
            <thead><tr><th style={{ width: 28 }} /><th>Vendor</th><th>Their part no.</th><th>Manufacturer part</th><th className="num">Buy</th><th className="num">Unit</th><th className="num">Total</th>
              {rates.data && <th className="num">In {rates.data.base}</th>}</tr></thead>
            <tbody>
              {(options.data ?? []).map((o) => (
                <tr key={o.vendor_part_id} className="clickable" onClick={() => { setChoice(o.vendor_part_id); setPriceEdited(false); }}>
                  <td><input type="radio" checked={choice === o.vendor_part_id} onChange={() => { setChoice(o.vendor_part_id); setPriceEdited(false); }} /></td>
                  <td>{o.vendor}{o.preferred && <span className="muted" title="Preferred"> ★</span>}</td>
                  <td className="mono">{o.sku}</td>
                  <td className="small">{o.manufacturer} <span className="mono">{o.mpn ?? ''}</span></td>
                  <td className="num" title={o.buy !== n ? `Rounded up to the minimum or multiple (${[o.moq && `min ${o.moq}`, o.order_multiple && `× ${o.order_multiple}`].filter(Boolean).join(', ')})` : undefined}>
                    {fmtQty(o.buy)}{o.buy !== n && n > 0 ? ' *' : ''}</td>
                  <td className="num">{o.unit != null ? fmtMoney(o.unit, o.currency) : <span className="muted">no price</span>}</td>
                  <td className="num">{o.total != null ? fmtMoney(o.total, o.currency) : ''}</td>
                  {rates.data && <td className="num muted">{o.total_base != null ? fmtMoney(o.total_base, rates.data.base) : o.total != null ? 'no rate' : ''}</td>}
                </tr>
              ))}
              <tr className="clickable" onClick={() => setChoice('other')}>
                <td><input type="radio" checked={choice === 'other'} onChange={() => setChoice('other')} /></td>
                <td colSpan={rates.data ? 7 : 6} className="muted">{options.data?.length ? 'Another vendor or part number' : 'This part has no vendor part numbers yet: choose a vendor'}</td>
              </tr>
            </tbody>
          </table>
          {opt && opt.buy !== n && n > 0 && (
            <p className="small muted">* {opt.vendor} sells these in {[opt.moq && `a minimum of ${opt.moq}`, opt.order_multiple && opt.order_multiple > 1 && `multiples of ${opt.order_multiple}`].filter(Boolean).join(' and ')}.{' '}
              <button className="link" onClick={() => setQty(String(opt.buy))}>Buy {fmtQty(opt.buy)}</button></p>
          )}
        </>
      )}

      <div className="form-grid">
        {(kind === 'other' || choice === 'other') && (
          <>
            <Field label="Vendor" hint="Vendors are added in Settings">
              <Select<number> value={vendorId} onChange={setVendorId} empty="Not chosen yet" options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))} />
            </Field>
            <Field label="Their part number"><input className="mono" value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
          </>
        )}
        <Field label={`Unit price${currency ? ` (${currency})` : ''}`} hint={num(price) != null && n ? `Total ${fmtMoney((num(price) ?? 0) * n, currency)}` : undefined}>
          <input value={price} inputMode="decimal" onChange={(e) => { setPrice(e.target.value); setPriceEdited(true); }} />
        </Field>
        <Field label="Notes" wide><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
