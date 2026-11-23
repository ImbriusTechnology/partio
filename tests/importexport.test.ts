// CSV import and export, run against a real (in-memory) library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useFreshLibrary } from './lib/backend.ts';
import { MIGRATIONS_DIR } from './lib/db.ts';
import { parseCsv, writeCsv } from '../src/lib/csv.ts';
import { COLUMNS, FILE_ORDER, guessKind } from '../src/lib/csvFormat.ts';
import { exportLibrary, templates } from '../src/lib/exporter.ts';
import { importCsv, type ImportOptions } from '../src/lib/importer.ts';
import { listLocations } from '../src/lib/locations.ts';
import { getPart, listParts } from '../src/lib/parts.ts';
import { listVendors } from '../src/lib/reference.ts';

const ADD: ImportOptions = { mode: 'add', stockMode: 'add' };
const UPDATE: ImportOptions = { mode: 'update', stockMode: 'add' };
const csv = (name: string, lines: string[]) => ({ name, text: `${lines.join('\n')}\n` });
const count = (db: ReturnType<typeof useFreshLibrary>, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('CSV parsing: quotes, commas, newlines in fields, CRLF, BOM, blank lines', () => {
  const t = parseCsv('﻿a,b,c\r\n1,"two, with comma","say ""hi"""\r\n\r\n4,"multi\nline",\n');
  assert.deepEqual(t.headers, ['a', 'b', 'c']);
  assert.deepEqual(t.rows, [['1', 'two, with comma', 'say "hi"'], ['4', 'multi\nline', '']]);
  assert.deepEqual(t.lines, [2, 4]);
  assert.throws(() => parseCsv('a\n"never closed'), /never closed/);
});

test('CSV writing round-trips through the parser', () => {
  const rows = [['1', 'two, with comma', 'say "hi"'], ['Ω µ ±', ' leading space', null]];
  const t = parseCsv(writeCsv(['a', 'b', 'c'], rows));
  assert.deepEqual(t.rows, [['1', 'two, with comma', 'say "hi"'], ['Ω µ ±', ' leading space', '']]);
});

test('file kinds are guessed from the name, then the columns', () => {
  assert.equal(guessKind('My Locations.csv', []), 'locations');
  assert.equal(guessKind('part_sources.csv', []), 'sources');
  assert.equal(guessKind('export.csv', ['PN', 'Description']), 'parts');
  assert.equal(guessKind('export.csv', ['pn', 'location', 'qty']), 'stock');
  assert.equal(guessKind('x.csv', ['foo']), null);
});

test('the templates import cleanly into an empty library', async () => {
  const db = useFreshLibrary();
  const r = await importCsv(templates(), ADD, true);
  assert.equal(r.errorCount, 0, JSON.stringify(r.files.flatMap((f) => f.errors)));
  assert.equal(r.committed, true);
  assert.equal(count(db, 'part'), 1);
  const p = (await getPart((await listParts())[0].id))!;
  assert.equal(p.location, 'Cabinet A > Drawer 1 > Bin 01');
  assert.equal(p.on_hand, 250);
  assert.deepEqual(p.mfrParts.map((m) => m.manufacturer).sort(), ['Vishay', 'Yageo']);
  assert.deepEqual(r.alsoCreated.categories, ['Passive', 'Passive > Resistor']);
  assert.deepEqual(r.alsoCreated.vendors, ['DigiKey', 'Mouser']);
});

test('a preview changes nothing, and reports what would happen', async () => {
  const db = useFreshLibrary();
  const r = await importCsv(templates(), ADD, false);
  assert.equal(r.committed, false);
  assert.equal(r.errorCount, 0);
  assert.equal(r.files.find((f) => f.kind === 'locations')!.created, 3);
  for (const t of ['part', 'location', 'category', 'vendor', 'manufacturer', 'stock_txn']) assert.equal(count(db, t), 0, t);
});

test('any error stops the whole import, and errors name the file line', async () => {
  const db = useFreshLibrary();
  const r = await importCsv([
    csv('locations.csv', ['path,code', 'Shelf,L0001']),
    csv('parts.csv', ['pn,description,kind,tolerance_pct', '00010,Good part,component,1', '00011,Bad kind,gizmo,', '00012,Bad number,,"1,5"']),
  ], ADD, true);
  assert.equal(r.committed, false);
  assert.deepEqual(r.files[1].errors.map((e) => e.line), [3, 4]);
  assert.match(r.files[1].errors[0].message, /kind should be one of/);
  assert.match(r.files[1].errors[1].message, /no thousands separators/);
  assert.equal(count(db, 'part'), 0);
  assert.equal(count(db, 'location'), 0, 'the good file is not kept either');
});

test('missing required columns and unknown columns are reported per file', async () => {
  useFreshLibrary();
  const r = await importCsv([
    csv('locations.csv', ['code,description', 'L1,x']),
    csv('parts.csv', ['pn,description,Colour', '00001,Thing,red']),
  ], ADD, false);
  assert.match(r.files[0].problem!, /Missing column: path/);
  assert.deepEqual(r.files[1].unknownColumns, ['Colour']);
  assert.equal(r.unknownColumnCount, 1);
});

test('add mode skips existing parts; update mode changes only the cells that are filled', async () => {
  const db = useFreshLibrary();
  await importCsv([csv('parts.csv', ['pn,name,description,value,notes', '00001,R1,Resistor,10k,keep me'])], ADD, true);
  const again = await importCsv([csv('parts.csv', ['pn,description,value', '00001,Changed,4k7'])], ADD, true);
  assert.equal(again.files[0].unchanged, 1);
  assert.equal((await getPart(1))!.description, 'Resistor');

  const upd = await importCsv([csv('parts.csv', ['pn,name,description,value,notes', '00001,,Resistor 4k7,4k7,'])], UPDATE, true);
  assert.equal(upd.files[0].updated, 1);
  const p = (await getPart(1))!;
  assert.equal(p.description, 'Resistor 4k7');
  assert.equal(p.value_text, '4k7');
  assert.equal(p.name, 'R1', 'a blank cell leaves the name alone');
  assert.equal(p.notes, 'keep me');
  const same = await importCsv([csv('parts.csv', ['pn,description,value', '00001,Resistor 4k7,4k7'])], UPDATE, true);
  assert.equal(same.files[0].unchanged, 1, 'an update that changes nothing counts as unchanged');
  assert.equal(count(db, 'part'), 1);
});

test('parts without a PN get the next number; rows match existing parts by MPN', async () => {
  useFreshLibrary();
  await importCsv([csv('parts.csv', ['description,manufacturer,mpn', 'Op-amp,TI,LM358DR', 'Timer,TI,NE555DR'])], ADD, true);
  assert.deepEqual((await listParts()).map((p) => p.pn).sort(), ['00001', '00002']);
  const r = await importCsv([csv('parts.csv', ['description,manufacturer,mpn,package', 'Op-amp dual,TI,LM358DR,SO-8'])], UPDATE, true);
  assert.equal(r.files[0].updated, 1);
  const p = (await listParts({ text: 'LM358DR' }))[0];
  assert.equal(p.package, 'SOIC-8', 'SO-8 is another name for SOIC-8');
});

test('stock: add mode adds, set mode sets counts', async () => {
  useFreshLibrary();
  await importCsv([csv('locations.csv', ['path,code', 'Bin,L0001']), csv('parts.csv', ['pn,description', '00001,Thing'])], ADD, true);
  await importCsv([csv('stock.csv', ['pn,location,qty', '00001,L0001,10', '00001,Box > Lid,5'])], ADD, true);
  let p = (await getPart(1))!;
  assert.equal(p.on_hand, 15);
  assert.equal(p.location, 'Bin', 'first stock location becomes the usual one');
  assert.ok((await listLocations()).some((l) => l.path === 'Box > Lid'), 'a new location path is created');
  const r = await importCsv([csv('stock.csv', ['pn,location,qty', '00001,L0001,7', '00001,Box > Lid,5'])], { mode: 'add', stockMode: 'set' }, true);
  assert.deepEqual([r.files[0].updated, r.files[0].unchanged], [1, 1]);
  p = (await getPart(1))!;
  assert.equal(p.on_hand, 12);
  const bad = await importCsv([csv('stock.csv', ['pn,location,qty', '00001,L0099,1'])], ADD, false);
  assert.match(bad.files[0].errors[0].message, /No location has the code L0099/);
});

test('sources: new manufacturer and vendor parts with price breaks; clashes are errors', async () => {
  useFreshLibrary();
  await importCsv([csv('parts.csv', ['pn,description', '00001,Resistor', '00002,Other'])], ADD, true);
  const r = await importCsv([csv('sources.csv', [
    'pn,manufacturer,mpn,preferred,vendor,sku,price_breaks,currency',
    '00001,Yageo,AC0805FR-0710KL,,DigiKey,311-10.0KCRCT-ND,1:0.10; 100:0.021,',
    '00001,Vishay,CRCW080510K0FKEA,yes,Mouser,71-CRCW,1:0.12,AUD',
    '00002,Yageo,AC0805FR-0710KL,,,,,',
  ])], ADD, false);
  assert.equal(r.files[0].created, 2);
  assert.match(r.files[0].errors[0].message, /already a source of 00001/);
  assert.equal(r.files[0].errors[0].line, 4);

  const ok = await importCsv([csv('sources.csv', [
    'pn,manufacturer,mpn,preferred,vendor,sku,price_breaks,currency',
    '00001,Yageo,AC0805FR-0710KL,,DigiKey,311-10.0KCRCT-ND,1:0.10; 100:0.021,',
    '00001,Vishay,CRCW080510K0FKEA,yes,Mouser,71-CRCW,1:0.12,AUD',
  ])], ADD, true);
  assert.equal(ok.committed, true);
  const p = (await getPart(1))!;
  assert.equal(p.mfrParts.find((m) => m.preferred)?.manufacturer, 'Vishay');
  const vishay = p.mfrParts.find((m) => m.manufacturer === 'Vishay')!;
  assert.equal(vishay.vendorParts[0].currency, 'AUD');
  assert.equal((await listVendors()).find((v) => v.name === 'Mouser')?.currency, 'AUD', 'a new vendor takes the currency of the row naming it');
  assert.deepEqual(p.mfrParts.find((m) => m.manufacturer === 'Yageo')!.vendorParts[0].breaks, [{ qty: 1, unit_price: 0.1 }, { qty: 100, unit_price: 0.021 }]);
  assert.equal((await listParts({ text: '71-CRCW' })).length, 1, 'the search index is rebuilt after an import');
});

test('in add mode, sources.csv can still fill in what parts.csv created in the same import', async () => {
  useFreshLibrary();
  const r = await importCsv([
    csv('parts.csv', ['pn,description,manufacturer,mpn', '00001,Diode,Diodes Inc,MMBD4148-7']),
    csv('sources.csv', ['pn,manufacturer,mpn,lifecycle,vendor,sku,currency', '00001,Diodes Inc,MMBD4148-7,obsolete,Mouser,621-MMBD4148-7,AUD']),
  ], ADD, true);
  assert.equal(r.errorCount, 0);
  const m = (await getPart(1))!.mfrParts[0];
  assert.equal(m.lifecycle, 'obsolete');
  assert.equal(m.vendorParts[0].currency, 'AUD');
  const again = await importCsv([csv('sources.csv', ['pn,manufacturer,mpn,lifecycle', '00001,Diodes Inc,MMBD4148-7,active'])], ADD, true);
  assert.equal(again.files[0].unchanged, 1, 'but not what was there before the import');
  assert.equal((await getPart(1))!.mfrParts[0].lifecycle, 'obsolete');
});

test('export, then import into an empty library, gives the same library', async () => {
  useFreshLibrary();
  const first = await importCsv(templates(), ADD, true);
  assert.equal(first.errorCount, 0);
  await importCsv([csv('parts.csv', ['description,category,value,tolerance_pct,package,notes,status',
    '"Cap 100n, X7R",Passive > Capacitor,100n,10,0603,"line one\nline two",obsolete'])], ADD, true);
  const exported = await exportLibrary();
  const snapshot = async () => {
    const vendorCurrency = new Map((await listVendors(true)).map((v) => [v.id, v.currency]));
    return (await Promise.all((await listParts({ showArchived: true })).map((p) => getPart(p.id)))).map((p) => ({
    pn: p!.pn, name: p!.name, description: p!.description, category: p!.category, value: p!.value_text, tol: p!.tolerance_pct,
    package: p!.package, location: p!.location, status: p!.status, notes: p!.notes, on_hand: p!.on_hand,
    stock: p!.stock.map((s) => [s.code, s.qty]),
    sources: p!.mfrParts.map((m) => [m.manufacturer, m.mpn, m.preferred,
      m.vendorParts.map((v) => [v.vendor, v.sku, v.currency ?? vendorCurrency.get(v.vendor_id), v.breaks])]),
  }));
  };
  const before = await snapshot();

  useFreshLibrary();
  const back = await importCsv(exported, ADD, true);
  assert.equal(back.errorCount, 0, JSON.stringify(back.files.flatMap((f) => f.errors)));
  assert.deepEqual(await snapshot(), before);
});

test('docs/csv-format.md describes every column', () => {
  const doc = readFileSync(join(MIGRATIONS_DIR, '..', 'docs', 'csv-format.md'), 'utf8');
  for (const kind of FILE_ORDER) {
    assert.ok(doc.includes(`${kind}.csv`), `${kind}.csv`);
    for (const c of COLUMNS[kind].columns) assert.ok(doc.includes(`\`${c.name}\``), `${kind}.${c.name}`);
  }
});
