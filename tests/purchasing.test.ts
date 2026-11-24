// Purchasing: sources and prices, the shopping list, build shortages, ordering and receiving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useFreshLibrary } from './lib/backend.ts';
import { addLine, createRev } from '../src/lib/bom.ts';
import { planBuild } from '../src/lib/builds.ts';
import { addLocation } from '../src/lib/locations.ts';
import { emptyPartFields, emptySourceDraft, emptyVendorDraft, getPart, savePart, setPreferredVendorPart } from '../src/lib/parts.ts';
import {
  addBuildShortages, addToList, betterBreak, cartCsv, getItem, listShopping, markOrdered, onOrder, orderText, receiveItem, removeItems,
  roundToPack, sourceOptions, unitPrice, unorder, updateItem,
} from '../src/lib/purchasing.ts';
import { addVendor, setRate } from '../src/lib/reference.ts';

async function setup() {
  const db = useFreshLibrary();
  const mouser = await addVendor('Mouser', 'USD', null);
  const euro = await addVendor('EuroParts', 'EUR', null);
  await setRate('EUR', 1.1);
  const r10k = await savePart({
    partId: null, fields: { ...emptyPartFields(), description: '10k' },
    sources: [{
      ...emptySourceDraft(), manufacturer: 'Yageo', mpn: 'RC0805-10K', preferred: true,
      vendors: [
        { ...emptyVendorDraft(), vendor_id: mouser, sku: 'M-10K', breaks: '1 0.10, 100 0.0095' },
        { ...emptyVendorDraft(), vendor_id: euro, sku: 'E-10K', breaks: '1 0.05' },
      ],
    }],
  });
  const bin = await addLocation(null, 'Bin', null);
  const vp = (sku: string) => (db.prepare('SELECT id FROM vendor_part WHERE sku = ?').get(sku) as { id: number }).id;
  return { db, mouser, euro, r10k, bin, vp };
}

test('prices: breaks, packs, and a bigger quantity that costs no more', () => {
  const b = [{ qty: 1, unit_price: 0.1 }, { qty: 100, unit_price: 0.0095 }];
  assert.deepEqual([unitPrice(b, 5), unitPrice(b, 100), unitPrice(b, 1000), unitPrice([], 5)], [0.1, 0.0095, 0.0095, null]);
  assert.deepEqual([roundToPack(7, { moq: 10, order_multiple: null }), roundToPack(12, { moq: null, order_multiple: 5 }), roundToPack(3, { moq: null, order_multiple: null })], [10, 15, 3]);
  assert.deepEqual(betterBreak(b, 20, { moq: null, order_multiple: null }), { qty: 100, unit: 0.0095, total: 0.95 });
  assert.equal(betterBreak(b, 5, { moq: null, order_multiple: null }), null, '100 for 0.95 costs more than 5 for 0.50');
  assert.equal(betterBreak(b, 150, { moq: null, order_multiple: null }), null);
});

test('sources: priced for the quantity, in the base currency too; the preferred one comes first, else the cheapest', async () => {
  const s = await setup();
  let o = await sourceOptions(s.r10k, 10);
  assert.deepEqual(o.map((x) => [x.vendor, x.total, x.total_base]), [['EuroParts', 0.5, 0.55], ['Mouser', 1, 1]]);
  await setPreferredVendorPart(s.r10k, s.vp('M-10K'));
  o = await sourceOptions(s.r10k, 10);
  assert.equal(o[0].vendor, 'Mouser');
  s.db.prepare('UPDATE vendor_part SET moq = 25 WHERE sku = ?').run('E-10K');
  assert.equal((await sourceOptions(s.r10k, 10)).find((x) => x.vendor === 'EuroParts')!.buy, 25);
});

test('the list: a part gets the best source and its price; the same part from the same vendor is topped up and repriced', async () => {
  const s = await setup();
  await setPreferredVendorPart(s.r10k, s.vp('M-10K'));
  const a = await addToList({ partId: s.r10k, qty: 50 });
  const b = await addToList({ partId: s.r10k, qty: 50, reason: 'B0001 short' });
  assert.equal(a, b);
  const it = (await getItem(a))!;
  assert.deepEqual([it.vendor, it.sku, it.qty, it.unit_price, it.currency, it.reason], ['Mouser', 'M-10K', 100, 0.0095, 'USD', 'manual, B0001 short']);
  const other = await addToList({ partId: s.r10k, qty: 10, vendorPartId: s.vp('E-10K') });
  assert.notEqual(other, a, 'a different vendor is a separate line');
  assert.deepEqual([(await getItem(other))!.currency, (await getItem(other))!.unit_price], ['EUR', 0.05]);
  const misc = await addToList({ description: 'Solder paste', qty: 1, vendorId: s.euro, unitPrice: 20 });
  assert.equal((await getItem(misc))!.currency, 'EUR');
  await updateItem(other, { qty: 10, vendor_id: s.mouser, sku: 'M-10K', unit_price: null, note: null });
  assert.deepEqual([(await getItem(other))!.vendor, (await getItem(other))!.unit_price], ['Mouser', 0.1], 'switching vendor picks up its part and price');
  assert.deepEqual(await onOrder([s.r10k]), new Map([[s.r10k, { open: 110, ordered: 0 }]]));
});

test('build shortages: what’s short, less what’s coming, rounded to the pack; asking again adds nothing', async () => {
  const s = await setup();
  await setPreferredVendorPart(s.r10k, s.vp('M-10K'));
  s.db.prepare('UPDATE vendor_part SET order_multiple = 10 WHERE sku = ?').run('M-10K');
  const board = await savePart({ partId: null, fields: { ...emptyPartFields(), description: 'Board', kind: 'assembly' }, sources: [] });
  const rev = await createRev(board, 'A', null, null);
  await addLine(rev, { part_id: s.r10k, designators: 'R1, R2, R3', qty: 3, dnp: false, note: null });
  const build = await planBuild(rev, 4);   // needs 12
  const first = await addBuildShortages(build);
  assert.deepEqual(first.added.map((a) => a.qty), [20]);
  const again = await addBuildShortages(build);
  assert.deepEqual([again.added.length, again.covered.length], [0, 1]);
  assert.equal((await listShopping('open'))[0].build_code, 'B0001');
});

test('order, receive part of it, then the rest: stock comes in with the cost in the base currency', async () => {
  const s = await setup();
  const id = await addToList({ partId: s.r10k, qty: 100, vendorPartId: s.vp('E-10K') });   // EUR 0.05
  await markOrdered([id], 'PO-1');
  assert.equal((await getItem(id))!.status, 'ordered');
  const first = await receiveItem(id, { qty: 60, locationId: s.bin });
  assert.equal(first.rest, 40);
  const part = (await getPart(s.r10k))!;
  assert.deepEqual([part.on_hand, part.location], [60, 'Bin']);
  const txn = s.db.prepare("SELECT unit_cost, order_ref, vendor_id FROM stock_txn WHERE kind = 'receive'").get() as Record<string, unknown>;
  assert.deepEqual({ ...txn }, { unit_cost: 0.055, order_ref: 'PO-1', vendor_id: s.euro });
  assert.deepEqual([(await getItem(id))!.qty, (await getItem(id))!.status], [40, 'ordered']);
  assert.deepEqual((await listShopping('received')).map((i) => [i.qty, i.order_ref]), [[60, 'PO-1']]);
  await receiveItem(id, { qty: 40, locationId: s.bin, unitPrice: 0.04 });
  assert.deepEqual([(await getItem(id))!.status, (await getItem(id))!.unit_price], ['received', 0.04]);
  assert.equal((await getPart(s.r10k))!.on_hand, 100);
  await assert.rejects(receiveItem(id, { qty: 1, locationId: s.bin }), /already been received/);
});

test('removing: deleted while to buy, cancelled once ordered; "not ordered" moves it back', async () => {
  const s = await setup();
  const a = await addToList({ partId: s.r10k, qty: 1 });
  const b = await addToList({ description: 'Stencil', qty: 1 });
  await markOrdered([b], null);
  await unorder([b]);
  assert.equal((await getItem(b))!.status, 'open');
  await markOrdered([b], 'X');
  await removeItems([a, b]);
  assert.equal(await getItem(a), undefined);
  assert.equal((await getItem(b))!.status, 'cancelled');
});

test('cart CSV: the vendor’s column names, our PN as the reference, and no byte-order mark', async () => {
  const s = await setup();
  s.db.prepare("UPDATE vendor SET api_connector = 'digikey' WHERE id = ?").run(s.mouser);
  const id = await addToList({ partId: s.r10k, qty: 25, vendorPartId: s.vp('M-10K') });
  const items = [(await getItem(id))!];
  const pn = (await getPart(s.r10k))!.pn;
  assert.equal(cartCsv(items), `Quantity,Digi-Key Part Number,Customer Reference\r\n25,M-10K,${pn}\r\n`);
  assert.equal(orderText(items), `25, M-10K, ${pn}`);
});
