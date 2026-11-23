// Quick find (⌘K / Ctrl+K): type "10k 0603 1%" and get matching parts with stock.
// Enter copies the PN (to paste into a schematic tool); ⌘/Ctrl+Enter opens the part.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { quickFind, type PartListRow, type QuickQuery } from '../lib/parts.ts';
import { isMac, shortcutLabel } from '../lib/platform.ts';
import { formatValue } from '../lib/values.ts';
import { IconSearch } from './icons.tsx';
import { copyText, fmtQty, useToast } from './ui.tsx';

export function QuickFind({ onClose, onOpenPart, onNewPart }: {
  onClose: () => void; onOpenPart: (id: number) => void; onNewPart: (hint: string) => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PartListRow[]>([]);
  const [parsed, setParsed] = useState<QuickQuery | null>(null);
  const [sel, setSel] = useState(0);
  const toast = useToast();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      if (!q.trim()) { setRows([]); setParsed(null); return; }
      try {
        const r = await quickFind(q);
        if (live) { setRows(r.rows); setParsed(r.parsed); setSel(0); }
      } catch (e) { if (live) toast(String((e as Error).message ?? e), 'error'); }
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q, toast]);

  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const copy = async (r: PartListRow) => {
    try {
      await copyText(r.pn);
      toast(`Copied ${r.pn}`);
    } catch {
      toast(`Couldn’t copy ${r.pn}`, 'error');
    }
    onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && rows[sel]) {
      e.preventDefault();
      if (isMac ? e.metaKey : e.ctrlKey) { onOpenPart(rows[sel].id); onClose(); } else void copy(rows[sel]);
    } else if (e.key === 'Escape') onClose();
  };

  const chips: string[] = [];
  if (parsed?.value) chips.push(`value ${formatValue(parsed.value.num, parsed.value.unit)}`);
  if (parsed?.packages) chips.push(`package ${parsed.packages.text}`);
  if (parsed?.tolerance !== undefined) chips.push(`≤ ${parsed.tolerance}%`);
  if (parsed?.words.length) chips.push(`text “${parsed.words.join(' ')}”`);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="quickfind" role="dialog" aria-label="Quick find">
        <div className="qf-input">
          <IconSearch size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Find a part: 10k 0603 1%, 100n 0805, schottky SMA, LM358, 00042…" />
        </div>
        {chips.length > 0 && <div className="chips">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
        <div className="qf-results" ref={listRef}>
          {rows.map((r, i) => (
            <div key={r.id} className={`qf-row ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => void copy(r)}>
              <span className="pn">{r.pn}</span>
              <span className="desc">{r.name ? <b>{r.name} </b> : null}{r.description}</span>
              <span className={`qty ${r.on_hand > 0 ? '' : 'zero'}`}>{fmtQty(r.on_hand)}</span>
              <span className="loc">{r.location ?? ''}</span>
            </div>
          ))}
          {q.trim() && rows.length === 0 && (
            <div className="qf-empty">
              No match.{' '}
              <button className="link" onClick={() => { onNewPart(q); onClose(); }}>Create a new part…</button>
            </div>
          )}
        </div>
        <div className="qf-help">↑↓ choose · Enter copies the PN · {shortcutLabel('Enter')} opens the part · Esc closes</div>
      </div>
    </div>
  );
}
