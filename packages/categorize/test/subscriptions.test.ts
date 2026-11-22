import { describe, expect, it } from 'vitest';
import {
  costPerYear,
  merchantWord,
  unusedSubscriptions,
  type MerchantTxn,
  type SubscriptionItem,
} from '../src/index.js';
import { d } from './fixtures.js';

const item = (over: Partial<SubscriptionItem> = {}): SubscriptionItem => ({
  id: 'sub-uber',
  name: 'Uber One',
  payeeKey: 'UBER ONE',
  categoryId: 'cat-subs',
  mcc: null,
  amountMinor: -999n,
  currency: 'USD',
  cadence: 'monthly',
  startDate: d('2026-01-15'),
  ...over,
});

const txn = (id: string, date: string, amountMinor: bigint, payeeKey = 'UBER TRIP'): MerchantTxn => ({
  id,
  date: d(date),
  payeeKey,
  amountMinor,
  recurringItemId: null,
});

const today = d('2026-11-20');
const settings = { idleMonths: 3, similarMin: 2 };

describe('merchantWord', () => {
  it('takes the first name word and skips how it was paid', () => {
    expect(merchantWord('UBER ONE')).toBe('UBER');
    expect(merchantWord('POS DEBIT NETFLIX COM')).toBe('NETFLIX');
    expect(merchantWord('THE HOME DEPOT')).toBe('HOME');
    expect(merchantWord('TO SAVINGS ••1234')).toBe('TO');
    expect(merchantWord('••1234')).toBe('');
    expect(merchantWord('')).toBe('');
  });
});

describe('costPerYear', () => {
  it('multiplies by the charges in a year', () => {
    expect(costPerYear(-999n, 'monthly')).toBe(11_988n);
    expect(costPerYear(-500n, 'weekly')).toBe(26_000n);
    expect(costPerYear(-13_900n, 'yearly')).toBe(13_900n);
  });
});

describe('unusedSubscriptions: idle', () => {
  it('flags a subscription whose merchant saw other spending before but none lately', () => {
    const res = unusedSubscriptions({
      items: [item()],
      txns: [
        txn('r1', '2026-05-02', -2350n),
        txn('r2', '2026-07-10', -1800n),
        // The membership's own charges (by amount) are not "other spending".
        txn('c1', '2026-10-15', -999n, 'UBER ONE'),
        txn('c2', '2026-11-15', -999n, 'UBER ONE'),
      ],
      today,
      settings,
    });
    expect(res).toEqual([
      { kind: 'idle', itemId: 'sub-uber', lastOtherSpending: d('2026-07-10'), costPerYearMinor: 11_988n },
    ]);
  });

  it('stays quiet while the merchant is still used', () => {
    const res = unusedSubscriptions({
      items: [item()],
      txns: [txn('r1', '2026-05-02', -2350n), txn('r2', '2026-09-01', -1800n)],
      today,
      settings,
    });
    expect(res).toEqual([]);
  });

  it('has no hint when there was never other spending there (a streaming service)', () => {
    const res = unusedSubscriptions({
      items: [item({ id: 'sub-nf', name: 'Netflix', payeeKey: 'NETFLIX COM', amountMinor: -1549n })],
      txns: [txn('c1', '2026-10-03', -1549n, 'NETFLIX COM')],
      today,
      settings,
    });
    expect(res).toEqual([]);
  });

  it('ignores charges the recurring item created, refunds and other merchants', () => {
    const res = unusedSubscriptions({
      items: [item()],
      txns: [
        txn('r1', '2026-05-02', -2350n),
        { ...txn('c1', '2026-10-15', -1200n, 'UBER ONE'), recurringItemId: 'sub-uber' },
        txn('refund', '2026-10-20', 1800n),
        txn('lyft', '2026-11-01', -2100n, 'LYFT RIDE'),
      ],
      today,
      settings,
    });
    expect(res.map((f) => f.kind)).toEqual(['idle']);
  });

  it('waits until the subscription has been charging for the whole window', () => {
    const res = unusedSubscriptions({
      items: [item({ startDate: d('2026-09-01') })],
      txns: [txn('r1', '2026-05-02', -2350n)],
      today,
      settings,
    });
    expect(res).toEqual([]);
  });

  it('follows the months setting, and 0 turns it off', () => {
    const txns = [txn('r1', '2026-09-10', -2350n)];
    expect(unusedSubscriptions({ items: [item()], txns, today, settings })).toEqual([]);
    expect(
      unusedSubscriptions({ items: [item()], txns, today, settings: { idleMonths: 2, similarMin: 0 } }),
    ).toHaveLength(1);
    expect(
      unusedSubscriptions({ items: [item()], txns, today, settings: { idleMonths: 0, similarMin: 0 } }),
    ).toEqual([]);
  });
});

describe('unusedSubscriptions: similar', () => {
  const streaming = [
    item({ id: 'sub-nf', name: 'Netflix', payeeKey: 'NETFLIX COM', mcc: '4899', amountMinor: -1549n }),
    item({ id: 'sub-hulu', name: 'Hulu', payeeKey: 'HULU', mcc: '4899', amountMinor: -799n }),
    item({ id: 'sub-spot', name: 'Spotify', payeeKey: 'SPOTIFY', mcc: '5815', amountMinor: -1199n }),
    // An unknown merchant has no merchant code: never grouped.
    item({ id: 'sub-x', name: 'Local paper', payeeKey: 'DAILY NEWS', mcc: null, amountMinor: -500n }),
  ];

  it('groups subscriptions in one category with the same merchant code', () => {
    const res = unusedSubscriptions({ items: streaming, txns: [], today, settings });
    expect(res).toEqual([
      {
        kind: 'similar',
        itemIds: ['sub-hulu', 'sub-nf'],
        categoryId: 'cat-subs',
        mcc: '4899',
        costPerYearMinor: (1549n + 799n) * 12n,
      },
    ]);
  });

  it('keeps categories apart and follows the minimum, with 0 for off', () => {
    const split = streaming.map((s) => (s.id === 'sub-hulu' ? { ...s, categoryId: 'cat-tv' } : s));
    expect(unusedSubscriptions({ items: split, txns: [], today, settings })).toEqual([]);
    expect(
      unusedSubscriptions({ items: streaming, txns: [], today, settings: { idleMonths: 3, similarMin: 3 } }),
    ).toEqual([]);
    expect(
      unusedSubscriptions({ items: streaming, txns: [], today, settings: { idleMonths: 3, similarMin: 0 } }),
    ).toEqual([]);
  });

  it('leaves income alone', () => {
    const income = streaming.map((s) => ({ ...s, amountMinor: -s.amountMinor }));
    expect(unusedSubscriptions({ items: income, txns: [], today, settings })).toEqual([]);
  });
});
