// Locations: the storage tree (collapsible), what is in each place, and adding/renaming places.
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { addLocation, listLocations, partsInLocation, removeBlocker, removeLocation, restoreLocation, updateLocation, type Location } from '../lib/locations.ts';
import { moveStockGroup } from '../lib/stock.ts';
import { IconChevron, IconPlus } from './icons.tsx';
import { matchScore } from './LocationPicker.tsx';
import { ConfirmButton, Field, Modal, SearchInput, Select, fmtQty, useAction, useLoad, useToast } from './ui.tsx';

export function LocationsView({ onOpenPart, focus, refreshKey, onChanged }: {
  onOpenPart: (id: number) => void; focus?: { id: number; n: number } | null; refreshKey: number; onChanged: () => void;
}) {
  const [showRemoved, setShowRemoved] = useState(false);
  const locs = useLoad(() => listLocations(showRemoved), [refreshKey, showRemoved]);
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ mode: 'add' | 'edit'; parent: Location | null; loc?: Location } | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const act = useAction();
  const all = locs.data ?? [];
  const sel = all.find((l) => l.id === selected) ?? null;
  // Asked to show a location (e.g. its label was scanned): select it and open the branches above it.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focus || focus.n === handledFocus.current) return;
    const target = all.find((l) => l.id === focus.id);
    if (!target) return;
    handledFocus.current = focus.n;
    setFilter('');
    setSelected(target.id);
    setOpen((o) => new Set([...o, ...all.filter((l) => target.path.startsWith(l.path + ' > ')).map((l) => l.id)]));
    setTimeout(() => document.querySelector(`[data-loc-id="${target.id}"]`)?.scrollIntoView({ block: 'center' }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n, locs.data]);
  const contents = useLoad(() => (selected ? partsInLocation(selected) : Promise.resolve([])), [selected, refreshKey]);
  const blocker = useLoad(() => (selected ? removeBlocker(selected) : Promise.resolve(null)), [selected, refreshKey]);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const lastTicked = useRef<number | null>(null);
  const [moving, setMoving] = useState(false);
  useEffect(() => { setTicked(new Set()); lastTicked.current = null; }, [selected]);
  const rows = contents.data ?? [];
  const tickedIds = rows.filter((r) => ticked.has(r.id)).map((r) => r.id);
  const allTicked = rows.length > 0 && tickedIds.length === rows.length;
  const tick = (id: number, e: MouseEvent) => {
    e.stopPropagation();
    setTicked((s) => {
      const n = new Set(s);
      const on = !n.has(id);
      if (e.shiftKey && lastTicked.current !== null) {
        const a = rows.findIndex((r) => r.id === lastTicked.current), b = rows.findIndex((r) => r.id === id);
        if (a >= 0 && b >= 0) for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) { if (on) n.add(r.id); else n.delete(r.id); }
      } else if (on) n.add(id); else n.delete(id);
      return n;
    });
    lastTicked.current = id;
  };

  const children = useMemo(() => {
    const m = new Map<number | null, Location[]>();
    for (const l of all) { if (!m.has(l.parent_id)) m.set(l.parent_id, []); m.get(l.parent_id)!.push(l); }
    return m;
  }, [all]);
  const totals = useMemo(() => {
    const t = new Map<number, number>();
    const sum = (l: Location): number => { const n = l.parts + (children.get(l.id) ?? []).reduce((s, k) => s + sum(k), 0); t.set(l.id, n); return n; };
    for (const r of children.get(null) ?? []) sum(r);
    return t;
  }, [children]);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const expandAll = () => setOpen(new Set(all.filter((l) => children.has(l.id)).map((l) => l.id)));
  const select = (l: Location) => {
    setSelected(l.id);
    // make sure its parents are open so it stays visible
    setOpen((s) => { const n = new Set(s); let p = l.parent_id; while (p) { n.add(p); p = all.find((x) => x.id === p)?.parent_id ?? null; } return n; });
  };

  const q = filter.trim().toLowerCase();
  const matches = q ? all.filter((l) => l.path.toLowerCase().includes(q) || l.code.toLowerCase() === q) : [];

  const renderTree = (parent: number | null, depth: number): ReactNode => (children.get(parent) ?? []).map((l) => {
    const kids = children.get(l.id) ?? [];
    const isOpen = open.has(l.id);
    return (
      <div key={l.id}>
        <div data-loc-id={l.id} className={`list-item loc-item ${selected === l.id ? 'sel' : ''} ${l.archived ? 'dim' : ''}`} style={{ paddingLeft: 6 + depth * 16 }} onClick={() => setSelected(l.id)}>
          {kids.length > 0
            ? <span className="twisty" onClick={(e) => { e.stopPropagation(); toggle(l.id); }}><IconChevron open={isOpen} /></span>
            : <span className="twisty" />}
          <span>{l.name}</span> <span className="muted small">{l.code}{l.archived ? ' · removed' : ''}</span>
          <span className="count">{totals.get(l.id) || ''}</span>
        </div>
        {isOpen && renderTree(l.id, depth + 1)}
      </div>
    );
  });

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="row">
          <SearchInput className="search" placeholder="Filter by name or code" value={filter} onChange={setFilter} />
          <button onClick={() => setEditing({ mode: 'add', parent: null })} title="Add a top-level location">Add</button>
        </div>
        <div className="row small">
          {!q && <button className="link" onClick={expandAll}>Expand all</button>}
          {!q && <button className="link" onClick={() => setOpen(new Set())}>Collapse all</button>}
          <span className="spacer" />
          <label className="check"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed</label>
        </div>
        {q
          ? matches.map((l) => (
            <div key={l.id} className={`list-item loc-item ${selected === l.id ? 'sel' : ''}`} onClick={() => { select(l); }}>
              <span>{l.path}</span> <span className="muted small">{l.code}</span><span className="count">{l.parts || ''}</span>
            </div>))
          : renderTree(null, 0)}
        {q && matches.length === 0 && <p className="empty">No locations match.</p>}
      </aside>
      <section className="main-pane">
        {sel ? (
          <>
            <div className="toolbar">
              <h2>{sel.path} <span className="muted small">{sel.code}</span></h2>
              <span className="spacer" />
              {sel.archived
                ? <button onClick={() => void act(async () => { await restoreLocation(sel.id); onChanged(); }, `${sel.path} restored`)}>Restore</button>
                : <>
                  <button onClick={() => setEditing({ mode: 'add', parent: sel })}>Add inside</button>
                  <button onClick={() => setEditing({ mode: 'edit', parent: null, loc: sel })} title="Rename it, or move it inside another location">Edit</button>
                  {blocker.data
                    ? <button className="danger" disabled title={`Can't remove: ${blocker.data}`}>Remove</button>
                    : <ConfirmButton label="Remove" confirmLabel="Click again to remove" className="danger"
                        onConfirm={() => void act(async () => {
                          const how = await removeLocation(sel.id);
                          if (!showRemoved) setSelected(null);
                          onChanged();
                          toast(how === 'deleted' ? `${sel.path} deleted` : `${sel.path} removed (kept in stock history; tick "Show removed" to restore)`);
                        })} />}
                </>}
            </div>
            {sel.description && <p className="muted pad">{sel.description}</p>}
            {sel.archived ? <p className="archived-note pad-x">Removed: hidden from the tree and from location pickers. Old stock records still refer to it.</p> : null}
            {!sel.archived && blocker.data && <p className="muted small pad">To remove this location: it {blocker.data}.</p>}
            {tickedIds.length > 0 && (
              <div className="bulk-bar">
                <b>{tickedIds.length} selected</b>
                <button className="primary" onClick={() => setMoving(true)}>Move selected to…</button>
                <span className="spacer" />
                <button className="link" onClick={() => setTicked(new Set())}>Clear selection</button>
              </div>
            )}
            <div className="table-wrap">
              <table className="grid">
                <thead><tr>
                  <th className="tick">{rows.length > 0 && <input type="checkbox" checked={allTicked} title="Select all"
                    onChange={() => setTicked(allTicked ? new Set() : new Set(rows.map((r) => r.id)))} />}</th>
                  <th>PN</th><th>Name</th><th>Description</th><th>Value</th><th>Package</th><th className="num">Here</th><th className="num">Total</th>
                </tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className={`clickable ${ticked.has(p.id) ? 'ticked' : ''}`} onClick={() => onOpenPart(p.id)}>
                      <td className="tick" onClick={(e) => tick(p.id, e)}><input type="checkbox" checked={ticked.has(p.id)} readOnly /></td>
                      <td className="pn">{p.pn}</td><td>{p.name ?? ''}</td><td>{p.description}</td><td>{p.value_text ?? ''}</td><td>{p.package ?? ''}</td>
                      <td className="num">{fmtQty(p.qty)}</td><td className="num muted">{fmtQty(p.on_hand)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {contents.data?.length === 0 && <p className="empty">Nothing stored here.</p>}
            </div>
            {rows.length > 0 && <div className="statusline">Tick parts (shift-click for a range) to move them together. Click a row to open the part.</div>}
          </>
        ) : all.length === 0 && locs.data ? (
          <div className="empty">
            <p>No locations yet. Start with the big things (a cabinet, a shelf), then add the drawers and bins inside them.</p>
            <button className="primary" onClick={() => setEditing({ mode: 'add', parent: null })}><IconPlus /> Add a location</button>
          </div>
        ) : <p className="empty">Choose a location.</p>}
      </section>
      {moving && sel && (
        <MoveDialog from={sel} count={tickedIds.length} locations={all.filter((l) => !l.archived && l.id !== sel.id)} onClose={() => setMoving(false)}
          onMove={(toId, followUsual) => void act(async () => {
            const n = await moveStockGroup(tickedIds, sel.id, toId, followUsual);
            setMoving(false);
            setTicked(new Set());
            onChanged();
            toast(`Moved ${n} part${n === 1 ? '' : 's'} to ${all.find((l) => l.id === toId)?.path ?? 'the new location'}`);
          })} />
      )}
      {editing && (
        <LocationDialog editing={editing} locations={all.filter((l) => !l.archived)} onClose={() => setEditing(null)}
          onSave={(name, description, parentId) => act(async () => {
            if (editing.mode === 'add') {
              const id = await addLocation(editing.parent?.id ?? null, name, description);
              if (editing.parent) setOpen((s) => new Set(s).add(editing.parent!.id));
              setSelected(id);
            } else if (editing.loc) {
              await updateLocation(editing.loc.id, { name, description, parent_id: parentId });
              if (parentId) setOpen((s) => new Set(s).add(parentId));
            }
            setEditing(null);
            onChanged();
          }, 'Saved')} />
      )}
    </div>
  );
}

function LocationDialog({ editing, locations, onClose, onSave }: {
  editing: { mode: 'add' | 'edit'; parent: Location | null; loc?: Location }; locations: Location[]; onClose: () => void;
  onSave: (name: string, description: string | null, parentId: number | null) => void;
}) {
  const [name, setName] = useState(editing.loc?.name ?? '');
  const [description, setDescription] = useState(editing.loc?.description ?? '');
  const [parentId, setParentId] = useState<number | null>(editing.loc?.parent_id ?? null);
  const self = editing.loc;
  // A location can't go inside itself or anything inside it.
  const parents = locations.filter((l) => !self || (l.id !== self.id && !l.path.startsWith(`${self.path} > `)));
  const title = editing.mode === 'add' ? (editing.parent ? `Add inside ${editing.parent.path}` : 'Add a top-level location') : `Edit ${self?.path}`;
  const submit = () => onSave(name, description || null, parentId);
  return (
    <Modal title={title} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={submit}>Save</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} /></Field>
        <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {editing.mode === 'edit' && (
          <Field label="Inside" wide hint="Everything inside it moves too">
            <Select value={parentId} onChange={setParentId} empty="(top level)" options={parents.map((l) => ({ value: l.id, label: l.path }))} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Pick a destination by typing part of its name or code. */
function MoveDialog({ from, count, locations, onClose, onMove }: {
  from: Location; count: number; locations: Location[]; onClose: () => void; onMove: (toId: number, followUsual: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [to, setTo] = useState<number | null>(null);
  const [followUsual, setFollowUsual] = useState(true);
  // same matching as the location picker: "B06", a code, or several words like "dr1 b0"
  const shown = locations.filter((l) => l.id !== from.id).map((l) => ({ l, s: matchScore(l, q) })).filter((x) => x.s !== null)
    .sort((a, b) => a.s! - b.s! || a.l.path.localeCompare(b.l.path, undefined, { numeric: true })).map((x) => x.l).slice(0, 200);
  const dest = locations.find((l) => l.id === to);
  return (
    <Modal title={`Move ${count} part${count === 1 ? '' : 's'} out of ${from.path}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!to} onClick={() => to && onMove(to, followUsual)}>{dest ? `Move to ${dest.path}` : 'Choose a location'}</button></>}>
      <p className="small">Everything held here for the ticked parts moves to the location you choose.</p>
      <SearchInput value={q} onChange={(v) => { setQ(v); setTo(null); }} placeholder="Type to find a location (name or code)" autoFocus />
      <div className="pick-list">
        {shown.map((l) => (
          <div key={l.id} className={`list-item ${to === l.id ? 'sel' : ''}`} onClick={() => setTo(l.id)} onDoubleClick={() => onMove(l.id, followUsual)}>
            {l.path} <span className="muted small">{l.code}</span>
          </div>
        ))}
        {shown.length === 0 && <p className="empty">No location matches.</p>}
      </div>
      <label className="check"><input type="checkbox" checked={followUsual} onChange={(e) => setFollowUsual(e.target.checked)} /> Make the new place their usual location (for parts that usually lived here)</label>
    </Modal>
  );
}
