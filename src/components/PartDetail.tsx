// One part: its fields, stock by location, manufacturer and vendor parts, where it is used, merged duplicates, and history.
// Sources are edited in the part editor, so every change to a part happens in one form.
import { useState } from 'react';
import {
  KIND_LABEL, STATUS_LABEL, deleteBlocker, deletePart, getPart, mergeParts, resolveCode, setPartsStatus, setPreferredVendorPart,
  type PartDetail as Part,
} from '../lib/parts.ts';
import { getSetting } from '../lib/reference.ts';
import { formatValue } from '../lib/values.ts';
import { IconCopy } from './icons.tsx';
import { PartEditor } from './PartEditor.tsx';
import { ConfirmButton, Modal, copyText, fmtMoney, fmtQty, useAction, useLoad, useToast } from './ui.tsx';

type Dialog = { kind: 'edit' } | { kind: 'similar' } | { kind: 'merge' };

export function PartDetail({ id, refreshKey, onChanged, onOpenPart, onDeleted }: {
  id: number; refreshKey: number; onChanged: () => void; onOpenPart: (id: number) => void; onDeleted?: () => void;
}) {
  const { data: p, error, reload } = useLoad(() => getPart(id), [id, refreshKey]);
  const blocker = useLoad(() => deleteBlocker(id), [id, refreshKey]);
  const base = useLoad(async () => (await getSetting('base_currency')) ?? 'USD', []);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const toast = useToast();
  const act = useAction();
  const changed = () => { setDialog(null); reload(); onChanged(); };

  if (error) return <p className="error">{error}</p>;
  if (!p) return <p className="empty">Loading…</p>;

  const buyFrom = defaultVendorPart(p);
  const value = p.value_num !== null ? formatValue(p.value_num, p.value_unit) : p.value_text;
  const merged = p.merged_into_id !== null;
  return (
    <div className="part-detail">
      <header className="part-head">
        <div className="part-head-top">
          <button className="pn-chip" title="Copy PN" onClick={() => void copyText(p.pn).then(() => toast(`Copied ${p.pn}`))}>{p.pn} <IconCopy /></button>
          {p.status !== 'active' && <span className={`badge ${p.status}`}>{STATUS_LABEL[p.status]}</span>}
          <span className="spacer" />
          <div className="head-actions">
            {!merged && <button className="primary" onClick={() => setDialog({ kind: 'edit' })}>Edit</button>}
            <button onClick={() => setDialog({ kind: 'similar' })} title="Start a new part with this one's category, package, tolerance, manufacturers and vendors">New similar</button>
            {!merged && (p.status === 'archived'
              ? <button onClick={() => void act(async () => { await setPartsStatus([p.id], 'active'); changed(); }, 'Restored')}>Restore</button>
              : <button title="Hide from lists and search; scans and old BOMs still find it"
                  onClick={() => void act(async () => { await setPartsStatus([p.id], 'archived'); changed(); }, `${p.pn} archived`)}>Archive</button>)}
            {blocker.data
              ? <button className="danger quiet" disabled title={`Can’t delete: ${blocker.data}. Archive it instead.`}>Delete</button>
              : <ConfirmButton className="danger quiet" label="Delete" confirmLabel="Delete permanently?"
                  onConfirm={() => void act(async () => { await deletePart(p.id); onChanged(); onDeleted?.(); }, `${p.pn} deleted`)} />}
          </div>
        </div>
        <div className="part-title">
          <div>
            {p.name && <div className="part-name">{p.name}</div>}
            <h2 className="part-desc">{p.description}</h2>
            <div className="meta">{[p.category?.replace(/ > /g, ' › '), p.kind !== 'component' ? KIND_LABEL[p.kind] : null].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
      </header>
      {merged && (
        <p className="archived-note">
          Merged into <button className="link" onClick={() => onOpenPart(p.merged_into_id!)}>{p.merged_into_pn}</button>.
          Its stock and sources moved there; scans and searches for {p.pn} lead there too.
        </p>
      )}
      {!merged && p.status === 'archived' && <p className="archived-note">Archived: hidden from lists and search. Scans and old BOMs still find it.</p>}

      <dl className="facts card">
        <div><dt>Value</dt><dd>{value || '—'}{p.value_text && value !== p.value_text ? <span className="muted"> ({p.value_text})</span> : null}</dd></div>
        <div><dt>Tolerance</dt><dd>{p.tolerance_pct !== null ? `${p.tolerance_pct}%` : '—'}</dd></div>
        <div><dt>Package</dt><dd>{p.package ?? '—'}</dd></div>
        <div><dt>Usual location</dt><dd>{p.location ?? '—'}</dd></div>
        <div><dt>Buy from</dt><dd>{buyFrom ? <>{buyFrom.vendor} <span className="mono small">{buyFrom.sku}</span></> : '—'}</dd></div>
        <div><dt>Standard cost</dt><dd>{p.standard_cost !== null ? fmtMoney(p.standard_cost, base.data ?? 'USD') : '—'}</dd></div>
      </dl>
      {p.notes && <p className="notes">{p.notes}</p>}

      <section className="card">
        <div className="section-head"><h3>Stock <span className="muted">{fmtQty(p.on_hand)}{p.unit !== 'each' ? ` ${p.unit}` : ''}</span></h3></div>
        {p.stock.length ? (
          <table className="grid compact">
            <tbody>
              {p.stock.map((s) => (
                <tr key={s.location_id}><td>{s.path} <span className="code-chip">{s.code}</span></td><td className="num">{fmtQty(s.qty)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">None in stock.</p>}
      </section>

      <section className="card">
        <div className="section-head">
          <h3>Manufacturer parts</h3>
          {!merged && <div className="actions"><button onClick={() => setDialog({ kind: 'edit' })}>Edit sources</button></div>}
        </div>
        {p.mfrParts.length === 0 && <p className="muted">No manufacturer parts yet.</p>}
        {p.mfrParts.map((m) => (
          <div key={m.id} className="mfr">
            <div className="mfr-head">
              <span className="mfr-name">{m.manufacturer}</span> <span className="mpn">{m.mpn ?? <em className="muted">MPN unknown</em>}</span>
              {m.preferred ? <span className="badge">preferred</span> : null}
              {m.lifecycle !== 'active' && <span className={`badge ${m.lifecycle}`}>{m.lifecycle}</span>}
              <span className="spacer" />
              {m.datasheet_url && <a href={m.datasheet_url} target="_blank" rel="noreferrer">Datasheet</a>}
            </div>
            {m.description && <div className="muted small">{m.description}</div>}
            {m.vendorParts.length > 0 && (
              <table className="grid compact vendor-table">
                <tbody>
                  {m.vendorParts.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <button className={`star ${v.preferred ? 'on' : ''}`} title={v.preferred ? 'Bought from here by default' : 'Buy from here by default'}
                          onClick={() => void act(async () => { await setPreferredVendorPart(p.id, v.id); changed(); }, `${v.vendor} ${v.sku} is now the default`)}>
                          {v.preferred ? '★' : '☆'}
                        </button>
                        {v.vendor}
                      </td>
                      <td className="mono">{v.url ? <a href={v.url} target="_blank" rel="noreferrer">{v.sku}</a> : v.sku}</td>
                      <td className="small breaks" title={v.prices_checked_at ? `Prices checked ${v.prices_checked_at}` : 'Prices not checked'}>
                        {v.breaks.length ? <><span className="muted">{v.currency ?? ''}</span> {v.breaks.slice(0, 4).map((b) => `${b.qty}+ ${fmtMoney(b.unit_price, '').trim()}`).join(' · ')}</> : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </section>

      {p.bomRevs.length > 0 && (
        <section className="card">
          <h3>Bill of materials</h3>
          <p className="muted small">{p.bomRevs.map((r) => `Rev ${r.rev} (${r.lines} lines, ${r.status})`).join(' · ')}</p>
        </section>
      )}

      {p.usedIn.length > 0 && (
        <section className="card">
          <h3>Used in</h3>
          <table className="grid compact">
            <tbody>
              {p.usedIn.map((u, i) => (
                <tr key={i} onClick={() => onOpenPart(u.assembly_id)} className="clickable">
                  <td className="pn">{u.assembly_pn}</td><td>{u.assembly_desc}</td><td>Rev {u.rev}</td>
                  <td className="num">{fmtQty(u.qty)}</td><td className="muted small">{u.designators ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!merged && (
        <section className="card">
          <div className="section-head">
            <h3>Duplicates</h3>
            <div className="actions"><button className="link" onClick={() => setDialog({ kind: 'merge' })}>Merge a duplicate into this…</button></div>
          </div>
          {p.mergedFrom.length
            ? <p className="small">Merged in: {p.mergedFrom.map((m, i) => <span key={m.id}>{i ? ', ' : ''}<button className="link" onClick={() => onOpenPart(m.id)}>{m.pn}</button></span>)}
                <span className="muted"> — their PNs still lead here</span></p>
            : <p className="muted small">None.</p>}
        </section>
      )}

      {p.history.length > 0 && (
        <section className="card">
          <h3>Stock history</h3>
          <table className="grid compact history">
            <tbody>
              {p.history.map((h, i) => (
                <tr key={i}>
                  <td className="muted small">{h.at.slice(0, 16)}</td><td>{h.kind}</td>
                  <td className={`num ${h.qty_delta < 0 ? 'neg' : ''}`}>{h.qty_delta > 0 ? '+' : ''}{fmtQty(h.qty_delta)}</td>
                  <td className="small">{h.path}</td><td className="muted small">{[h.vendor, h.order_ref, h.note].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {dialog?.kind === 'edit' && <PartEditor part={p} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog?.kind === 'similar' && (
        <PartEditor template={p} onClose={() => setDialog(null)} onSaved={(newId) => { setDialog(null); onChanged(); onOpenPart(newId); }} />
      )}
      {dialog?.kind === 'merge' && <MergeDialog part={p} onClose={() => setDialog(null)} onDone={changed} />}
    </div>
  );
}

function MergeDialog({ part, onClose, onDone }: { part: Part; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Part | null>(null);
  const look = () => act(async () => {
    const hit = await resolveCode(code);
    if (!hit) throw new Error(`No part found for ${code}`);
    if (hit.id === part.id) throw new Error('That is this part');
    setFound((await getPart(hit.id)) ?? null);
  });
  const merge = () => act(async () => { if (found) { await mergeParts(part.id, found.id); onDone(); } }, 'Merged');
  return (
    <Modal title={`Merge a duplicate into ${part.pn}`} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" disabled={!found} onClick={() => void merge()}>Merge</button></>}>
      <p className="small">The duplicate’s stock, manufacturer and vendor parts, BOM lines and documents move to <b>{part.pn}</b>.
        The duplicate is archived and keeps its own history; scanning or searching its PN leads to {part.pn}.</p>
      <div className="row">
        <input value={code} onChange={(e) => { setCode(e.target.value); setFound(null); }} placeholder="PN, MPN or vendor part number of the duplicate"
          onKeyDown={(e) => { if (e.key === 'Enter') void look(); }} autoFocus />
        <button onClick={() => void look()}>Find</button>
      </div>
      {found && <p className="found"><b>{found.pn}</b> {found.name ? `${found.name} · ` : ''}{found.description} — {fmtQty(found.on_hand)} in stock</p>}
    </Modal>
  );
}

/** The vendor part a purchase would use: starred on the preferred manufacturer part first, then starred, then cheapest. */
function defaultVendorPart(part: Part) {
  const all = part.mfrParts.flatMap((m) => m.vendorParts.map((v) => ({ ...v, mfr_part_id: m.id, mpref: !!m.preferred })));
  const first = (v: (typeof all)[number]) => v.breaks[0]?.unit_price ?? Infinity;
  return [...all].sort((a, b) =>
    Number(b.mpref && !!b.preferred) - Number(a.mpref && !!a.preferred) || Number(!!b.preferred) - Number(!!a.preferred)
    || Number(b.mpref) - Number(a.mpref) || first(a) - first(b) || a.id - b.id)[0];
}
