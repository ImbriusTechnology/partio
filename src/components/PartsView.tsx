// Parts: category tree on the left, searchable table in the middle, the selected part on the right.
// Tick rows (shift-click for a range) to archive, mark obsolete, recategorise or delete several at once.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { STATUS_LABEL, deleteOrArchiveParts, listParts, setPartName, setPartsStatus, type PartListRow, type PartStatus } from '../lib/parts.ts';
import { shortcutLabel } from '../lib/platform.ts';
import { listCategories, setPartsCategory, type Category } from '../lib/reference.ts';
import { CategoryManager } from './CategoryManager.tsx';
import { IconChevron, IconPlus } from './icons.tsx';
import { PartDetail } from './PartDetail.tsx';
import { ConfirmButton, Field, Modal, SearchInput, Select, fmtQty, useAction, useLoad, useToast } from './ui.tsx';

export function PartsView({ selectedId, onSelect, onNewPart, refreshKey, onChanged }: {
  selectedId: number | null; onSelect: (id: number | null) => void; onNewPart: () => void; refreshKey: number; onChanged: () => void;
}) {
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [managing, setManaging] = useState(false);
  const [recategorising, setRecategorising] = useState(false);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingName, setEditingName] = useState<number | null>(null);
  const [names, setNames] = useState<Map<number, string | null>>(new Map());   // names edited inline since the last load
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const lastTicked = useRef<number | null>(null);
  const [archived, setArchived] = useState<Array<{ id: number; pn: string; reason: string }> | null>(null);
  const act = useAction();
  const toast = useToast();
  const cats = useLoad(listCategories, [refreshKey]);
  const parts = useLoad(async () => {
    const r = await listParts({ text, categoryId, inStockOnly, showArchived });
    setNames(new Map());
    return r;
  }, [text, categoryId, inStockOnly, showArchived, refreshKey]);
  const rows = parts.data ?? [];
  const category = cats.data?.find((c) => c.id === categoryId);
  useEffect(() => { if (categoryId !== null && cats.data && !category) setCategoryId(null); }, [cats.data, categoryId, category]);
  const filtered = !!text || categoryId !== null || inStockOnly || showArchived;
  const tickedIds = rows.filter((r) => ticked.has(r.id)).map((r) => r.id);    // only rows still on screen
  const plural = (n: number) => `${n} part${n === 1 ? '' : 's'}`;

  const saveName = async (p: PartListRow, value: string, moveBy: number) => {
    const v = value.trim() || null;
    if (v !== (names.has(p.id) ? names.get(p.id) : p.name)) {
      const ok = await act(() => setPartName(p.id, v));
      if (!ok) return;
      setNames((m) => new Map(m).set(p.id, v));
      if (p.id === selectedId) onChanged();
    }
    const i = rows.findIndex((r) => r.id === p.id);
    setEditingName(moveBy && rows[i + moveBy] ? rows[i + moveBy].id : null);
  };

  const tick = (id: number, e: MouseEvent) => {
    e.stopPropagation();
    setTicked((s) => {
      const n = new Set(s);
      const on = !n.has(id);
      if (e.shiftKey && lastTicked.current !== null) {
        const a = rows.findIndex((r) => r.id === lastTicked.current);
        const b = rows.findIndex((r) => r.id === id);
        if (a >= 0 && b >= 0) for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) { if (on) n.add(r.id); else n.delete(r.id); }
      } else if (on) n.add(id); else n.delete(id);
      return n;
    });
    lastTicked.current = id;
  };
  const allTicked = rows.length > 0 && tickedIds.length === rows.length;
  const tickAll = () => setTicked(allTicked ? new Set() : new Set(rows.map((r) => r.id)));

  const setStatus = (status: PartStatus) => act(async () => {
    await setPartsStatus(tickedIds, status);
    setTicked(new Set());
    onChanged();
  }, `${plural(tickedIds.length)} ${status === 'archived' ? 'archived' : `marked ${STATUS_LABEL[status].toLowerCase()}`}`);

  const remove = () => act(async () => {
    const r = await deleteOrArchiveParts(tickedIds);
    setTicked(new Set());
    if (selectedId && tickedIds.includes(selectedId) && !r.archived.some((k) => k.id === selectedId)) onSelect(null);
    onChanged();
    if (r.deleted) toast(`Deleted ${plural(r.deleted)}`);
    if (r.archived.length) setArchived(r.archived);
  });

  const empty = parts.data && rows.length === 0 && !filtered;

  return (
    <div className="parts-view">
      <aside className="cat-tree">
        <div className={`cat ${categoryId === null ? 'sel' : ''}`} onClick={() => setCategoryId(null)}>All parts</div>
        {cats.data && <CategoryTree cats={cats.data} selected={categoryId} onSelect={setCategoryId} />}
        <button className="link small manage" onClick={() => setManaging(true)}>{cats.data?.length ? 'Manage categories…' : 'Add categories…'}</button>
      </aside>
      {managing && <CategoryManager initialId={categoryId} onClose={() => setManaging(false)} onChanged={onChanged} />}
      {recategorising && cats.data && (
        <SetCategoryDialog count={tickedIds.length} cats={cats.data} onClose={() => setRecategorising(false)}
          onSave={(cid) => void act(async () => { await setPartsCategory(tickedIds, cid); setRecategorising(false); setTicked(new Set()); onChanged(); },
            `${plural(tickedIds.length)} moved`)} />
      )}
      <section className="parts-list">
        <div className="toolbar">
          <SearchInput className="search" placeholder="Search PN, name, description, MPN, SKU, value, package…" value={text} onChange={setText} />
          <label className="check"><input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} /> In stock</label>
          <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          <button className="primary" onClick={onNewPart} title={`New part (${shortcutLabel('N')})`}><IconPlus /> New part</button>
        </div>
        {(category || filtered) && (
          <div className="filter-bar">
            {category && <span className="chip">{category.path}<button className="chip-x" onClick={() => setCategoryId(null)} aria-label="Clear category">×</button></span>}
            {filtered && <button className="link" onClick={() => { setText(''); setCategoryId(null); setInStockOnly(false); setShowArchived(false); }}>Clear all filters</button>}
          </div>
        )}
        {tickedIds.length > 0 && (
          <div className="bulk-bar">
            <b>{tickedIds.length} selected</b>
            <button onClick={() => void setStatus('archived')} title="Hide from lists and search; scans and old BOMs still find it">Archive</button>
            <button onClick={() => void setStatus('obsolete')} title="Still listed, flagged as not for new designs">Mark obsolete</button>
            <button onClick={() => void setStatus('active')}>Make active</button>
            <button onClick={() => setRecategorising(true)}>Set category…</button>
            <ConfirmButton className="danger" label="Delete…" confirmLabel={`Delete ${tickedIds.length}? Click again`} onConfirm={() => void remove()} />
            <span className="spacer" />
            <button className="link" onClick={() => setTicked(new Set())}>Clear selection</button>
          </div>
        )}
        <div className="table-wrap">
          <table className={`grid parts-table ${tickedIds.length ? 'ticking' : ''}`}>
            <colgroup>
              <col style={{ width: 30 }} /><col style={{ width: 62 }} /><col style={{ width: '15%' }} /><col className="desc-col" />
              <col style={{ width: 92 }} /><col style={{ width: 84 }} /><col style={{ width: 62 }} /><col style={{ width: '15%' }} />
            </colgroup>
            <thead><tr>
              <th className="tick"><input type="checkbox" checked={allTicked} onChange={tickAll} title="Select all shown" /></th>
              <th>PN</th><th title="Double-click a name to edit it">Name</th><th>Description</th><th>Value</th><th>Package</th><th className="num">Stock</th><th>Location</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const name = names.has(p.id) ? names.get(p.id) : p.name;
                return (
                  <tr key={p.id} className={`${p.id === selectedId ? 'sel' : ''} ${ticked.has(p.id) ? 'ticked' : ''} ${p.status === 'archived' ? 'dim' : ''}`} onClick={() => onSelect(p.id)}>
                    <td className="tick" onClick={(e) => tick(p.id, e)}><input type="checkbox" checked={ticked.has(p.id)} readOnly /></td>
                    <td className="pn">{p.pn}</td>
                    <td className="name-cell" onDoubleClick={(e) => { e.stopPropagation(); setEditingName(p.id); }}>
                      {editingName === p.id
                        ? <NameInput initial={name ?? ''} onDone={(v, move) => void saveName(p, v, move)} onCancel={() => setEditingName(null)} />
                        : name ?? ''}
                    </td>
                    <td className="clip" title={p.description}>{p.status !== 'active' && <span className={`badge ${p.status}`}>{STATUS_LABEL[p.status]}</span>}{p.description}</td>
                    <td className="clip">{[p.value_text, p.tolerance_pct !== null ? `${p.tolerance_pct}%` : null].filter(Boolean).join(' · ')}</td>
                    <td className="clip">{p.package ?? ''}</td>
                    <td className="num"><span className={`qty-pill ${p.on_hand > 0 ? 'in' : 'out'}`}>{fmtQty(p.on_hand)}</span></td>
                    <td className="loc clip" title={p.location ?? ''}>{p.location ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {parts.error && <p className="error">{parts.error}</p>}
          {empty && (
            <div className="empty">
              <p>No parts yet.</p>
              <button className="primary" onClick={onNewPart}><IconPlus /> Add your first part</button>
            </div>
          )}
          {parts.data && rows.length === 0 && filtered && <p className="empty">No parts match.</p>}
        </div>
        <div className="statusline">{parts.data ? <><b>{rows.length.toLocaleString()}</b> parts <span className="hint">Double-click a name to edit · tick rows to archive or delete</span></> : 'Loading…'}</div>
      </section>
      <section className="detail-pane">
        {selectedId
          ? <PartDetail id={selectedId} refreshKey={refreshKey} onChanged={onChanged} onOpenPart={onSelect} onDeleted={() => onSelect(null)} />
          : <p className="empty">Select a part, or press {shortcutLabel('K')} to find one.</p>}
      </section>
      {archived && (
        <Modal title={`${plural(archived.length)} archived instead of deleted`} onClose={() => setArchived(null)} wide
          footer={<><span className="spacer" /><button className="primary" onClick={() => setArchived(null)}>OK</button></>}>
          <p className="small">These have stock, history or other uses, so deleting them would leave holes in old records.
            They’ve been archived: hidden from lists and search, but scans and old BOMs still find them.</p>
          <table className="grid compact">
            <tbody>{archived.map((k) => <tr key={k.id}><td className="pn">{k.pn}</td><td>{k.reason}</td></tr>)}</tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}

/** Inline name editor: Enter saves and moves to the next row, Shift+Enter moves up, Tab saves, Escape cancels. */
function NameInput({ initial, onDone, onCancel }: { initial: string; onDone: (v: string, moveBy: number) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const finished = useRef(false);                       // a blur after Enter/Escape must not act again
  const finish = (fn: () => void) => { if (finished.current) return; finished.current = true; fn(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(() => onDone(v, e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(() => onDone(v, 0)); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(onCancel); }
  };
  return <input className="name-input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={onKey}
    onBlur={() => finish(() => onDone(v, 0))} onClick={(e) => e.stopPropagation()} />;
}

function CategoryTree({ cats, selected, onSelect }: { cats: Category[]; selected: number | null; onSelect: (id: number) => void }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const children = useMemo(() => {
    const m = new Map<number | null, Category[]>();
    for (const c of cats) m.set(c.parent_id, [...(m.get(c.parent_id) ?? []), c]);
    return m;
  }, [cats]);
  const total = useMemo(() => {
    const t = new Map<number, number>();
    const sum = (c: Category): number => {
      const n = c.parts + (children.get(c.id) ?? []).reduce((s, k) => s + sum(k), 0);
      t.set(c.id, n);
      return n;
    };
    for (const r of children.get(null) ?? []) sum(r);
    return t;
  }, [children]);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const render = (parent: number | null, depth: number): ReactNode => (children.get(parent) ?? []).map((c) => {
    const kids = children.get(c.id) ?? [];
    const isOpen = open.has(c.id);
    return (
      <div key={c.id}>
        <div className={`cat ${selected === c.id ? 'sel' : ''} ${total.get(c.id) ? '' : 'dim'}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(c.id)}>
          {kids.length > 0
            ? <span className="twisty" onClick={(e) => { e.stopPropagation(); toggle(c.id); }}><IconChevron open={isOpen} /></span>
            : <span className="twisty" />}
          {c.name} <span className="count">{total.get(c.id) || ''}</span>
        </div>
        {isOpen && render(c.id, depth + 1)}
      </div>
    );
  });
  return <>{render(null, 0)}</>;
}

function SetCategoryDialog({ count, cats, onClose, onSave }: { count: number; cats: Category[]; onClose: () => void; onSave: (id: number | null) => void }) {
  const [cid, setCid] = useState<number | null>(null);
  return (
    <Modal title={`Set category for ${count} part${count === 1 ? '' : 's'}`} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(cid)}>Move</button></>}>
      <Field label="Category" wide><Select value={cid} onChange={setCid} empty="(no category)" options={cats.map((c) => ({ value: c.id, label: c.path }))} /></Field>
    </Modal>
  );
}
