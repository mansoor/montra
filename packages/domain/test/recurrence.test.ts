import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  calendarDate,
  compareDates,
  fromEpochDay,
  nextOccurrenceAfter,
  occurrence,
  occurrencesBetween,
  toEpochDay,
  CADENCES,
} from '../src/index.js';

const d = calendarDate;

describe('recurrence (TXN-05)', () => {
  it('anchors monthly schedules to the start day', () => {
    const start = d('2026-01-31');
    expect([0, 1, 2, 3].map((n) => occurrence(start, 'monthly', n))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('handles weekly, quarterly and yearly cadences', () => {
    expect(occurrence(d('2026-10-30'), 'biweekly', 2)).toBe('2026-11-27');
    expect(occurrence(d('2026-11-30'), 'quarterly', 1)).toBe('2027-02-28');
    expect(occurrence(d('2024-02-29'), 'yearly', 1)).toBe('2025-02-28');
    expect(occurrence(d('2024-02-29'), 'yearly', 4)).toBe('2028-02-29');
  });

  it('pays semimonthly on day d and d+15', () => {
    expect(occurrencesBetween(d('2026-01-05'), 'semimonthly', d('2026-01-01'), d('2026-02-28'))).toEqual([
      '2026-01-05',
      '2026-01-20',
      '2026-02-05',
      '2026-02-20',
    ]);
    expect(occurrencesBetween(d('2026-01-30'), 'semimonthly', d('2026-01-01'), d('2026-03-01'))).toEqual([
      '2026-01-30',
      '2026-02-15',
      '2026-02-28',
    ]);
  });

  it('respects the end date and finds the next occurrence', () => {
    expect(
      occurrencesBetween(d('2026-01-01'), 'monthly', d('2026-01-01'), d('2026-12-31'), d('2026-03-15')),
    ).toHaveLength(3);
    expect(nextOccurrenceAfter(d('2026-01-15'), 'monthly', d('2026-10-30'))).toBe('2026-11-15');
    expect(nextOccurrenceAfter(d('2026-01-15'), 'monthly', d('2026-10-30'), d('2026-11-01'))).toBeNull();
  });

  it('produces strictly increasing dates (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30_000 }), fc.constantFrom(...CADENCES), (day, cadence) => {
        const start = fromEpochDay(day);
        let prev = occurrence(start, cadence, 0);
        expect(prev).toBe(start);
        for (let n = 1; n < 30; n++) {
          const next = occurrence(start, cadence, n);
          expect(compareDates(next, prev)).toBe(1);
          expect(toEpochDay(next) - toEpochDay(prev)).toBeLessThanOrEqual(
            cadence === 'yearly' ? 366 : cadence === 'quarterly' ? 92 : 31,
          );
          prev = next;
        }
      }),
    );
  });
});
