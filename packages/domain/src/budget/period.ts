/** Budget periods (BUD-05): calendar months by default, or 7/14-day pay periods from an anchor date. */
import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  startOfMonth,
  type CalendarDate,
} from '../calendar-date.js';

export type BudgetPeriodType = 'monthly' | 'weekly' | 'biweekly';

export interface PeriodSpec {
  type: BudgetPeriodType;
  /** Weekly/biweekly: any first day of a period. */
  anchor?: CalendarDate | null;
}

export interface Period {
  start: CalendarDate;
  end: CalendarDate;
}

const lengthOf = (type: BudgetPeriodType) => (type === 'weekly' ? 7 : 14);

function anchorOf(spec: PeriodSpec): CalendarDate {
  if (!spec.anchor) throw new RangeError(`A ${spec.type} budget needs an anchor date`);
  return spec.anchor;
}

/** The period containing `date`. */
export function periodContaining(spec: PeriodSpec, date: CalendarDate): Period {
  if (spec.type === 'monthly') return { start: startOfMonth(date), end: endOfMonth(date) };
  const len = lengthOf(spec.type);
  const offset = diffDays(date, anchorOf(spec));
  const index = Math.floor(offset / len);
  const start = addDays(anchorOf(spec), index * len);
  return { start, end: addDays(start, len - 1) };
}

/** The period `n` periods after (negative: before) the one starting at `start`. */
export function shiftPeriod(spec: PeriodSpec, start: CalendarDate, n: number): Period {
  if (spec.type === 'monthly') {
    const s = addMonths(startOfMonth(start), n);
    return { start: s, end: endOfMonth(s) };
  }
  const s = addDays(start, n * lengthOf(spec.type));
  return { start: s, end: addDays(s, lengthOf(spec.type) - 1) };
}

/** True when `start` is the first day of a period. */
export const isPeriodStart = (spec: PeriodSpec, start: CalendarDate): boolean =>
  periodContaining(spec, start).start === start;

/** Periods from the one containing `from` through the one containing `to`, in order. */
export function periodsBetween(spec: PeriodSpec, from: CalendarDate, to: CalendarDate): Period[] {
  const out: Period[] = [];
  let p = periodContaining(spec, from);
  while (p.start <= to) {
    out.push(p);
    p = shiftPeriod(spec, p.start, 1);
  }
  return out;
}

/** Days in the period (inclusive). */
export const periodDays = (p: Period): number => diffDays(p.end, p.start) + 1;
