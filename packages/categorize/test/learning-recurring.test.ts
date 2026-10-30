import { addDays, addMonths, type CalendarDate } from '@montra/domain';
import { describe, expect, it } from 'vitest';
import { detectRecurring, proposeRuleFromCorrections, type PayeeSeries } from '../src/index.js';
import { d } from './fixtures.js';

describe('proposeRuleFromCorrections', () => {
  const c = (
    toValue: string | null,
    field: 'category' | 'member' = 'category',
    payee: string | null = 'Shell',
  ) => ({
    payeeKey: 'SHELL',
    payee,
    field,
    toValue,
  });

  it('offers a rule after 2 identical corrections', () => {
    expect(proposeRuleFromCorrections([c('cat-fuel'), c('cat-fuel')])).toEqual({
      payeeKey: 'SHELL',
      name: 'Shell',
      conditions: { all: [{ field: 'payee', op: 'contains', value: 'Shell', ci: true }] },
      actions: { categoryId: 'cat-fuel' },
      evidence: 2,
    });
  });

  it('needs the minimum evidence', () => {
    expect(proposeRuleFromCorrections([c('cat-fuel'), c('cat-food')])).toBeNull();
    expect(proposeRuleFromCorrections([c('cat-fuel'), c('cat-fuel')], 3)).toBeNull();
    expect(proposeRuleFromCorrections([])).toBeNull();
  });

  it('the most recent wins a tie; member corrections become member rules', () => {
    const p = proposeRuleFromCorrections([
      c('cat-a'),
      c('cat-a'),
      c('mem-son', 'member'),
      c('mem-son', 'member'),
    ]);
    expect(p!.actions).toEqual({ memberId: 'mem-son' });
  });

  it('ignores null targets and falls back to the payee key', () => {
    const p = proposeRuleFromCorrections([
      c(null, 'category', null),
      c('cat-a', 'category', null),
      c('cat-a', 'category', null),
    ]);
    expect(p!.name).toBe('SHELL');
  });
});

function series(
  dates: CalendarDate[],
  amounts: bigint[] | bigint,
  over: Partial<PayeeSeries> = {},
): PayeeSeries {
  return {
    payeeKey: 'NETFLIX',
    payee: 'Netflix',
    accountId: 'acct-1',
    entityId: 'ent-1',
    categoryId: 'cat-subs',
    txns: dates.map((date, i) => ({
      id: `t${i}`,
      date,
      accountId: 'acct-1',
      amountMinor: typeof amounts === 'bigint' ? amounts : amounts[i]!,
    })),
    ...over,
  };
}
const monthly = (start: string, n: number) => Array.from({ length: n }, (_, i) => addMonths(d(start), i));
const every = (start: string, days: number, n: number) =>
  Array.from({ length: n }, (_, i) => addDays(d(start), i * days));

describe('detectRecurring', () => {
  it('finds a fixed monthly subscription', () => {
    const [p] = detectRecurring([series(monthly('2026-04-12', 6), -1599n)], d('2026-10-01'));
    expect(p).toMatchObject({
      cadence: 'monthly',
      amountKind: 'fixed',
      amountMinor: -1599n,
      lastDate: '2026-09-12',
      nextDate: '2026-10-12',
      firstSeen: '2026-04-12',
      occurrences: 6,
      isNew: false,
      priceIncrease: null,
    });
  });

  it('keeps month-end anchors', () => {
    const dates = [d('2026-01-31'), d('2026-02-28'), d('2026-03-31'), d('2026-04-30')];
    const [p] = detectRecurring([series(dates, -1000n)], d('2026-05-01'));
    expect(p!.nextDate).toBe('2026-05-31');
  });

  it('classifies weekly, biweekly, quarterly and yearly cadences', () => {
    const today = d('2026-10-30');
    const cad = (dates: CalendarDate[]) => detectRecurring([series(dates, -500n)], today)[0]?.cadence;
    expect(cad(every('2026-10-02', 7, 4))).toBe('weekly');
    expect(cad(every('2026-08-21', 14, 5))).toBe('biweekly');
    expect(cad([d('2025-10-15'), d('2026-01-15'), d('2026-04-15'), d('2026-07-15'), d('2026-10-15')])).toBe(
      'quarterly',
    );
    expect(cad([d('2023-11-01'), d('2024-11-01'), d('2025-11-01')])).toBe('yearly');
  });

  it('classifies yearly within its staleness window', () => {
    const [p] = detectRecurring(
      [series([d('2024-03-01'), d('2025-03-01'), d('2026-03-02')], -9900n)],
      d('2026-10-30'),
    );
    expect(p).toMatchObject({ cadence: 'yearly', nextDate: '2027-03-01' });
  });

  it('detects semimonthly pay on the 1st and 15th', () => {
    const dates = ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15', '2026-10-01', '2026-10-15'].map(d);
    const [p] = detectRecurring([series(dates, 250_000n)], d('2026-10-20'));
    expect(p).toMatchObject({ cadence: 'semimonthly', nextDate: '2026-11-01', amountMinor: 250_000n });
  });

  it('marks variable amounts and new series', () => {
    const [p] = detectRecurring(
      [series(monthly('2026-08-03', 3), [-8000n, -9500n, -7200n], { payeeKey: 'POWER', payee: 'Power Co' })],
      d('2026-10-10'),
    );
    expect(p).toMatchObject({ amountKind: 'variable', minMinor: -9500n, maxMinor: -7200n, isNew: false });
    const [n] = detectRecurring([series(every('2026-10-01', 7, 3), -999n)], d('2026-10-16'));
    expect(n!.isNew).toBe(true);
  });

  it('flags a price increase above 5%', () => {
    const [p] = detectRecurring(
      [series(monthly('2026-05-12', 5), [-1599n, -1599n, -1599n, -1599n, -1799n])],
      d('2026-10-01'),
    );
    expect(p!.priceIncrease).toEqual({ fromMinor: -1599n, toMinor: -1799n, percent: 12.5 });
    expect(p!.amountMinor).toBe(-1799n);
    expect(p!.amountKind).toBe('fixed');
    const [q] = detectRecurring(
      [series(monthly('2026-05-12', 5), [-1000n, -1000n, -1000n, -1000n, -1040n])],
      d('2026-10-01'),
    );
    expect(q!.priceIncrease).toBeNull();
  });

  it('rejects irregular, short and stale series', () => {
    const irregular = [d('2026-01-01'), d('2026-01-09'), d('2026-02-20'), d('2026-03-01'), d('2026-05-17')];
    expect(detectRecurring([series(irregular, -500n)], d('2026-06-01'))).toEqual([]);
    expect(detectRecurring([series(monthly('2026-08-01', 2), -500n)], d('2026-10-01'))).toEqual([]);
    expect(detectRecurring([series(monthly('2025-01-01', 6), -500n)], d('2026-10-01'))).toEqual([]);
  });

  it('ignores a refund and same-day doubles', () => {
    const dates = [...monthly('2026-05-12', 5), d('2026-07-13'), d('2026-08-12')];
    const amounts = [-1599n, -1599n, -1599n, -1599n, -1599n, 1599n, -1599n];
    const [p] = detectRecurring([series(dates, amounts)], d('2026-10-01'));
    expect(p).toMatchObject({ cadence: 'monthly', occurrences: 5 });
  });
});
