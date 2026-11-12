/**
 * Overtime from hours worked each day (PRL-27; ADR-0036 §4). Pure, so the pay run, the web form and the tests agree.
 *
 * California (Labor Code §510; Labor Commissioner, "Overtime" FAQ, dir.ca.gov/dlse/faq_overtime.htm):
 * - over 8 hours in a workday, up to 12, and the first 8 hours on the seventh consecutive day of work in a workweek are
 *   paid at one and a half times the regular rate;
 * - over 12 hours in a workday, and over 8 on that seventh day, at twice the regular rate;
 * - over 40 hours in a workweek at one and a half times. Only straight-time hours count toward the 40, so an hour is
 *   never paid as overtime twice (the Labor Commissioner's no-pyramiding method).
 *
 * Federal (FLSA): over 40 hours in a workweek only.
 *
 * Hours are thousandths (8 hours = 8000). Only hours worked count: vacation, sick and holiday pay never do.
 */
import { addDays, isoDayOfWeek, type CalendarDate } from './calendar-date.js';
import { divRound } from './rounding.js';

export type OvertimeRules = 'california' | 'federal';

export interface WorkDay {
  date: CalendarDate;
  hoursMilli: bigint;
}

export interface DayOvertime extends WorkDay {
  regular: bigint;
  overtime: bigint;
  doubleTime: bigint;
  /** The seventh consecutive day worked in its workweek (California). */
  seventhDay: boolean;
}

export interface OvertimeSplit {
  regular: bigint;
  overtime: bigint;
  doubleTime: bigint;
  days: DayOvertime[];
}

const DAY = 8000n;
const DOUBLE_AFTER = 12000n;
const WEEK = 40000n;

/** The first day of the workweek holding `date`, for a workweek starting on ISO weekday `startsOn` (0 = Monday). */
export function workweekStart(date: CalendarDate, startsOn: number): CalendarDate {
  return addDays(date, -((isoDayOfWeek(date) - startsOn + 7) % 7));
}

/** Double time: twice the regular rate. */
export const doubleTimeRate = (rateMinor: bigint): bigint => rateMinor * 2n;

/** An hourly rate for a salary: the year's pay over 2,080 hours, to the cent. */
export const salaryHourlyRate = (annualMinor: bigint): bigint => divRound(annualMinor, 2080n);

/**
 * Splits each day's hours into regular, overtime (1.5×) and double time (2×).
 *
 * `earlier` are days already paid on an earlier paycheck in the same workweeks as `days` (a workweek can cross pay
 * periods). They count toward the week's 40 hours and the seventh day, but aren't paid again: only `days` are returned
 * and totalled. A date in both lists is taken from `days`.
 */
export function splitOvertime(
  days: readonly WorkDay[],
  opts: { rules: OvertimeRules; weekStartsOn: number; earlier?: readonly WorkDay[] },
): OvertimeSplit {
  const paid = new Map(days.map((d) => [d.date, d.hoursMilli]));
  const all = new Map<CalendarDate, bigint>();
  for (const d of opts.earlier ?? []) if (!paid.has(d.date)) all.set(d.date, d.hoursMilli);
  for (const [date, h] of paid) all.set(date, h);
  const weeks = new Map<CalendarDate, CalendarDate>();
  for (const date of all.keys()) {
    const start = workweekStart(date, opts.weekStartsOn);
    weeks.set(start, start);
  }
  const out: DayOvertime[] = [];
  for (const start of [...weeks.keys()].sort()) {
    let weekRegular = 0n;
    let consecutive = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const h = all.get(date) ?? 0n;
      consecutive = h > 0n ? consecutive + 1 : 0;
      if (h <= 0n) {
        if (paid.has(date))
          out.push({ date, hoursMilli: 0n, regular: 0n, overtime: 0n, doubleTime: 0n, seventhDay: false });
        continue;
      }
      const seventhDay = opts.rules === 'california' && i === 6 && consecutive === 7;
      let regular: bigint;
      let overtime: bigint;
      let doubleTime: bigint;
      if (opts.rules === 'federal') {
        regular = h;
        overtime = 0n;
        doubleTime = 0n;
      } else if (seventhDay) {
        regular = 0n;
        overtime = h < DAY ? h : DAY;
        doubleTime = h - overtime;
      } else {
        regular = h < DAY ? h : DAY;
        doubleTime = h > DOUBLE_AFTER ? h - DOUBLE_AFTER : 0n;
        overtime = h - regular - doubleTime;
      }
      // The week's 41st straight-time hour onward is overtime.
      if (weekRegular + regular > WEEK) {
        const over = weekRegular + regular - WEEK;
        const moved = over < regular ? over : regular;
        regular -= moved;
        overtime += moved;
      }
      weekRegular += regular;
      if (paid.has(date)) out.push({ date, hoursMilli: h, regular, overtime, doubleTime, seventhDay });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    regular: out.reduce((t, d) => t + d.regular, 0n),
    overtime: out.reduce((t, d) => t + d.overtime, 0n),
    doubleTime: out.reduce((t, d) => t + d.doubleTime, 0n),
    days: out,
  };
}
