import { describe, expect, it } from 'vitest';
import { calendarDate, nextBill, type BillPayment } from '../src/index.js';

// Billers' next bills (ADR-0048 §4).
const d = calendarDate;
const paid = (date: string, amount: bigint): BillPayment => ({ date: d(date), amount });

describe('nextBill', () => {
  const payments = [paid('2026-08-19', 9000n), paid('2026-09-18', 8000n), paid('2026-10-19', 8500n)];

  it('averages the last three payments, due one cadence after the last', () => {
    expect(nextBill({ today: d('2026-11-14'), cadence: 'monthly', dueDay: 20, payments })).toEqual({
      date: '2026-11-20',
      amount: 8500n,
      basedOn: 3,
    });
    // Without a due day, the day it was last paid.
    expect(nextBill({ today: d('2026-11-14'), cadence: 'monthly', dueDay: null, payments })?.date).toBe(
      '2026-11-19',
    );
  });

  it('steps past a cycle already gone, and clamps the day to the month', () => {
    // Last paid in August, today mid-November: the November bill, not September's.
    expect(
      nextBill({
        today: d('2026-11-14'),
        cadence: 'monthly',
        dueDay: 20,
        payments: [paid('2026-08-19', 100n)],
      })?.date,
    ).toBe('2026-11-20');
    expect(
      nextBill({
        today: d('2027-02-01'),
        cadence: 'monthly',
        dueDay: 31,
        payments: [paid('2027-01-30', 100n)],
      })?.date,
    ).toBe('2027-02-28');
    expect(
      nextBill({
        today: d('2026-11-14'),
        cadence: 'quarterly',
        dueDay: 5,
        payments: [paid('2026-10-04', 100n)],
      })?.date,
    ).toBe('2027-01-05');
  });

  it('averages what there is, rounding half up, and has nothing to go on without payments', () => {
    expect(
      nextBill({
        today: d('2026-11-14'),
        cadence: 'monthly',
        dueDay: 1,
        payments: [paid('2026-10-01', 101n), paid('2026-09-01', 100n)],
      }),
    ).toMatchObject({ amount: 101n, basedOn: 2 });
    expect(nextBill({ today: d('2026-11-14'), cadence: 'monthly', dueDay: 1, payments: [] })).toBeNull();
  });
});
