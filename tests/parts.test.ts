// Parts, sources, search and merging, run against a real (in-memory) library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useFreshLibrary } from './lib/backend.ts';
import {
  deleteOrArchiveParts, emptyPartFields, emptySourceDraft, emptyVendorDraft, getPart, listParts, mergeParts, parseBreaks,
  quickFind, resolveCode, savePart, setPartsStatus, sourcesOf, type PartFields, type SourceDraft,
} from '../src/lib/parts.ts';
import { addVendor, ensureCategoryPath, findPackage, listPackages, packageLabel, updateCategory } from '../src/lib/reference.ts';

const fields = (over: Partial<PartFields>): PartFields => ({ ...emptyPartFields(), ...over });

function source(manufacturer: string, mpn: string, vendors: Array<{ vendor_id: number; sku: string; breaks?: string }> = []): SourceDraft {
  return { ...emptySourceDraft(), manufacturer, mpn, vendors: vendors.map((v) => ({ ...emptyVendorDraft(), ...v, breaks: v.breaks ?? '' })) };
}

async function resistor10k(db: ReturnType<typeof useFreshLibrary>) {
  const cat = await ensureCategoryPath('Passive > Resistor');
  const pkg = await findPackage('2012M');
  const digikey = await addVendor('DigiKey', 'USD', null);
  const id = await savePart({
    partId: null,
    fields: fields({ description: 'Resistor 10k 1% 0805', category_id: cat, value_text: '10k', tolerance_pct: 1, package_id: pkg }),
    sources: [source('Yageo', 'AC0805FR-0710KL', [{ vendor_id: digikey, sku: '311-10.0KCRCT-ND', breaks: '1 0.10, 100 0.021' }])],
  });
  return { id, cat, pkg, digikey, db };
}

test('price breaks parse in any of the usual layouts', () => {
  const want = [{ qty: 1, unit_price: 0.1 }, { qty: 100, unit_price: 0.021 }];
  assert.deepEqual(parseBreaks('1 0.10, 100 0.021'), want);
  assert.deepEqual(parseBreaks('1:0.10; 100:0.021'), want, 'the CSV format');
  assert.deepEqual(parseBreaks('100 $0.021\n1 $0.10'), want, 'one per line, any order, with $');
  assert.deepEqual(parseBreaks(''), []);
  assert.throws(() => parseBreaks('1 0.10 100'), /pairs/);
  assert.throws(() => parseBreaks('1.5 0.10'), /whole quantity/);
});

test('a new part gets the next 5-digit PN, its value, and its sources', async () => {
  const { id, pkg } = await resistor10k(useFreshLibrary());
  const p = (await getPart(id))!;
  assert.equal(p.pn, '00001');
  assert.equal(p.value_num, 10000);
  assert.equal(p.value_unit, 'Ω', 'unit comes from the category');
  assert.equal(p.package_id, pkg);
  assert.equal(p.package, '0805');
  assert.equal(p.mfrParts.length, 1);
  assert.equal(p.mfrParts[0].manufacturer, 'Yageo');
  assert.equal(p.mfrParts[0].preferred, 1, 'the only source is preferred');
  assert.deepEqual(p.mfrParts[0].vendorParts[0].breaks, [{ qty: 1, unit_price: 0.1 }, { qty: 100, unit_price: 0.021 }]);

  const second = await savePart({ partId: null, fields: fields({ description: 'Another' }), sources: [] });
  assert.equal((await getPart(second))!.pn, '00002');
});

test('a PN typed by hand is skipped by the series', async () => {
  useFreshLibrary();
  await savePart({ partId: null, manualPn: '00001', fields: fields({ description: 'typed' }), sources: [] });
  const next = await savePart({ partId: null, fields: fields({ description: 'auto' }), sources: [] });
  assert.equal((await getPart(next))!.pn, '00002');
  await assert.rejects(savePart({ partId: null, manualPn: '00002', fields: fields({ description: 'dup' }), sources: [] }), /already used/);
});

test('an MPN or SKU can belong to only one part', async () => {
  const { digikey } = await resistor10k(useFreshLibrary());
  await assert.rejects(savePart({ partId: null, fields: fields({ description: 'x' }), sources: [source('Yageo', 'AC0805FR-0710KL')] }),
    /already a source of 00001/);
  await assert.rejects(savePart({ partId: null, fields: fields({ description: 'x' }),
    sources: [source('Vishay', 'CRCW080510K0FKEA', [{ vendor_id: digikey, sku: '311-10.0KCRCT-ND' }])] }), /already listed on 00001/);
});

test('editing keeps unchanged sources, removes dropped ones, and re-indexes', async () => {
  const { id } = await resistor10k(useFreshLibrary());
  const p = (await getPart(id))!;
  const drafts = sourcesOf(p);
  drafts.push(source('Vishay', 'CRCW080510K0FKEA'));
  await savePart({ partId: id, fields: { ...fields({}), ...p, name: '10K 1% 0805', status: 'active', kind: 'component' }, sources: drafts });
  let after = (await getPart(id))!;
  assert.equal(after.mfrParts.length, 2);
  assert.equal(after.name, '10K 1% 0805');
  assert.equal((await listParts({ text: 'crcw0805' })).length, 1, 'new MPN is searchable');

  await savePart({ partId: id, fields: { ...fields({}), ...after }, sources: sourcesOf(after).filter((s) => s.manufacturer === 'Vishay') });
  after = (await getPart(id))!;
  assert.deepEqual(after.mfrParts.map((m) => m.manufacturer), ['Vishay']);
  assert.equal((await listParts({ text: 'AC0805FR' })).length, 0, 'removed MPN is gone from search');
});

test('search finds parts by PN, name, MPN, SKU, value (either spelling), package and category', async () => {
  await resistor10k(useFreshLibrary());
  for (const q of ['00001', 'AC0805FR', '311-10', '10k', '10kΩ', '0805', 'resistor', 'passive resistor']) {
    assert.equal((await listParts({ text: q })).length, 1, q);
  }
  assert.equal((await listParts({ text: 'capacitor' })).length, 0);
});

test('quick find understands value, package (including metric) and tolerance', async () => {
  await resistor10k(useFreshLibrary());
  const { parsed, rows } = await quickFind('10k 2012M 1%');
  assert.equal(parsed.value?.num, 10000);
  assert.equal(parsed.tolerance, 1);
  assert.equal(parsed.packages?.text, '2012M');
  assert.equal(rows.length, 1);
  assert.equal((await quickFind('4k7 0805')).rows.length, 0);
});

test('renaming a category updates the paths below it and search', async () => {
  const { cat } = await resistor10k(useFreshLibrary());
  const passive = await ensureCategoryPath('Passive');
  await updateCategory(passive, { name: 'Passives', parent_id: null, ref_prefix: null });
  const p = (await getPart((await listParts())[0].id))!;
  assert.equal(p.category, 'Passives > Resistor');
  assert.equal(p.category_id, cat);
  assert.equal((await listParts({ text: 'passives' })).length, 1);
});

test('packages show their metric name', async () => {
  useFreshLibrary();
  const rows = await listPackages();
  assert.equal(packageLabel(rows.find((r) => r.name === '0805')!), '0805 (2012 metric)');
  assert.equal(packageLabel(rows.find((r) => r.name === 'SOIC-8')!), 'SOIC-8');
});

test('an unused part is deleted; a used one is archived instead', async () => {
  const db = useFreshLibrary();
  const unused = await savePart({ partId: null, fields: fields({ description: 'unused' }), sources: [] });
  const used = await savePart({ partId: null, fields: fields({ description: 'used' }), sources: [] });
  db.exec("INSERT INTO location (id, name, path, code) VALUES (1, 'Bin', 'Bin', 'L0001')");
  db.exec(`INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta) VALUES ('b', 'opening', ${used}, 1, 5)`);
  const r = await deleteOrArchiveParts([unused, used]);
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.archived.map((a) => a.reason), ['5 in stock']);
  assert.equal(await getPart(unused), undefined);
  assert.equal((await getPart(used))!.status, 'archived');
  assert.equal((await listParts()).length, 0, 'archived parts are hidden by default');
  assert.equal((await listParts({ showArchived: true })).length, 1);
});

test('merging moves stock and sources, keeps history, and archives the duplicate', async () => {
  const db = useFreshLibrary();
  const { id: keep, digikey } = await resistor10k(db);
  const dup = await savePart({ partId: null, fields: fields({ description: '10k resistor (duplicate)' }),
    sources: [source('Vishay', 'CRCW080510K0FKEA', [{ vendor_id: digikey, sku: '541-10.0KCCT-ND' }])] });
  db.exec("INSERT INTO location (id, name, path, code) VALUES (1, 'Bin', 'Bin', 'L0001'), (2, 'Box', 'Box', 'L0002')");
  db.exec(`INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta) VALUES
    ('a', 'opening', ${keep}, 1, 100), ('b', 'opening', ${dup}, 1, 40), ('c', 'opening', ${dup}, 2, 7)`);

  await mergeParts(keep, dup);

  const k = (await getPart(keep))!;
  const d = (await getPart(dup))!;
  assert.equal(k.on_hand, 147);
  assert.deepEqual(k.mfrParts.map((m) => m.manufacturer).sort(), ['Vishay', 'Yageo']);
  assert.equal(k.mfrParts.filter((m) => m.preferred).length, 1, 'still one preferred source');
  assert.deepEqual(k.mergedFrom.map((m) => m.pn), ['00002']);
  assert.equal(d.status, 'archived');
  assert.equal(d.merged_into_pn, '00001');
  assert.equal(d.on_hand, 0);
  assert.equal(d.history.length, 4, 'the duplicate keeps its own history: 2 openings, 2 moves out');
  assert.equal((await resolveCode('00002'))?.pn, '00001', 'the old PN leads to the kept part');
  assert.equal((await resolveCode('541-10.0KCCT-ND'))?.pn, '00001');
  await assert.rejects(setPartsStatus([dup], 'active'), /stays archived/);
  await assert.rejects(mergeParts(keep, dup), /already been merged/);
});
