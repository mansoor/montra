/**
 * When payroll taxes are due (PRL-15; ADR-0034 §7): the IRS's monthly and semiweekly deposit schedules (Pub 15 §11), FUTA
 * by quarter, and California's EDD deposits, moved to the next banking day past weekends and federal holidays.
 */
import {
  addDays,
  endOfMonth,
  fromParts,
  isoDayOfWeek,
  parts,
  startOfMonth,
  type CalendarDate,
} from './calendar-date.js';

export type DepositSchedule = 'monthly' | 'semiweekly' | 'quarterly';

/** The nth weekday (Monday = 0) of a month; n = -1 for the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): CalendarDate {
  if (n > 0) {
    const first = fromParts(year, month, 1);
    const offset = (weekday - isoDayOfWeek(first) + 7) % 7;
    return addDays(first, offset + (n - 1) * 7);
  }
  const last = endOfMonth(fromParts(year, month, 1));
  return addDays(last, -((isoDayOfWeek(last) - weekday + 7) % 7));
}

/** Saturday holidays are observed on Friday, Sunday ones on Monday. */
function observed(d: CalendarDate): CalendarDate {
  const dow = isoDayOfWeek(d);
  return dow === 5 ? addDays(d, -1) : dow === 6 ? addDays(d, 1) : d;
}

/** Federal holidays as observed, plus Emancipation Day, a legal holiday in DC that moves IRS due dates. */
export function federalHolidays(year: number): CalendarDate[] {
  const on = (m: number, d: number) => observed(fromParts(year, m, d));
  return [
    on(1, 1),
    nthWeekday(year, 1, 0, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 0, 3), // Washington's Birthday
    on(4, 16), // Emancipation Day (DC)
    nthWeekday(year, 5, 0, -1), // Memorial Day
    on(6, 19),
    on(7, 4),
    nthWeekday(year, 9, 0, 1), // Labor Day
    nthWeekday(year, 10, 0, 2), // Columbus Day
    on(11, 11),
    nthWeekday(year, 11, 3, 4), // Thanksgiving
    on(12, 25),
    // New Year's Day of the next year, when it's observed on December 31.
    ...(isoDayOfWeek(fromParts(year + 1, 1, 1)) === 5 ? [fromParts(year, 12, 31)] : []),
  ];
}

export function isBankingDay(d: CalendarDate): boolean {
  if (isoDayOfWeek(d) >= 5) return false;
  return !federalHolidays(parts(d).year).includes(d);
}

/** The date itself, or the next banking day. */
export function nextBankingDay(d: CalendarDate): CalendarDate {
  let out = d;
  while (!isBankingDay(out)) out = addDays(out, 1);
  return out;
}

/** The nth banking day after a date. */
export function addBankingDays(d: CalendarDate, n: number): CalendarDate {
  let out = d;
  for (let left = n; left > 0;) {
    out = addDays(out, 1);
    if (isBankingDay(out)) left--;
  }
  return out;
}

export const quarterOf = (d: CalendarDate): 1 | 2 | 3 | 4 =>
  (Math.floor((parts(d).month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
export const quarterStart = (year: number, q: number): CalendarDate => fromParts(year, (q - 1) * 3 + 1, 1);
export const quarterEnd = (year: number, q: number): CalendarDate => endOfMonth(fromParts(year, q * 3, 1));

/** Quarterly returns (941, DE 9) and quarterly deposits are due by the last day of the month after the quarter. */
export const quarterlyDue = (year: number, q: number): CalendarDate =>
  nextBankingDay(endOfMonth(fromParts(q === 4 ? year + 1 : year, q === 4 ? 1 : q * 3 + 1, 1)));

export interface DepositPeriod {
  /** The pay dates it covers. */
  start: CalendarDate;
  end: CalendarDate;
  due: CalendarDate;
}

/**
 * The deposit period a pay date falls in, and its due date.
 * - Monthly: the calendar month, due the 15th of the next month.
 * - Semiweekly: paydays Wednesday to Friday are due the following Wednesday, Saturday to Tuesday the following Friday,
 *   always with at least 3 banking days after the period. A period never spans two quarters (Pub 15 §11).
 * - Quarterly: due by the last day of the month after the quarter.
 */
export function depositPeriod(schedule: DepositSchedule, payDate: CalendarDate): DepositPeriod {
  const { year } = parts(payDate);
  const q = quarterOf(payDate);
  if (schedule === 'monthly') {
    const end = endOfMonth(payDate);
    return { start: startOfMonth(payDate), end, due: nextBankingDay(addDays(end, 15)) };
  }
  if (schedule === 'quarterly')
    return { start: quarterStart(year, q), end: quarterEnd(year, q), due: quarterlyDue(year, q) };
  const dow = isoDayOfWeek(payDate); // Monday 0 … Sunday 6
  const start = dow >= 2 && dow <= 4 ? addDays(payDate, -(dow - 2)) : addDays(payDate, -((dow + 2) % 7));
  const end = addDays(start, dow >= 2 && dow <= 4 ? 2 : 3);
  const due = addBankingDays(end, 3);
  const qs = quarterStart(year, q);
  const qe = quarterEnd(year, q);
  return { start: start < qs ? qs : start, end: end > qe ? qe : end, due };
}

/** $100,000 or more of 941 taxes on one day must be deposited by the next banking day (Pub 15 §11). */
export const NEXT_DAY_THRESHOLD = 10_000_000n;
/** Under $2,500 of 941 taxes in a quarter may be paid with the return instead. */
export const PAY_WITH_RETURN_THRESHOLD = 250_000n;
/** FUTA is deposited for a quarter once more than $500 is owed, else carried to the next. */
export const FUTA_DEPOSIT_THRESHOLD = 50_000n;
