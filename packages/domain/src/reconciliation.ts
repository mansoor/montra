import {
  addMonths,
  compareDates,
  daysInMonth,
  endOfMonth,
  fromParts,
  parts,
  type CalendarDate,
} from './calendar-date.js';

/**
 * The statement after one dated `last` (DE-11): a month later. A card's statement day wins when it has one; a
 * statement on a month's last day stays on month ends (Jan 31 → Feb 28 → Mar 31); otherwise the day is kept, clamped
 * to the month's length.
 */
export function nextStatementDate(last: CalendarDate, statementDay?: number | null): CalendarDate {
  if (statementDay) {
    const next = parts(addMonths(last, 1));
    const day = Math.min(statementDay, daysInMonth(next.year, next.month));
    return fromParts(next.year, next.month, day);
  }
  if (last === endOfMonth(last)) return endOfMonth(addMonths(last, 1));
  return addMonths(last, 1);
}

/** DE-14: a statement is due once more than a month has passed since the last one reconciled. */
export function reconciliationDue(last: CalendarDate | null, today: CalendarDate): boolean {
  if (!last) return false;
  return compareDates(today, addMonths(last, 1)) > 0;
}
