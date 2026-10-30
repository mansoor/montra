import { addMonths } from '@montra/domain';
import { describe, expect, it } from 'vitest';
import { detectAnomalies, detectRecurring, parseQuickAddHeuristic, type HistoryTxn } from '../src/index.js';
import { d } from './fixtures.js';

describe('detectAnomalies', () => {
  const h = (id: string, date: string, amountMinor: bigint, accountId = 'acct-1'): HistoryTxn => ({
    id,
    date: d(date),
    amountMinor,
    accountId,
  });
  const usual = [
    h('p1', '2026-06-03', -4500n),
    h('p2', '2026-07-03', -5200n),
    h('p3', '2026-08-03', -4800n),
    h('p4', '2026-09-03', -5000n),
  ];
  const t = (id: string, date: string, amountMinor: bigint, payeeKey = 'CAFE') => ({
    ...h(id, date, amountMinor),
    payeeKey,
    payee: 'Cafe Roma',
    currency: 'USD',
  });

  it('flags an unusual amount with computed numbers', () => {
    const [a] = detectAnomalies({
      txns: [t('n1', '2026-10-03', -16000n)],
      history: () => usual,
      recurring: [],
      today: d('2026-10-04'),
    });
    expect(a).toEqual({
      kind: 'unusual_amount',
      transactionId: 'n1',
      payeeKey: 'CAFE',
      dedupeKey: 'unusual_amount:n1',
      message: '$160.00 is 3.3× your usual $49.00 at Cafe Roma',
      data: { amount: '16000', usual: '4900', ratio: 3.3, priorCount: 4 },
    });
  });

  it('needs 4 earlier transactions and a real jump', () => {
    const run = (amount: bigint, history: HistoryTxn[]) =>
      detectAnomalies({
        txns: [t('n1', '2026-10-03', amount)],
        history: () => history,
        recurring: [],
        today: d('2026-10-04'),
      });
    expect(run(-16000n, usual.slice(0, 3))).toEqual([]);
    expect(run(-9000n, usual)).toEqual([]);
  });

  it('flags the later of two identical charges within 2 days', () => {
    const out = detectAnomalies({
      txns: [t('a', '2026-10-01', -2999n), t('b', '2026-10-02', -2999n), t('c', '2026-10-09', -2999n)],
      history: () => [],
      recurring: [],
      today: d('2026-10-10'),
    });
    expect(out.map((x) => [x.kind, x.transactionId])).toEqual([['duplicate_charge', 'b']]);
    expect(out[0]!.message).toBe('Possible duplicate: $29.99 at Cafe Roma was also charged on 2026-10-01');
  });

  it('finds duplicates against history, not across accounts or payees', () => {
    const out = detectAnomalies({
      txns: [t('b', '2026-10-02', -2999n), { ...t('x', '2026-10-02', -2999n, 'OTHER') }],
      history: (k) =>
        k === 'CAFE' ? [h('a', '2026-10-01', -2999n, 'acct-2'), h('a2', '2026-10-01', -2999n)] : [],
      recurring: [],
      today: d('2026-10-10'),
    });
    expect(out.map((x) => x.transactionId)).toEqual(['b']);
    expect(out[0]!.data.otherTransactionId).toBe('a2');
  });

  it('reports new subscriptions and price increases from recurring proposals', () => {
    const dates = [0, 1, 2, 3].map((i) => addMonths(d('2026-07-05'), i));
    const amounts = [-1599n, -1599n, -1599n, -1799n];
    const txns = dates.map((date, i) => ({ ...t(`s${i}`, date, amounts[i]!, 'NETFLIX'), payee: 'Netflix' }));
    const recurring = detectRecurring(
      [{ payeeKey: 'NETFLIX', payee: 'Netflix', accountId: 'acct-1', entityId: 'e', categoryId: null, txns }],
      d('2026-10-06'),
    );
    const out = detectAnomalies({ txns: [txns[3]!], history: () => txns, recurring, today: d('2026-10-06') });
    expect(out.map((x) => x.message)).toEqual(['Netflix went up 12.5% from $15.99 to $17.99']);

    const fresh = detectRecurring(
      [
        {
          payeeKey: 'NETFLIX',
          payee: 'Netflix',
          accountId: 'acct-1',
          entityId: 'e',
          categoryId: null,
          txns: txns.slice(0, 3),
        },
      ],
      d('2026-09-10'),
    );
    expect(fresh[0]!.isNew).toBe(false);
    const recent = [0, 7, 14].map((n, i) => ({
      ...t(`w${i}`, `2026-10-0${1 + (n % 9)}`, -999n, 'GYM'),
      payee: 'Gym',
    }));
    recent[1]!.date = d('2026-10-08');
    recent[2]!.date = d('2026-10-15');
    const gym = detectRecurring(
      [{ payeeKey: 'GYM', payee: 'Gym', accountId: 'acct-1', entityId: 'e', categoryId: null, txns: recent }],
      d('2026-10-16'),
    );
    const flags = detectAnomalies({
      txns: [recent[2]!],
      history: () => recent,
      recurring: gym,
      today: d('2026-10-16'),
    });
    expect(flags).toEqual([
      expect.objectContaining({
        kind: 'new_subscription',
        transactionId: 'w2',
        dedupeKey: 'new_subscription:w2',
        message: 'New recurring charge: Gym, weekly, $9.99',
      }),
    ]);
  });
});

describe('parseQuickAddHeuristic', () => {
  const ctx = {
    today: d('2026-10-14'), // Wednesday
    accounts: [
      { id: 'acct-amex', label: 'Amex Gold' },
      { id: 'acct-chk', label: 'Checking' },
      { id: 'acct-visa1', label: 'Visa Sapphire' },
      { id: 'acct-visa2', label: 'Visa Freedom' },
    ],
    categories: [
      { id: 'cat-groc', name: 'Groceries' },
      { id: 'cat-dining', name: 'Dining out' },
      { id: 'cat-fuel', name: 'Fuel' },
    ],
    members: [{ id: 'mem-sam', name: 'Sam Lee' }],
  };

  it('parses the canonical example', () => {
    expect(parseQuickAddHeuristic('lunch 18.50 amex client meeting', ctx)).toEqual({
      date: '2026-10-14',
      amount: '18.50',
      direction: 'out',
      payee: 'lunch',
      accountId: 'acct-amex',
      categoryId: null,
      memberId: null,
      memo: 'client meeting',
      tags: [],
      confidence: 0.8,
      spans: [
        { field: 'amount', text: '18.50' },
        { field: 'account', text: 'amex' },
        { field: 'payee', text: 'lunch' },
        { field: 'memo', text: 'client meeting' },
      ],
    });
  });

  it('reads dates, categories, members and tags', () => {
    const r = parseQuickAddHeuristic(
      'Whole Foods $82.10 groceries for Sam yesterday #weekly on checking',
      ctx,
    );
    expect(r).toMatchObject({
      date: '2026-10-13',
      amount: '82.10',
      payee: 'Whole Foods',
      accountId: 'acct-chk',
      categoryId: 'cat-groc',
      memberId: 'mem-sam',
      memo: null,
      tags: ['weekly'],
      confidence: 0.9,
    });
  });

  it('understands weekday names, M/D, ISO and month names', () => {
    const date = (text: string) => parseQuickAddHeuristic(`coffee 4.50 ${text}`, ctx).date;
    expect(date('monday')).toBe('2026-10-12');
    expect(date('wed')).toBe('2026-10-14');
    expect(date('thu')).toBe('2026-10-08');
    expect(date('3/14')).toBe('2026-03-14');
    expect(date('12/24')).toBe('2025-12-24');
    expect(date('2026-01-02')).toBe('2026-01-02');
    expect(date('14 mar')).toBe('2026-03-14');
    expect(date('sept 3')).toBe('2026-09-03');
    expect(parseQuickAddHeuristic('coffee 3/14', ctx).amount).toBeNull();
  });

  it('detects money in', () => {
    expect(parseQuickAddHeuristic('+50 from Alex', ctx).direction).toBe('in');
    expect(parseQuickAddHeuristic('refund amazon 23.99', ctx)).toMatchObject({
      direction: 'in',
      payee: 'refund amazon',
    });
  });

  it('handles grouping, multi-word names and ambiguity', () => {
    const r = parseQuickAddHeuristic('rent 1,250.00 visa dining out', ctx);
    expect(r).toMatchObject({
      amount: '1250.00',
      accountId: null,
      categoryId: 'cat-dining',
      payee: 'rent',
      memo: 'visa',
    });
    expect(parseQuickAddHeuristic('visa sapphire 20 fuel', ctx)).toMatchObject({
      accountId: 'acct-visa1',
      categoryId: 'cat-fuel',
    });
  });

  it('puts the first word after the amount as payee when nothing comes before', () => {
    expect(parseQuickAddHeuristic('12 starbucks latte', ctx)).toMatchObject({
      payee: 'starbucks',
      memo: 'latte',
    });
  });

  it('has zero confidence without an amount', () => {
    expect(parseQuickAddHeuristic('lunch with team', ctx)).toMatchObject({ amount: null, confidence: 0 });
  });
});
