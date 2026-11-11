/**
 * Small-business arithmetic (BIZ-05..10; design 04 §13, ADR-0017). Pure and exact: amounts are positive bigint minor
 * units in the entity's currency. Tax figures here are estimates the user asked for, never tax advice.
 */
import { allocate } from './allocate.js';
import { addDays, addMonths, endOfMonth, type CalendarDate } from './calendar-date.js';
import { divRound } from './rounding.js';

// ----- Invoices (BIZ-05) ------------------------------------------------------------------------------------

export interface InvoiceLineInput {
  /** Thousandths: 1.5 hours = 1500. */
  quantityMilli: bigint;
  unitPrice: bigint;
  taxRateBps: number;
}

export interface InvoiceLineAmounts {
  amount: bigint;
  tax: bigint;
}

export function invoiceLineAmounts(l: InvoiceLineInput): InvoiceLineAmounts {
  const amount = divRound(l.quantityMilli * l.unitPrice, 1000n);
  return { amount, tax: divRound(amount * BigInt(l.taxRateBps), 10_000n) };
}

export interface InvoiceTotals {
  subtotal: bigint;
  tax: bigint;
  total: bigint;
}

export function invoiceTotals(lines: readonly InvoiceLineInput[]): InvoiceTotals {
  const amounts = lines.map(invoiceLineAmounts);
  const subtotal = amounts.reduce((t, a) => t + a.amount, 0n);
  const tax = amounts.reduce((t, a) => t + a.tax, 0n);
  return { subtotal, tax, total: subtotal + tax };
}

export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void';

/** Stored status plus payments and date. Paid wins over overdue; partial stays partial until it's overdue. */
export function invoiceStatus(
  stored: 'draft' | 'sent' | 'void',
  total: bigint,
  paid: bigint,
  dueDate: CalendarDate,
  today: CalendarDate,
): InvoiceStatus {
  if (stored !== 'sent') return stored;
  if (total > 0n && paid >= total) return 'paid';
  if (dueDate < today) return 'overdue';
  return paid > 0n ? 'partial' : 'sent';
}

export interface PaymentSplit<K> {
  key: K;
  amount: bigint;
}

/**
 * Where one payment goes, across weighted parts of an invoice (each line, and sales tax). Allocates what's paid so
 * far and takes the difference, so the parts add up exactly once the invoice is fully paid, however many payments
 * it took. Only cash received counts as income (cash basis, ADR-0017).
 */
export function allocatePayment<K>(
  parts: readonly { key: K; weight: bigint }[],
  paidBefore: bigint,
  payment: bigint,
): PaymentSplit<K>[] {
  const weights = parts.map((p) => p.weight);
  const before = paidBefore === 0n ? weights.map(() => 0n) : allocate(paidBefore, weights);
  const after = allocate(paidBefore + payment, weights);
  return parts.map((p, i) => ({ key: p.key, amount: after[i]! - before[i]! })).filter((s) => s.amount !== 0n);
}

// ----- Matching a payment to an open item (BIZ-05, BIZ-06; design 04 §10) -----------------------------------

/** Invoices: from the issue date to 90 days on. */
export const INVOICE_MATCH_DAYS_AFTER = 90;
/** Bills: within 10 days of the due date. */
export const BILL_MATCH_DAYS = 10;

export interface OpenItem {
  id: string;
  /** What's still owed. */
  open: bigint;
  from: CalendarDate;
  to: CalendarDate;
  /** Text that identifies the item when a statement quotes it, such as an invoice number. */
  reference: string | null;
}

export interface PaymentCandidate {
  id: string;
  date: CalendarDate;
  /** Positive. */
  amount: bigint;
  text: string;
}

const mentions = (text: string, reference: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${reference.replace(/[^a-z0-9]/gi, '\\W?')}($|[^a-z0-9])`, 'i').test(text);

export const canPay = (item: OpenItem, p: PaymentCandidate): boolean =>
  p.amount > 0n && p.amount <= item.open && p.date >= item.from && p.date <= item.to;

/**
 * The pairs that are safe to link without asking. A statement quoting the item's reference links it, partial amounts
 * included. Otherwise it takes the exact amount, with nothing else competing on either side. Two invoices for the same
 * amount, or two deposits, are left for the user.
 */
export function autoMatch(
  items: readonly OpenItem[],
  payments: readonly PaymentCandidate[],
): { itemId: string; paymentId: string }[] {
  const links: { itemId: string; paymentId: string }[] = [];
  const usedPayments = new Set<string>();
  const usedItems = new Set<string>();
  for (const item of items) {
    if (!item.reference) continue;
    const quoted = payments.filter(
      (p) => !usedPayments.has(p.id) && canPay(item, p) && mentions(p.text, item.reference!),
    );
    if (quoted.length !== 1) continue;
    links.push({ itemId: item.id, paymentId: quoted[0]!.id });
    usedPayments.add(quoted[0]!.id);
    usedItems.add(item.id);
  }
  const exact = (i: OpenItem, p: PaymentCandidate) => p.amount === i.open && canPay(i, p);
  const items2 = items.filter((i) => !usedItems.has(i.id));
  const payments2 = payments.filter((p) => !usedPayments.has(p.id));
  for (const item of items2) {
    const fits = payments2.filter((p) => exact(item, p));
    if (fits.length !== 1) continue;
    const rivals = items2.filter((i) => exact(i, fits[0]!));
    if (rivals.length !== 1) continue;
    links.push({ itemId: item.id, paymentId: fits[0]!.id });
  }
  return links;
}

// ----- Mileage (BIZ-07) -------------------------------------------------------------------------------------

/** miles × rate, half up, in cents. Tenths of a mile × tenths of a cent = hundredths of a cent. */
export const mileageDeduction = (milesTenths: number, tenthsOfCent: number): bigint =>
  divRound(BigInt(milesTenths) * BigInt(tenthsOfCent), 100n);

/** The rate in force on a date: the latest that started on or before it. */
export function mileageRateOn<T extends { effectiveFrom: CalendarDate }>(
  rates: readonly T[],
  date: CalendarDate,
): T | null {
  let best: T | null = null;
  for (const r of rates) {
    if (r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best;
}

// ----- Estimated tax (BIZ-09) -------------------------------------------------------------------------------

const dayOfWeek = (d: CalendarDate): number => new Date(`${d}T00:00:00Z`).getUTCDay();

/** Federal holidays that can fall on or next to an estimated-tax date: MLK Day, and Emancipation Day in DC. */
function isHoliday(d: CalendarDate): boolean {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  // Third Monday of January.
  if (m === 1 && dayOfWeek(d) === 1 && day >= 15 && day <= 21) return true;
  if (m !== 4) return false;
  const y4 = String(y);
  const apr16 = `${y4}-04-16` as CalendarDate;
  const dow = dayOfWeek(apr16);
  // Observed on the nearest weekday when April 16 falls on a weekend.
  const observed = dow === 6 ? 15 : dow === 0 ? 17 : 16;
  return day === observed;
}

/** The date itself, or the next business day when it's a weekend or holiday. */
function nextBusinessDay(d: CalendarDate): CalendarDate {
  let out = d;
  while (dayOfWeek(out) === 0 || dayOfWeek(out) === 6 || isHoliday(out)) out = addDays(out, 1);
  return out;
}

export interface EstimatedTaxPeriod {
  quarter: 1 | 2 | 3 | 4;
  /** The income the IRS counts for this payment: January 1 through this date. */
  through: CalendarDate;
  due: CalendarDate;
}

/** US federal estimated-tax periods. They aren't calendar quarters: the second is two months, the fourth is four. */
export function estimatedTaxPeriods(taxYear: number): EstimatedTaxPeriod[] {
  const date = (y: number, md: string) => `${y}-${md}` as CalendarDate;
  return [
    { quarter: 1, through: date(taxYear, '03-31'), due: nextBusinessDay(date(taxYear, '04-15')) },
    { quarter: 2, through: date(taxYear, '05-31'), due: nextBusinessDay(date(taxYear, '06-15')) },
    { quarter: 3, through: date(taxYear, '08-31'), due: nextBusinessDay(date(taxYear, '09-15')) },
    { quarter: 4, through: date(taxYear, '12-31'), due: nextBusinessDay(date(taxYear + 1, '01-15')) },
  ];
}

/** max(0, profit so far) × the user's rate. A loss sets nothing aside. */
export const taxSetAsideTarget = (ytdProfit: bigint, rateBps: number): bigint =>
  ytdProfit <= 0n ? 0n : divRound(ytdProfit * BigInt(rateBps), 10_000n);

/** What's still to put aside, never negative: saving ahead of the target isn't a refund. */
export function taxSetAside(ytdProfit: bigint, rateBps: number, savedSoFar: bigint): bigint {
  const left = taxSetAsideTarget(ytdProfit, rateBps) - savedSoFar;
  return left > 0n ? left : 0n;
}

// ----- Margin (BIZ-10, BIZ-11) ------------------------------------------------------------------------------

/** Profit ÷ revenue in basis points; null without revenue. */
export const marginBps = (revenue: bigint, expenses: bigint): number | null =>
  revenue <= 0n ? null : Number(divRound((revenue - expenses) * 10_000n, revenue));

// ----- The business landing page (ADR-0032) -------------------------------------------------------------------

export interface BusinessMonth {
  readonly moneyIn: bigint | string;
  readonly moneyOut: bigint | string;
  readonly revenue: bigint | string;
  readonly expenses: bigint | string;
}

export interface BusinessTotals {
  moneyIn: bigint;
  moneyOut: bigint;
  revenue: bigint;
  expenses: bigint;
  profit: bigint;
  marginBps: number | null;
}

/** The period's totals: sums over the months, profit as revenue less expenses and the margin as the P&L states it. */
export function summarizeBusinessMonths(months: readonly BusinessMonth[]): BusinessTotals {
  const sum = (k: keyof BusinessMonth) => months.reduce((t, m) => t + BigInt(m[k]), 0n);
  const revenue = sum('revenue');
  const expenses = sum('expenses');
  return {
    moneyIn: sum('moneyIn'),
    moneyOut: sum('moneyOut'),
    revenue,
    expenses,
    profit: revenue - expenses,
    marginBps: marginBps(revenue, expenses),
  };
}

/**
 * The months a dashboard shows: `count` calendar months ending with the one starting `last` (a first of the month),
 * oldest first.
 */
export function monthsEnding(
  last: CalendarDate,
  count: number,
): { start: CalendarDate; end: CalendarDate }[] {
  return Array.from({ length: count }, (_, i) => {
    const start = addMonths(last, -(count - 1 - i));
    return { start, end: endOfMonth(start) };
  });
}
