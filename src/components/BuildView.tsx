// Builds: planning one, and the build itself (what's short, the pick list by location, and completing it).
import { useEffect, useMemo, useState } from 'react';
import { listRevs } from '../lib/bom.ts';
import { findPartForLine } from '../lib/bom.ts';
import {
  bomChanged, buildUsage, cancelBuild, completeBuild, getBuild, planBuild, refreshFromBom, requirements, setSubstitute, updateBuild,
  type BuildRow, type Requirement,
} from '../lib/builds.ts';
import { writeCsv } from '../lib/csv.ts';
import { revealInFileManager, saveFilesToFolder } from '../lib/db.ts';
import { listLocations } from '../lib/locations.ts';
import { getSetting } from '../lib/reference.ts';
import { LocationPicker } from './LocationPicker.tsx';
import { ConfirmButton, Field, Modal, Select, copyText, fmtMoney, fmtQty, num, useAction, useLoad, useToast } from './ui.tsx';

export const BUILD_STATUS_LABEL: Record<string, string> = { planned: 'Planned', complete: 'Complete', cancelled: 'Cancelled' };

/** "B0003 · 10 × Rev A", or "8 of 10" for a build that made fewer than planned. */
export function buildSummary(b: BuildRow): string {
  const qty = b.status === 'complete' && b.qty_built !== null && b.qty_built !== b.qty ? `${fmtQty(b.qty_built)} of ${fmtQty(b.qty)}` : fmtQty(b.qty);
  return `${qty} × Rev ${b.rev}`;
}

// ------------------------------------------------------------------ planning

/** Plan a build: choose the revision (obsolete ones can't be built) and how many. */
export function PlanBuildDialog({ assemblyId, title, defaultRevId, defaultQty, onClose, onPlanned }: {
  assemblyId: number; title: string; defaultRevId?: number | null; defaultQty?: number; onClose: () => void; onPlanned: (buildId: number) => void;
}) {
  const act = useAction();
  const revs = useLoad(() => listRevs(assemblyId), [assemblyId]);
  const usable = (revs.data ?? []).filter((r) => r.status !== 'obsolete');
  const [revId, setRevId] = useState<number | null>(null);
  const [qty, setQty] = useState(String(defaultQty ?? 1));
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (revId || !revs.data) return;
    const pick = usable.find((r) => r.id === defaultRevId) ?? [...usable].reverse().find((r) => r.status === 'released') ?? usable.at(-1);
    if (pick) setRevId(pick.id);
  }, [revs.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rev = usable.find((r) => r.id === revId);
  const n = num(qty);
  const plan = () => act(async () => {
    if (!revId) throw new Error('Choose a revision');
    onPlanned(await planBuild(revId, n ?? 0, notes));
  }, 'Build planned');

  return (
    <Modal title={title} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!revId || !n} onClick={() => void plan()}>Plan build</button></>}>
      {revs.data && !usable.length
        ? <p>This assembly has no BOM revision that can be built. Import or start one on the Assemblies screen, or restore an obsolete one.</p>
        : (
          <div className="form-grid">
            <Field label="BOM revision">
              <Select<number> value={revId} onChange={setRevId}
                options={usable.map((r) => ({ value: r.id, label: `Rev ${r.rev}${r.status === 'draft' ? ' (draft)' : ''}` }))} />
            </Field>
            <Field label="How many"><input className="qty-input" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" autoFocus /></Field>
            <Field label="Reference or notes" wide hint="A work order, a customer, why it's being built…">
              <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        )}
      {rev?.status === 'draft' && (
        <p className="small warn">Rev {rev.rev} is a draft. You can build it (for a prototype, say); the build is recorded as built from an unreleased BOM.</p>
      )}
      <p className="small muted">The build keeps its own copy of the BOM, so later changes to the BOM don’t change it unless you refresh it.</p>
    </Modal>
  );
}

// ------------------------------------------------------------------ one build

type PickRow = { key: string; req: Requirement; location_id: number; path: string; available: number; suggested: number };

/** Every place each fitted line's part is stored, pre-filled with the suggested quantity, sorted by location for walking the drawers. */
function pickRows(reqs: Requirement[]): PickRow[] {
  return reqs.filter((r) => r.need > 0 && r.part_id).flatMap((r) => r.spots.map((s) => ({
    key: `${r.line_no}:${s.location_id}`, req: r, location_id: s.location_id, path: s.path, available: s.qty,
    suggested: r.picks.find((p) => p.location_id === s.location_id)?.qty ?? 0,
  }))).filter((x) => x.suggested > 0 || x.req.picks.reduce((t, p) => t + p.qty, 0) < x.req.need)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }) || (a.req.pn ?? '').localeCompare(b.req.pn ?? ''));
}

export function BuildView({ buildId, onClose, onChanged, onOpenPart, onOpenBuild, onPlanSubBuild }: {
  buildId: number; onClose: () => void; onChanged: () => void; onOpenPart: (id: number) => void;
  onOpenBuild?: (id: number) => void; onPlanSubBuild?: (assemblyId: number, qty: number) => void;
}) {
  const act = useAction();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const refresh = () => { setTick((t) => t + 1); onChanged(); };
  const build = useLoad(() => getBuild(buildId), [buildId, tick]);
  const b = build.data;
  const open = b?.status === 'planned';
  const reqs = useLoad(() => (b && open ? requirements(b.id) : Promise.resolve([])), [b?.id, b?.qty, open, tick]);
  const changed = useLoad(() => (b && open ? bomChanged(b.id) : Promise.resolve(false)), [b?.id, open, tick]);
  const usage = useLoad(() => (b && b.status === 'complete' ? buildUsage(b.id) : Promise.resolve([])), [b?.id, b?.status, tick]);
  const base = useLoad(async () => (await getSetting('base_currency')) ?? 'USD', []);
  const [qtyText, setQtyText] = useState('');
  const [notes, setNotes] = useState('');
  const [taken, setTaken] = useState<Map<string, string>>(new Map());   // edited pick quantities
  const [picked, setPicked] = useState<Set<string>>(new Set());          // ticked while picking (on screen only)
  const [completing, setCompleting] = useState(false);
  useEffect(() => { if (b) { setQtyText(String(b.qty)); setNotes(b.notes ?? ''); } }, [b?.id, b?.qty, b?.notes]);
  useEffect(() => { setTaken(new Map()); }, [reqs.data]);

  const all = reqs.data ?? [];
  const rows = useMemo(() => pickRows(all), [all]);
  const takeOf = (r: PickRow) => { const t = taken.get(r.key); return t === undefined ? r.suggested : num(t) ?? 0; };
  const takenByLine = new Map<number, number>();
  for (const r of rows) takenByLine.set(r.req.line_no, (takenByLine.get(r.req.line_no) ?? 0) + takeOf(r));
  const fitted = all.filter((r) => !r.dnp);
  const noPart = fitted.filter((r) => !r.part_id);
  const short = fitted.filter((r) => r.part_id && r.short > 0);
  const notPicked = fitted.filter((r) => r.part_id && (takenByLine.get(r.line_no) ?? 0) < r.need);
  const attention = fitted.filter((r) => !r.part_id || r.short > 0 || (takenByLine.get(r.line_no) ?? 0) < r.need);
  const units = rows.reduce((t, r) => t + takeOf(r), 0);
  const qty = num(qtyText);
  const dirty = !!b && ((qty !== null && qty !== b.qty) || notes.trim() !== (b.notes ?? ''));

  const save = () => act(async () => { await updateBuild(buildId, { qty: qty ?? undefined, notes }); refresh(); }, 'Build saved');
  const substitute = (lineNo: number, code: string | null) => act(async () => {
    let id: number | null = null;
    if (code) {
      const hit = await findPartForLine(code);
      if (!hit) throw new Error(`No part found for ${code}`);
      id = hit.id;
    }
    await setSubstitute(buildId, lineNo, id);
    refresh();
  }, code ? 'Substitute chosen' : 'Back to the BOM’s part');
  const pickListRows = () => rows.filter((r) => takeOf(r) > 0);
  const pickText = () => [
    `Pick list ${b?.code}: ${b?.qty} × ${b?.assembly_pn} ${b?.assembly_name ?? ''} Rev ${b?.rev}`, '',
    ['Location', 'PN', 'Name', 'Designators', 'Take'].join('\t'),
    ...pickListRows().map((r) => [r.path, r.req.pn, r.req.name ?? r.req.description ?? '', r.req.designators ?? '', takeOf(r)].join('\t')),
  ].join('\n');
  const saveCsv = () => act(async () => {
    if (!b) return;
    const text = writeCsv(['location', 'pn', 'name', 'description', 'designators', 'take', 'line'],
      pickListRows().map((r) => [r.path, r.req.pn, r.req.name, r.req.description, r.req.designators, takeOf(r), r.req.line_no]));
    const where = await saveFilesToFolder('Choose where to save the pick list', `partio-pick-list-${b.code}`, [{ name: `pick-list-${b.code}.csv`, text }]);
    if (!where) return;
    toast(`Saved to ${where}`);
    await revealInFileManager(where).catch(() => undefined);
  });

  if (!b) return null;
  const draft = b.rev_status === 'draft';
  return (
    <Modal title={`Build ${b.code}`} onClose={onClose} xwide sticky
      footer={open ? <>
        <ConfirmButton className="danger quiet" label="Cancel build" confirmLabel="Cancel this build?"
          onConfirm={() => void act(async () => { await cancelBuild(b.id); refresh(); }, 'Build cancelled')} />
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => setCompleting(true)}>Complete build…</button>
      </> : <><span className="spacer" /><button onClick={onClose}>Close</button></>}>
      <div className="build-head">
        <div>
          <div className="build-title"><span className="pn">{b.assembly_pn}</span> {b.assembly_name && <b>{b.assembly_name}</b>} <span className="muted">Rev {b.rev}</span>
            {(open ? draft : b.bom_status === 'draft') && <span className="badge obsolete" style={{ marginLeft: 8 }}>draft BOM</span>}</div>
          <div className="muted small">{b.assembly_desc}</div>
        </div>
        <span className="spacer" />
        <span className={`status-pill ${b.status}`}>{BUILD_STATUS_LABEL[b.status] ?? b.status}</span>
      </div>

      {open ? (
        <>
          {changed.data && (
            <div className="card attention row">
              <span>The BOM has changed since this build was planned. The build still uses its own copy.</span>
              <span className="spacer" />
              <button onClick={() => void act(async () => { await refreshFromBom(b.id); refresh(); }, 'Build refreshed from the BOM')}>Refresh from BOM</button>
            </div>
          )}
          {b.rev_status === 'obsolete' && <p className="small warn">Rev {b.rev} is now obsolete. This build can still be completed; new builds need a current revision.</p>}
          {draft && <p className="small muted">Rev {b.rev} is a draft: this build will be recorded as built from an unreleased BOM.</p>}

          <div className="build-controls">
            <label className="inline">Quantity <input className="qty-input" value={qtyText} onChange={(e) => setQtyText(e.target.value)} inputMode="numeric" /></label>
            <label className="inline grow">Reference <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Work order, customer, notes…" /></label>
            {dirty && <button className="primary" onClick={() => void save()}>Save</button>}
          </div>
          <div className="build-controls">
            <span className={attention.length ? 'warn' : 'ok'}>{attention.length
              ? [noPart.length && `${noPart.length} without a part`, short.length && `${short.length} short`,
                  notPicked.length > short.length && `${notPicked.length - short.length} not fully picked`].filter(Boolean).join(' · ')
              : 'Everything is in stock'}</span>
            <span className="spacer" />
            <span className="muted small">{pickListRows().length} picks · {fmtQty(units)} parts</span>
            <button onClick={() => void copyText(pickText()).then(() => toast('Pick list copied (paste into a spreadsheet)'))}>Copy</button>
            <button onClick={() => void saveCsv()}>Save CSV…</button>
            <button onClick={() => window.print()}>Print pick list</button>
          </div>

          {attention.length > 0 && (
            <div className="card attention">
              <h3>Needs attention</h3>
              <table className="grid compact">
                <thead><tr><th style={{ width: 40 }}>Line</th><th style={{ width: 64 }}>PN</th><th>Part</th><th>Designators</th>
                  <th className="num">Need</th><th className="num">On hand</th><th className="num" title="Needed by builds planned before this one">Earlier builds</th><th className="num">Short</th><th /></tr></thead>
                <tbody>
                  {attention.map((r) => (
                    <tr key={r.line_no}>
                      <td className="muted">{r.line_no}</td>
                      <td className="pn">{r.pn ?? <span className="error">{r.said ?? '?'}</span>}</td>
                      <td>{r.part_id
                        ? <>{r.name && <b>{r.name} </b>}<span className="muted">{r.description}</span>{r.substitute && <span className="badge" title={`Instead of ${r.bom_pn ?? 'the BOM’s part'}`}>substitute</span>}</>
                        : <span className="muted">No part: resolve it on the BOM and refresh, or choose a substitute</span>}</td>
                      <td className="small muted">{r.designators}</td>
                      <td className="num">{fmtQty(r.need)}</td>
                      <td className="num">{fmtQty(r.on_hand)}</td>
                      <td className="num muted">{r.reserved ? fmtQty(r.reserved) : ''}</td>
                      <td className="num warn">{r.part_id ? fmtQty(Math.max(r.short, r.need - (takenByLine.get(r.line_no) ?? 0))) : 'no part'}</td>
                      <td className="row-actions">
                        {r.part_id && r.has_bom && onPlanSubBuild && <button onClick={() => onPlanSubBuild(r.part_id!, Math.ceil(r.short || r.need))}>Plan a build of it</button>}
                        {r.substitute && <button className="link" onClick={() => void substitute(r.line_no, null)}>Use {r.bom_pn ?? 'BOM part'}</button>}
                        <SubstituteInput onUse={(code) => void substitute(r.line_no, code)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">Short counts what builds planned before this one need first. A build can be completed with lines short (if parts came from elsewhere); only what’s picked here is taken from stock.</p>
            </div>
          )}

          <div className="print-area">
            <h2 className="print-only">Pick list {b.code}: {fmtQty(b.qty)} × {b.assembly_pn} {b.assembly_name ?? ''} Rev {b.rev}{b.notes ? ` · ${b.notes}` : ''}</h2>
            <table className="grid compact pick-table">
              <thead><tr><th style={{ width: 28 }} /><th>Location</th><th style={{ width: 64 }}>PN</th><th>Name</th><th>Designators</th><th className="num" style={{ width: 70 }}>Here</th><th className="num" style={{ width: 80 }}>Take</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={`${picked.has(r.key) ? 'done' : ''} ${takeOf(r) === 0 ? 'dim' : ''}`}>
                    <td><input type="checkbox" checked={picked.has(r.key)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} /></td>
                    <td>{r.path}</td>
                    <td className="pn"><button className="link mono" onClick={() => r.req.part_id && onOpenPart(r.req.part_id)}>{r.req.pn}</button></td>
                    <td>{r.req.name ?? <span className="muted">{r.req.description}</span>}{r.req.substitute && <span className="badge">substitute</span>}</td>
                    <td className="small muted clip" title={r.req.designators ?? ''}>{r.req.designators}</td>
                    <td className="num muted">{fmtQty(r.available)}</td>
                    <td className="num">
                      <input className="qty-input" value={taken.get(r.key) ?? String(r.suggested)} inputMode="decimal"
                        onChange={(e) => setTaken((m) => new Map(m).set(r.key, e.target.value))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reqs.data && !fitted.length && <p className="empty">This build has no fitted lines to pick.</p>}
            {reqs.data && fitted.length > 0 && !rows.length && <p className="empty">None of the parts are in stock.</p>}
          </div>
        </>
      ) : b.status === 'complete' ? (
        <>
          <p className="small">{buildSummary(b)} built {b.completed_at?.slice(0, 10)}{b.output_path ? ` into ${b.output_path}` : ''}
            {b.unit_cost !== null && <> · {fmtMoney(b.unit_cost, base.data)} each in parts</>}
            {b.bom_status === 'draft' && <> · built from a draft BOM</>}
            {b.notes && <> · {b.notes}</>}</p>
          <table className="grid compact">
            <thead><tr><th style={{ width: 64 }}>PN</th><th>Name</th><th>Designators</th><th>Taken from</th><th className="num">Used</th></tr></thead>
            <tbody>
              {(usage.data ?? []).map((u, i) => (
                <tr key={i} className="clickable" onClick={() => onOpenPart(u.part_id)}>
                  <td className="pn">{u.pn}</td><td>{u.name ?? <span className="muted">{u.description}</span>}{u.substitute ? <span className="badge">substitute</span> : null}</td>
                  <td className="small muted">{u.designators}</td><td className="loc">{u.path}</td><td className="num">{fmtQty(u.qty_used)}</td>
                </tr>
              ))}
              {usage.data && !usage.data.length && <tr><td colSpan={5} className="empty small">No parts were taken from stock.</td></tr>}
            </tbody>
          </table>
        </>
      ) : (
        <p className="small muted">This build was cancelled; no stock was taken.{b.notes ? ` ${b.notes}` : ''}</p>
      )}

      {completing && (
        <CompleteDialog build={b} picks={rows.map((r) => ({ line_no: r.req.line_no, part_id: r.req.part_id!, location_id: r.location_id, qty: takeOf(r) }))}
          problems={{ short: notPicked.length, noPart: noPart.length }}
          onClose={() => setCompleting(false)}
          onDone={(restId) => { setCompleting(false); refresh(); if (restId && onOpenBuild) onOpenBuild(restId); }} />
      )}
    </Modal>
  );
}

/** How many were built and where they go. Building fewer than planned takes parts for that many, and can plan the rest. */
function CompleteDialog({ build: b, picks, problems, onClose, onDone }: {
  build: BuildRow; picks: Array<{ line_no: number; part_id: number; location_id: number; qty: number }>;
  problems: { short: number; noPart: number }; onClose: () => void; onDone: (restId: number | null) => void;
}) {
  const act = useAction();
  const locs = useLoad(() => listLocations(), []);
  const [builtText, setBuiltText] = useState(String(b.qty));
  const [loc, setLoc] = useState<number | null>(b.output_location_id);
  const [planRest, setPlanRest] = useState(true);
  const built = num(builtText);
  const fewer = built !== null && built > 0 && built < b.qty;
  const different = built !== null && built !== b.qty;
  const complete = () => act(async () => {
    if (!built) throw new Error('How many were built?');
    if (!loc) throw new Error('Choose where the finished assemblies go');
    // Built a different number: take what that many need, from the suggested places.
    const take = different
      ? (await requirements(b.id, built)).flatMap((r) => r.picks.map((p) => ({ line_no: r.line_no, part_id: r.part_id!, location_id: p.location_id, qty: p.qty })))
      : picks;
    const { restId } = await completeBuild(b.id, { built, outputLocationId: loc, picks: take, planRest: fewer && planRest });
    onDone(restId);
  }, `Build ${b.code} complete`);

  return (
    <Modal title={`Complete build ${b.code}`} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!built || !loc || problems.noPart > 0} onClick={() => void complete()}>Complete build</button></>}>
      <div className="form-grid">
        <Field label="How many were built"><input className="qty-input" value={builtText} onChange={(e) => setBuiltText(e.target.value)} inputMode="numeric" autoFocus /></Field>
        <Field label="Put them in" wide><LocationPicker value={loc} onChange={setLoc} locations={locs.data ?? []} /></Field>
      </div>
      {fewer && (
        <label className="check small"><input type="checkbox" checked={planRest} onChange={(e) => setPlanRest(e.target.checked)} /> Plan the other {fmtQty(b.qty - built!)} as a new build</label>
      )}
      {different && <p className="small muted">Parts are taken for {fmtQty(built)} from the suggested locations; changes made to the Take column are not used.</p>}
      {problems.noPart > 0 && <p className="small error">{problems.noPart} line{problems.noPart === 1 ? ' has' : 's have'} no part. Resolve {problems.noPart === 1 ? 'it' : 'them'} on the BOM, or choose a substitute, first.</p>}
      {problems.short > 0 && !different && <p className="small warn">{problems.short} line{problems.short === 1 ? ' is' : 's are'} not fully picked. Only what’s on the pick list is taken from stock.</p>}
      {b.rev_status === 'draft' && <p className="small muted">Rev {b.rev} is a draft, so this build is recorded as built from an unreleased BOM.</p>}
      <p className="small muted">The parts come out of stock and the finished {b.assembly_pn} go in, in one step. Completed builds can’t be undone, but stock can be adjusted afterwards.</p>
    </Modal>
  );
}

function SubstituteInput({ onUse }: { onUse: (code: string) => void }) {
  const [v, setV] = useState('');
  return (
    <span className="resolve">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Use another part" onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onUse(v.trim()); }} />
      <button disabled={!v.trim()} onClick={() => onUse(v.trim())}>Use</button>
    </span>
  );
}
