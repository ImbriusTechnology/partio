// Assemblies and their BOM revisions: listing, editing lines, and revision status.
// BOMs are imported as bom.csv through the CSV importer (importer.ts), like everything else.
import { execute, query, queryOne, ref, transaction, type Statement } from './db.ts';
import { resolveCode } from './parts.ts';

export type RevStatus = 'draft' | 'released' | 'obsolete';

export interface AssemblyRow {
  id: number; pn: string; name: string | null; description: string; kind: string; project_code: string | null; revs: string | null; on_hand: number;
}
export interface RevRow { id: number; rev: string; status: RevStatus; project_code: string | null; notes: string | null; source_file: string | null; created_at: string }
export interface BomLineRow {
  id: number; line_no: number; designators: string | null; qty: number; dnp: number; note: string | null;
  pn_as_imported: string | null; mpn_as_imported: string | null;
  part_id: number | null; pn: string | null; name: string | null; description: string | null; value_text: string | null; package: string | null;
  on_hand: number; location: string | null;
}

/** Assembly parts, and any other part that has a BOM. (A bare PCB is a line on a BOM, not an assembly.) */
export const listAssemblies = () => query<AssemblyRow>(`
  SELECT p.id, p.pn, p.name, p.description, p.kind,
         (SELECT project_code FROM bom_rev r WHERE r.part_id = p.id AND project_code IS NOT NULL ORDER BY length(rev) DESC, rev DESC LIMIT 1) AS project_code,
         (SELECT group_concat(rev, ', ') FROM (SELECT rev FROM bom_rev r WHERE r.part_id = p.id ORDER BY length(rev), rev)) AS revs,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.part_id = p.id), 0) AS on_hand
  FROM part p
  WHERE (EXISTS (SELECT 1 FROM bom_rev r WHERE r.part_id = p.id) OR p.kind = 'assembly') AND p.status <> 'archived'
  ORDER BY p.pn`);

export const listRevs = (assemblyId: number) => query<RevRow>(
  'SELECT id, rev, status, project_code, notes, source_file, created_at FROM bom_rev WHERE part_id = ? ORDER BY length(rev), rev', [assemblyId]);

export const bomLines = (revId: number) => query<BomLineRow>(`
  SELECT bl.id, bl.line_no, bl.designators, bl.qty, bl.dnp, bl.note, bl.pn_as_imported, bl.mpn_as_imported, bl.part_id,
         p.pn, p.name, p.description, p.value_text, pk.name AS package,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.part_id = p.id), 0) AS on_hand, l.path AS location
  FROM bom_line bl
  LEFT JOIN part p ON p.id = bl.part_id
  LEFT JOIN package pk ON pk.id = p.package_id
  LEFT JOIN location l ON l.id = p.default_location_id
  WHERE bl.bom_rev_id = ? ORDER BY bl.line_no`, [revId]);

// ------------------------------------------------------------------ finding parts for lines

/** A part by PN, MPN or vendor part number; a short number is also tried as a 5-digit PN (spreadsheets drop leading zeros). */
export async function findPartForLine(code: string): Promise<{ id: number; pn: string } | undefined> {
  const c = code.trim();
  if (!c) return undefined;
  return (await resolveCode(c)) ?? (/^\d{1,4}$/.test(c) ? resolveCode(c.padStart(5, '0')) : undefined);
}

// ------------------------------------------------------------------ revisions

/** A, B, … Z, AA, AB … */
export function revLetter(n: number): string {
  let s = '';
  for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
const revIndex = (rev: string) => [...rev.toUpperCase()].reduce((t, ch) => t * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** The letter after the highest lettered revision (A when there are none). */
export async function nextRev(assemblyId: number): Promise<string> {
  const revs = await query<{ rev: string }>('SELECT rev FROM bom_rev WHERE part_id = ?', [assemblyId]);
  const max = Math.max(-1, ...revs.map((r) => (/^[A-Z]+$/i.test(r.rev) ? revIndex(r.rev) : -1)));
  return revLetter(max + 1);
}

function checkRev(rev: string): string {
  const r = rev.trim().toUpperCase();
  if (!r) throw new Error('Give the revision a name, e.g. A');
  if (r.length > 10) throw new Error('Keep the revision short, e.g. A, B or 1.2');
  return r;
}

/** Start an empty draft revision; lines are added by hand or by importing bom.csv. */
export async function createRev(assemblyId: number, rev: string, projectCode: string | null, notes: string | null): Promise<number> {
  const r = checkRev(rev);
  if (await queryOne('SELECT 1 FROM bom_rev WHERE part_id = ? AND rev = ?', [assemblyId, r])) throw new Error(`Rev ${r} already exists`);
  const res = (await transaction([
    { sql: `INSERT INTO bom_rev (part_id, rev, status, project_code, notes) VALUES (?, ?, 'draft', ?, ?)`,
      params: [assemblyId, r, projectCode?.trim() || null, notes?.trim() || null] },
    { sql: "UPDATE part SET kind = 'assembly' WHERE id = ? AND kind = 'component'", params: [assemblyId] },
  ])) as Array<{ lastInsertId: number }>;
  return res[0].lastInsertId;
}

/** Copy a revision's lines into a new draft revision (the way to change a released one). */
export async function copyRev(revId: number, newRev: string, notes: string | null): Promise<number> {
  const src = await queryOne<{ part_id: number; project_code: string | null; rev: string }>('SELECT part_id, project_code, rev FROM bom_rev WHERE id = ?', [revId]);
  if (!src) throw new Error('Revision not found');
  const rev = checkRev(newRev);
  if (await queryOne('SELECT 1 FROM bom_rev WHERE part_id = ? AND rev = ?', [src.part_id, rev])) throw new Error(`Rev ${rev} already exists`);
  const res = (await transaction([
    { sql: `INSERT INTO bom_rev (part_id, rev, status, project_code, notes) VALUES (?, ?, 'draft', ?, ?)`,
      params: [src.part_id, rev, src.project_code, notes ?? `Copied from Rev ${src.rev}`] },
    { sql: `INSERT INTO bom_line (bom_rev_id, line_no, part_id, pn_as_imported, mpn_as_imported, qty, designators, dnp, note)
            SELECT ?, line_no, part_id, pn_as_imported, mpn_as_imported, qty, designators, dnp, note FROM bom_line WHERE bom_rev_id = ?`, params: [ref(0), revId] },
  ])) as Array<{ lastInsertId: number }>;
  return res[0].lastInsertId;
}

export async function setRevStatus(revId: number, status: RevStatus): Promise<void> {
  if (status === 'released') {
    const unresolved = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bom_line WHERE bom_rev_id = ? AND part_id IS NULL AND dnp = 0', [revId]);
    if (unresolved?.n) throw new Error(`${unresolved.n} line${unresolved.n === 1 ? ' has' : 's have'} no part yet. Resolve ${unresolved.n === 1 ? 'it' : 'them'} before releasing.`);
  }
  await execute('UPDATE bom_rev SET status = ? WHERE id = ?', [status, revId]);
}

export async function updateRevInfo(revId: number, projectCode: string | null, notes: string | null): Promise<void> {
  await execute('UPDATE bom_rev SET project_code = ?, notes = ? WHERE id = ?', [projectCode?.trim() || null, notes?.trim() || null, revId]);
}

/** Delete a revision that has never been built (cancelled builds of it go too). */
export async function deleteRev(revId: number): Promise<void> {
  if (await queryOne("SELECT 1 FROM build WHERE bom_rev_id = ? AND status <> 'cancelled'", [revId])) {
    throw new Error('This revision has builds; mark it obsolete instead');
  }
  await transaction([
    { sql: 'DELETE FROM build WHERE bom_rev_id = ?', params: [revId] },
    { sql: 'DELETE FROM document_link WHERE bom_rev_id = ?', params: [revId] },
    { sql: 'DELETE FROM bom_rev WHERE id = ?', params: [revId] },
  ]);
}

// ------------------------------------------------------------------ lines

/** Draft and released revisions can be edited (planned builds follow; completed builds keep their own record). Obsolete ones can't. */
async function assertEditable(revId: number): Promise<void> {
  const r = await queryOne<{ status: string; rev: string }>('SELECT status, rev FROM bom_rev WHERE id = ?', [revId]);
  if (!r) throw new Error('Revision not found');
  if (r.status === 'obsolete') throw new Error(`Rev ${r.rev} is obsolete; restore it to change it`);
}
/** Every BOM edit is recorded in audit_log, so it's possible to see later what changed. */
const audit = (lineId: number | { $ref: number }, action: 'create' | 'update' | 'delete', changes: object): Statement =>
  ({ sql: `INSERT INTO audit_log (entity, entity_id, action, changes) VALUES ('bom_line', ?, ?, ?)`, params: [lineId, action, JSON.stringify(changes)] });
const detach = (lineId: number): Statement => ({ sql: 'UPDATE build_line SET bom_line_id = NULL WHERE bom_line_id = ?', params: [lineId] });
const revOfLine = async (lineId: number) => (await queryOne<{ bom_rev_id: number }>('SELECT bom_rev_id FROM bom_line WHERE id = ?', [lineId]))?.bom_rev_id ?? 0;

export const splitDesignators = (s: string | null | undefined) => (s ?? '').split(/[\s,;]+/).filter(Boolean);
export const sortDesignators = (list: string[]) => [...new Set(list)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
export const joinDesignators = (list: string[]) => sortDesignators(list).join(', ') || null;

export interface LineFields { part_id: number | null; designators: string; qty: number; dnp: boolean; note: string | null }

function checkLine(f: LineFields): void {
  if (!Number.isFinite(f.qty) || f.qty <= 0) throw new Error('Quantity should be more than zero');
}

/** Choose the part for a line (resolving an unresolved one, or swapping the part). */
export async function setLinePart(lineId: number, partId: number | null): Promise<void> {
  await assertEditable(await revOfLine(lineId));
  await transaction([
    { sql: 'UPDATE bom_line SET part_id = ? WHERE id = ?', params: [partId, lineId] },
    audit(lineId, 'update', { via: 'resolve', part_id: partId }),
  ]);
}

export async function updateLine(lineId: number, f: LineFields): Promise<void> {
  await assertEditable(await revOfLine(lineId));
  checkLine(f);
  const des = joinDesignators(splitDesignators(f.designators));
  await transaction([
    { sql: 'UPDATE bom_line SET part_id = ?, designators = ?, qty = ?, dnp = ?, note = ? WHERE id = ?', params: [f.part_id, des, f.qty, f.dnp ? 1 : 0, f.note, lineId] },
    audit(lineId, 'update', { via: 'edit', ...f, designators: des }),
  ]);
}

export async function addLine(revId: number, f: LineFields): Promise<number> {
  await assertEditable(revId);
  checkLine(f);
  const n = (await queryOne<{ n: number | null }>('SELECT MAX(line_no) AS n FROM bom_line WHERE bom_rev_id = ?', [revId]))?.n ?? 0;
  const pn = f.part_id ? (await queryOne<{ pn: string }>('SELECT pn FROM part WHERE id = ?', [f.part_id]))?.pn ?? null : null;
  const des = joinDesignators(splitDesignators(f.designators));
  const res = (await transaction([
    { sql: 'INSERT INTO bom_line (bom_rev_id, line_no, part_id, pn_as_imported, qty, designators, dnp, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [revId, n + 1, f.part_id, pn, f.qty, des, f.dnp ? 1 : 0, f.note] },
    audit(ref(0), 'create', { via: 'add', bom_rev_id: revId, ...f, designators: des }),
  ])) as Array<{ lastInsertId: number }>;
  return res[0].lastInsertId;
}

export async function deleteLine(lineId: number): Promise<void> {
  await assertEditable(await revOfLine(lineId));
  await transaction([detach(lineId), { sql: 'DELETE FROM bom_line WHERE id = ?', params: [lineId] }, audit(lineId, 'delete', { via: 'delete' })]);
}

/**
 * Move some designators of a line to another part. They join that part's existing line in the revision
 * (or a new line), and both quantities follow the designator counts.
 */
export async function moveDesignators(lineId: number, designators: string[], toPartId: number): Promise<void> {
  const line = await queryOne<{ bom_rev_id: number; designators: string | null; qty: number; dnp: number; part_id: number | null }>(
    'SELECT bom_rev_id, designators, qty, dnp, part_id FROM bom_line WHERE id = ?', [lineId]);
  if (!line) throw new Error('Line not found');
  await assertEditable(line.bom_rev_id);
  const moving = new Set(designators);
  const current = splitDesignators(line.designators);
  if (!designators.length || designators.some((d) => !current.includes(d))) throw new Error('Choose designators from this line');
  if (toPartId === line.part_id) throw new Error('That is already the part on this line');
  const keep = current.filter((d) => !moving.has(d));
  const target = await queryOne<{ id: number; designators: string | null }>(
    'SELECT id, designators FROM bom_line WHERE bom_rev_id = ? AND part_id = ? AND dnp = ? AND id <> ? LIMIT 1', [line.bom_rev_id, toPartId, line.dnp, lineId]);
  const pn = (await queryOne<{ pn: string }>('SELECT pn FROM part WHERE id = ?', [toPartId]))?.pn ?? null;
  const n = (await queryOne<{ n: number | null }>('SELECT MAX(line_no) AS n FROM bom_line WHERE bom_rev_id = ?', [line.bom_rev_id]))?.n ?? 0;
  const stmts: Statement[] = [];
  if (keep.length) stmts.push({ sql: 'UPDATE bom_line SET designators = ?, qty = ? WHERE id = ?', params: [keep.join(', '), keep.length, lineId] });
  else stmts.push(detach(lineId), { sql: 'DELETE FROM bom_line WHERE id = ?', params: [lineId] });
  if (target) {
    const all = sortDesignators([...splitDesignators(target.designators), ...designators]);
    stmts.push({ sql: 'UPDATE bom_line SET designators = ?, qty = ? WHERE id = ?', params: [all.join(', '), all.length, target.id] });
  } else {
    stmts.push({ sql: 'INSERT INTO bom_line (bom_rev_id, line_no, part_id, pn_as_imported, qty, designators, dnp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [line.bom_rev_id, n + 1, toPartId, pn, designators.length, joinDesignators(designators), line.dnp] });
  }
  stmts.push(audit(lineId, keep.length ? 'update' : 'delete', { via: 'move', moved: designators, to_part_id: toPartId, into_line: target?.id ?? 'new', keep }));
  await transaction(stmts);
}
