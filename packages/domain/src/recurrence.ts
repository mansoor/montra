/**
 * Recurring schedule dates (TXN-05). Occurrences are computed from the anchor (start date), never from the
 * previous occurrence, so a monthly item on the 31st lands on Feb 28 and then Mar 31 again.
 */
import {
  addDays,
  addMonths,
  compareDates,
  daysInMonth,
  fromParts,
  parts,
  type CalendarDate,
} from './calendar-date.js';

export const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'] as const;
export type Cadence = (typeof CADENCES)[number];

/** The n-th occurrence (n = 0 is the start date). */
export function occurrence(start: CalendarDate, cadence: Cadence, n: number): CalendarDate {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('occurrence index must be a non-negative integer');
  switch (cadence) {
    case 'weekly':
      return addDays(start, 7 * n);
    case 'biweekly':
      return addDays(start, 14 * n);
    case 'monthly':
      return addMonths(start, n);
    case 'quarterly':
      return addMonths(start, 3 * n);
    case 'yearly':
      return addMonths(start, 12 * n);
    case 'semimonthly': {
      // Two dates a month, 15 days apart: day d and d+15 (or d−15 and d), clamped to month length.
      const { day } = parts(start);
      const first = day > 15 ? day - 15 : day;
      const startsOnSecond = day > 15;
      const index = n + (startsOnSecond ? 1 : 0);
      const month = addMonths(fromParts(parts(start).year, parts(start).month, 1), Math.floor(index / 2));
      const { year, month: m } = parts(month);
      const d = index % 2 === 0 ? first : first + 15;
      return fromParts(year, m, Math.min(d, daysInMonth(year, m)));
    }
  }
}

/** All occurrences in [from, to] (inclusive), optionally stopping at `end`. */
export function occurrencesBetween(
  start: CalendarDate,
  cadence: Cadence,
  from: CalendarDate,
  to: CalendarDate,
  end?: CalendarDate | null,
): CalendarDate[] {
  const out: CalendarDate[] = [];
  const last = end && compareDates(end, to) < 0 ? end : to;
  for (let n = 0; n < 10_000; n++) {
    const d = occurrence(start, cadence, n);
    if (compareDates(d, last) > 0) break;
    if (compareDates(d, from) >= 0) out.push(d);
  }
  return out;
}

/** First occurrence strictly after `after`, or null when the schedule has ended. */
export function nextOccurrenceAfter(
  start: CalendarDate,
  cadence: Cadence,
  after: CalendarDate,
  end?: CalendarDate | null,
): CalendarDate | null {
  for (let n = 0; n < 10_000; n++) {
    const d = occurrence(start, cadence, n);
    if (end && compareDates(d, end) > 0) return null;
    if (compareDates(d, after) > 0) return d;
  }
  return null;
}
