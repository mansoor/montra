import { describe, expect, it } from 'vitest';
import { barShares, sharePercent, summarizeMonths } from '../src/dashboard-charts.js';

const m = (income: string, spending: string, netWorth = '0') => ({ income, spending, netWorth });

describe('Home chart summary (FLOW-01)', () => {
  it('averages the full months and says how much of income was kept', () => {
    const s = summarizeMonths([
      m('500000', '400000', '100'),
      m('500000', '300000', '200'),
      m('100', '9999', '900'),
    ]);
    // The current month (last) is left out.
    expect(s).toEqual({
      months: 2,
      income: 500000n,
      spending: 350000n,
      keptPercent: 30,
      netWorthChange: 800n,
    });
  });

  it('skips the months before any money moved, and handles none at all', () => {
    expect(summarizeMonths([m('0', '0'), m('0', '0'), m('300', '100'), m('5', '5')])).toMatchObject({
      months: 1,
      income: 300n,
      spending: 100n,
      keptPercent: 67,
    });
    expect(summarizeMonths([m('0', '0'), m('0', '0')])).toMatchObject({ months: 0, keptPercent: null });
    expect(summarizeMonths([])).toMatchObject({ months: 0, netWorthChange: 0n });
  });

  it('uses the only month there is, and goes negative when spending ran over', () => {
    expect(summarizeMonths([m('1000', '1500')])).toMatchObject({ months: 1, keptPercent: -50 });
    expect(summarizeMonths([m('0', '200'), m('0', '0')])).toMatchObject({
      keptPercent: null,
      spending: 200n,
    });
  });

  it('sizes bars against the largest, either way, and shares of a total', () => {
    expect(barShares([200n, -100n, 50n, 0n])).toEqual([100, 50, 25, 0]);
    expect(barShares([3n, 1n])).toEqual([100, 33.3]);
    expect(barShares([0n, 0n])).toEqual([0, 0]);
    expect(sharePercent(20000n, 33000n)).toBe(61);
    expect(sharePercent(1n, 0n)).toBe(0);
  });
});
