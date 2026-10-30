import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addDays,
  addMonths,
  calendarDate,
  diffDays,
  endOfMonth,
  fromEpochDay,
  isCalendarDate,
  isoDayOfWeek,
  todayIn,
  toEpochDay,
} from '../src/index.js';

describe('CalendarDate (TZ-02)', () => {
  it('validates real dates only', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
    expect(() => calendarDate('2026-04-31')).toThrow(RangeError);
  });

  it('does date arithmetic without time zones', () => {
    const d = calendarDate('2026-10-29');
    expect(toEpochDay(calendarDate('1970-01-01'))).toBe(0);
    expect(addDays(d, 3)).toBe('2026-11-01');
    expect(addDays(calendarDate('2024-03-01'), -1)).toBe('2024-02-29');
    expect(diffDays(calendarDate('2026-11-01'), d)).toBe(3);
    expect(addMonths(calendarDate('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addMonths(calendarDate('2026-01-15'), -13)).toBe('2024-12-15');
    expect(endOfMonth(calendarDate('2028-02-10'))).toBe('2028-02-29');
    expect(isoDayOfWeek(calendarDate('2026-10-29'))).toBe(3); // Thursday
  });

  it('round-trips epoch days (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 200_000 }), (n) => {
        expect(toEpochDay(fromEpochDay(n))).toBe(n);
      }),
    );
  });

  it('computes "today" in the workspace time zone (TZ-01)', () => {
    const instant = new Date('2026-10-30T02:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-10-30');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-29');
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-10-30');
  });
});
