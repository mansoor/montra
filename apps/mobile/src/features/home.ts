/**
 * Home tab numbers from the offline store (08 §3). Budgets arrive in Phase 7; until then "spent this month" is the
 * sum of categorized and to-review outflows, all computed in bigint minor units (NFR-09, AIA-05).
 */
import { addDays, calendarDate, startOfMonth, type CalendarDate } from '@montra/domain';
import type { LocalTransaction } from '@montra/sync';

export interface MonthSummary {
  currency: string;
  spent: bigint;
  income: bigint;
  count: number;
  upcoming: LocalTransaction[];
  needsReview: number;
}

/** Totals for `today`'s month in `currency`; transfers (no category, reviewed) are left out. */
export function monthSummary(rows: readonly LocalTransaction[], today: CalendarDate, currency: string): MonthSummary {
  const from = startOfMonth(today);
  const horizon = addDays(today, 14);
  let spent = 0n;
  let income = 0n;
  let count = 0;
  const upcoming: LocalTransaction[] = [];
  let needsReview = 0;
  for (const t of rows) {
    if (t.reviewState === 'needs_review' && t.status === 'posted') needsReview++;
    if (t.status === 'scheduled') {
      if (t.date >= today && t.date <= horizon) upcoming.push(t);
      continue;
    }
    if (t.status !== 'posted' || t.amount === null || t.currency !== currency) continue;
    if (t.date < from || t.date > today) continue;
    const isTransfer = t.categoryId === null && t.reviewState !== 'needs_review' && t.server?.splits === null;
    if (isTransfer) continue;
    const a = BigInt(t.amount);
    if (a < 0n) spent += -a;
    else income += a;
    count++;
  }
  upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { currency, spent, income, count, upcoming, needsReview };
}

export const todayLocal = (d = new Date()): CalendarDate =>
  calendarDate(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  );
