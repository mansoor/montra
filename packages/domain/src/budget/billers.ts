/**
 * Billers' next bills (ADR-0048 §4): when the next bill from a provider is due and roughly how much, from its recent
 * payments. A scanned bill replaces the estimate with its exact amount and date.
 */
import { divRound } from '../rounding.js';
import { addMonths, daysInMonth, fromParts, parts, type CalendarDate } from '../calendar-date.js';

export const BILL_CADENCES = ['monthly', 'bimonthly', 'quarterly', 'semiannual', 'yearly'] as const;
export type BillCadence = (typeof BILL_CADENCES)[number];

export const CADENCE_MONTHS: Record<BillCadence, number> = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
};

/** How many recent payments the estimate averages. */
export const ESTIMATE_PAYMENTS = 3;

export interface BillPayment {
  date: CalendarDate;
  /** What was paid, positive minor units. */
  amount: bigint;
}

export interface NextBill {
  date: CalendarDate;
  amount: bigint;
  /** The payments averaged. */
  basedOn: number;
}

/** `day` of the month `months` after `from`'s month, clamped to that month's length. */
function dayIn(from: CalendarDate, months: number, day: number): CalendarDate {
  const first = addMonths(fromParts(parts(from).year, parts(from).month, 1), months);
  const { year, month } = parts(first);
  return fromParts(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * The next bill on or after `today`: the average of the last three payments, due on the biller's due day (or the day
 * it was last paid) one cadence after the last payment, stepping on while that's already past. Null without payments:
 * a new biller has nothing to go on until its first bill or payment.
 */
export function nextBill(input: {
  today: CalendarDate;
  cadence: BillCadence;
  dueDay: number | null;
  payments: readonly BillPayment[];
}): NextBill | null {
  const recent = [...input.payments].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const last = recent[0];
  if (!last) return null;
  const used = recent.slice(0, ESTIMATE_PAYMENTS);
  const amount = divRound(
    used.reduce((t, p) => t + p.amount, 0n),
    BigInt(used.length),
  );
  const step = CADENCE_MONTHS[input.cadence];
  const day = input.dueDay ?? parts(last.date).day;
  let k = 1;
  let date = dayIn(last.date, step, day);
  while (date < input.today) {
    k += 1;
    date = dayIn(last.date, step * k, day);
  }
  return { date, amount, basedOn: used.length };
}
