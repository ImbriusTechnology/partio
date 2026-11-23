// First-run setup, starter data and the demo library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useFreshLibrary } from './lib/backend.ts';
import { MIGRATIONS_DIR } from './lib/db.ts';
import { addLocation } from '../src/lib/locations.ts';
import { emptyPartFields, getPart, listParts, savePart } from '../src/lib/parts.ts';
import { getSetting, listCategories, listVendors, setRate } from '../src/lib/reference.ts';
import {
  STARTER_CATEGORIES, addStarterData, completeSetup, currencyForLocale, demoCounts, loadDemo, needsSetup, removeDemo, setBaseCurrency,
} from '../src/lib/setup.ts';
import { moveStock, receiveStock } from '../src/lib/stock.ts';

const DEMO_DIR = join(MIGRATIONS_DIR, '..', 'src', 'demo');
const demoFiles = () => ['locations', 'parts', 'stock', 'sources'].map((k) => ({ name: `${k}.csv`, text: readFileSync(join(DEMO_DIR, `${k}.csv`), 'utf8') }));

test('the currency is guessed from the locale', () => {
  assert.equal(currencyForLocale('en-AU'), 'AUD');
  assert.equal(currencyForLocale('de-DE'), 'EUR');
  assert.equal(currencyForLocale('en_GB'), 'GBP');
  assert.equal(currencyForLocale('zh-Hans-CN'), 'CNY');
  assert.equal(currencyForLocale('en'), 'USD');
  assert.equal(currencyForLocale(undefined), 'USD');
});

test('a new library needs setup; one with parts does not', async () => {
  useFreshLibrary();
  assert.equal(await needsSetup(), true);
  await savePart({ partId: null, fields: { ...emptyPartFields(), description: 'x' }, sources: [] });
  assert.equal(await needsSetup(), false);
  assert.ok(await getSetting('setup_done'));
});

test('setup sets the base currency, resets exchange rates, and adds starter data once', async () => {
  const db = useFreshLibrary();
  await completeSetup({ currency: 'aud', starter: true });
  assert.equal(await getSetting('base_currency'), 'AUD');
  const rates = () => db.prepare('SELECT currency, to_base FROM fx_rate ORDER BY currency').all().map((r) => ({ ...r }));
  assert.deepEqual(rates(), [{ currency: 'AUD', to_base: 1 }, { currency: 'USD', to_base: 0 }], 'the old base stays listed, not set');
  assert.equal((await listCategories()).length, STARTER_CATEGORIES.length);
  assert.equal((await listCategories()).find((c) => c.path === 'Passive > Resistor')?.ref_prefix, 'R');
  const vendors = await listVendors();
  assert.deepEqual(vendors.map((v) => [v.name, v.currency]), [['DigiKey', 'AUD'], ['element14', 'AUD'], ['LCSC', 'USD'], ['Mouser', 'AUD']]);
  assert.deepEqual(await addStarterData('AUD'), { categories: 0, vendors: 0 }, 'running it again adds nothing');

  // Changing the base: it becomes 1, every other rate (the old base included) is kept but set to 0.
  db.exec("INSERT INTO fx_rate (currency, to_base) VALUES ('EUR', 1.65)");
  db.exec("UPDATE fx_rate SET to_base = 1.52 WHERE currency = 'USD'");
  await setBaseCurrency('USD');
  assert.deepEqual(rates(), [{ currency: 'AUD', to_base: 0 }, { currency: 'EUR', to_base: 0 }, { currency: 'USD', to_base: 1 }]);
  await setRate('AUD', 0.66);
  assert.deepEqual(rates()[0], { currency: 'AUD', to_base: 0.66 }, 'the old base can be given a rate');
  assert.equal(await needsSetup(), false);
});

test('the demo loads cleanly, with or without the starter data', async () => {
  for (const starter of [true, false]) {
    useFreshLibrary();
    await completeSetup({ currency: 'USD', starter });
    const r = await loadDemo(demoFiles());
    assert.equal(r.errorCount, 0);
    assert.deepEqual(await demoCounts(), { parts: 27, locations: 11 });
    const lm358 = (await listParts({ text: 'LM358' }))[0];
    const p = (await getPart(lm358.id))!;
    assert.equal(p.pn, '90014');
    assert.equal(p.category, 'IC > Op-amp');
    assert.equal(p.on_hand, 12);
    assert.equal(p.mfrParts[0].vendorParts[0].sku, '595-LM358DR');
    if (starter) assert.deepEqual(r.alsoCreated.vendors, [], 'the demo uses the starter vendors');
  }
});

test('a new part after the demo still starts at 00001', async () => {
  useFreshLibrary();
  await completeSetup({ currency: 'USD', starter: true });
  await loadDemo(demoFiles());
  const id = await savePart({ partId: null, fields: { ...emptyPartFields(), description: 'Mine' }, sources: [] });
  assert.equal((await getPart(id))!.pn, '00001');
  await assert.rejects(loadDemo(demoFiles()), /already loaded/);
});

test('removing the demo keeps what you have used or added, and removes the rest', async () => {
  useFreshLibrary();
  await completeSetup({ currency: 'USD', starter: true });
  await loadDemo(demoFiles());
  const byPn = async (pn: string) => (await listParts({ text: pn, showArchived: true })).find((p) => p.pn === pn)!;
  const bin = (await getPart((await byPn('90014')).id))!.stock[0].location_id;

  // Use two demo parts, and add a part and a location of your own inside a demo location.
  const lm358 = (await byPn('90014')).id;
  const ne555 = (await byPn('90015')).id;
  const mine = await addLocation(bin, 'My tray', null);
  await moveStock(lm358, bin, mine, 2, null);
  await receiveStock(ne555, bin, 10);
  const myPart = await savePart({ partId: null, fields: { ...emptyPartFields(), description: 'Mine' }, sources: [] });

  const r = await removeDemo();
  assert.deepEqual([r.removedParts, r.keptParts], [25, 2]);
  const left = (await listParts({ showArchived: true })).map((p) => p.pn).sort();
  assert.deepEqual(left, ['00001', '90014', '90015']);
  assert.ok(await getPart(myPart));
  assert.equal((await getPart(lm358))!.on_hand, 12, 'kept parts keep all their stock, demo opening included');
  assert.deepEqual(await demoCounts(), { parts: 0, locations: 0 }, 'what was kept is no longer tagged as demo');
  // The bin holds kept stock, so it and the cabinet and drawer above it stay; the rest of the demo locations go.
  assert.ok(r.keptLocations >= 3);
  assert.equal(r.removedLocations + r.keptLocations, 11);
  assert.equal((await listParts({ text: 'resistor' })).length, 0, 'search no longer finds removed demo parts');
});
