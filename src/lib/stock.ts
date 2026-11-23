// Changing stock. Every change is a row in the stock_txn ledger; a trigger keeps the stock table in step.
// Ledger rows are never edited or deleted: a mistake is corrected with another row.
import { batchId, execute, query, queryOne, transaction, type Statement } from './db.ts';
import { manufacturerIdFor } from './reference.ts';
import { reindexPart } from './search.ts';

export async function currentQty(partId: number, locationId: number): Promise<number> {
  return (await queryOne<{ qty: number }>('SELECT qty FROM stock WHERE part_id = ? AND location_id = ?', [partId, locationId]))?.qty ?? 0;
}

function checkQty(qty: number): void {
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be more than zero');
}

async function checkLocation(locationId: number): Promise<void> {
  const l = await queryOne<{ archived: number; path: string }>('SELECT archived, path FROM location WHERE id = ?', [locationId]);
  if (!l) throw new Error('Location not found');
  if (l.archived) throw new Error(`${l.path} has been removed; restore it first`);
}

/** Set the counted quantity at a location (records the difference as a count). Returns the difference. */
export async function countStock(partId: number, locationId: number, counted: number, note: string | null): Promise<number> {
  if (!Number.isFinite(counted) || counted < 0) throw new Error('The count can’t be negative');
  await checkLocation(locationId);
  const delta = counted - (await currentQty(partId, locationId));
  if (delta !== 0) {
    await execute(`INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'count', ?, ?, ?, ?)`,
      [batchId(), partId, locationId, delta, note?.trim() || null]);
  }
  return delta;
}

/** Take stock out (used, lost, scrapped). */
export async function removeStock(partId: number, locationId: number, qty: number, note: string | null): Promise<void> {
  checkQty(qty);
  if ((await currentQty(partId, locationId)) < qty) throw new Error('Not that many at that location');
  await execute(`INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'adjust', ?, ?, ?, ?)`,
    [batchId(), partId, locationId, -qty, note?.trim() || null]);
}

export async function moveStock(partId: number, fromId: number, toId: number, qty: number, note: string | null): Promise<void> {
  if (fromId === toId) throw new Error('Choose a different location');
  checkQty(qty);
  await checkLocation(toId);
  if ((await currentQty(partId, fromId)) < qty) throw new Error('Not that many at the source location');
  const b = batchId();
  await transaction([
    { sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'move', ?, ?, ?, ?)`, params: [b, partId, fromId, -qty, note?.trim() || null] },
    { sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'move', ?, ?, ?, ?)`, params: [b, partId, toId, qty, note?.trim() || null] },
  ]);
}

/**
 * Book stock in. The vendor is recorded on the receipt. With a vendor part number (SKU) too, that vendor part
 * is used, or added to the part if it's new (under the chosen manufacturer part, else the preferred one,
 * else a placeholder "Unknown" manufacturer part), so the next order can find it.
 * `unitCost` is in the base currency.
 */
export async function receiveStock(partId: number, locationId: number, qty: number, o: {
  mfrPartId?: number | null; vendorId?: number | null; sku?: string | null; unitCost?: number | null; orderRef?: string | null; note?: string | null;
} = {}): Promise<{ addedVendorPart: boolean }> {
  checkQty(qty);
  await checkLocation(locationId);
  let mfrPartId = o.mfrPartId ?? null;
  let vendorPartId: number | null = null;
  let added = false;
  const sku = o.sku?.trim() || null;
  if (sku && !o.vendorId) throw new Error('Choose who it was bought from as well as their part number');
  if (o.vendorId && sku) {
    const vp = await queryOne<{ id: number; mfr_part_id: number; part_id: number; pn: string }>(`
      SELECT vp.id, vp.mfr_part_id, m.part_id, p.pn FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id JOIN part p ON p.id = m.part_id
      WHERE vp.vendor_id = ? AND vp.sku = ? COLLATE NOCASE`, [o.vendorId, sku]);
    if (vp && vp.part_id !== partId) throw new Error(`That vendor part number is already on part ${vp.pn}`);
    if (vp) {
      vendorPartId = vp.id;
      mfrPartId ??= vp.mfr_part_id;
    } else {
      mfrPartId ??= (await queryOne<{ id: number }>('SELECT id FROM mfr_part WHERE part_id = ? ORDER BY preferred DESC, id LIMIT 1', [partId]))?.id ?? null;
      if (!mfrPartId) {
        const unknown = await manufacturerIdFor('Unknown');
        mfrPartId = (await execute('INSERT INTO mfr_part (part_id, manufacturer_id, mpn, preferred) VALUES (?, ?, NULL, 1)', [partId, unknown])).lastInsertId;
      }
      const currency = (await queryOne<{ currency: string }>('SELECT currency FROM vendor WHERE id = ?', [o.vendorId]))?.currency ?? null;
      vendorPartId = (await execute('INSERT INTO vendor_part (mfr_part_id, vendor_id, sku, currency) VALUES (?, ?, ?, ?)',
        [mfrPartId, o.vendorId, sku, currency])).lastInsertId;
      added = true;
    }
  }
  await execute(`INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, unit_cost, mfr_part_id, vendor_part_id, vendor_id, order_ref, note)
     VALUES (?, 'receive', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [batchId(), partId, locationId, qty, o.unitCost ?? null, mfrPartId, vendorPartId, o.vendorId ?? null, o.orderRef?.trim() || null, o.note?.trim() || null]);
  if (!(await queryOne('SELECT 1 FROM part WHERE id = ? AND default_location_id IS NOT NULL', [partId]))) {
    await execute('UPDATE part SET default_location_id = ? WHERE id = ?', [locationId, partId]);   // first home becomes the usual one
  }
  if (added) await reindexPart(partId);
  return { addedVendorPart: added };
}

/**
 * Move everything held at `fromId` for each of these parts to `toId`, as one recorded batch.
 * With `followUsual`, parts whose usual location was `fromId` get `toId` as their usual location. Returns how many parts moved.
 */
export async function moveStockGroup(partIds: number[], fromId: number, toId: number, followUsual: boolean): Promise<number> {
  if (fromId === toId) throw new Error('Choose a different location');
  if (!partIds.length) return 0;
  await checkLocation(toId);
  const rows = await query<{ part_id: number; qty: number }>(
    `SELECT part_id, qty FROM stock WHERE location_id = ? AND qty <> 0 AND part_id IN (${partIds.map(() => '?').join(',')})`, [fromId, ...partIds]);
  const b = batchId();
  const stmts: Statement[] = rows.flatMap((r) => [
    { sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'move', ?, ?, ?, 'Group move')`, params: [b, r.part_id, fromId, -r.qty] },
    { sql: `INSERT INTO stock_txn (batch_id, kind, part_id, location_id, qty_delta, note) VALUES (?, 'move', ?, ?, ?, 'Group move')`, params: [b, r.part_id, toId, r.qty] },
  ]);
  if (followUsual) {
    for (const id of partIds) {
      stmts.push({ sql: 'UPDATE part SET default_location_id = ? WHERE id = ? AND (default_location_id = ? OR default_location_id IS NULL)', params: [toId, id, fromId] });
    }
  }
  if (stmts.length) await transaction(stmts);
  return rows.length;
}

/** Where to receive a part: its usual location, else wherever most of it already is. */
export function receiveLocationFor(part: { default_location_id: number | null; stock: Array<{ location_id: number; qty: number }> }): number | null {
  if (part.default_location_id) return part.default_location_id;
  return [...part.stock].sort((a, b) => b.qty - a.qty)[0]?.location_id ?? null;
}

/** Notes for the location picker: "usual" and "has 120" beside the places this part is kept. */
export function locationNotes(part: { default_location_id: number | null; stock: Array<{ location_id: number; qty: number }> }): Map<number, string> {
  const m = new Map<number, string>();
  if (part.default_location_id) m.set(part.default_location_id, 'usual');
  for (const s of part.stock) {
    const has = `has ${s.qty.toLocaleString()}`;
    m.set(s.location_id, m.has(s.location_id) ? `usual · ${has}` : has);
  }
  return m;
}
