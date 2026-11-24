// Assemblies: each assembly's BOM revisions, their lines, and a stock check for a build quantity.
// BOMs come in as bom.csv (Import BOM…) or are typed in line by line. Builds arrive in the next step.
import { useEffect, useState } from 'react';
import {
  addLine, bomLines, copyRev, createRev, deleteLine, deleteRev, findPartForLine, listAssemblies, listRevs, moveDesignators, nextRev,
  setLinePart, setRevStatus, splitDesignators, updateLine, updateRevInfo, type BomLineRow, type LineFields, type RevRow,
} from '../lib/bom.ts';
import { getPart } from '../lib/parts.ts';
import { IconPlus } from './icons.tsx';
import { ImportDialog } from './ImportExport.tsx';
import { PartEditor } from './PartEditor.tsx';
import { ConfirmButton, Field, Modal, SearchInput, fmtQty, num, useAction, useLoad } from './ui.tsx';

export function AssembliesView({ onOpenPart, focus, refreshKey, onChanged }: {
  onOpenPart: (id: number) => void; focus: { id: number; n: number } | null; refreshKey: number; onChanged: () => void;
}) {
  const list = useLoad(listAssemblies, [refreshKey]);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (focus) setSelected(focus.id); }, [focus]);
  const shown = (list.data ?? []).filter((a) => !filter || `${a.pn} ${a.name ?? ''} ${a.description} ${a.project_code ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="row">
          <SearchInput className="search" placeholder="Filter assemblies" value={filter} onChange={setFilter} />
          <button onClick={() => setCreating(true)} title="New assembly"><IconPlus /></button>
        </div>
        {shown.map((a) => (
          <div key={a.id} className={`list-item ${selected === a.id ? 'sel' : ''}`} onClick={() => setSelected(a.id)}>
            <div><span className="pn">{a.pn}</span> {a.name && <b>{a.name}</b>} <span className="muted small">{a.project_code ?? ''}</span></div>
            <div className="small clip-line">{a.description}</div>
            <div className="muted small">{a.revs ? `Rev ${a.revs}` : 'No BOM yet'} · {fmtQty(a.on_hand)} in stock</div>
          </div>
        ))}
        {list.data && !list.data.length && (
          <p className="empty small">No assemblies yet. An assembly is a part whose kind is Assembly, or any part you give a BOM.</p>
        )}
      </aside>
      <section className="main-pane">
        {selected
          ? <AssemblyPanel id={selected} refreshKey={refreshKey} onChanged={onChanged} onOpenPart={onOpenPart} />
          : <div className="empty">
              <p>Choose an assembly, or add one.</p>
              <button className="primary" onClick={() => setCreating(true)}><IconPlus /> New assembly</button>
            </div>}
      </section>
      {creating && (
        <PartEditor preset={{ kind: 'assembly' }} onClose={() => setCreating(false)}
          onSaved={(id) => { setCreating(false); onChanged(); setSelected(id); }} />
      )}
    </div>
  );
}

function AssemblyPanel({ id, refreshKey, onChanged, onOpenPart }: {
  id: number; refreshKey: number; onChanged: () => void; onOpenPart: (id: number) => void;
}) {
  const act = useAction();
  const info = useLoad(async () => (await listAssemblies()).find((a) => a.id === id) ?? (await getPart(id)), [id, refreshKey]);
  const revs = useLoad(() => listRevs(id), [id, refreshKey]);
  const [revId, setRevId] = useState<number | null>(null);
  const [buildQty, setBuildQty] = useState('1');
  const [importing, setImporting] = useState<string | null>(null);   // the revision to import as
  const [resolving, setResolving] = useState<BomLineRow | null>(null);
  const [editingLine, setEditingLine] = useState<BomLineRow | 'new' | null>(null);
  const [editingRev, setEditingRev] = useState<RevRow | null>(null);
  useEffect(() => {
    const list = revs.data ?? [];
    if (!list.some((r) => r.id === revId)) setRevId(list.at(-1)?.id ?? null);
  }, [revs.data, revId]);
  const lines = useLoad(() => (revId ? bomLines(revId) : Promise.resolve([])), [revId, refreshKey]);
  const n = num(buildQty) ?? 0;
  const rows = (lines.data ?? []).map((l) => ({ ...l, need: l.dnp ? 0 : l.qty * n }));
  const short = rows.filter((l) => !l.dnp && (l.need > l.on_hand || !l.part_id));
  const unresolved = rows.filter((l) => !l.part_id && !l.dnp);   // a DNP line needs no part
  const rev = revs.data?.find((r) => r.id === revId);
  const a = info.data;
  if (!a) return <p className="empty">Loading…</p>;
  const projectCode = 'project_code' in a ? a.project_code : null;
  const editable = rev && rev.status !== 'obsolete';

  const startEmpty = () => act(async () => {
    const letter = await nextRev(id);
    const newId = await createRev(id, letter, null, null);
    setRevId(newId);
    onChanged();
    setEditingLine('new');
  }, 'Revision started');

  return (
    <div className="bom">
      <div className="assembly-head">
        <div>
          <div><span className="pn-chip static">{a.pn}</span> {a.name && <b className="assembly-name">{a.name}</b>}</div>
          <div className="part-desc">{a.description}</div>
          <div className="meta">{projectCode ? `${projectCode} · ` : ''}{fmtQty(a.on_hand)} in stock</div>
        </div>
        <span className="spacer" />
        <div className="head-actions">
          <button onClick={() => onOpenPart(a.id)}>Open part</button>
          <button onClick={() => void nextRev(id).then(setImporting)}>Import BOM…</button>
          <button onClick={() => void startEmpty()} title="Start a new, empty draft revision">New revision</button>
        </div>
      </div>

      {(revs.data?.length ?? 0) === 0 ? (
        <div className="empty">
          No BOM yet. <button className="link" onClick={() => void nextRev(id).then(setImporting)}>Import one from a CSV file</button> or{' '}
          <button className="link" onClick={() => void startEmpty()}>start an empty one</button> and add the lines yourself.
        </div>
      ) : (
        <>
          <div className="toolbar">
            <div className="tabs">
              {(revs.data ?? []).map((r) => (
                <button key={r.id} className={r.id === revId ? 'tab sel' : 'tab'} onClick={() => setRevId(r.id)}>
                  Rev {r.rev}{r.status === 'draft' ? ' · draft' : r.status === 'obsolete' ? ' · obsolete' : ''}
                </button>
              ))}
            </div>
            {rev?.status === 'draft' && <button className="link" onClick={() => void act(async () => { await setRevStatus(rev.id, 'released'); onChanged(); }, `Rev ${rev.rev} released`)}>Release</button>}
            {rev?.status === 'released' && <button className="link" onClick={() => void act(async () => { await setRevStatus(rev.id, 'obsolete'); onChanged(); }, `Rev ${rev.rev} marked obsolete`)}>Mark obsolete</button>}
            {rev?.status === 'obsolete' && <button className="link" onClick={() => void act(async () => { await setRevStatus(rev.id, 'released'); onChanged(); }, `Rev ${rev.rev} released`)}>Restore</button>}
            {rev && <button className="link" onClick={() => setEditingRev(rev)}>Details</button>}
            {rev?.status === 'draft' && <ConfirmButton className="link danger" label="Delete" confirmLabel={`Delete Rev ${rev.rev}?`}
              onConfirm={() => void act(async () => { await deleteRev(rev.id); onChanged(); }, `Rev ${rev.rev} deleted`)} />}
            {editable && <button onClick={() => setEditingLine('new')}>+ Add line</button>}
            {rev && rev.status !== 'draft' && (
              <button className="quiet" title="Make a draft copy of this revision that you can change" onClick={() => void act(async () => {
                const newId = await copyRev(rev.id, await nextRev(id), `Copied from Rev ${rev.rev}`);
                setRevId(newId);
                onChanged();
              }, 'Draft copy made')}>Copy to new revision</button>
            )}
            <span className="spacer" />
            <label className="inline">Check stock for <input className="qty-input" value={buildQty} onChange={(e) => setBuildQty(e.target.value)} inputMode="numeric" /></label>
            <span className={short.length ? 'warn' : 'ok'}>{short.length ? `${short.length} line${short.length === 1 ? '' : 's'} short` : 'All in stock'}</span>
          </div>
          {rev?.notes && <p className="muted small pad">{rev.notes}</p>}
          {rev?.status === 'released' && <p className="muted small pad">Released. Edits apply to this revision straight away; to keep it as it is, copy it to a new revision first.</p>}
          {unresolved.length > 0 && <p className="warn small pad">{unresolved.length} line{unresolved.length === 1 ? ' has' : 's have'} no part yet. Click Resolve to choose one.</p>}
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Designators</th><th style={{ width: 64 }}>PN</th><th>Name</th><th>Description</th><th className="num">Per unit</th><th className="num">Need</th><th className="num">Stock</th><th>Location</th>{editable && <th style={{ width: 44 }} />}</tr></thead>
              <tbody>
                {rows.length === 0 && lines.data && (
                  <tr><td colSpan={9} className="empty small">No lines yet. {editable && <button className="link" onClick={() => setEditingLine('new')}>Add the first line</button>}</td></tr>
                )}
                {rows.map((l) => (
                  <tr key={l.id} className={`${l.part_id ? 'clickable' : ''} ${l.dnp ? 'dim' : ''} ${!l.dnp && (l.need > l.on_hand || !l.part_id) ? 'short' : ''}`}
                    onClick={() => l.part_id && onOpenPart(l.part_id)}>
                    <td className="small">{l.designators}{l.dnp ? ' (not fitted)' : ''}</td>
                    <td className="pn">{l.pn ?? <span className="error">{l.pn_as_imported ?? l.mpn_as_imported ?? '?'}</span>}</td>
                    <td>{l.name ?? ''}</td>
                    <td className="clip" title={l.description ?? ''}>{l.description ?? (editable
                      ? <button className="link" onClick={(e) => { e.stopPropagation(); setResolving(l); }}>Resolve…</button>
                      : <span className="muted">unresolved</span>)}</td>
                    <td className="num">{fmtQty(l.qty)}</td>
                    <td className="num">{fmtQty(l.need)}</td>
                    <td className="num"><span className={`qty-pill ${l.on_hand >= l.need && l.on_hand > 0 ? 'in' : 'out'}`}>{fmtQty(l.on_hand)}</span></td>
                    <td className="loc clip">{l.location ?? ''}</td>
                    {editable && <td className="row-actions"><button className="link" onClick={(e) => { e.stopPropagation(); setEditingLine(l); }}>Edit</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {importing && (
        <ImportDialog title={`Import a BOM for ${a.pn}${a.name ? ` ${a.name}` : ''}`} bomFor={{ assemblyPn: a.pn, rev: importing }}
          hint={`One BOM per file, with pn and/or mpn, qty and designators columns (line, dnp and note are optional). It becomes a new draft revision of ${a.pn}. Parts not found are kept as unresolved lines to match up afterwards.`}
          onClose={() => setImporting(null)} onDone={() => { setImporting(null); onChanged(); }} />
      )}
      {editingRev && (
        <RevDialog rev={editingRev} onClose={() => setEditingRev(null)}
          onSave={(project, notes) => void act(async () => { await updateRevInfo(editingRev.id, project, notes); setEditingRev(null); onChanged(); }, 'Saved')} />
      )}
      {editingLine && rev && (
        <LineEditor line={editingLine === 'new' ? null : editingLine} released={rev.status === 'released'} onClose={() => setEditingLine(null)}
          onSave={(f, move) => void act(async () => {
            if (editingLine === 'new') await addLine(rev.id, f);
            else {
              // Move first (it needs the designators still on this line), then save the rest of the edit.
              if (move) await moveDesignators(editingLine.id, move.designators, move.partId);
              const left = splitDesignators(f.designators).length;
              const had = splitDesignators(editingLine.designators).length;
              if (left || !had) await updateLine(editingLine.id, f);
              else if (!move) await deleteLine(editingLine.id);   // every designator taken out, none moved
            }
            setEditingLine(null);
            onChanged();
          }, 'BOM updated')}
          onDelete={editingLine === 'new' ? undefined : () => void act(async () => { await deleteLine((editingLine as BomLineRow).id); setEditingLine(null); onChanged(); }, 'Line deleted')} />
      )}
      {resolving && (
        <ResolveDialog said={[resolving.pn_as_imported, resolving.mpn_as_imported].filter(Boolean).join(' / ') || null}
          initial={resolving.pn_as_imported ?? resolving.mpn_as_imported ?? ''} onClose={() => setResolving(null)}
          onResolve={(code) => void act(async () => {
            const hit = await findPartForLine(code);
            if (!hit) throw new Error(`No part found for ${code}`);
            await setLinePart(resolving.id, hit.id);
            setResolving(null);
            onChanged();
          }, 'Line resolved')} />
      )}
    </div>
  );
}

function RevDialog({ rev, onClose, onSave }: { rev: RevRow; onClose: () => void; onSave: (project: string | null, notes: string | null) => void }) {
  const [project, setProject] = useState(rev.project_code ?? '');
  const [notes, setNotes] = useState(rev.notes ?? '');
  return (
    <Modal title={`Rev ${rev.rev}`} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(project || null, notes || null)}>Save</button></>}>
      <div className="form-grid">
        <Field label="Project" hint="Your project reference, if any"><input value={project} onChange={(e) => setProject(e.target.value)} autoFocus /></Field>
        <Field label="Status"><span>{rev.status}</span></Field>
        <Field label="Notes" wide><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      <p className="small muted">Created {rev.created_at.slice(0, 10)}{rev.source_file ? ` from ${rev.source_file}` : ''}.</p>
    </Modal>
  );
}

function ResolveDialog({ said, initial, onClose, onResolve }: { said: string | null; initial: string; onClose: () => void; onResolve: (code: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title="Choose the part for this line" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" disabled={!v.trim()} onClick={() => onResolve(v.trim())}>Use</button></>}>
      <Field label="PN, MPN or vendor part number" hint={said ? `The BOM said ${said}` : undefined}>
        <input value={v} onChange={(e) => setV(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onResolve(v.trim()); }} />
      </Field>
      <p className="small muted">If the part isn’t in your library yet, add it on the Parts screen first, then come back.</p>
    </Modal>
  );
}

/** Look up a part by PN (padding stripped zeros), MPN or vendor part number, with a line describing it. */
async function findPart(code: string) {
  const hit = await findPartForLine(code);
  if (!hit) return undefined;
  const p = await getPart(hit.id);
  return { id: hit.id, pn: hit.pn, desc: [p?.name, p?.description].filter(Boolean).join(' — ') };
}
type Found = Awaited<ReturnType<typeof findPart>>;

/**
 * Edit one BOM line. Taking designators out of the list asks where they go: onto another part
 * (they join that part's line, or a new one) or out of the BOM. One Save does it all.
 */
function LineEditor({ line, released, onClose, onSave, onDelete }: {
  line: BomLineRow | null; released?: boolean; onClose: () => void;
  onSave: (f: LineFields, move?: { designators: string[]; partId: number }) => void;
  onDelete?: () => void;
}) {
  const act = useAction();
  const [pnText, setPnText] = useState(line?.pn ?? line?.pn_as_imported ?? '');
  const [part, setPart] = useState<Found>(line?.part_id ? { id: line.part_id, pn: line.pn ?? '', desc: [line.name, line.description].filter(Boolean).join(' — ') } : undefined);
  const [des, setDes] = useState(line?.designators ?? '');
  const [qtyText, setQtyText] = useState(line ? String(line.qty) : '');
  const [qtyEdited, setQtyEdited] = useState(!!line && splitDesignators(line.designators).length !== line.qty);
  const [dnp, setDnp] = useState(!!line?.dnp);
  const [note, setNote] = useState(line?.note ?? '');
  const [moveText, setMoveText] = useState('');
  const [moveTo, setMoveTo] = useState<Found | null>(null);   // null = not looked up yet
  const [dropRemoved, setDropRemoved] = useState(false);

  const desList = splitDesignators(des);
  const removed = line ? splitDesignators(line.designators).filter((d) => !desList.includes(d)) : [];
  const qty = qtyEdited ? num(qtyText) : desList.length || (removed.length ? 0 : num(qtyText));
  const lookUpPart = (code: string) => act(async () => {
    const hit = code.trim() ? await findPart(code) : undefined;
    setPart(hit);
    if (hit) setPnText(hit.pn); else if (code.trim()) throw new Error(`No part found for ${code}`);
  });
  const lookUpMove = async (code: string) => {
    const hit = code.trim() ? await findPart(code) : null;
    setMoveTo(hit ?? null);
    if (hit) setMoveText(hit.pn);
    return hit;
  };

  const needsChoice = removed.length > 0 && !moveTo && !dropRemoved;
  const canSave = !needsChoice && (desList.length > 0 ? !!qty && qty > 0 : removed.length > 0 || (!!qty && qty > 0));
  const save = () => act(async () => {
    let target = moveTo;
    if (removed.length && !dropRemoved && !target) {   // PN typed but not looked up yet
      target = (await lookUpMove(moveText)) ?? null;
      if (!target) throw new Error(moveText.trim() ? `No part found for ${moveText}` : `Say where ${removed.join(', ')} should go`);
    }
    if (target && target.id === part?.id) throw new Error(`${removed.join(', ')} are already on ${target.pn}`);
    onSave({ part_id: part?.id ?? null, designators: des, qty: qty ?? 0, dnp, note: note || null },
      removed.length && target && !dropRemoved ? { designators: removed, partId: target.id } : undefined);
  });
  const saveLabel = removed.length && !dropRemoved && moveTo ? `Save and move ${removed.join(', ')} to ${moveTo.pn}` : 'Save';

  return (
    <Modal title={line ? `Edit line ${line.designators ?? line.line_no}` : 'Add a BOM line'} onClose={onClose} wide
      footer={<>
        {onDelete && <ConfirmButton className="danger quiet" label="Delete line" confirmLabel="Delete this line?" onConfirm={onDelete} />}
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!canSave} onClick={() => void save()}>{saveLabel}</button>
      </>}>
      {released && <p className="small muted" style={{ marginTop: 0 }}>This revision is released. Changes apply straight away; completed builds keep the parts they used.</p>}
      <div className="form-grid">
        <Field label="Part" hint={part ? `${part.pn} ${part.desc}` : 'PN, MPN or vendor part number'} wide>
          <input value={pnText} onChange={(e) => setPnText(e.target.value)} onBlur={() => { if (pnText.trim() !== (part?.pn ?? '')) void lookUpPart(pnText); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void lookUpPart(pnText); }} autoFocus={!line} />
        </Field>
        <Field label="Designators" hint={line ? 'To put some on a different part, delete them here' : 'Separated by commas or spaces'} wide>
          <input value={des} onChange={(e) => setDes(e.target.value)} />
        </Field>
        <Field label="Quantity" hint={!qtyEdited && desList.length ? 'From the designator count' : undefined}>
          <input value={qtyEdited ? qtyText : String(qty ?? '')} onChange={(e) => { setQtyEdited(true); setQtyText(e.target.value); }} inputMode="decimal" />
        </Field>
        <Field label="Fitted"><label className="check"><input type="checkbox" checked={dnp} onChange={(e) => setDnp(e.target.checked)} /> Not fitted (DNP)</label></Field>
        <Field label="Notes" wide><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {removed.length > 0 && (
        <div className="move-box">
          <h3 className="form-section">Where do {removed.join(', ')} go?</h3>
          <label className="check"><input type="radio" checked={!dropRemoved} onChange={() => setDropRemoved(false)} /> Onto another part</label>
          {!dropRemoved && (
            <div className="row" style={{ margin: '6px 0 4px 24px' }}>
              <input value={moveText} autoFocus placeholder="PN, e.g. 01704" onChange={(e) => { setMoveText(e.target.value); setMoveTo(null); }}
                onBlur={() => void lookUpMove(moveText)} onKeyDown={(e) => { if (e.key === 'Enter') void lookUpMove(moveText); }} />
              <span className="small muted clip">{moveTo ? moveTo.desc : moveText.trim() ? 'Press Enter to look it up' : ''}</span>
            </div>
          )}
          <label className="check"><input type="radio" checked={dropRemoved} onChange={() => setDropRemoved(true)} /> Remove them from the BOM</label>
          {!dropRemoved && moveTo && <p className="small muted">They join {moveTo.pn}’s line in this revision, or a new line at the bottom if there isn’t one.</p>}
          {!desList.length && <p className="small muted">This line will have no designators left, so it will be removed{dropRemoved ? '' : ' after the move'}.</p>}
        </div>
      )}
    </Modal>
  );
}
