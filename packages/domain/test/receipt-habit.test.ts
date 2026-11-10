import { describe, expect, it } from 'vitest';
import { calendarDate as d } from '../src/calendar-date.js';
import { receiptHabit, weekStartOf } from '../src/receipt-habit.js';

// 2026-11-11 is a Wednesday.
const today = d('2026-11-11');
const habit = (capturedOn: string[], missingOn: string[], weekStart = 1) =>
  receiptHabit({ today, weekStart, weeks: 12, capturedOn: capturedOn.map(d), missingOn: missingOn.map(d) });

describe('receipt habit (UP-09)', () => {
  it('finds the week by the user’s first day', () => {
    expect(weekStartOf(today, 1)).toBe('2026-11-09'); // Monday
    expect(weekStartOf(today, 7)).toBe('2026-11-08'); // Sunday
    expect(weekStartOf(today, 3)).toBe('2026-11-11'); // Wednesday itself
    expect(weekStartOf(d('2026-11-08'), 1)).toBe('2026-11-02');
  });

  it('counts this week’s receipts and the purchases still missing one', () => {
    expect(habit(['2026-11-09', '2026-11-10', '2026-11-05'], ['2026-11-11', '2026-11-01'])).toMatchObject({
      week: { start: '2026-11-09', end: '2026-11-15' },
      captured: 2,
      missing: 1,
    });
  });

  it('streaks weeks with receipts and none missing; a quiet week neither counts nor breaks it', () => {
    // This week clean, last week clean, the week before quiet, then clean, then one missing.
    const s = habit(['2026-11-10', '2026-11-03', '2026-10-21', '2026-10-14'], ['2026-10-13']);
    expect(s.streakWeeks).toBe(3);
  });

  it('never lets the week in progress break the streak', () => {
    expect(habit(['2026-11-03', '2026-10-27'], ['2026-11-10']).streakWeeks).toBe(2);
    expect(habit([], []).streakWeeks).toBe(0);
  });
});
