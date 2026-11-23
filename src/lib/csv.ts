// Reading and writing CSV (RFC 4180): comma-separated, double quotes around fields that need them,
// "" for a quote inside a quoted field, CRLF or LF line ends. Excel's UTF-8 byte-order mark is accepted on read
// and written on export, so Excel shows µ, Ω and ± correctly.

export interface CsvTable {
  /** Header names as written in the file. */
  headers: string[];
  /** One array of cells per data row (blank lines are skipped). */
  rows: string[][];
  /** The file line each data row starts on (1 = the header), for error messages. */
  lines: number[];
}

export function parseCsv(text: string): CsvTable {
  const s = text.replace(/^﻿/, '');
  const records: Array<{ cells: string[]; line: number }> = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;
  const endField = () => { cells.push(field); field = ''; fieldStarted = false; };
  const endRecord = () => {
    endField();
    if (!(cells.length === 1 && cells[0] === '')) records.push({ cells, line: recordLine });
    cells = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) { quoted = true; fieldStarted = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r' && s[i + 1] === '\n') continue;
    if (ch === '\n' || ch === '\r') { endRecord(); line++; recordLine = line; continue; }
    field += ch;
    fieldStarted = true;
  }
  if (quoted) throw new Error(`A quoted field starting near line ${recordLine} is never closed`);
  if (field !== '' || cells.length) endRecord();
  if (!records.length) return { headers: [], rows: [], lines: [] };
  const [head, ...rest] = records;
  return { headers: head.cells.map((h) => h.trim()), rows: rest.map((r) => r.cells), lines: rest.map((r) => r.line) };
}

function quote(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A CSV file's text, with a byte-order mark for Excel and CRLF line ends. */
export function writeCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : quote(String(v)));
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
