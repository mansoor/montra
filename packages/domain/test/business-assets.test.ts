import { describe, expect, it } from 'vitest';
import {
  assetDepreciationForYear,
  assetDepreciationInDisposalYear,
  assetSchedule,
  calendarDate,
  carveAssetSplits,
  disposalGain,
  MACRS_HALF_YEAR,
  type AssetBasis,
} from '../src/index.js';

const asset = (over: Partial<AssetBasis> = {}): AssetBasis => ({
  category: 'computers',
  method: 'macrs_half_year',
  life: 5,
  cost: 1_000_000n,
  section179: 0n,
  inService: calendarDate('2024-03-01'),
  ...over,
});

describe('asset depreciation (BIZ-16)', () => {
  it('every MACRS half-year column adds up to 100%', () => {
    for (const col of Object.values(MACRS_HALF_YEAR)) expect(col.reduce((t, p) => t + p, 0)).toBe(10_000);
  });

  it('MACRS 5-year follows Table A-1', () => {
    expect(assetSchedule(asset())).toEqual([
      { year: 2024, amount: 200_000n },
      { year: 2025, amount: 320_000n },
      { year: 2026, amount: 192_000n },
      { year: 2027, amount: 115_200n },
      { year: 2028, amount: 115_200n },
      { year: 2029, amount: 57_600n },
    ]);
  });

  it('straight line takes half a year at each end and adds up to the cost', () => {
    const a = asset({ category: 'furniture', method: 'straight_line', life: 7, cost: 700_001n });
    const s = assetSchedule(a);
    expect(s).toHaveLength(8);
    expect(s[0]).toEqual({ year: 2024, amount: 50_000n });
    expect(s[1]).toEqual({ year: 2025, amount: 100_000n });
    expect(s.reduce((t, r) => t + r.amount, 0n)).toBe(700_001n);
  });

  it('software is straight line over 36 months from the month placed in service', () => {
    const a = asset({
      category: 'software',
      method: 'straight_line',
      life: 3,
      cost: 360_000n,
      inService: calendarDate('2026-10-15'),
    });
    expect(assetSchedule(a)).toEqual([
      { year: 2026, amount: 30_000n },
      { year: 2027, amount: 120_000n },
      { year: 2028, amount: 120_000n },
      { year: 2029, amount: 90_000n },
    ]);
  });

  it('Section 179 is taken in the first year and the rest is depreciated', () => {
    const a = asset({ section179: 400_000n });
    expect(assetDepreciationForYear(a, 2024)).toBe(400_000n + 120_000n);
    expect(assetSchedule(a).reduce((t, r) => t + r.amount, 0n)).toBe(1_000_000n);
  });

  it('expense now has no depreciation: the purchase is already an expense', () => {
    expect(assetSchedule(asset({ method: 'expense_now', cost: 200_000n }))).toEqual([]);
  });

  it('the disposal year gets half its amount, and nothing in the year placed in service', () => {
    expect(assetDepreciationInDisposalYear(asset(), calendarDate('2026-06-30'))).toBe(96_000n);
    expect(assetDepreciationInDisposalYear(asset(), calendarDate('2024-12-01'))).toBe(0n);
  });

  it('a gain or loss is proceeds less book value', () => {
    // Cost 10,000, taken 2,000 + 3,200 + 960 = 6,160: book value 3,840. Sold for 3,000: a loss of 840.
    expect(disposalGain(300_000n, 1_000_000n, 616_000n)).toBe(-84_000n);
    expect(disposalGain(500_000n, 1_000_000n, 616_000n)).toBe(116_000n);
  });
});

describe('capitalizing a purchase (BIZ-16)', () => {
  const split = (accountId: string, amount: string) => ({ accountId, amount, memberId: null });

  it('takes the cost from the largest business expense split first', () => {
    const out = carveAssetSplits(
      [split('office', '-300000'), split('supplies', '-50000'), split('personal', '-10000')],
      new Set(['office', 'supplies']),
      320_000n,
      'fixed',
    );
    expect(out).toEqual([
      split('supplies', '-30000'),
      split('personal', '-10000'),
      split('fixed', '-320000'),
    ]);
  });

  it('refuses a cost larger than the business spending in the purchase', () => {
    expect(carveAssetSplits([split('office', '-1000')], new Set(['office']), 1001n, 'fixed')).toBeNull();
  });
});
