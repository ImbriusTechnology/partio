// Builds: plan a build of an assembly from one of its BOM revisions, see what's short, pick the parts, and complete it
// (parts out of stock, finished assemblies in).
//
// A build takes its own copy of the BOM lines (build_req) when it's planned, so editing the BOM afterwards doesn't
// quietly change it; the build shows that the BOM has changed, and can be refreshed from it. Draft BOMs can be built
// (prototypes); a build records the revision's status when it was completed. Planned builds reserve stock in the
// order they were planned: an earlier build's needs come first when working out what a later one is short of.
import { batchId, query, queryOne, ref, transaction, type Statement } from './db.ts';

export type BuildStatus = 'planned' | 'complete' | 'cancelled';

export interface BuildRow {
  id: number; code: string; bom_rev_id: number; rev: string; rev_status: string; qty: number; qty_built: number | null; status: BuildStatus;
  assembly_id: number; assembly_pn: string; assembly_name: string | null; assembly_desc: string;
  output_location_id: number | null; output_path: string | null; notes: string | null;
  created_at: string | null; completed_at: string | null; bom_status: string | null; unit_cost: number | null;
}

const BUILD_SELECT = `
  SELECT b.id, b.code, b.bom_rev_id, r.rev, r.status AS rev_status, b.qty, b.qty_built, b.status,
         p.id AS assembly_id, p.pn AS assembly_pn, p.name AS assembly_name, p.description AS assembly_desc,
         b.output_location_id, l.path AS output_path, b.notes, b.created_at, b.completed_at, b.bom_status, b.unit_cost
  FROM build b JOIN bom_rev r ON r.id = b.bom_rev_id JOIN part p ON p.id = r.part_id LEFT JOIN location l ON l.id = b.output_location_id`;

/** Builds, newest first: of one assembly, or (with `open`) the planned ones across the library. */
export function listBuilds(filter: { assemblyId?: number; open?: boolean } = {}): Promise<BuildRow[]> {
  const where: string[] = [];
  const params: number[] = [];
  if (filter.assemblyId) { where.push('p.id = ?'); params.push(filter.assemblyId); }
  if (filter.open) where.push("b.status = 'planned'");
  return query<BuildRow>(`${BUILD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.id DESC`, params);
}
export const getBuild = (id: number) => queryOne<BuildRow>(`${BUILD_SELECT} WHERE b.id = ?`, [id]);

async function nextBuildNumber(): Promise<number> {
  const r = await queryOne<{ n: number | null }>(`SELECT MAX(CAST(substr(code, 2) AS INTEGER)) AS n FROM build WHERE code GLOB 'B[0-9]*'`);
  return (r?.n ?? 0) + 1;
}
const buildCode = (n: number) => `B${String(n).padStart(4, '0')}`;

/** Copy a revision's lines into a build. */
const snapshot = (buildId: number | { $ref: number }, revId: number): Statement => ({
  sql: `INSERT INTO build_req (build_id, bom_line_id, line_no, part_id, pn_as_imported, mpn_as_imported, qty_per, designators, dnp)
        SELECT ?, id, line_no, part_id, pn_as_imported, mpn_as_imported, qty, designators, dnp FROM bom_line WHERE bom_rev_id = ?`,
  params: [buildId, revId],
});

function wholeQty(qty: number): number {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Build a whole number, at least 1');
  return qty;
}

async function plannedBuild(id: number): Promise<BuildRow> {
  const b = await getBuild(id);
  if (!b) throw new Error('Build not found');
  if (b.status !== 'planned') throw new Error(`Build ${b.code} is ${b.status}; only a planned build can be changed`);
  return b;
}

/** Plan a build of `qty` from a revision. Obsolete revisions can't be planned. */
export async function planBuild(bomRevId: number, qty: number, notes: string | null = null): Promise<number> {
  wholeQty(qty);
  const r = await queryOne<{ status: string; rev: string; default_location_id: number | null }>(
    'SELECT r.status, r.rev, p.default_location_id FROM bom_rev r JOIN part p ON p.id = r.part_id WHERE r.id = ?', [bomRevId]);
  if (!r) throw new Error('Revision not found');
  if (r.status === 'obsolete') throw new Error(`Rev ${r.rev} is obsolete. Build from a current revision, or restore this one first.`);
  const res = (await transaction([
    { sql: `INSERT INTO build (code, bom_rev_id, qty, status, output_location_id, notes, created_at) VALUES (?, ?, ?, 'planned', ?, ?, datetime('now'))`,
      params: [buildCode(await nextBuildNumber()), bomRevId, qty, r.default_location_id, notes?.trim() || null] },
    snapshot(ref(0), bomRevId),
  ])) as Array<{ lastInsertId: number }>;
  return res[0].lastInsertId;
}

export async function updateBuild(id: number, f: { qty?: number; notes?: string | null; output_location_id?: number | null }): Promise<void> {
  const b = await plannedBuild(id);
  await transaction([{ sql: 'UPDATE build SET qty = ?, notes = ?, output_location_id = ? WHERE id = ?', params: [
    f.qty !== undefined ? wholeQty(f.qty) : b.qty,
    f.notes !== undefined ? f.notes?.trim() || null : b.notes,
    f.output_location_id !== undefined ? f.output_location_id : b.output_location_id, id] }]);
}

export async function cancelBuild(id: number): Promise<void> {
  await plannedBuild(id);
  await transaction([{ sql: "UPDATE build SET status = 'cancelled' WHERE id = ?", params: [id] }]);
}

// ------------------------------------------------------------------ the build's copy of the BOM

interface ReqRow {
  id: number; line_no: number; bom_line_id: number | null; part_id: number | null; use_part_id: number | null;
  pn_as_imported: string | null; mpn_as_imported: string | null; qty_per: number; designators: string | null; dnp: number;
}
const reqRows = (buildId: number) => query<ReqRow>(
  'SELECT id, line_no, bom_line_id, part_id, use_part_id, pn_as_imported, mpn_as_imported, qty_per, designators, dnp FROM build_req WHERE build_id = ? ORDER BY line_no', [buildId]);

/** Whether the BOM revision has changed since the build took its copy. */
export async function bomChanged(buildId: number): Promise<boolean> {
  const b = await getBuild(buildId);
  if (!b) return false;
  const key = (l: { line_no: number; part_id: number | null; qty: number; designators: string | null; dnp: number }) =>
    `${l.line_no}|${l.part_id ?? ''}|${l.qty}|${l.designators ?? ''}|${l.dnp}`;
  const now = await query<{ line_no: number; part_id: number | null; qty: number; designators: string | null; dnp: number }>(
    'SELECT line_no, part_id, qty, designators, dnp FROM bom_line WHERE bom_rev_id = ? ORDER BY line_no', [b.bom_rev_id]);
  const mine = (await reqRows(buildId)).map((r) => ({ ...r, qty: r.qty_per }));
  return now.map(key).join('\n') !== mine.map(key).join('\n');
}

/** Take a fresh copy of the BOM. Substitutes are kept for lines that still use the same part. */
export async function refreshFromBom(buildId: number): Promise<void> {
  const b = await plannedBuild(buildId);
  const subs = (await reqRows(buildId)).filter((r) => r.use_part_id !== null);
  await transaction([
    { sql: 'DELETE FROM build_req WHERE build_id = ?', params: [buildId] },
    snapshot(buildId, b.bom_rev_id),
    ...subs.map((s) => ({
      sql: 'UPDATE build_req SET use_part_id = ? WHERE build_id = ? AND line_no = ? AND part_id IS ?',
      params: [s.use_part_id, buildId, s.line_no, s.part_id],
    })),
  ]);
}

/** Use a different part for one line of this build (null: back to the BOM's part). The BOM itself is unchanged. */
export async function setSubstitute(buildId: number, lineNo: number, partId: number | null): Promise<void> {
  await plannedBuild(buildId);
  const r = await queryOne<{ part_id: number | null }>('SELECT part_id FROM build_req WHERE build_id = ? AND line_no = ?', [buildId, lineNo]);
  if (!r) throw new Error(`No line ${lineNo} in this build`);
  if (partId !== null) {
    const p = await queryOne<{ status: string; pn: string }>('SELECT status, pn FROM part WHERE id = ?', [partId]);
    if (!p) throw new Error('Part not found');
    if (p.status === 'archived') throw new Error(`${p.pn} is archived`);
  }
  await transaction([{ sql: 'UPDATE build_req SET use_part_id = ? WHERE build_id = ? AND line_no = ?',
    params: [partId === r.part_id ? null : partId, buildId, lineNo] }]);
}

// ------------------------------------------------------------------ what a build needs, and where to pick it

export interface StockSpot { location_id: number; path: string; qty: number; usual: boolean }
export interface Pick { location_id: number; path: string; qty: number }

export interface Requirement {
  line_no: number; designators: string | null; dnp: boolean;
  bom_part_id: number | null; bom_pn: string | null; said: string | null;   // what the BOM file said, for an unresolved line
  part_id: number | null; pn: string | null; name: string | null; description: string | null; substitute: boolean; has_bom: boolean;
  per_unit: number; need: number;
  on_hand: number;     // everywhere
  reserved: number;    // needed by builds planned earlier
  short: number;       // need less what's left after earlier builds (shared between this build's lines of the same part)
  picks: Pick[];       // suggested: the usual location first, then the fullest
  spots: StockSpot[];  // everywhere it's stored
}

/** Stock still needed by planned builds earlier than `buildId`, per part. */
async function reservedBefore(buildId: number, partIds: number[]): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  if (!partIds.length) return m;
  const rows = await query<{ part_id: number; qty: number }>(`
    SELECT COALESCE(q.use_part_id, q.part_id) AS part_id, SUM(q.qty_per * b.qty) AS qty
    FROM build_req q JOIN build b ON b.id = q.build_id
    WHERE b.status = 'planned' AND b.id < ? AND q.dnp = 0 AND COALESCE(q.use_part_id, q.part_id) IN (${partIds.map(() => '?').join(',')})
    GROUP BY 1`, [buildId, ...partIds]);
  for (const r of rows) m.set(r.part_id, r.qty);
  return m;
}

async function stockSpots(partIds: number[]): Promise<Map<number, StockSpot[]>> {
  const m = new Map<number, StockSpot[]>();
  if (!partIds.length) return m;
  const rows = await query<{ part_id: number; location_id: number; path: string; qty: number; usual: number }>(`
    SELECT s.part_id, s.location_id, l.path, s.qty, (p.default_location_id IS s.location_id) AS usual
    FROM stock s JOIN location l ON l.id = s.location_id JOIN part p ON p.id = s.part_id
    WHERE s.qty > 0 AND s.part_id IN (${partIds.map(() => '?').join(',')})
    ORDER BY usual DESC, s.qty DESC, l.path`, partIds);
  for (const r of rows) {
    if (!m.has(r.part_id)) m.set(r.part_id, []);
    m.get(r.part_id)!.push({ location_id: r.location_id, path: r.path, qty: r.qty, usual: !!r.usual });
  }
  return m;
}

/** Take `need` from the spots in order, sharing stock between this build's lines of the same part. */
function allocate(need: number, spots: StockSpot[], used: Map<string, number>, partId: number): Pick[] {
  const picks: Pick[] = [];
  let left = need;
  for (const s of spots) {
    if (left <= 0) break;
    const key = `${partId}:${s.location_id}`;
    const free = s.qty - (used.get(key) ?? 0);
    if (free <= 0) continue;
    const take = Math.min(free, left);
    picks.push({ location_id: s.location_id, path: s.path, qty: take });
    used.set(key, (used.get(key) ?? 0) + take);
    left -= take;
  }
  return picks;
}

/** Every line of a build of `qty` (the build's own quantity if not given), DNP lines included with nothing needed. */
export async function requirements(buildId: number, qty?: number): Promise<Requirement[]> {
  const b = await getBuild(buildId);
  if (!b) throw new Error('Build not found');
  const n = qty ?? b.qty;
  const lines = await reqRows(buildId);
  const partIds = [...new Set(lines.flatMap((l) => [l.use_part_id ?? l.part_id, l.part_id]).filter((x): x is number => x !== null))];
  const parts = new Map<number, { pn: string; name: string | null; description: string; has_bom: number }>();
  if (partIds.length) {
    for (const p of await query<{ id: number; pn: string; name: string | null; description: string; has_bom: number }>(`
      SELECT id, pn, name, description, EXISTS (SELECT 1 FROM bom_rev r WHERE r.part_id = part.id) AS has_bom
      FROM part WHERE id IN (${partIds.map(() => '?').join(',')})`, partIds)) parts.set(p.id, p);
  }
  const spots = await stockSpots(partIds);
  const reserved = await reservedBefore(buildId, partIds);
  const left = new Map<number, number>();   // per part: what's left for this build after earlier builds and earlier lines
  const used = new Map<string, number>();
  return lines.map((l) => {
    const partId = l.use_part_id ?? l.part_id;
    const p = partId ? parts.get(partId) : undefined;
    const need = l.dnp ? 0 : l.qty_per * n;
    const s = partId ? spots.get(partId) ?? [] : [];
    const onHand = s.reduce((t, x) => t + x.qty, 0);
    let short = need;
    if (partId) {
      if (!left.has(partId)) left.set(partId, Math.max(0, onHand - (reserved.get(partId) ?? 0)));
      const avail = left.get(partId)!;
      short = Math.max(0, need - avail);
      left.set(partId, Math.max(0, avail - need));
    }
    return {
      line_no: l.line_no, designators: l.designators, dnp: !!l.dnp,
      bom_part_id: l.part_id, bom_pn: l.part_id ? parts.get(l.part_id)?.pn ?? null : null, said: l.pn_as_imported ?? l.mpn_as_imported,
      part_id: partId, pn: p?.pn ?? null, name: p?.name ?? null, description: p?.description ?? null,
      substitute: l.use_part_id !== null, has_bom: !!p?.has_bom,
      per_unit: l.qty_per, need, on_hand: onHand, reserved: partId ? reserved.get(partId) ?? 0 : 0, short,
      picks: partId && need > 0 ? allocate(need, s, used, partId) : [], spots: s,
    };
  });
}

// ------------------------------------------------------------------ completing

export interface PickToTake { line_no: number; part_id: number; location_id: number; qty: number }

export interface CompleteOptions {
  built: number;                // how many were made; may be fewer than planned
  outputLocationId: number;     // where they go
  picks: PickToTake[];          // what was taken, and from where
  planRest?: boolean;           // built fewer than planned: plan the rest as a new build
}

/** The cost of one of a part, in the base currency: its standard cost, else what it last cost to receive. */
const COST_SQL = `SELECT COALESCE(p.standard_cost,
    (SELECT t.unit_cost FROM stock_txn t WHERE t.part_id = p.id AND t.kind IN ('receive', 'opening', 'build_output') AND t.unit_cost IS NOT NULL
     ORDER BY t.at DESC, t.id DESC LIMIT 1)) AS cost FROM part p WHERE p.id = ?`;

/**
 * Complete a build: take the picks out of stock, put the finished assemblies in, and record what was used.
 * Every line that's fitted needs a part (resolve it on the BOM, or choose a substitute); lines can be short,
 * when parts came from outside the library. All in one transaction.
 */
export async function completeBuild(id: number, o: CompleteOptions): Promise<{ restId: number | null }> {
  const b = await plannedBuild(id);
  const built = wholeQty(o.built);
  if (!(await queryOne('SELECT 1 FROM location WHERE id = ? AND archived = 0', [o.outputLocationId]))) throw new Error('Choose where the finished assemblies go');
  const lines = await reqRows(id);
  const byLine = new Map(lines.map((l) => [l.line_no, l]));
  const noPart = lines.filter((l) => !l.dnp && (l.use_part_id ?? l.part_id) === null);
  if (noPart.length) {
    throw new Error(`Line${noPart.length === 1 ? '' : 's'} ${noPart.map((l) => l.line_no).join(', ')} ${noPart.length === 1 ? 'has' : 'have'} no part. Resolve ${noPart.length === 1 ? 'it' : 'them'} on the BOM (then refresh the build), or choose a substitute.`);
  }
  const picks = o.picks.filter((p) => p.qty > 0);
  const want = new Map<string, { part_id: number; location_id: number; qty: number }>();
  for (const p of picks) {
    const l = byLine.get(p.line_no);
    if (!l || l.dnp) throw new Error(`Line ${p.line_no} isn't fitted in this build`);
    if ((l.use_part_id ?? l.part_id) !== p.part_id) throw new Error(`Line ${p.line_no} uses a different part`);
    const k = `${p.part_id}:${p.location_id}`;
    const e = want.get(k) ?? { part_id: p.part_id, location_id: p.location_id, qty: 0 };
    e.qty += p.qty;
    want.set(k, e);
  }
  for (const w of want.values()) {
    const have = (await queryOne<{ qty: number }>('SELECT qty FROM stock WHERE part_id = ? AND location_id = ?', [w.part_id, w.location_id]))?.qty ?? 0;
    if (have < w.qty) {
      const info = await queryOne<{ pn: string; path: string }>('SELECT p.pn, l.path FROM part p, location l WHERE p.id = ? AND l.id = ?', [w.part_id, w.location_id]);
      throw new Error(`Only ${have} of ${info?.pn} at ${info?.path}, but ${w.qty} to take`);
    }
  }
  const costs = new Map<number, number | null>();
  for (const p of picks) if (!costs.has(p.part_id)) costs.set(p.part_id, (await queryOne<{ cost: number | null }>(COST_SQL, [p.part_id]))?.cost ?? null);
  const total = picks.reduce((t, p) => t + (costs.get(p.part_id) ?? 0) * p.qty, 0);
  const unitCost = total > 0 ? Math.round((total / built) * 1e4) / 1e4 : null;
  const note = `Build ${b.code}`;

  const bid = batchId();
  const stmts: Statement[] = [];
  for (const p of picks) {
    const l = byLine.get(p.line_no)!;
    stmts.push({ sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, unit_cost, build_id, note) VALUES (?, 'consume', ?, ?, ?, ?, ?, ?)`,
      params: [bid, p.part_id, p.location_id, -p.qty, costs.get(p.part_id) ?? null, id, note] });
    stmts.push({ sql: `INSERT INTO build_line (build_id, bom_line_id, bom_part_id, designators, part_id, location_id, qty_used, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, l.bom_line_id, l.part_id, l.designators, p.part_id, p.location_id, p.qty, costs.get(p.part_id) ?? null] });
  }
  stmts.push({ sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, unit_cost, build_id, note) VALUES (?, 'build_output', ?, ?, ?, ?, ?, ?)`,
    params: [bid, b.assembly_id, o.outputLocationId, built, unitCost, id, note] });
  stmts.push({ sql: `UPDATE build SET status = 'complete', qty_built = ?, output_location_id = ?, completed_at = datetime('now'),
      bom_status = (SELECT status FROM bom_rev WHERE id = ?), unit_cost = ? WHERE id = ?`, params: [built, o.outputLocationId, b.bom_rev_id, unitCost, id] });
  stmts.push({ sql: 'UPDATE part SET default_location_id = COALESCE(default_location_id, ?) WHERE id = ?', params: [o.outputLocationId, b.assembly_id] });
  let restAt = -1;
  if (o.planRest && built < b.qty) {
    restAt = stmts.length;
    stmts.push({ sql: `INSERT INTO build (code, bom_rev_id, qty, status, output_location_id, notes, created_at) VALUES (?, ?, ?, 'planned', ?, ?, datetime('now'))`,
      params: [buildCode(await nextBuildNumber()), b.bom_rev_id, b.qty - built, o.outputLocationId, `The rest of ${b.code}${b.notes ? `. ${b.notes}` : ''}`] });
    stmts.push({ sql: `INSERT INTO build_req (build_id, bom_line_id, line_no, part_id, pn_as_imported, mpn_as_imported, qty_per, designators, dnp, use_part_id)
      SELECT ?, bom_line_id, line_no, part_id, pn_as_imported, mpn_as_imported, qty_per, designators, dnp, use_part_id FROM build_req WHERE build_id = ?`,
      params: [ref(restAt), id] });
  }
  const res = (await transaction(stmts)) as Array<{ lastInsertId: number }>;
  return { restId: restAt >= 0 ? res[restAt].lastInsertId : null };
}

/** What a completed build used. */
export const buildUsage = (id: number) => query<{
  part_id: number; pn: string; name: string | null; description: string; path: string | null; qty_used: number; designators: string | null; substitute: number;
}>(`
  SELECT bl.part_id, p.pn, p.name, p.description, l.path, bl.qty_used, bl.designators,
         (bl.bom_part_id IS NOT NULL AND bl.bom_part_id <> bl.part_id) AS substitute
  FROM build_line bl JOIN part p ON p.id = bl.part_id LEFT JOIN location l ON l.id = bl.location_id
  WHERE bl.build_id = ? ORDER BY l.path, p.pn`, [id]);
