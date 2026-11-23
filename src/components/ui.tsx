// Small shared UI pieces: modal dialogs, form fields, toasts, async loading.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ------------------------------------------------------------------ toasts

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
const ToastContext = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

/** Run an async action, report errors as a toast, return whether it worked. */
export function useAction() {
  const toast = useToast();
  return useCallback(async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    try {
      await fn();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(String((e as Error)?.message ?? e), 'error');
      return false;
    }
  }, [toast]);
}

// ------------------------------------------------------------------ data loading

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) { setData(d); setError(null); } }, (e) => { if (live) setError(String(e?.message ?? e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ------------------------------------------------------------------ modal

/** A dialog. `sticky` ones (long forms) only close from their own buttons, never from Escape or a click outside. */
export function Modal({ title, onClose, children, footer, wide, xwide, sticky }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; xwide?: boolean; sticky?: boolean;
}) {
  useEffect(() => {
    if (sticky) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, sticky]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (!sticky && e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''}`} role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">×</button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fields

export function Field({ label, children, hint, wide, wide2, wide3 }: { label: string; children: ReactNode; hint?: string; wide?: boolean; wide2?: boolean; wide3?: boolean }) {
  return (
    <label className={`field ${wide ? 'wide' : ''} ${wide2 ? 'wide2' : ''} ${wide3 ? 'wide3' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Select<T extends string | number>({ value, onChange, options, empty }: {
  value: T | null; onChange: (v: T | null) => void; options: Array<{ value: T; label: string }>; empty?: string;
}) {
  return (
    <select value={value === null ? '' : String(value)} onChange={(e) => {
      const raw = e.target.value;
      if (raw === '') return onChange(null);
      const hit = options.find((o) => String(o.value) === raw);
      onChange(hit ? hit.value : null);
    }}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

/** A text input with suggestions from a list (manufacturers, vendors). */
export function Combo({ value, onChange, options, placeholder, autoFocus }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder?: string; autoFocus?: boolean;
}) {
  const id = useRef(`combo-${Math.random().toString(36).slice(2)}`).current;
  return (
    <>
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

/** A search box with a clear (×) button; Escape also clears it. */
export function SearchInput({ value, onChange, placeholder, autoFocus, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; className?: string;
}) {
  return (
    <div className={`search-box ${className ?? ''}`}>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }} />
      {value && <button className="clear" onClick={() => onChange('')} aria-label="Clear search" title="Clear">×</button>}
    </div>
  );
}

/** A button that needs a second click to act (instead of a browser confirm dialog). */
export function ConfirmButton({ label, confirmLabel, onConfirm, className }: { label: string; confirmLabel?: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button className={`${className ?? ''} ${armed ? 'armed' : ''}`} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel ?? 'Click again to confirm' : label}
    </button>
  );
}

export const num = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export const fmtQty = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 });

export const fmtMoney = (n: number | null | undefined, currency = 'USD') =>
  n === null || n === undefined ? '' : `${currency} ${n < 1 ? n.toFixed(4).replace(/0{1,2}$/, '') : n.toFixed(2)}`;

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
