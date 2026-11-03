/**
 * Online order history (RCP-12): Amazon's "Retail.OrderHistory" export (one row per item) and the older
 * "Items" report become one receipt per order, categorized line by line like a paper receipt.
 */
import {
  calendarDate,
  isCurrencyCode,
  parseMoney,
  type CalendarDate,
  type CurrencyCode,
} from '@montra/domain';
import { decodeText, parseDelimited } from '@montra/importers';

export interface OrderLine {
  rawText: string;
  qty: string;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
  /** The item's own tax from the export; untaxed items (groceries) get none of the order's tax. */
  taxMinor: bigint;
}

export interface Order {
  orderRef: string;
  date: CalendarDate;
  currency: CurrencyCode;
  lines: OrderLine[];
  taxMinor: bigint;
  feesMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
}

/** Header aliases per field, lower-case: the current export first, then the older "Items" report. */
const COLUMNS = {
  orderId: ['order id'],
  date: ['order date'],
  product: ['product name', 'title'],
  qty: ['quantity'],
  unitPrice: ['unit price', 'purchase price per unit'],
  unitTax: ['unit price tax'],
  itemTax: ['item subtotal tax'],
  shipping: ['shipping charge'],
  discounts: ['total discounts'],
  total: ['total owed', 'item total'],
  currency: ['currency'],
} as const;

export class OrderHistoryError extends Error {}

export function parseOrderHistory(bytes: Uint8Array, fallbackCurrency: CurrencyCode): Order[] {
  const { rows } = parseDelimited(decodeText(bytes).text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, col(names)])) as Record<
    keyof typeof COLUMNS,
    number
  >;
  for (const required of ['orderId', 'date', 'product', 'qty', 'unitPrice', 'total'] as const) {
    if (at[required] < 0) {
      throw new OrderHistoryError(
        `Not an order-history file: no "${COLUMNS[required][0]}" column (Amazon Retail.OrderHistory CSV)`,
      );
    }
  }
  const orders = new Map<string, Order>();
  for (const row of rows.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const id = cell(at.orderId);
    if (!id) continue;
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(cell(at.date))?.[1] ?? usDate(cell(at.date));
    if (!date) continue;
    const code = cell(at.currency).toUpperCase();
    const currency = (isCurrencyCode(code) ? code : fallbackCurrency) as CurrencyCode;
    const money = (s: string) => {
      const v = s.replace(/[^0-9.,-]/g, '');
      if (!v) return 0n;
      try {
        return parseMoney(v, currency).amount;
      } catch {
        return 0n;
      }
    };
    const qty = cell(at.qty) || '1';
    const qtyN = BigInt(/^\d+$/.test(qty) ? qty : '1');
    const unit = money(cell(at.unitPrice));
    const order =
      orders.get(id) ??
      ({
        orderRef: id,
        date: calendarDate(date),
        currency,
        lines: [],
        taxMinor: 0n,
        feesMinor: 0n,
        discountMinor: 0n,
        totalMinor: 0n,
      } satisfies Order);
    const tax = at.unitTax >= 0 ? money(cell(at.unitTax)) * qtyN : money(cell(at.itemTax));
    order.lines.push({
      rawText: cell(at.product).slice(0, 500) || 'Item',
      qty,
      unitPriceMinor: unit,
      lineTotalMinor: unit * qtyN,
      taxMinor: tax,
    });
    order.taxMinor += tax;
    order.feesMinor += money(cell(at.shipping));
    const discount = money(cell(at.discounts));
    order.discountMinor += discount < 0n ? -discount : discount;
    order.totalMinor += money(cell(at.total));
    orders.set(id, order);
  }
  return [...orders.values()];
}

function usDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${year}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}
