import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDate as d,
  doubleTimeRate,
  salaryHourlyRate,
  splitOvertime,
  workweekStart,
  type CalendarDate,
  type WorkDay,
} from '../src/index.js';

const h = (hours: number) => BigInt(hours * 1000);
/** Consecutive days from `start`, one per number given (hours). */
const week = (start: string, ...hours: number[]): WorkDay[] =>
  hours.map((x, i) => ({ date: addDays(d(start), i), hoursMilli: h(x) }));
// 2026-11-01 is a Sunday; a Sunday-start workweek is ISO weekday 6.
const SUNDAY = 6;
const ca = (days: WorkDay[], earlier?: WorkDay[]) =>
  splitOvertime(days, { rules: 'california', weekStartsOn: SUNDAY, earlier });
const totals = (s: ReturnType<typeof splitOvertime>) => [s.regular, s.overtime, s.doubleTime].map(Number);

describe('workweek start', () => {
  it('finds the Sunday before (or on) a date', () => {
    expect(workweekStart(d('2026-11-04'), SUNDAY)).toBe('2026-11-01');
    expect(workweekStart(d('2026-11-01'), SUNDAY)).toBe('2026-11-01');
    expect(workweekStart(d('2026-11-07'), SUNDAY)).toBe('2026-11-01');
    // A Monday-start workweek.
    expect(workweekStart(d('2026-11-01'), 0)).toBe('2026-10-26');
  });
});

describe('California daily overtime (Labor Code §510)', () => {
  it('pays exactly 8 hours a day, 40 a week, all at the regular rate', () => {
    expect(totals(ca(week('2026-11-02', 8, 8, 8, 8, 8)))).toEqual([40000, 0, 0]);
  });

  it('pays over 8 in a day at 1.5× even in a short week', () => {
    expect(totals(ca(week('2026-11-02', 10, 6, 6)))).toEqual([20000, 2000, 0]);
  });

  it('pays over 12 in a day at 2×, and 8–12 at 1.5×', () => {
    expect(totals(ca(week('2026-11-02', 14)))).toEqual([8000, 4000, 2000]);
  });

  it('counts exactly 12 hours as 8 regular and 4 overtime, no double time', () => {
    expect(totals(ca(week('2026-11-02', 12)))).toEqual([8000, 4000, 0]);
  });

  it('makes the week’s 41st straight-time hour overtime without paying daily overtime twice', () => {
    // Mon–Fri 9 hours: 1 daily OT each (5); straight time 8×5 = 40. Saturday 6 hours: all over 40 → OT.
    const s = ca(week('2026-11-02', 9, 9, 9, 9, 9, 6));
    expect(totals(s)).toEqual([40000, 11000, 0]);
    expect(s.days.at(-1)).toMatchObject({ regular: 0n, overtime: 6000n });
  });

  it('splits a day that crosses 40 straight-time hours', () => {
    // 8,8,8,8 = 32; Friday 10: 8 straight but only 8 left to 40 → 8 regular, 2 daily OT. Saturday 5 → all OT.
    expect(totals(ca(week('2026-11-02', 8, 8, 8, 8, 10, 5)))).toEqual([40000, 7000, 0]);
  });

  it('pays the seventh consecutive day: first 8 at 1.5×, the rest at 2×', () => {
    // Sun–Sat, 7 days of 5 hours: 30 straight time by Friday, Saturday is the seventh day.
    const s = ca(week('2026-11-01', 5, 5, 5, 5, 5, 5, 10));
    expect(s.days.at(-1)).toMatchObject({
      seventhDay: true,
      regular: 0n,
      overtime: 8000n,
      doubleTime: 2000n,
    });
    expect(totals(s)).toEqual([30000, 8000, 2000]);
  });

  it('pays a short seventh day all at 1.5×', () => {
    expect(totals(ca(week('2026-11-01', 4, 4, 4, 4, 4, 4, 3)))).toEqual([24000, 3000, 0]);
  });

  it('has no seventh-day premium when a day off breaks the run', () => {
    const s = ca(week('2026-11-01', 0, 5, 5, 5, 5, 5, 10));
    expect(s.days.at(-1)?.seventhDay).toBe(false);
    expect(totals(s)).toEqual([33000, 2000, 0]);
  });

  it('only counts seven days inside one workweek, not across two', () => {
    // Wednesday to the next Tuesday: seven days in a row, but split over two Sunday-start workweeks.
    const s = ca(week('2026-11-04', 6, 6, 6, 6, 6, 6, 6));
    expect(s.days.some((x) => x.seventhDay)).toBe(false);
    expect(totals(s)).toEqual([42000, 0, 0]);
  });

  it('counts days paid on the last paycheck toward this week, without paying them again', () => {
    // The period starts Thursday 11-05. Sun–Wed (8 each, 32) were paid on the last paycheck.
    const earlier = week('2026-11-01', 8, 8, 8, 8);
    const s = ca(week('2026-11-05', 8, 8, 8), earlier);
    expect(s.days.map((x) => x.date)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
    // Thursday reaches 40; Friday is over 40 (OT); Saturday is the seventh consecutive day (8 at 1.5×).
    expect(totals(s)).toEqual([8000, 16000, 0]);
    expect(s.days.at(-1)?.seventhDay).toBe(true);
  });

  it('takes a day in both lists from this paycheck', () => {
    const s = ca(week('2026-11-02', 10), week('2026-11-02', 4));
    expect(totals(s)).toEqual([8000, 2000, 0]);
  });

  it('ignores zero-hour days but keeps them in the list', () => {
    const s = ca(week('2026-11-02', 0, 9));
    expect(s.days).toHaveLength(2);
    expect(totals(s)).toEqual([8000, 1000, 0]);
  });

  it('handles thousandths of an hour', () => {
    const s = ca([{ date: d('2026-11-02'), hoursMilli: 8250n }]);
    expect(totals(s)).toEqual([8000, 250, 0]);
  });

  it('keeps every hour: regular + overtime + double time = hours worked', () => {
    const days = week('2026-11-01', 13, 2, 11.5, 0, 9.25, 12.75, 7);
    const s = ca(days);
    const worked = days.reduce((t, x) => t + x.hoursMilli, 0n);
    expect(s.regular + s.overtime + s.doubleTime).toBe(worked);
  });
});

describe('federal (FLSA) weekly overtime', () => {
  it('pays only over 40 a week, never by the day', () => {
    const s = splitOvertime(week('2026-11-02', 12, 12, 12, 12), { rules: 'federal', weekStartsOn: SUNDAY });
    expect(totals(s)).toEqual([40000, 8000, 0]);
  });

  it('has no seventh-day rule', () => {
    const s = splitOvertime(week('2026-11-01', 5, 5, 5, 5, 5, 5, 10), {
      rules: 'federal',
      weekStartsOn: SUNDAY,
    });
    expect(totals(s)).toEqual([40000, 0, 0]);
  });

  it('works out each workweek of a two-week period on its own', () => {
    const days: WorkDay[] = [
      ...week('2026-11-01', 0, 9, 9, 9, 9, 9),
      ...week('2026-11-08', 0, 8, 8, 8, 8, 8),
    ];
    expect(totals(splitOvertime(days, { rules: 'federal', weekStartsOn: SUNDAY }))).toEqual([80000, 5000, 0]);
  });
});

describe('rates', () => {
  it('doubles the rate for double time', () => {
    expect(doubleTimeRate(2250n)).toBe(4500n);
  });

  it('turns a salary into an hourly rate over 2,080 hours', () => {
    expect(salaryHourlyRate(5_200_000n)).toBe(2500n);
    // $50,000 / 2,080 = $24.038… → $24.04
    expect(salaryHourlyRate(5_000_000n)).toBe(2404n);
  });
});

// Typed check that dates stay CalendarDate strings.
const _date: CalendarDate = d('2026-11-01');
void _date;
