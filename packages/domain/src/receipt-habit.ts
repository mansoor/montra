/**
 * The receipt habit (UP-09, RCP-11): how many of this week's receipts were kept, and the streak of weeks with none
 * missing. Kept gentle on purpose: the current week can add to the streak but never breaks it, and a week with nothing
 * to keep neither counts nor breaks it.
 */
import { addDays, isoDayOfWeek, type CalendarDate } from './calendar-date.js';

/** The first day of `date`'s week, for a week starting on `weekStart` (1 = Monday … 7 = Sunday). */
export function weekStartOf(date: CalendarDate, weekStart: number): CalendarDate {
  return addDays(date, -((isoDayOfWeek(date) - (weekStart - 1) + 7) % 7));
}

export interface ReceiptHabit {
  week: { start: CalendarDate; end: CalendarDate };
  /** Receipts captured this week. */
  captured: number;
  /** Purchases this week that could use a receipt and have none. */
  missing: number;
  /** Weeks in a row with receipts captured and none missing. */
  streakWeeks: number;
}

export function receiptHabit(input: {
  today: CalendarDate;
  weekStart: number;
  /** How far back the streak may look. */
  weeks: number;
  /** One date per receipt captured. */
  capturedOn: readonly CalendarDate[];
  /** One date per purchase still missing a receipt. */
  missingOn: readonly CalendarDate[];
}): ReceiptHabit {
  const start = weekStartOf(input.today, input.weekStart);
  const tally = (dates: readonly CalendarDate[], from: CalendarDate, to: CalendarDate) =>
    dates.filter((d) => d >= from && d <= to).length;
  const weeks = Array.from({ length: input.weeks }, (_, i) => {
    const from = addDays(start, -7 * i);
    const to = addDays(from, 6);
    return {
      from,
      to,
      captured: tally(input.capturedOn, from, to),
      missing: tally(input.missingOn, from, to),
    };
  });
  let streakWeeks = 0;
  for (const [i, w] of weeks.entries()) {
    if (i === 0) {
      // This week is still going: it adds when clean so far, and never breaks the streak.
      if (w.missing === 0 && w.captured > 0) streakWeeks++;
      continue;
    }
    if (w.missing > 0) break;
    if (w.captured > 0) streakWeeks++;
  }
  const now = weeks[0]!;
  return {
    week: { start: now.from, end: now.to },
    captured: now.captured,
    missing: now.missing,
    streakWeeks,
  };
}
