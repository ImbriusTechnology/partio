// The schema: migrations apply cleanly, and the rules the database enforces hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshLibrary, migrate, migrationFiles, MIGRATIONS_DIR } from './lib/db.ts';

const one = <T>(db: ReturnType<typeof freshLibrary>, sql: string, ...params: Array<string | number | null>) =>
  db.prepare(sql).get(...params) as T;

test('every migration applies, once', () => {
  const db = freshLibrary();
  const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>;
  assert.deepEqual(rows.map((r) => r.name), migrationFiles());
  assert.deepEqual(migrate(db), [], 'a second run applies nothing');
});

test('the app lists the same migrations as migrations/', () => {
  const rust = readFileSync(join(MIGRATIONS_DIR, '..', 'src-tauri', 'src', 'db.rs'), 'utf8');
  const listed = [...rust.matchAll(/\("(\d{3}_[^"]+\.sql)"/g)].map((m) => m[1]);
  assert.deepEqual(listed, migrationFiles());
});

test('a new library starts with no parts, one 5-digit series and a base currency', () => {
  const db = freshLibrary();
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM part').n, 0);
  const s = one<{ prefix: string; width: number; next_value: number }>(db, 'SELECT * FROM pn_series');
  assert.deepEqual({ prefix: s.prefix, width: s.width, next: s.next_value }, { prefix: '', width: 5, next: 1 });
  assert.equal(one<{ value: string }>(db, "SELECT value FROM setting WHERE key = 'base_currency'").value, 'USD');
});

test('old part numbers are not part of the schema', () => {
  const db = freshLibrary();
  assert.equal(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'legacy_pn'").n, 0);
});

test('part kinds exclude product, and statuses are active, obsolete, archived', () => {
  const db = freshLibrary();
  const add = db.prepare("INSERT INTO part (pn, kind, status, description) VALUES (?, ?, ?, 'x')");
  for (const kind of ['component', 'pcb', 'assembly', 'mechanical', 'consumable']) add.run(`k-${kind}`, kind, 'active');
  assert.throws(() => add.run('k-product', 'product', 'active'), /CHECK/);
  add.run('s-obsolete', 'component', 'obsolete');
  add.run('s-archived', 'component', 'archived');
  assert.throws(() => add.run('s-hidden', 'component', 'hidden'), /CHECK/);
});

test('a merged part must be archived', () => {
  const db = freshLibrary();
  db.exec("INSERT INTO part (id, pn, description) VALUES (1, '00001', 'keeper')");
  assert.throws(() => db.exec("INSERT INTO part (pn, description, merged_into_id) VALUES ('00002', 'dup', 1)"), /CHECK/);
  db.exec("INSERT INTO part (pn, description, merged_into_id, status) VALUES ('00002', 'dup', 1, 'archived')");
});

test('stock follows the ledger, and the ledger cannot be edited', () => {
  const db = freshLibrary();
  db.exec("INSERT INTO part (id, pn, description) VALUES (1, '00001', 'resistor')");
  db.exec("INSERT INTO location (id, name, path, code) VALUES (1, 'Bin 01', 'Bin 01', 'L0001')");
  const txn = db.prepare("INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta) VALUES ('b', ?, 1, 1, ?)");
  txn.run('opening', 100);
  txn.run('consume', -30);
  assert.equal(one<{ qty: number }>(db, 'SELECT qty FROM stock').qty, 70);
  assert.equal(one<{ on_hand: number }>(db, 'SELECT on_hand FROM part_stock WHERE part_id = 1').on_hand, 70);
  txn.run('consume', -70);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM stock').n, 0, 'an emptied location leaves no row');
  assert.throws(() => db.exec('UPDATE stock_txn SET qty_delta = 5'), /cannot be changed/);
});

test('packages find each other by metric name', () => {
  const db = freshLibrary();
  const find = (name: string) => one<{ name: string } | undefined>(db,
    `SELECT p.name FROM package p WHERE p.name = ?1
     UNION SELECT p.name FROM package_alias a JOIN package p ON p.id = a.package_id WHERE a.alias = ?1`, name)?.name;
  assert.equal(find('2012M'), '0805');
  assert.equal(find('2012'), '0805');
  assert.equal(find('1608m'), '0603', 'aliases ignore case');
  assert.equal(find('0603'), '0603', 'a bare 0603 is the imperial size');
  assert.equal(find('SO-8'), 'SOIC-8');
  const label = one<{ label: string }>(db,
    `SELECT p.name || ' (' || replace(a.alias, 'M', '') || ' metric)' AS label
     FROM package p JOIN package_alias a ON a.package_id = p.id AND a.is_metric AND a.alias LIKE '%M'
     WHERE p.name = '0805'`).label;
  assert.equal(label, '0805 (2012 metric)');
});

test('full-text search finds a part by name, value and prefix', () => {
  const db = freshLibrary();
  db.prepare('INSERT INTO part_fts (part_id, pn, name, description, value_text, package) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, '00001', 'LM358', 'Dual op-amp', null, 'SOIC-8');
  const hit = (q: string) => (db.prepare('SELECT part_id FROM part_fts WHERE part_fts MATCH ?').all(q) as unknown[]).length;
  assert.equal(hit('lm358'), 1);
  assert.equal(hit('op*'), 1);
  assert.equal(hit('resistor'), 0);
});
