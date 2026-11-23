// Parsing and formatting of component values ("4K7", "100n", "2.2 µF", "1M2", "R025").
// Self-contained (no imports) so it can be used anywhere, including tests and import code.

export type Unit = 'Ω' | 'F' | 'H' | 'Hz' | 'V' | 'A' | 'W';

export interface ParsedValue {
  num: number;          // in SI base units
  unit: Unit | null;    // from the text, or from the hint when the text has none
}

const PREFIX: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};

const UNIT_WORDS: Array<[RegExp, Unit]> = [
  [/^(Ω|ohms?|R)$/i, 'Ω'],
  [/^F$/i, 'F'],
  [/^H$/i, 'H'],
  [/^Hz$/i, 'Hz'],
  [/^V$/i, 'V'],
  [/^A$/i, 'A'],
  [/^W$/i, 'W'],
];

function unitFrom(word: string): Unit | null {
  for (const [re, u] of UNIT_WORDS) if (re.test(word)) return u;
  return null;
}

/** Round away floating-point noise: 4.7 * 1e3 -> 4700, not 4700.000000000001. */
function clean(n: number): number {
  return Number.parseFloat(n.toPrecision(12));
}

/**
 * Parse a value. Accepts engineering notation ("4.7 kΩ", "100 nF", "12MHz", "3.3V")
 * and RKM codes where the letter is the decimal point ("4K7", "1M2", "5R6", "R025", "2u2", "4n7").
 * `hint` is the unit implied by the category (a resistor's "1M" is 1 MΩ; a bare "100n" on a capacitor is F).
 */
export function parseValue(raw: string | null | undefined, hint: Unit | null = null): ParsedValue | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ').replace(/,/g, '.');
  if (!s) return null;

  // Voltage code: "5V1", "3V3", "+5V0", "12V"
  const volts = /^([+-]?)(\d+)V(\d*)$/i.exec(s);
  if (volts) {
    const num = Number.parseFloat(`${volts[1]}${volts[2]}.${volts[3] || '0'}`);
    return { num: clean(num), unit: 'V' };
  }

  // RKM: digits, a letter, digits (either side may be empty but not both)
  const rkm = /^(\d*)([RKMGkmunpµμ])(\d*)\s*(Ω|ohms?|F|H)?$/.exec(s);
  if (rkm && (rkm[1] || rkm[3])) {
    const [, a, letter, b, unitWord] = rkm;
    let mult: number;
    let unit: Unit | null = unitWord ? unitFrom(unitWord) : hint;
    if (letter === 'R') { mult = 1; unit = 'Ω'; }
    else mult = PREFIX[letter];
    // "1M" on a capacitor is not mega-farads; leave non-resistor M alone
    if (letter === 'M' && unit && unit !== 'Ω' && unit !== 'Hz') return null;
    const num = Number.parseFloat(`${a || '0'}.${b || '0'}`) * mult;
    if (Number.isFinite(num)) return { num: clean(num), unit };
  }

  // Engineering: number, optional prefix, optional unit
  const eng = /^(\d+(?:\.\d+)?|\.\d+)\s*([pnuµμmkKMG])?\s*(Ω|ohms?|F|H|Hz|V|A|W|R)?$/.exec(s);
  if (eng) {
    const [, n, prefix, unitWord] = eng;
    let unit: Unit | null = unitWord ? unitFrom(unitWord) : hint;
    // "M" with no unit on a non-resistor (e.g. "1M" capacitor) is ambiguous; "MHz" is fine
    const mult = prefix ? PREFIX[prefix] : 1;
    if (prefix === 'M' && !unitWord && hint !== 'Ω') return null;
    const num = Number.parseFloat(n) * mult;
    if (Number.isFinite(num)) return { num: clean(num), unit };
  }
  return null;
}

/** The unit implied by a category path such as 'Passive > Resistor > Fixed'. */
export function unitForCategory(path: string | null | undefined): Unit | null {
  if (!path) return null;
  if (/resistor|thermistor|shunt/i.test(path)) return 'Ω';
  if (/capacitor/i.test(path)) return 'F';
  if (/inductor|ferrite/i.test(path)) return 'H';
  if (/crystal|oscillator/i.test(path)) return 'Hz';
  if (/zener|regulator|reference/i.test(path)) return 'V';
  return null;
}

const DISPLAY_PREFIXES: Array<[number, string]> = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'],
];

/** 4700, 'Ω' -> '4.7 kΩ'; 1e-7, 'F' -> '100 nF'. */
export function formatValue(num: number | null | undefined, unit: string | null | undefined): string {
  if (num === null || num === undefined || !Number.isFinite(num)) return '';
  if (num === 0) return `0 ${unit ?? ''}`.trim();
  const abs = Math.abs(num);
  for (const [scale, p] of DISPLAY_PREFIXES) {
    if (abs >= scale * 0.9999999) {
      const v = clean(num / scale);
      return `${v} ${p}${unit ?? ''}`.trim();
    }
  }
  const v = clean(num / 1e-12);
  return `${v} p${unit ?? ''}`.trim();
}

/** True when two values agree to within 0.1 %. */
export function sameValue(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-3;
}

/** Normalise a package spelling for matching: 'SOT-23-3' and 'sot23-3' both become 'SOT233'. */
export function packageKey(name: string | null | undefined): string {
  return (name ?? '').toUpperCase().replace(/[\s\-_./]/g, '');
}
