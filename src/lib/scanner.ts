// Barcode / QR scanners that act as a keyboard ("keyboard wedge") type a whole code in a few milliseconds,
// usually followed by Enter. This tells such a burst apart from a person typing. Works the same on every platform.

export interface ScannerOptions {
  onScan: (code: string) => void;
  maxGapMs?: number;      // longest pause between characters within one scan
  minLength?: number;
}

export interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; inField: boolean }

/**
 * The scan detector itself, free of the browser so it can be tested. Feed it every key press with the time;
 * it returns true when the key belongs to a scan (so the app should not act on it as a shortcut or typing).
 * `tick(now)` must be called when no key has come for a while, for scanners set to send no Enter.
 */
export function createScanDetector({ onScan, maxGapMs = 40, minLength = 3 }: ScannerOptions) {
  let buf = '';
  let last = -Infinity;
  const finish = () => {
    const code = buf.replace(/^\][A-Za-z]\d/, '').trim();   // drop an AIM symbology prefix such as ]Q1 if the scanner adds one
    buf = '';
    if (code.length >= minLength) onScan(code);
  };
  return {
    key(e: KeyLike, now: number): boolean {
      if (e.metaKey || e.ctrlKey || e.altKey || e.inField) { buf = ''; return false; }
      if (now - last > maxGapMs) buf = '';
      last = now;
      if (e.key === 'Enter' || e.key === 'Tab') {
        const scan = buf.length >= minLength;
        if (scan) finish();
        buf = '';
        return scan;
      }
      if (e.key.length !== 1) return false;
      buf += e.key;
      return buf.length >= 2;   // part of a scan: don't let it trigger anything else
    },
    tick(now: number): void {
      if (buf && now - last > maxGapMs * 3) {
        if (buf.length >= minLength) finish();
        else buf = '';
      }
    },
  };
}

/** Listen for scans while focus isn't in a text field (where a scan is just typing). Returns a function to stop. */
export function listenForScans(options: ScannerOptions): () => void {
  const d = createScanDetector(options);
  const gap = options.maxGapMs ?? 40;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inField = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  };
  const onKey = (e: KeyboardEvent) => {
    const scan = d.key({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, inField: inField(e.target) }, performance.now());
    if (scan) e.preventDefault();
    clearTimeout(timer);
    timer = setTimeout(() => d.tick(performance.now()), gap * 3 + 5);
  };
  window.addEventListener('keydown', onKey, true);
  return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(timer); };
}

/** What a scanned code names: a location code (L0042) or anything a part can be found by (PN, MPN, vendor part number). */
export function scanTarget(code: string): { kind: 'location'; code: string } | { kind: 'part'; codes: string[] } {
  const c = code.trim();
  if (/^L\d+$/i.test(c)) return { kind: 'location', code: c.toUpperCase() };
  // A short number is tried as written and as a 5-digit PN (some labels drop the leading zeros).
  return { kind: 'part', codes: /^\d{1,4}$/.test(c) ? [c, c.padStart(5, '0')] : [c] };
}
