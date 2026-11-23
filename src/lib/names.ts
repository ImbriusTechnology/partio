// A suggested short name for a part whose name is left blank:
//   Resistors:      value, tolerance, package  -> "12K 1% 0603"
//   Capacitors:     value, dielectric, package -> "100n X7R 0805"
//   Semiconductors: the preferred MPN in full  -> "LM358DR" (trim by hand)
//   Everything else: no suggestion.

/** RKM-style value: 4700 -> "4K7", 12000 -> "12K", 100 -> "100R", 0.025 -> "R025"; 1e-7 F -> "100n", 4.7e-9 -> "4n7". */
export function rkm(num: number, kind: 'R' | 'C'): string {
  const steps: Array<[number, string]> = kind === 'R'
    ? [[1e6, 'M'], [1e3, 'K'], [1, 'R']]
    : [[1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
  if (kind === 'R' && num < 1) {
    const digits = num.toFixed(4).replace(/^0\./, '').replace(/0+$/, '');
    return `R${digits.padEnd(3, '0').slice(0, Math.max(3, digits.length))}`;
  }
  for (const [scale, letter] of steps) {
    if (num >= scale * 0.9999999) {
      const v = Number.parseFloat((num / scale).toPrecision(6));
      const [int, frac] = String(v).split('.');
      return frac ? `${int}${letter}${frac}` : `${int}${letter}`;
    }
  }
  return String(num);
}

const DIELECTRIC = /\b(C0G|COG|NP0|NPO|X7R|X5R|X7S|X6S|X8R|X7T|Y5V|Z5U|U2J)\b/i;

export function dielectricOf(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    const m = DIELECTRIC.exec(t ?? '');
    if (m) {
      const d = m[1].toUpperCase();
      return d === 'COG' ? 'C0G' : d === 'NPO' ? 'NP0' : d;
    }
  }
  return null;
}

const tolText = (t: number | null) => (t === null || t === undefined ? null : `${Number.parseFloat(t.toPrecision(4))}%`);

export interface NameInputs {
  category: string | null; value_num: number | null; tolerance_pct: number | null;
  package: string | null; description: string; mpn: string | null;
}

export function suggestName(c: NameInputs): string | null {
  const cat = c.category ?? '';
  if (/^Passive > Resistor/i.test(cat)) {
    if (c.value_num === null) return null;
    return [rkm(c.value_num, 'R'), tolText(c.tolerance_pct), c.package].filter(Boolean).join(' ');
  }
  if (/^Passive > Capacitor/i.test(cat)) {
    if (c.value_num === null) return null;
    return [rkm(c.value_num, 'C'), dielectricOf(c.description), c.package].filter(Boolean).join(' ');
  }
  if (/^(Discrete|IC|Opto)\b/i.test(cat)) return c.mpn?.trim() || null;
  return null;
}
