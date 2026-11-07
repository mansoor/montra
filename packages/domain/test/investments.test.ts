import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  annualizedBps,
  calendarDate,
  EMPLOYER_PLAN_ROUTES,
  PAYSLIP_PLAN_ROUTES,
  performance,
  performancePeriods,
  routeToPlan,
  valueAndInvested,
  type PlanType,
} from '../src/index.js';

const d = calendarDate;

describe('routing payslip money to a plan (ADR-0025)', () => {
  const accounts: { id: string; planType: PlanType | null }[] = [
    { id: 'brokerage', planType: 'brokerage' },
    { id: 'roth', planType: 'roth_401k' },
    { id: 'hsa', planType: 'hsa' },
  ];

  it('picks the best fit, falling back to a close one', () => {
    expect(routeToPlan(PAYSLIP_PLAN_ROUTES['roth_401k'], accounts)?.id).toBe('roth');
    // No traditional 401(k): a Roth one takes it before nothing does.
    expect(routeToPlan(PAYSLIP_PLAN_ROUTES['401k'], accounts)?.id).toBe('roth');
    expect(routeToPlan(PAYSLIP_PLAN_ROUTES['hsa'], accounts)?.id).toBe('hsa');
    expect(routeToPlan(PAYSLIP_PLAN_ROUTES['espp'], accounts)?.id).toBe('brokerage');
    expect(routeToPlan(EMPLOYER_PLAN_ROUTES['match'], accounts)?.id).toBe('roth');
  });

  it('finds nothing for a line with no plan, or no fitting account', () => {
    expect(routeToPlan(PAYSLIP_PLAN_ROUTES['fsa'], accounts)).toBeUndefined();
    expect(routeToPlan(PAYSLIP_PLAN_ROUTES['pension'], accounts)).toBeUndefined();
    expect(routeToPlan(EMPLOYER_PLAN_ROUTES['other'], accounts)).toBeUndefined();
  });
});

describe('performance', () => {
  it('separates money put in from changes in value', () => {
    const p = performance(
      [
        { date: d('2026-01-01'), delta: 100000n, valuation: 0n },
        { date: d('2026-02-01'), delta: 50000n, valuation: 0n },
        { date: d('2026-02-15'), delta: 12000n, valuation: 12000n },
        { date: d('2026-03-01'), delta: -5000n, valuation: 0n },
      ],
      d('2026-02-01'),
      d('2026-03-31'),
    );
    expect(p).toMatchObject({ start: 100000n, end: 157000n, moneyIn: 50000n, moneyOut: 5000n, gain: 12000n });
    expect(p.start + p.moneyIn - p.moneyOut + p.gain).toBe(p.end);
  });

  it('gives a plain percentage when nothing moves in or out', () => {
    const p = performance(
      [
        { date: d('2025-12-31'), delta: 100000n, valuation: 0n },
        { date: d('2026-06-30'), delta: 7000n, valuation: 7000n },
      ],
      d('2026-01-01'),
      d('2026-12-31'),
    );
    expect(p.returnBps).toBe(700);
  });

  it('counts money that came in late for less of the period', () => {
    // $1,000 at work all year gains $100. $1,000 more arriving on the last day isn't at work, so the rate stays near 10%.
    const p = performance(
      [
        { date: d('2025-12-31'), delta: 100000n, valuation: 0n },
        { date: d('2026-12-30'), delta: 10000n, valuation: 10000n },
        { date: d('2026-12-31'), delta: 100000n, valuation: 0n },
      ],
      d('2026-01-01'),
      d('2026-12-31'),
    );
    expect(p.returnBps).toBe(1000);
  });

  it('says nothing about a rate when nothing was at work', () => {
    const p = performance(
      [{ date: d('2026-03-31'), delta: 5000n, valuation: 0n }],
      d('2026-01-01'),
      d('2026-03-31'),
    );
    expect(p.returnBps).toBeNull();
    expect(performance([], d('2026-01-01'), d('2026-03-31'))).toMatchObject({
      start: 0n,
      end: 0n,
      returnBps: null,
    });
  });

  it('always adds up', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 0, max: 800 }),
            delta: fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
            valuation: fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
          }),
          { maxLength: 40 },
        ),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (raw, a, b) => {
          const date = (n: number) => d(new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10));
          const changes = [...raw]
            .sort((x, y) => x.day - y.day)
            .map((r) => ({ date: date(r.day), delta: r.delta, valuation: r.valuation }));
          const from = date(Math.min(a, a + b));
          const to = date(a + b);
          const p = performance(changes, from, to);
          expect(p.start + p.moneyIn - p.moneyOut + p.gain).toBe(p.end);
          expect(p.moneyIn >= 0n && p.moneyOut >= 0n).toBe(true);
        },
      ),
    );
  });
});

describe('annualizedBps', () => {
  it('is only for more than a year', () => {
    expect(annualizedBps(1000, d('2026-01-01'), d('2026-06-30'))).toBeNull();
    expect(annualizedBps(null, d('2020-01-01'), d('2026-06-30'))).toBeNull();
  });

  it('turns two years’ growth into a yearly rate', () => {
    // 21% over two years is 10% a year.
    expect(annualizedBps(2100, d('2025-01-01'), d('2026-12-31'))).toBe(1000);
  });
});

describe('performancePeriods', () => {
  it('is months for a year or so, clipped at both ends', () => {
    expect(performancePeriods(d('2026-01-15'), d('2026-03-10'))).toEqual([
      { from: d('2026-01-15'), to: d('2026-01-31') },
      { from: d('2026-02-01'), to: d('2026-02-28') },
      { from: d('2026-03-01'), to: d('2026-03-10') },
    ]);
  });

  it('is years for a long span', () => {
    const p = performancePeriods(d('2020-06-01'), d('2026-11-07'));
    expect(p[0]).toEqual({ from: d('2020-06-01'), to: d('2020-12-31') });
    expect(p[p.length - 1]).toEqual({ from: d('2026-01-01'), to: d('2026-11-07') });
    expect(p).toHaveLength(7);
  });
});

describe('valueAndInvested', () => {
  it('draws the value, and what it would be without market changes', () => {
    const changes = [
      { date: d('2026-01-01'), delta: 100000n, valuation: 0n },
      { date: d('2026-01-10'), delta: 3000n, valuation: 3000n },
    ];
    expect(valueAndInvested(changes, [d('2026-01-05'), d('2026-01-10')])).toEqual([
      { date: d('2026-01-05'), value: 100000n, invested: 100000n },
      { date: d('2026-01-10'), value: 103000n, invested: 100000n },
    ]);
  });
});
