/** Recurring and subscription detection (AI-08, UP-14; 04 §10). */
import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  fromParts,
  parts,
  type CalendarDate,
} from '@montra/domain';
import type { Cadence, HistoryTxn, PayeeSeries, RecurringProposal } from './types.js';

const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 15,
  monthly: 31,
  quarterly: 91,
  yearly: 365,
};

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function medianBig(values: readonly bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[(s.length - 1) >> 1]!;
}

const absBig = (n: bigint) => (n < 0n ? -n : n);

/** Day of month, with each month's last day folded into 31 (the 30th of April, Feb 28/29). */
function domKey(d: CalendarDate): number {
  const { year, month, day } = parts(d);
  return day === daysInMonth(year, month) ? 31 : day;
}

function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[values.length - 1]!;
  let n = 0;
  for (const [v, c] of counts)
    if (c > n) {
      best = v;
      n = c;
    }
  return best;
}

function withDay(year: number, month: number, dom: number): CalendarDate {
  return fromParts(year, month, Math.min(dom, daysInMonth(year, month)));
}

function classify(dates: readonly CalendarDate[], intervals: readonly number[], med: number): Cadence | null {
  const all = (lo: number, hi: number) => intervals.every((d) => d >= lo && d <= hi);
  if (med >= 6 && med <= 8) return 'weekly';
  if (med >= 12 && med <= 17) {
    // Two fixed days of the month (the 1st and 15th) is semimonthly; biweekly drifts through the month.
    const doms = new Set(dates.map(domKey));
    const months = new Set(dates.map((d) => d.slice(0, 7)));
    if (doms.size === 2 && months.size >= 2 && all(12, 18)) return 'semimonthly';
    return med <= 16 ? 'biweekly' : null;
  }
  if (med >= 28 && med <= 31) return 'monthly';
  if (med >= 89 && med <= 93) return 'quarterly';
  if (med >= 360 && med <= 370) return 'yearly';
  return null;
}

function nextDate(cadence: Cadence, dates: readonly CalendarDate[]): CalendarDate {
  const last = dates[dates.length - 1]!;
  const { year, month } = parts(last);
  switch (cadence) {
    case 'weekly':
      return addDays(last, 7);
    case 'biweekly':
      return addDays(last, 14);
    case 'semimonthly': {
      const days = [...new Set(dates.map(domKey))].sort((a, b) => a - b);
      const lastKey = domKey(last);
      const later = days.find((d) => d > lastKey);
      if (later !== undefined) return withDay(year, month, later);
      const next = addMonths(fromParts(year, month, 1), 1);
      const p = parts(next);
      return withDay(p.year, p.month, days[0]!);
    }
    default: {
      const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
      const dom = mode(dates.map(domKey));
      const p = parts(addMonths(fromParts(year, month, 1), months));
      return withDay(p.year, p.month, dom);
    }
  }
}

function isFixed(amounts: readonly bigint[]): boolean {
  const abs = amounts.map(absBig);
  const min = abs.reduce((a, b) => (b < a ? b : a));
  const max = abs.reduce((a, b) => (b > a ? b : a));
  return max * 100n <= min * 102n;
}

function proposal(series: PayeeSeries, today: CalendarDate): RecurringProposal | null {
  // Keep the majority sign (a refund doesn't break a subscription) and one charge per day.
  const negatives = series.txns.filter((t) => t.amountMinor < 0n).length;
  const wantNegative = negatives * 2 >= series.txns.length;
  const byDate = new Map<string, HistoryTxn>();
  for (const t of [...series.txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)))
    if (t.amountMinor !== 0n && t.amountMinor < 0n === wantNegative && !byDate.has(t.date))
      byDate.set(t.date, t);
  const txns = [...byDate.values()];
  if (txns.length < 3) return null;

  const dates = txns.map((t) => t.date);
  const intervals = dates.slice(1).map((d, i) => diffDays(d, dates[i]!));
  const med = median(intervals);
  const mad = median(intervals.map((d) => Math.abs(d - med)));
  if (mad > Math.max(2, 0.2 * med)) return null;
  const cadence = classify(dates, intervals, med);
  if (!cadence) return null;

  const last = dates[dates.length - 1]!;
  if (diffDays(today, last) > 2 * CADENCE_DAYS[cadence]) return null;

  const amounts = txns.map((t) => t.amountMinor);
  const lastAmount = amounts[amounts.length - 1]!;
  const prior = amounts.slice(0, -1);
  let priceIncrease: RecurringProposal['priceIncrease'] = null;
  if (prior.length >= 2 && isFixed(prior)) {
    const stable = medianBig(prior);
    const s = absBig(stable);
    const l = absBig(lastAmount);
    if (s > 0n && l * 100n > s * 105n) {
      const tenths = ((l - s) * 1000n + s / 2n) / s;
      priceIncrease = { fromMinor: stable, toMinor: lastAmount, percent: Number(tenths) / 10 };
    }
  }
  const basis = priceIncrease ? prior : amounts;
  const abs = amounts.map(absBig);
  const minAbs = abs.reduce((a, b) => (b < a ? b : a));
  const maxAbs = abs.reduce((a, b) => (b > a ? b : a));
  const sign = wantNegative ? -1n : 1n;
  const firstSeen = dates[0]!;
  return {
    payeeKey: series.payeeKey,
    payee: series.payee,
    accountId: series.accountId,
    entityId: series.entityId,
    categoryId: series.categoryId,
    cadence,
    amountKind: isFixed(basis) ? 'fixed' : 'variable',
    amountMinor: priceIncrease ? lastAmount : medianBig(amounts),
    minMinor: sign < 0n ? -maxAbs : minAbs,
    maxMinor: sign < 0n ? -minAbs : maxAbs,
    lastDate: last,
    nextDate: nextDate(cadence, dates),
    firstSeen,
    occurrences: txns.length,
    isNew: diffDays(today, firstSeen) <= 45,
    priceIncrease,
  };
}

/** Recurring candidates from posted history: ≥3 occurrences at a regular cadence, not gone stale. */
export function detectRecurring(series: readonly PayeeSeries[], today: CalendarDate): RecurringProposal[] {
  const out: RecurringProposal[] = [];
  for (const s of series) {
    const p = proposal(s, today);
    if (p) out.push(p);
  }
  return out;
}
