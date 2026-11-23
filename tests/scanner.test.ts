// Telling a barcode scanner's burst of keys apart from a person typing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanDetector, scanTarget } from '../src/lib/scanner.ts';

const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; inField: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, inField: false, ...over });

function type(d: ReturnType<typeof createScanDetector>, text: string, start: number, gapMs: number, enter = true): number {
  let t = start;
  for (const ch of text) { d.key(key(ch), t); t += gapMs; }
  if (enter) d.key(key('Enter'), t);
  return t;
}

test('a fast burst ending in Enter is a scan', () => {
  const scans: string[] = [];
  const d = createScanDetector({ onScan: (c) => scans.push(c) });
  type(d, '00042', 0, 5);
  assert.deepEqual(scans, ['00042']);
});

test('slow typing is not a scan', () => {
  const scans: string[] = [];
  const d = createScanDetector({ onScan: (c) => scans.push(c) });
  type(d, '00042', 0, 150);
  assert.deepEqual(scans, []);
});

test('keys typed in a text field, or with a modifier, are never a scan', () => {
  const scans: string[] = [];
  const d = createScanDetector({ onScan: (c) => scans.push(c) });
  for (const ch of 'L0001') d.key(key(ch, { inField: true }), 0);
  d.key(key('Enter', { inField: true }), 1);
  assert.equal(d.key(key('k', { metaKey: true }), 2), false);
  assert.deepEqual(scans, []);
});

test('a scanner that sends no Enter is caught after a pause', () => {
  const scans: string[] = [];
  const d = createScanDetector({ onScan: (c) => scans.push(c) });
  const end = type(d, 'L0042', 0, 5, false);
  d.tick(end + 10);
  assert.deepEqual(scans, [], 'not yet');
  d.tick(end + 200);
  assert.deepEqual(scans, ['L0042']);
});

test('a symbology prefix such as ]Q1 is dropped', () => {
  const scans: string[] = [];
  const d = createScanDetector({ onScan: (c) => scans.push(c) });
  type(d, ']Q100042', 0, 5);
  assert.deepEqual(scans, ['00042']);
});

test('scan targets: location codes, PNs and short numbers', () => {
  assert.deepEqual(scanTarget('l0042'), { kind: 'location', code: 'L0042' });
  assert.deepEqual(scanTarget('42'), { kind: 'part', codes: ['42', '00042'] });
  assert.deepEqual(scanTarget('595-LM358DR'), { kind: 'part', codes: ['595-LM358DR'] });
});
