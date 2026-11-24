// Builds: planning from a BOM, shortfalls with earlier builds reserving stock, substitutes, refreshing, completing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useFreshLibrary } from './lib/backend.ts';
import { addLine, bomLines, createRev, setRevStatus, updateLine } from '../src/lib/bom.ts';
import {
  bomChanged, buildUsage, cancelBuild, completeBuild, getBuild, listBuilds, planBuild, refreshFromBom, requirements, setSubstitute, updateBuild,
} from '../src/lib/builds.ts';
import { addLocation } from '../src/lib/locations.ts';
import { deleteBlocker, emptyPartFields, getPart, mergeParts, savePart, type Kind } from '../src/lib/parts.ts';
import { receiveStock } from '../src/lib/stock.ts';

const part = (description: string, kind: Kind = 'component', standard_cost: number | null = null) =>
  savePart({ partId: null, fields: { ...emptyPartFields(), description, kind, standard_cost }, sources: [] });

async function setup() {
  const db = useFreshLibrary();
  const board = await part('Board', 'assembly');
  const r10k = await part('10k', 'component', 0.01);
  const cap = await part('100n', 'component', 0.02);
  const spare = await part('10k other make', 'component', 0.015);
  const binA = await addLocation(null, 'Bin A', null);
  const binB = await addLocation(null, 'Bin B', null);
  const shelf = await addLocation(null, 'Shelf', null);
  const rev = await createRev(board, 'A', null, null);
  await addLine(rev, { part_id: r10k, designators: 'R1, R2', qty: 2, dnp: false, note: null });
  await addLine(rev, { part_id: cap, designators: 'C1', qty: 1, dnp: false, note: null });
  await addLine(rev, { part_id: null, designators: 'R9', qty: 1, dnp: true, note: null });   // not fitted, no part: fine
  return { db, board, r10k, cap, spare, binA, binB, shelf, rev };
}

test('plan a build: it copies the BOM, needs scale with quantity, DNP lines need nothing', async () => {
  const s = await setup();
  await receiveStock(s.r10k, s.binA, 15);
  await receiveStock(s.r10k, s.binB, 10);
  await receiveStock(s.cap, s.binA, 3);
  const id = await planBuild(s.rev, 10, 'WO-7');
  const b = (await getBuild(id))!;
  assert.deepEqual([b.code, b.status, b.qty, b.rev_status, b.notes], ['B0001', 'planned', 10, 'draft', 'WO-7']);
  const r = await requirements(id);
  assert.deepEqual(r.map((x) => [x.line_no, x.need, x.short, x.dnp]), [[1, 20, 0, false], [2, 10, 7, false], [3, 0, 0, true]]);
  assert.deepEqual(r[0].picks.map((p) => p.qty), [15, 5], 'fullest place first, then the next');
  assert.equal(await bomChanged(id), false);
  await updateBuild(id, { qty: 2 });
  assert.equal((await requirements(id))[1].short, 0);
  await assert.rejects(updateBuild(id, { qty: 1.5 }), /whole number/);
});

test('earlier planned builds reserve stock; a later build is short of what they need', async () => {
  const s = await setup();
  await receiveStock(s.r10k, s.binA, 30);
  await receiveStock(s.cap, s.binA, 30);
  const first = await planBuild(s.rev, 10);
  const second = await planBuild(s.rev, 10);
  assert.equal((await requirements(first))[0].short, 0);
  const later = await requirements(second);
  assert.deepEqual([later[0].reserved, later[0].short], [20, 10]);
  await cancelBuild(first);
  assert.equal((await requirements(second))[0].short, 0, 'a cancelled build reserves nothing');
});

test('the build keeps its copy when the BOM changes, until refreshed; substitutes survive a refresh', async () => {
  const s = await setup();
  const id = await planBuild(s.rev, 1);
  await setSubstitute(id, 1, s.spare);
  const line2 = (await bomLines(s.rev)).find((l) => l.line_no === 2)!;
  await updateLine(line2.id, { part_id: s.cap, designators: 'C1, C2', qty: 2, dnp: false, note: null });
  assert.equal(await bomChanged(id), true);
  assert.equal((await requirements(id))[1].need, 1, 'still the old copy');
  await refreshFromBom(id);
  const r = await requirements(id);
  assert.equal(r[1].need, 2);
  assert.deepEqual([r[0].part_id, r[0].substitute, r[0].bom_part_id], [s.spare, true, s.r10k]);
  assert.equal(await bomChanged(id), false);
  await setSubstitute(id, 1, s.r10k);
  assert.equal((await requirements(id))[0].substitute, false, 'choosing the BOM’s part clears the substitute');
});

test('obsolete revisions can’t be planned; a fitted line without a part blocks completion until substituted', async () => {
  const s = await setup();
  const board2 = await part('Board 2', 'assembly');
  const rev2 = await createRev(board2, 'A', null, null);
  await addLine(rev2, { part_id: null, designators: 'U1', qty: 1, dnp: false, note: null });
  const id = await planBuild(rev2, 1);
  assert.equal((await requirements(id))[0].short, 1);
  await assert.rejects(completeBuild(id, { built: 1, outputLocationId: s.shelf, picks: [] }), /Line 1 has no part/);
  await setSubstitute(id, 1, s.cap);
  await completeBuild(id, { built: 1, outputLocationId: s.shelf, picks: [] });   // short: the part came from elsewhere
  assert.equal((await getBuild(id))!.status, 'complete');

  await setRevStatus(s.rev, 'released');
  await setRevStatus(s.rev, 'obsolete');
  await assert.rejects(planBuild(s.rev, 1), /obsolete/);
});

test('complete: parts out by the ledger, assemblies in, usage and cost recorded, draft status kept', async () => {
  const s = await setup();
  await receiveStock(s.r10k, s.binA, 50);
  await receiveStock(s.cap, s.binA, 50);
  const id = await planBuild(s.rev, 10);
  const picks = (await requirements(id)).flatMap((r) => r.picks.map((p) => ({ line_no: r.line_no, part_id: r.part_id!, location_id: p.location_id, qty: p.qty })));
  await assert.rejects(completeBuild(id, { built: 10, outputLocationId: s.shelf, picks: [{ ...picks[0], qty: 999 }] }), /Only 50/);
  await completeBuild(id, { built: 10, outputLocationId: s.shelf, picks });
  const b = (await getBuild(id))!;
  assert.deepEqual([b.status, b.qty_built, b.bom_status, b.unit_cost, b.output_path], ['complete', 10, 'draft', 0.04, 'Shelf']);
  assert.equal((await getPart(s.r10k))!.on_hand, 30);
  assert.equal((await getPart(s.cap))!.on_hand, 40);
  const asm = (await getPart(s.board))!;
  assert.deepEqual([asm.on_hand, asm.location], [10, 'Shelf']);
  assert.deepEqual((await buildUsage(id)).map((u) => [u.pn, u.qty_used]).sort(), [[(await getPart(s.r10k))!.pn, 20], [(await getPart(s.cap))!.pn, 10]].sort());
  assert.deepEqual(asm.history.map((h) => h.kind), ['build_output']);
  await assert.rejects(cancelBuild(id), /only a planned build/);
  assert.match((await deleteBlocker(s.r10k))!, /builds/);
});

test('building fewer than planned can plan the rest as a new build, with its substitutes', async () => {
  const s = await setup();
  await receiveStock(s.spare, s.binA, 50);
  await receiveStock(s.cap, s.binA, 50);
  const id = await planBuild(s.rev, 10);
  await setSubstitute(id, 1, s.spare);
  const picks = (await requirements(id, 8)).flatMap((r) => r.picks.map((p) => ({ line_no: r.line_no, part_id: r.part_id!, location_id: p.location_id, qty: p.qty })));
  const { restId } = await completeBuild(id, { built: 8, outputLocationId: s.shelf, picks, planRest: true });
  assert.ok(restId);
  const rest = (await getBuild(restId!))!;
  assert.deepEqual([rest.code, rest.qty, rest.status], ['B0002', 2, 'planned']);
  assert.equal((await requirements(restId!))[0].part_id, s.spare);
  assert.equal((await getPart(s.spare))!.on_hand, 34);
  assert.deepEqual((await listBuilds({ open: true })).map((b) => b.code), ['B0002']);
  assert.deepEqual((await listBuilds({ assemblyId: s.board })).map((b) => [b.code, b.status, b.qty_built]), [['B0002', 'planned', null], ['B0001', 'complete', 8]]);
});

test('merging a duplicate moves it in builds too', async () => {
  const s = await setup();
  const id = await planBuild(s.rev, 1);
  await setSubstitute(id, 2, s.spare);
  await mergeParts(s.r10k, s.spare);
  const r = await requirements(id);
  assert.deepEqual([r[0].part_id, r[1].part_id, r[1].substitute], [s.r10k, s.r10k, true]);
});
