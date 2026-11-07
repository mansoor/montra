/**
 * Credit cards and lines of credit (ADR-0026): the statement cycle, what's due, and what a payment rule pays. A cycle closes
 * on the statement day each month; the statement's balance is due on the due day after it. A day past the end of a month
 * means its last day.
 */
import { addDays, compareDates, type CalendarDate } from './calendar-date.js';

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const on = (y: number, m: number, day: number): CalendarDate =>
  `${y}-${pad(m)}-${pad(Math.min(day, daysIn(y, m)))}` as CalendarDate;
const shift = (y: number, m: number, by: number): [number, number] => {
  const z = y * 12 + (m - 1) + by;
  return [Math.floor(z / 12), (z % 12) + 1];
};

export const PAY_RULES = ['statement', 'minimum', 'fixed'] as const;
export type PayRule = (typeof PAY_RULES)[number];

export interface StatementCycle {
  /** The latest statement: closed on or before today. */
  lastClose: CalendarDate;
  /** Its balance is due on this day. */
  dueDate: CalendarDate;
  nextClose: CalendarDate;
  /** When the next statement's balance will be due. */
  nextDueDate: CalendarDate;
}

/** The first `day` of a month strictly after `date`. */
function nextDay(date: CalendarDate, day: number): CalendarDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const same = on(y, m, day);
  if (compareDates(same, date) > 0) return same;
  const [ny, nm] = shift(y, m, 1);
  return on(ny, nm, day);
}

export function statementCycle(today: CalendarDate, statementDay: number, dueDay: number): StatementCycle {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const thisMonth = on(y, m, statementDay);
  const lastClose = compareDates(thisMonth, today) <= 0 ? thisMonth : on(...shift(y, m, -1), statementDay);
  const nextClose = nextDay(lastClose, statementDay);
  return {
    lastClose,
    dueDate: nextDay(lastClose, dueDay),
    nextClose,
    nextDueDate: nextDay(nextClose, dueDay),
  };
}

export interface StatementDue {
  /** What the latest statement says is owed, less what's been paid since. Never below zero. */
  due: bigint;
  /** The minimum still to pay on it: the account's minimum, or all of it if that's less. */
  minimumDue: bigint;
}

/**
 * What's still due on the latest statement. `paidSince` is everything that reduced what's owed after the statement closed:
 * payments, and refunds too, as the card counts them.
 */
export function statementDue(
  statementBalance: bigint,
  paidSince: bigint,
  minimum: bigint | null,
): StatementDue {
  const left = statementBalance - paidSince;
  const due = left > 0n ? left : 0n;
  const min = minimum === null ? due : minimum < due ? minimum : due;
  return { due, minimumDue: min };
}

/** What a payment rule pays on the due date, never more than is owed. */
export function rulePayment(rule: PayRule, d: StatementDue, owed: bigint, fixed: bigint | null): bigint {
  const cap = (n: bigint) => (n > owed ? (owed > 0n ? owed : 0n) : n);
  if (rule === 'statement') return cap(d.due);
  if (rule === 'minimum') return cap(d.minimumDue);
  return cap(fixed ?? 0n);
}

/** Owed as a share of the limit, in basis points. Null without a limit. */
export const utilizationBps = (owed: bigint, limit: bigint | null): number | null =>
  limit !== null && limit > 0n ? Number(((owed > 0n ? owed : 0n) * 10_000n) / limit) : null;

/** The day after a date: payments made on the closing day itself fall in the old statement. */
export const afterClose = (close: CalendarDate): CalendarDate => addDays(close, 1);
