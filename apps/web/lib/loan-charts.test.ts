import { describe, expect, it } from 'vitest';
import type { AmortizationRowDto } from '@montra/api-client';
import {
  SCHEDULE_BARS_BY_YEAR_ABOVE,
  niceTicks,
  paidSoFar,
  payoffProjection,
  readScheduleView,
  scheduleBars,
  todayIndex,
} from './loan-charts';

/** A schedule row as the API sends it: monthly from `first`, recorded while `paid`. */
const row = (
  number: number,
  date: string,
  { paid = false, interest = '1000', principal = '9000', balance = '0', escrow = '0', lateFee = '0' } = {},
): AmortizationRowDto =>
  ({
    number,
    date,
    payment: String(BigInt(interest) + BigInt(principal)),
    interest,
    principal,
    escrow,
    balance,
    transactionId: paid ? `t${number}` : null,
    lateFee,
  }) as AmortizationRowDto;

/** `count` monthly rows from January of `year`, the first `paid` of them recorded. */
const monthly = (year: number, count: number, paid: number) =>
  Array.from({ length: count }, (_, i) => {
    const y = year + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    return row(i + 1, `${y}-${m}-01`, {
      paid: i < paid,
      interest: String(1000 - i),
      principal: String(9000 + i),
      balance: String((count - i - 1) * 9000),
      lateFee: i === 1 ? '2500' : '0',
    });
  });

describe('the schedule as bars', () => {
  it('draws one bar per payment up to the threshold, with the table’s figures', () => {
    const rows = [
      row(1, '2026-10-01', { paid: true, escrow: '500', lateFee: '2500', balance: '91000' }),
      row(2, '2026-11-01', { balance: '82000' }),
    ];
    const { byYear, bars } = scheduleBars(rows);
    expect(byYear).toBe(false);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({
      date: '2026-10-01',
      recorded: true,
      principal: 9000n,
      interest: 1000n,
      lateFee: 2500n,
      // What the table's Payment column shows: principal, interest and escrow.
      payment: 10500n,
      owedAfter: 91000n,
      count: 1,
      year: null,
    });
    expect(bars[1]).toMatchObject({ recorded: false, lateFee: 0n, owedAfter: 82000n });
  });

  it('keeps 120 payments as they are, and sums 121 or more by year', () => {
    expect(SCHEDULE_BARS_BY_YEAR_ABOVE).toBe(120);
    expect(scheduleBars(monthly(2026, 120, 0)).byYear).toBe(false);
    const { byYear, bars } = scheduleBars(monthly(2026, 121, 0));
    expect(byYear).toBe(true);
    // Ten full years and January of the eleventh.
    expect(bars).toHaveLength(11);
    expect(bars[0]).toMatchObject({ year: 2026, count: 12, date: '2026-01-01', lastDate: '2026-12-01' });
    // Sums, exactly: interest 1000 + 999 + … + 989, principal 9000 + … + 9011.
    expect(bars[0]!.interest).toBe(11934n);
    expect(bars[0]!.principal).toBe(108066n);
    expect(bars[0]!.lateFee).toBe(2500n);
    expect(bars[0]!.owedAfter).toBe(BigInt((121 - 12) * 9000));
    expect(bars[10]).toMatchObject({ year: 2036, count: 1, owedAfter: 0n });
  });

  it('splits a year with both recorded payments and ones to come, so today falls between bars', () => {
    const { bars } = scheduleBars(monthly(2026, 130, 15));
    expect(bars.slice(0, 3).map((b) => [b.year, b.count, b.recorded])).toEqual([
      [2026, 12, true],
      [2027, 3, true],
      [2027, 9, false],
    ]);
    expect(todayIndex(bars)).toBe(2);
    expect(bars.reduce((n, b) => n + b.count, 0)).toBe(130);
  });

  it('puts today first when nothing is recorded, and last when everything is', () => {
    expect(todayIndex(scheduleBars(monthly(2026, 3, 0)).bars)).toBe(0);
    expect(todayIndex(scheduleBars(monthly(2026, 3, 3)).bars)).toBe(3);
  });

  it('orders the rows by number, as the table does', () => {
    const { bars } = scheduleBars([row(2, '2026-11-01'), row(1, '2026-10-01', { paid: true })]);
    expect(bars.map((b) => b.key)).toEqual(['p1', 'p2']);
  });
});

describe('the amount owed to payoff', () => {
  it('runs from what’s owed today along each upcoming payment’s balance, to zero', () => {
    const rows = [
      row(1, '2026-10-27', { paid: true, balance: '20000' }),
      row(2, '2026-11-27', { balance: '10000' }),
      row(3, '2026-12-27', { balance: '0' }),
    ];
    expect(payoffProjection({ scheduledBalance: '20000' }, rows, '2026-11-24')).toEqual([
      { date: '2026-11-24', owed: 20000n },
      { date: '2026-11-27', owed: 10000n },
      { date: '2026-12-27', owed: 0n },
    ]);
  });

  it('counts an overdue payment from today, and has nothing to project once paid off', () => {
    const rows = [row(1, '2026-11-01', { balance: '5000' }), row(2, '2026-12-01', { balance: '0' })];
    expect(payoffProjection({ scheduledBalance: '15000' }, rows, '2026-11-24').map((p) => p.date)).toEqual([
      '2026-11-24',
      '2026-11-24',
      '2026-12-01',
    ]);
    expect(
      payoffProjection({ scheduledBalance: '0' }, [row(1, '2026-11-01', { paid: true })], '2026-11-24'),
    ).toEqual([]);
  });
});

describe('paid so far', () => {
  it('sets principal repaid against the original amount, and interest paid against paid plus still to pay', () => {
    expect(
      paidSoFar({
        principal: '20000000',
        principalPaid: '19910',
        interestPaid: '100000',
        interestRemaining: '23000000',
      }),
    ).toEqual({
      principalPaid: 19910n,
      principal: 20000000n,
      interestPaid: 100000n,
      interestTotal: 23100000n,
    });
  });
});

describe('chart helpers', () => {
  it('remembers only a known choice of view, the table by default', () => {
    expect(readScheduleView('chart')).toBe('chart');
    expect(readScheduleView('table')).toBe('table');
    expect(readScheduleView(null)).toBe('table');
    expect(readScheduleView('pie')).toBe('table');
  });

  it('steps the axis in 1, 2 or 5 times a power of ten, reaching the largest value', () => {
    expect(niceTicks(119910)).toEqual([0, 50000, 100000, 150000]);
    expect(niceTicks(1000)).toEqual([0, 500, 1000]);
    expect(niceTicks(1001)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
  });
});
