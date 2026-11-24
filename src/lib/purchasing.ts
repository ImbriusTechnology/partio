// Purchasing: a shopping list of parts and other things, grouped by vendor, that goes from "to buy" to "on order"
// to "received". Receiving a part books its stock in, with what it cost.
//
// Prices are in the vendor part's currency (or the vendor's); totals are also shown in the base currency at the
// rates in Settings → Exchange rates. A rate that isn't set (0) leaves the base figure blank rather than guessing.
import { execute, query, queryOne, transaction, type Statement } from './db.ts';
import { requirements } from './builds.ts';
import { writeCsv } from './csv.ts';
import { getSetting } from './reference.ts';
import { receiveStock } from './stock.ts';

export type ShopStatus = 'open' | 'ordered' | 'received' | 'cancelled';

export interface ShopItem {
  id: number; part_id: number | null; pn: string | null; name: string | null; part_description: string | null;
  description: string | null;            // the item's own description (things that aren't stocked parts)
  vendor_id: number | null; vendor: string | null; connector: string | null; sku: string | null; vendor_part_id: number | null;
  qty: number; unit_price: number | null; currency: string | null;
  reason: string | null; build_id: number | null; build_code: string | null;
  status: ShopStatus; order_ref: string | null; note: string | null;
  created_at: string; ordered_at: string | null; received_at: string | null;
  on_hand: number | null; default_location_id: number | null;
  receive_location_id: number | null;   // usual location if set, else where most of the part is kept
}

const SELECT = `
  SELECT s.*, p.pn, p.name, p.description AS part_description, v.name AS vendor, v.api_connector AS connector, b.code AS build_code,
         p.default_location_id,
         COALESCE(p.default_location_id, (SELECT st.location_id FROM stock st WHERE st.part_id = s.part_id AND st.qty > 0 ORDER BY st.qty DESC LIMIT 1)) AS receive_location_id,
         CASE WHEN s.part_id IS NULL THEN NULL ELSE COALESCE((SELECT SUM(qty) FROM stock st WHERE st.part_id = s.part_id), 0) END AS on_hand
  FROM shopping_item s LEFT JOIN part p ON p.id = s.part_id LEFT JOIN vendor v ON v.id = s.vendor_id
  LEFT JOIN build b ON b.id = s.build_id`;

export function listShopping(status: ShopStatus): Promise<ShopItem[]> {
  if (status === 'received') return query<ShopItem>(`${SELECT} WHERE s.status = 'received' ORDER BY s.received_at DESC, s.id DESC LIMIT 500`);
  return query<ShopItem>(`${SELECT} WHERE s.status = ? ORDER BY v.name IS NULL, v.name COLLATE NOCASE, s.order_ref, p.pn, s.description`, [status]);
}
export const getItem = (id: number) => queryOne<ShopItem>(`${SELECT} WHERE s.id = ?`, [id]);

export const shopCounts = async () =>
  (await queryOne<{ open: number | null; ordered: number | null }>(`SELECT SUM(status = 'open') AS open, SUM(status = 'ordered') AS ordered FROM shopping_item`))
  ?? { open: 0, ordered: 0 };

/** How many of each part are already on the list (to buy) or on order. */
export async function onOrder(partIds: number[]): Promise<Map<number, { open: number; ordered: number }>> {
  const m = new Map<number, { open: number; ordered: number }>();
  if (!partIds.length) return m;
  for (const r of await query<{ part_id: number; open: number; ordered: number }>(`
    SELECT part_id, SUM(CASE WHEN status = 'open' THEN qty ELSE 0 END) AS open, SUM(CASE WHEN status = 'ordered' THEN qty ELSE 0 END) AS ordered
    FROM shopping_item WHERE status IN ('open', 'ordered') AND part_id IN (${partIds.map(() => '?').join(',')}) GROUP BY part_id`, partIds)) {
    m.set(r.part_id, { open: r.open, ordered: r.ordered });
  }
  return m;
}

// ------------------------------------------------------------------ currencies

/** Multipliers to the base currency (the base itself is 1). Unset rates (0) are left out. */
export async function baseRates(): Promise<{ base: string; rates: Map<string, number> }> {
  const base = (await getSetting('base_currency')) ?? 'USD';
  const rates = new Map<string, number>([[base, 1]]);
  for (const r of await query<{ currency: string; to_base: number }>('SELECT currency, to_base FROM fx_rate WHERE to_base > 0')) rates.set(r.currency, r.to_base);
  rates.set(base, 1);
  return { base, rates };
}

export function toBase(amount: number | null, currency: string | null, r: { base: string; rates: Map<string, number> }): number | null {
  if (amount == null) return null;
  const rate = r.rates.get(currency ?? r.base);
  return rate ? Math.round(amount * rate * 1e5) / 1e5 : null;
}

// ------------------------------------------------------------------ sources and prices

export interface Breaks { qty: number; unit_price: number }

/** The unit price a quantity reaches (the best break at or below it; below the first break, the first break's price). */
export function unitPrice(breaks: Breaks[], qty: number): number | null {
  const s = [...breaks].sort((a, b) => a.qty - b.qty);
  if (!s.length) return null;
  const reached = s.filter((b) => b.qty <= qty);
  return (reached.at(-1) ?? s[0]).unit_price;
}

/** Round up to the vendor's minimum and order multiple. */
export function roundToPack(qty: number, s: { moq: number | null; order_multiple: number | null }): number {
  let q = Math.max(qty, s.moq ?? 0);
  if (s.order_multiple && s.order_multiple > 1) q = Math.ceil(q / s.order_multiple) * s.order_multiple;
  return q;
}

/**
 * Whether buying more costs no more (or barely more): the cheapest total among the price breaks above `qty`,
 * if it's within 2% of what `qty` costs. Returns null when there's nothing better.
 */
export function betterBreak(breaks: Breaks[], qty: number, pack: { moq: number | null; order_multiple: number | null }): { qty: number; unit: number; total: number } | null {
  const unit = unitPrice(breaks, qty);
  if (unit == null) return null;
  const now = unit * qty;
  let best: { qty: number; unit: number; total: number } | null = null;
  for (const b of breaks) {
    if (b.qty <= qty) continue;
    const q = roundToPack(b.qty, pack);
    const u = unitPrice(breaks, q)!;
    const total = u * q;
    if (total <= now * 1.02 && (!best || total < best.total || (total === best.total && q > best.qty))) best = { qty: q, unit: u, total };
  }
  return best;
}

export interface SourceOption {
  vendor_part_id: number; vendor_id: number; vendor: string; sku: string; currency: string; moq: number | null; order_multiple: number | null;
  preferred: boolean; mfr_preferred: boolean; manufacturer: string; mpn: string | null; breaks: Breaks[];
  buy: number; unit: number | null; total: number | null; total_base: number | null;   // for the quantity asked about, rounded to the pack
}

/**
 * Every vendor part a part can be bought as, priced for `qty`, best first: the ★ vendor part on the preferred
 * manufacturer part, then any ★ vendor part, then the preferred manufacturer part's, then the cheapest (in base currency).
 */
export async function sourceOptions(partId: number, qty: number): Promise<SourceOption[]> {
  const vps = await query<{ id: number; vendor_id: number; vendor: string; sku: string; currency: string; moq: number | null; order_multiple: number | null;
    preferred: number; mpref: number; manufacturer: string; mpn: string | null; part_vendor: number | null }>(`
    SELECT vp.id, vp.vendor_id, v.name AS vendor, vp.sku, COALESCE(vp.currency, v.currency) AS currency, vp.moq, vp.order_multiple,
           vp.preferred, m.preferred AS mpref, mf.name AS manufacturer, m.mpn, p.preferred_vendor_id AS part_vendor
    FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id JOIN vendor v ON v.id = vp.vendor_id
    JOIN manufacturer mf ON mf.id = m.manufacturer_id JOIN part p ON p.id = m.part_id
    WHERE m.part_id = ? AND v.active = 1`, [partId]);
  if (!vps.length) return [];
  const breaks = await query<{ vendor_part_id: number; qty: number; unit_price: number }>(
    `SELECT vendor_part_id, qty, unit_price FROM price_break WHERE vendor_part_id IN (${vps.map(() => '?').join(',')}) ORDER BY qty`, vps.map((v) => v.id));
  const rates = await baseRates();
  const opts = vps.map((v) => {
    const b = breaks.filter((x) => x.vendor_part_id === v.id).map(({ qty: q, unit_price }) => ({ qty: q, unit_price }));
    const buy = roundToPack(qty, v);
    const unit = unitPrice(b, buy);
    const total = unit == null ? null : unit * buy;
    return {
      vendor_part_id: v.id, vendor_id: v.vendor_id, vendor: v.vendor, sku: v.sku, currency: v.currency, moq: v.moq, order_multiple: v.order_multiple,
      preferred: !!v.preferred, mfr_preferred: !!v.mpref, manufacturer: v.manufacturer, mpn: v.mpn, breaks: b,
      buy, unit, total, total_base: toBase(total, v.currency, rates), _vendorPref: v.part_vendor === v.vendor_id,
    };
  });
  const rank = (o: (typeof opts)[number]) => (o.preferred && o.mfr_preferred ? 0 : o.preferred ? 1 : o._vendorPref ? 2 : o.mfr_preferred ? 3 : 4);
  opts.sort((a, b) => rank(a) - rank(b) || (a.total_base ?? Infinity) - (b.total_base ?? Infinity) || a.vendor_part_id - b.vendor_part_id);
  return opts.map(({ _vendorPref: _, ...o }) => o);
}

async function vendorCurrency(vendorId: number | null): Promise<string | null> {
  return vendorId ? (await queryOne<{ c: string }>('SELECT currency AS c FROM vendor WHERE id = ?', [vendorId]))?.c ?? null : null;
}

/** The vendor part with this vendor and number on this part, if there is one. */
async function vendorPartOf(partId: number, vendorId: number, sku: string) {
  return queryOne<{ id: number; currency: string }>(`SELECT vp.id, COALESCE(vp.currency, v.currency) AS currency
    FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id JOIN vendor v ON v.id = vp.vendor_id
    WHERE m.part_id = ? AND vp.vendor_id = ? AND vp.sku = ? COLLATE NOCASE`, [partId, vendorId, sku]);
}
async function breaksOf(vendorPartId: number | null): Promise<Breaks[]> {
  return vendorPartId ? query<Breaks>('SELECT qty, unit_price FROM price_break WHERE vendor_part_id = ? ORDER BY qty', [vendorPartId]) : [];
}

/** For items still to buy: a bigger quantity that costs no more, from the item's vendor part's breaks. */
export async function cheaperQuantities(items: ShopItem[]): Promise<Map<number, { qty: number; unit: number; total: number }>> {
  const m = new Map<number, { qty: number; unit: number; total: number }>();
  const ids = [...new Set(items.filter((i) => i.status === 'open' && i.vendor_part_id).map((i) => i.vendor_part_id!))];
  if (!ids.length) return m;
  const q = ids.map(() => '?').join(',');
  const packs = new Map((await query<{ id: number; moq: number | null; order_multiple: number | null }>(
    `SELECT id, moq, order_multiple FROM vendor_part WHERE id IN (${q})`, ids)).map((p) => [p.id, p]));
  const breaks = await query<{ vendor_part_id: number; qty: number; unit_price: number }>(
    `SELECT vendor_part_id, qty, unit_price FROM price_break WHERE vendor_part_id IN (${q}) ORDER BY qty`, ids);
  for (const i of items) {
    if (i.status !== 'open' || !i.vendor_part_id) continue;
    const b = breaks.filter((x) => x.vendor_part_id === i.vendor_part_id);
    const better = betterBreak(b, i.qty, packs.get(i.vendor_part_id) ?? { moq: null, order_multiple: null });
    if (better) m.set(i.id, better);
  }
  return m;
}

// ------------------------------------------------------------------ adding and changing

export interface NewItem {
  partId?: number | null; description?: string | null; qty: number;
  vendorPartId?: number | null;    // a part's vendor part to buy; blank: the best one
  vendorId?: number | null; sku?: string | null; unitPrice?: number | null;
  reason?: string | null; buildId?: number | null; note?: string | null;
}

/**
 * Put something on the shopping list. A part gets the best vendor part (or the one given), and the price for the
 * quantity from its price breaks unless a price is given. The same part already on the list from the same vendor
 * is topped up instead of listed twice. Returns the item's id.
 */
export async function addToList(n: NewItem): Promise<number> {
  if (!(n.qty > 0)) throw new Error('Quantity must be more than zero');
  if (!n.partId && !n.description?.trim()) throw new Error('Choose a part or describe the item');
  if (!n.partId) {
    return (await execute(`INSERT INTO shopping_item (description, vendor_id, sku, qty, unit_price, currency, reason, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [n.description!.trim(), n.vendorId ?? null, n.sku?.trim() || null, n.qty, n.unitPrice ?? null, await vendorCurrency(n.vendorId ?? null),
        n.reason ?? 'manual', n.note?.trim() || null])).lastInsertId;
  }
  let vendorId: number | null = null, vendorPartId: number | null = null, sku: string | null = null, currency: string | null = null;
  if (n.vendorPartId) {
    const vp = await queryOne<{ id: number; vendor_id: number; sku: string; currency: string }>(`SELECT vp.id, vp.vendor_id, vp.sku, COALESCE(vp.currency, v.currency) AS currency
      FROM vendor_part vp JOIN mfr_part m ON m.id = vp.mfr_part_id JOIN vendor v ON v.id = vp.vendor_id WHERE vp.id = ? AND m.part_id = ?`, [n.vendorPartId, n.partId]);
    if (!vp) throw new Error('That vendor part number isn’t one of this part’s');
    ({ vendor_id: vendorId, id: vendorPartId, sku, currency } = vp);
  } else if (n.vendorId !== undefined) {
    vendorId = n.vendorId;
    const best = (await sourceOptions(n.partId, n.qty)).find((o) => o.vendor_id === vendorId && (!n.sku || o.sku.toLowerCase() === n.sku.trim().toLowerCase()));
    vendorPartId = best?.vendor_part_id ?? null;
    sku = n.sku?.trim() || best?.sku || null;
    currency = best?.currency ?? (await vendorCurrency(vendorId));
  } else {
    const best = (await sourceOptions(n.partId, n.qty))[0];
    if (best) ({ vendor_id: vendorId, vendor_part_id: vendorPartId, sku, currency } = best);
  }
  const existing = await queryOne<{ id: number; qty: number; reason: string | null; build_id: number | null }>(
    `SELECT id, qty, reason, build_id FROM shopping_item WHERE status = 'open' AND part_id = ? AND vendor_id IS ? ORDER BY id LIMIT 1`, [n.partId, vendorId]);
  const breaks = await breaksOf(vendorPartId);
  if (existing) {
    const qty = existing.qty + n.qty;
    const reasons = [...new Set([...(existing.reason ?? '').split(', '), n.reason ?? 'manual'].filter(Boolean))].join(', ');
    const price = n.unitPrice ?? unitPrice(breaks, qty);   // the combined quantity may reach a better break
    await execute('UPDATE shopping_item SET qty = ?, reason = ?, unit_price = COALESCE(?, unit_price), build_id = COALESCE(build_id, ?) WHERE id = ?',
      [qty, reasons, price, n.buildId ?? null, existing.id]);
    return existing.id;
  }
  return (await execute(`INSERT INTO shopping_item (part_id, vendor_id, vendor_part_id, sku, qty, unit_price, currency, reason, build_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [n.partId, vendorId, vendorPartId, sku, n.qty, n.unitPrice ?? unitPrice(breaks, n.qty), currency, n.reason ?? 'manual', n.buildId ?? null, n.note?.trim() || null])).lastInsertId;
}

export interface ItemFields {
  qty: number; vendor_id: number | null; sku: string | null; unit_price: number | null;
  description?: string | null; note: string | null; order_ref?: string | null;
}

/**
 * Change an item. For a part, a vendor and number that match one of its vendor parts link to it (and its currency);
 * a blank price is filled in from that vendor part's breaks.
 */
export async function updateItem(id: number, f: ItemFields): Promise<void> {
  const it = await queryOne<{ part_id: number | null; status: ShopStatus }>('SELECT part_id, status FROM shopping_item WHERE id = ?', [id]);
  if (!it) throw new Error('Item not found');
  if (it.status === 'received' || it.status === 'cancelled') throw new Error('That item is closed');
  if (!(f.qty > 0)) throw new Error('Quantity must be more than zero');
  if (!it.part_id && f.description !== undefined && !f.description?.trim()) throw new Error('Describe the item');
  let vendorPartId: number | null = null;
  let currency = await vendorCurrency(f.vendor_id);
  let price = f.unit_price;
  if (it.part_id && f.vendor_id && f.sku?.trim()) {
    const vp = await vendorPartOf(it.part_id, f.vendor_id, f.sku.trim());
    if (vp) {
      vendorPartId = vp.id;
      currency = vp.currency;
      price ??= unitPrice(await breaksOf(vp.id), f.qty);
    }
  }
  await execute(`UPDATE shopping_item SET qty = ?, vendor_id = ?, vendor_part_id = ?, sku = ?, unit_price = ?, currency = ?, note = ?,
      description = CASE WHEN part_id IS NULL THEN COALESCE(?, description) ELSE description END,
      order_ref = CASE WHEN ? AND status = 'ordered' THEN ? ELSE order_ref END WHERE id = ?`,
  [f.qty, f.vendor_id, vendorPartId, f.sku?.trim() || null, price, currency, f.note?.trim() || null, f.description?.trim() || null,
    f.order_ref !== undefined ? 1 : 0, f.order_ref?.trim() || null, id]);
}

/** Take items off the list: deleted while still to buy; cancelled once ordered, so the record stays. */
export async function removeItems(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const q = ids.map(() => '?').join(',');
  await transaction([
    { sql: `DELETE FROM shopping_item WHERE status = 'open' AND id IN (${q})`, params: ids },
    { sql: `UPDATE shopping_item SET status = 'cancelled' WHERE status = 'ordered' AND id IN (${q})`, params: ids },
  ]);
}

export async function markOrdered(ids: number[], orderRef: string | null): Promise<void> {
  if (!ids.length) return;
  await execute(`UPDATE shopping_item SET status = 'ordered', order_ref = ?, ordered_at = datetime('now') WHERE status = 'open' AND id IN (${ids.map(() => '?').join(',')})`,
    [orderRef?.trim() || null, ...ids]);
}

/** Back from "on order" to "to buy" (marked ordered by mistake). */
export async function unorder(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await execute(`UPDATE shopping_item SET status = 'open', order_ref = NULL, ordered_at = NULL WHERE status = 'ordered' AND id IN (${ids.map(() => '?').join(',')})`, ids);
}

// ------------------------------------------------------------------ builds

/**
 * Add what a build is short to the list: for each part, the shortfall less what's already on the list or on order,
 * rounded up to the vendor's minimum and order multiple. Parts with their own BOM are left out (build those instead).
 */
export async function addBuildShortages(buildId: number): Promise<{ added: Array<{ pn: string; qty: number }>; covered: string[] }> {
  const b = await queryOne<{ code: string; status: string }>('SELECT code, status FROM build WHERE id = ?', [buildId]);
  if (!b) throw new Error('Build not found');
  if (b.status !== 'planned') throw new Error(`Build ${b.code} is ${b.status}`);
  const short = new Map<number, { pn: string; qty: number }>();
  for (const r of await requirements(buildId)) {
    if (!r.part_id || r.short <= 0 || r.has_bom) continue;
    const s = short.get(r.part_id) ?? { pn: r.pn ?? '', qty: 0 };
    s.qty += r.short;
    short.set(r.part_id, s);
  }
  const coming = await onOrder([...short.keys()]);
  const added: Array<{ pn: string; qty: number }> = [];
  const covered: string[] = [];
  for (const [partId, s] of short) {
    const c = coming.get(partId);
    const need = Math.ceil(s.qty - (c ? c.open + c.ordered : 0));
    if (need <= 0) { covered.push(s.pn); continue; }
    const best = (await sourceOptions(partId, need))[0];
    const qty = best ? best.buy : need;
    await addToList({ partId, qty, vendorPartId: best?.vendor_part_id ?? null, reason: `${b.code} short`, buildId });
    added.push({ pn: s.pn, qty });
  }
  return { added, covered };
}

// ------------------------------------------------------------------ receiving

/**
 * Receive (some of) an item. A part's stock is booked in at the location with the vendor, their part number,
 * the cost (in the base currency) and the order number. If fewer arrive than were ordered, the rest stays on order
 * and the delivery is recorded as its own received line.
 */
export async function receiveItem(id: number, o: { qty: number; locationId: number | null; unitPrice?: number | null }): Promise<{ addedVendorPart: boolean; rest: number }> {
  const it = await getItem(id);
  if (!it) throw new Error('Item not found');
  if (it.status !== 'ordered' && it.status !== 'open') throw new Error('That item has already been received');
  if (!(o.qty > 0)) throw new Error('Quantity must be more than zero');
  const price = o.unitPrice !== undefined ? o.unitPrice : it.unit_price;
  let added = false;
  if (it.part_id) {
    if (!o.locationId) throw new Error(`Choose where ${it.pn} goes`);
    const r = await receiveStock(it.part_id, o.locationId, o.qty, {
      vendorId: it.vendor_id, sku: it.vendor_id ? it.sku : null, unitCost: toBase(price, it.currency, await baseRates()),
      orderRef: it.order_ref, note: 'From the shopping list',
    });
    added = r.addedVendorPart;
  }
  const rest = Math.max(0, it.qty - o.qty);
  const stmts: Statement[] = rest > 0
    ? [
      { sql: 'UPDATE shopping_item SET qty = ? WHERE id = ?', params: [rest, id] },
      { sql: `INSERT INTO shopping_item (part_id, description, vendor_id, vendor_part_id, sku, qty, unit_price, currency, reason, build_id, status, order_ref, note, created_at, ordered_at, received_at)
        SELECT part_id, description, vendor_id, vendor_part_id, sku, ?, ?, currency, reason, build_id, 'received', order_ref, note, created_at, COALESCE(ordered_at, datetime('now')), datetime('now')
        FROM shopping_item WHERE id = ?`, params: [o.qty, price, id] },
    ]
    : [{ sql: `UPDATE shopping_item SET status = 'received', qty = ?, unit_price = ?, received_at = datetime('now'), ordered_at = COALESCE(ordered_at, datetime('now')) WHERE id = ?`,
      params: [o.qty, price, id] }];
  await transaction(stmts);
  return { addedVendorPart: added, rest };
}

// ------------------------------------------------------------------ orders for the vendor

const fmtQ = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
/** Our reference on the vendor's order: the PN, or a short description for something that isn't a stocked part. */
const customerRef = (i: ShopItem) => (i.part_id ? i.pn ?? '' : (i.description ?? '').replace(/[,\t\r\n]+/g, ' ').slice(0, 30).trim());

/**
 * Column headings for a vendor's cart upload, by connector. Vendors' upload pages let you match columns,
 * so these are the names they show; anything else gets plain ones.
 */
const CART_COLUMNS: Record<string, [string, string, string]> = {
  digikey: ['Quantity', 'Digi-Key Part Number', 'Customer Reference'],
  mouser: ['Mouser Part Number', 'Quantity', 'Customer Part Number'],
  element14: ['Part Number', 'Quantity', 'Line Note'],
  lcsc: ['LCSC Part Number', 'Quantity', 'Customer Part Number'],
};

/** A cart-upload CSV for one vendor: their part number, quantity and our reference. */
export function cartCsv(items: ShopItem[]): string {
  const connector = items[0]?.connector ?? '';
  const cols = CART_COLUMNS[connector] ?? ['Vendor Part Number', 'Quantity', 'Our Reference'];
  // No byte-order mark: some vendors' upload pages read it as part of the first heading.
  return writeCsv(cols, items.map((i) => {
    const v: Record<string, string> = { qty: fmtQ(i.qty), sku: i.sku ?? '', ref: customerRef(i) };
    return cols.map((c) => (/quantity/i.test(c) ? v.qty : /reference|customer|note|our/i.test(c) ? v.ref : v.sku));
  })).replace(/^\uFEFF/, '');
}

/** Lines for a vendor's quick-add box: quantity, their part number, our reference, one item per line. */
export const orderText = (items: ShopItem[]) => items.map((i) => [fmtQ(i.qty), i.sku ?? '', customerRef(i)].join(', ')).join('\n');

/** How many of each part each location holds, for the receive dialog's location notes. */
export async function stockByLocation(partIds: number[]): Promise<Array<{ part_id: number; location_id: number; qty: number; usual: number }>> {
  if (!partIds.length) return [];
  return query(`SELECT st.part_id, st.location_id, st.qty, (p.default_location_id IS st.location_id) AS usual FROM stock st JOIN part p ON p.id = st.part_id
    WHERE st.qty > 0 AND st.part_id IN (${partIds.map(() => '?').join(',')}) ORDER BY st.qty DESC`, partIds);
}
