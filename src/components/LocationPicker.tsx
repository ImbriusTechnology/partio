// Choosing a storage location by typing: "B06" finds "Drawer 1 > B06", a location code (L0056, or a scanned
// location label) finds that location, and several words narrow it down ("dr1 b0").
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Location } from '../lib/locations.ts';

type Loc = Pick<Location, 'id' | 'path' | 'name' | 'code'>;

const RECENT_KEY = 'recent_locations';
function recentIds(): number[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
}
function remember(id: number) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 8))); } catch { /* not kept */ }
}

/** How well a location matches what was typed (lower is better), or null if it doesn't. */
export function matchScore(l: Loc, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 3;
  const name = l.name.toLowerCase(), path = l.path.toLowerCase(), code = (l.code ?? '').toLowerCase();
  if (code && q === code) return 0;
  if (name === q) return 0;
  const squash = (s: string) => s.replace(/[\s>_-]+/g, '');
  const segs = path.split(' > ').map(squash);
  // "dr3" for "Drawer 3": starts like the segment and the rest of its letters follow in order
  const abbrev = (t: string, seg: string) => {
    if (t.length < 2 || seg[0] !== t[0]) return false;
    let i = 1;
    for (const ch of seg.slice(1)) if (ch === t[i]) i++;
    return i === t.length;
  };
  const tokens = q.split(/\s+/).filter(Boolean);
  // every word must appear somewhere in the path (spaces and ">" ignored): "B06", "drawer 1 b06", "dr3 3c"
  if (!tokens.every((t) => path.includes(t) || squash(path).includes(squash(t)) || code.includes(t) || segs.some((g) => abbrev(squash(t), g)))) return null;
  if (name.startsWith(q)) return 1;
  if (path.split(' > ').some((seg) => seg.startsWith(tokens[tokens.length - 1]))) return 2;
  return 3;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function LocationPicker({ value, onChange, locations, allowEmpty, emptyLabel = 'None', placeholder = 'Type to find a location…', notes, autoFocus }: {
  value: number | null; onChange: (id: number | null) => void; locations: Loc[];
  allowEmpty?: boolean; emptyLabel?: string; placeholder?: string;
  notes?: Map<number, string>;   // shown beside a location, e.g. "has 120"; these are also suggested first
  autoFocus?: boolean;
}) {
  const selected = locations.find((l) => l.id === value) ?? null;
  const [text, setText] = useState<string | null>(null);   // null = not editing; shows the chosen location
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = text !== null;

  const options = useMemo(() => {
    if (!open) return [];
    const q = text ?? '';
    if (!q.trim()) {
      // nothing typed: the locations with notes (where this part is), then recently used, then the rest
      const rec = recentIds();
      const first = [...(notes?.keys() ?? [])], second = rec.filter((id) => !notes?.has(id));
      const byId = new Map(locations.map((l) => [l.id, l]));
      const top = [...first, ...second].map((id) => byId.get(id)).filter((l): l is Loc => !!l);
      const rest = locations.filter((l) => !top.includes(l));
      return [...top, ...rest].slice(0, 200);
    }
    return locations.map((l) => ({ l, s: matchScore(l, q) })).filter((x) => x.s !== null)
      .sort((a, b) => a.s! - b.s! || natural(a.l.path, b.l.path)).map((x) => x.l).slice(0, 200);
  }, [open, text, locations, notes]);

  useEffect(() => { setHi(0); }, [text]);
  useEffect(() => { list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const choose = (l: Loc | null) => {
    if (l) remember(l.id);
    onChange(l ? l.id : null);
    setText(null);
    input.current?.blur();
  };
  const finish = () => {
    // leaving the box: an emptied box clears the choice (where allowed); otherwise keep what was chosen
    if (text !== null && !text.trim() && allowEmpty) onChange(null);
    setText(null);
  };

  return (
    <div className="loc-picker">
      <input ref={input} value={open ? text! : selected?.path ?? ''} placeholder={open ? selected?.path ?? placeholder : allowEmpty ? emptyLabel : placeholder}
        autoFocus={autoFocus} spellCheck={false} autoComplete="off"
        onFocus={(e) => { setText(''); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTimeout(finish, 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (options[hi]) choose(options[hi]); else if (allowEmpty && !text?.trim()) choose(null); }
          else if (e.key === 'Escape') { e.stopPropagation(); setText(null); input.current?.blur(); }
        }} />
      {selected && !open && notes?.get(selected.id) && <span className="loc-note">{notes.get(selected.id)}</span>}
      {open && (
        <div className="loc-options" ref={list}>
          {allowEmpty && !text?.trim() && (
            <div className="loc-option muted" onMouseDown={(e) => { e.preventDefault(); choose(null); }}>{emptyLabel}</div>
          )}
          {options.length === 0 && <div className="loc-option muted">No location matches “{text}”</div>}
          {options.map((l, i) => (
            <div key={l.id} className={`loc-option ${i === hi ? 'sel' : ''} ${l.id === value ? 'chosen' : ''}`}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); choose(l); }}>
              <span className="loc-path">{l.path.includes(' > ') ? <><span className="muted">{l.path.slice(0, l.path.lastIndexOf(' > ') + 3)}</span>{l.name}</> : l.name}</span>
              {notes?.get(l.id) && <span className="loc-note">{notes.get(l.id)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
