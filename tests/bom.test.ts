// BOM revisions and lines, run against a real (in-memory) library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useFreshLibrary } from './lib/backend.ts';
import {
  addLine, bomLines, copyRev, createRev, deleteLine, deleteRev, findPartForLine, listAssemblies, listRevs, moveDesignators, nextRev,
  revLetter, setLinePart, setRevStatus, updateLine,
} from '../src/lib/bom.ts';
import { emptyPartFields, getPart, savePart, type Kind } from '../src/lib/parts.ts';

const part = (description: string, kind: Kind = 'component') => savePart({ partId: null, fields: { ...emptyPartFields(), description, kind }, sources: [] });

test('revision letters run A…Z, AA…', async () => {
  assert.deepEqual([0, 1, 25, 26, 27, 701, 702].map(revLetter), ['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  useFreshLibrary();
  const board = await part('Board', 'assembly');
  assert.equal(await nextRev(board), 'A');
  await createRev(board, 'a', null, null);
  await createRev(board, '1.2', null, null);
  assert.equal(await nextRev(board), 'B', 'non-letter revisions are ignored');
  await assert.rejects(createRev(board, 'A', null, null), /already exists/);
});

test('assemblies list: assembly parts and parts with a BOM (which become assemblies); not bare PCBs', async () => {
  useFreshLibrary();
  await part('Bare board', 'pcb');
  const thing = await part('Thing');
  await part('Resistor');
  await createRev(thing, 'A', null, null);
  assert.equal((await getPart(thing))!.kind, 'assembly');
  assert.deepEqual((await listAssemblies()).map((a) => [a.description, a.revs]), [['Thing', 'A']]);
});

test('lines: add, edit, move designators to another part, delete', async () => {
  useFreshLibrary();
  const board = await part('Board', 'assembly');
  const r10k = await part('10k');
  const r1k = await part('1k');
  const rev = await createRev(board, 'A', 'P42', null);
  const line = await addLine(rev, { part_id: r10k, designators: 'R3 R1, R2', qty: 3, dnp: false, note: null });
  assert.equal((await bomLines(rev))[0].designators, 'R1, R2, R3');
  await assert.rejects(addLine(rev, { part_id: r1k, designators: '', qty: 0, dnp: false, note: null }), /more than zero/);

  await moveDesignators(line, ['R2'], r1k);
  let lines = await bomLines(rev);
  assert.deepEqual(lines.map((l) => [l.part_id, l.designators, l.qty]), [[r10k, 'R1, R3', 2], [r1k, 'R2', 1]]);
  await moveDesignators(line, ['R1', 'R3'], r1k);
  lines = await bomLines(rev);
  assert.deepEqual(lines.map((l) => [l.part_id, l.designators, l.qty]), [[r1k, 'R1, R2, R3', 3]], 'they join the existing line; the emptied line goes');

  await updateLine(lines[0].id, { part_id: r1k, designators: 'R1, R2, R3', qty: 3, dnp: true, note: 'not for v1' });
  assert.equal((await bomLines(rev))[0].dnp, 1);
  await deleteLine(lines[0].id);
  assert.equal((await bomLines(rev)).length, 0);
});

test('unresolved lines block release until a part is chosen', async () => {
  const db = useFreshLibrary();
  const board = await part('Board', 'assembly');
  const r = await part('Resistor');
  const rev = await createRev(board, 'A', null, null);
  db.exec(`INSERT INTO bom_line (bom_rev_id, line_no, part_id, pn_as_imported, qty, designators) VALUES (${rev}, 1, NULL, 'X-123', 1, 'R1')`);
  await assert.rejects(setRevStatus(rev, 'released'), /1 line has no part yet/);
  assert.equal((await findPartForLine('2'))?.id, r, 'a short number finds the padded PN (00002)');
  await setLinePart((await bomLines(rev))[0].id, r);
  await setRevStatus(rev, 'released');
  assert.equal((await listRevs(board))[0].status, 'released');
});

test('copying a released revision makes an editable draft; obsolete revisions are read-only; delete', async () => {
  useFreshLibrary();
  const board = await part('Board', 'assembly');
  const r = await part('Resistor');
  const a = await createRev(board, 'A', null, null);
  await addLine(a, { part_id: r, designators: 'R1', qty: 1, dnp: false, note: null });
  await setRevStatus(a, 'released');
  const b = await copyRev(a, await nextRev(board), null);
  assert.deepEqual((await listRevs(board)).map((x) => [x.rev, x.status, x.notes]), [['A', 'released', null], ['B', 'draft', 'Copied from Rev A']]);
  assert.equal((await bomLines(b)).length, 1);
  await setRevStatus(a, 'obsolete');
  await assert.rejects(addLine(a, { part_id: r, designators: 'R2', qty: 1, dnp: false, note: null }), /obsolete/);
  await deleteRev(b);
  assert.deepEqual((await listRevs(board)).map((x) => x.rev), ['A']);
});
