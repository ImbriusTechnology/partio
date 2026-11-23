// Locations and stock, run against a real (in-memory) library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useFreshLibrary } from './lib/backend.ts';
import {
  addLocation, ensureLocationPath, findLocation, listLocations, partsInLocation, removeBlocker, removeLocation, restoreLocation, updateLocation,
} from '../src/lib/locations.ts';
import { emptyPartFields, getPart, savePart } from '../src/lib/parts.ts';
import { addVendor } from '../src/lib/reference.ts';
import { countStock, moveStock, moveStockGroup, receiveStock, removeStock } from '../src/lib/stock.ts';

const newPart = (description: string) => savePart({ partId: null, fields: { ...emptyPartFields(), description }, sources: [] });

test('locations get paths and L-codes, and paths follow renames and moves', async () => {
  useFreshLibrary();
  const cab = await addLocation(null, 'Cabinet A', null);
  const drawer = await addLocation(cab, 'Drawer 1', 'Resistors');
  const bin = await addLocation(drawer, 'Bin 01', null);
  assert.deepEqual((await listLocations()).map((l) => [l.path, l.code]), [
    ['Cabinet A', 'L0001'], ['Cabinet A > Drawer 1', 'L0002'], ['Cabinet A > Drawer 1 > Bin 01', 'L0003'],
  ]);
  await assert.rejects(addLocation(cab, 'Drawer 1', null), /already exists/);
  await assert.rejects(addLocation(null, 'A > B', null), /can’t contain/);

  await updateLocation(drawer, { name: 'Drawer 2', description: null, parent_id: cab });
  assert.equal((await findLocation('L0003'))?.path, 'Cabinet A > Drawer 2 > Bin 01');

  const shelf = await addLocation(null, 'Shelf', null);
  await updateLocation(drawer, { name: 'Drawer 2', description: null, parent_id: shelf });
  assert.equal((await findLocation('L0003'))?.path, 'Shelf > Drawer 2 > Bin 01', 'moving a location moves what is inside it');
  await assert.rejects(updateLocation(shelf, { name: 'Shelf', description: null, parent_id: bin }), /inside itself/);
});

test('ensureLocationPath creates what is missing and reuses what exists', async () => {
  useFreshLibrary();
  const a = await ensureLocationPath('Cabinet A > Drawer 1 > Bin 01');
  const b = await ensureLocationPath('cabinet a > drawer 1 > bin 01');
  assert.equal(a, b, 'paths match ignoring case');
  assert.equal((await listLocations()).length, 3);
});

test('receive, move, count and remove all go through the ledger', async () => {
  useFreshLibrary();
  const part = await newPart('10k resistor');
  const bin = await addLocation(null, 'Bin', null);
  const box = await addLocation(null, 'Box', null);

  await receiveStock(part, bin, 100, { unitCost: 0.02, orderRef: 'PO-1' });
  let p = (await getPart(part))!;
  assert.equal(p.on_hand, 100);
  assert.equal(p.default_location_id, bin, 'the first receipt sets the usual location');

  await moveStock(part, bin, box, 30, null);
  await assert.rejects(moveStock(part, bin, box, 500, null), /Not that many/);
  assert.equal(await countStock(part, box, 28, 'counted'), -2);
  assert.equal(await countStock(part, box, 28, null), 0, 'a count that matches records nothing');
  await removeStock(part, bin, 10, 'used');
  await assert.rejects(removeStock(part, bin, 1000, null), /Not that many/);

  p = (await getPart(part))!;
  assert.deepEqual(p.stock.map((s) => [s.path, s.qty]), [['Bin', 60], ['Box', 28]]);
  assert.equal(p.on_hand, 88);
  assert.deepEqual(p.history.map((h) => h.kind).sort(), ['adjust', 'count', 'move', 'move', 'receive']);
});

test('receiving with a new vendor part number adds it to the part', async () => {
  useFreshLibrary();
  const part = await newPart('LM358');
  const bin = await addLocation(null, 'Bin', null);
  const mouser = await addVendor('Mouser', 'AUD', null);
  const r = await receiveStock(part, bin, 5, { vendorId: mouser, sku: '595-LM358DR' });
  assert.equal(r.addedVendorPart, true);
  const p = (await getPart(part))!;
  assert.equal(p.mfrParts[0].manufacturer, 'Unknown');
  assert.equal(p.mfrParts[0].vendorParts[0].sku, '595-LM358DR');
  assert.equal(p.mfrParts[0].vendorParts[0].currency, 'AUD');
  assert.equal((await receiveStock(part, bin, 5, { vendorId: mouser, sku: '595-lm358dr' })).addedVendorPart, false, 'known SKU, any case');
  await assert.rejects(receiveStock(part, bin, 5, { sku: 'X' }), /who it was bought from/);
});

test('a group move empties one place into another and can update usual locations', async () => {
  useFreshLibrary();
  const a = await newPart('A');
  const b = await newPart('B');
  const from = await addLocation(null, 'Old drawer', null);
  const to = await addLocation(null, 'New drawer', null);
  await receiveStock(a, from, 10);
  await receiveStock(b, from, 20);
  assert.equal(await moveStockGroup([a, b], from, to, true), 2);
  assert.equal((await partsInLocation(from)).length, 0);
  assert.deepEqual((await partsInLocation(to)).map((r) => r.qty).sort(), [10, 20]);
  assert.equal((await getPart(a))!.default_location_id, to);
});

test('a used location is archived when removed; an unused one is deleted', async () => {
  useFreshLibrary();
  const part = await newPart('A');
  const used = await addLocation(null, 'Used', null);
  const unused = await addLocation(null, 'Unused', null);
  await receiveStock(part, used, 3);
  assert.match((await removeBlocker(used))!, /still holds 1 part/);
  await removeStock(part, used, 3, null);
  assert.equal(await removeBlocker(used), null);
  assert.equal(await removeLocation(used), 'archived');
  assert.equal(await removeLocation(unused), 'deleted');
  assert.equal((await getPart(part))!.default_location_id, null, 'parts no longer point at a removed location');
  assert.deepEqual((await listLocations()).map((l) => l.path), []);
  await assert.rejects(receiveStock(part, used, 1), /has been removed/);
  await restoreLocation(used);
  assert.deepEqual((await listLocations()).map((l) => l.path), ['Used']);
  await removeLocation(used);
  assert.equal(await addLocation(null, 'Used', null), used, 'adding a removed location again brings it back');
  assert.deepEqual((await listLocations()).map((l) => l.path), ['Used']);
});
