import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addDays, calendarDate, type CalendarDate, type CurrencyCode, type Decimal } from '@montra/domain';
import {
  matchReceipts,
  merchantSimilarity,
  normalizeDescription,
  RECEIPT_AUTO_LINK_SCORE,
  scoreReceiptMatch,
  type RateLookup,
  type ReceiptForMatch,
  type TransactionForMatch,
} from '../src/index.js';

const d = (s: string) => calendarDate(s);
const USD = 'USD' as CurrencyCode;
const EUR = 'EUR' as CurrencyCode;
const JPY = 'JPY' as CurrencyCode;

const receipt = (over: Partial<ReceiptForMatch> & { merchant?: string }): ReceiptForMatch => {
  const { merchant = 'Walmart', ...rest } = over;
  return {
    id: 'r1',
    date: d('2026-10-05'),
    total: 2871n,
    currency: USD,
    merchantKey: normalizeDescription(merchant),
    ...rest,
  };
};
const txn = (over: Partial<TransactionForMatch> & { payee?: string }): TransactionForMatch => {
  const { payee = 'WAL-MART #1234 SUPERCENTER BENTONVILLE AR', ...rest } = over;
  return {
    transactionId: 't1',
    date: d('2026-10-06'),
    amount: -2871n,
    currency: USD,
    payeeKey: normalizeDescription(payee),
    ...rest,
  };
};

const rates: Record<string, Decimal> = {
  'EUR>USD': { coefficient: 10912n, scale: 4 }, // 1 EUR = 1.0912 USD
  'JPY>USD': { coefficient: 65n, scale: 4 }, // 1 JPY = 0.0065 USD
};
const rateOf: RateLookup = (from, to) => rates[`${from}>${to}`] ?? null;
const noRates: RateLookup = () => null;

describe('receipt matching (IMP-11)', () => {
  it('links the Walmart receipt to its card line a day later', () => {
    const [result] = matchReceipts(
      [receipt({ merchantId: 'walmart' })],
      [
        txn({ merchantId: 'walmart' }),
        txn({ transactionId: 'other-amount', amount: -2899n }),
        txn({ transactionId: 'too-late', date: d('2026-10-11') }),
      ],
      noRates,
    );
    expect(result!.link).toMatchObject({
      transactionId: 't1',
      score: 0.97, // 0.45 × 1 + 0.20 × 0.85 + 0.35 × 1
      factors: { amount: { kind: 'exact', gap: 0n }, days: 1, merchant: 1 },
      fx: null,
    });
    expect(result!.candidates.map((c) => c.transactionId)).toEqual(['t1']);
  });

  it('still links on a fuzzy statement descriptor without a reference merchant', () => {
    const c = scoreReceiptMatch(receipt({}), txn({}), noRates)!;
    expect(c.factors.merchant).toBeCloseTo(0.5455, 4); // WALMART vs WAL MART
    expect(c.score).toBeGreaterThanOrEqual(RECEIPT_AUTO_LINK_SCORE);
  });

  it('accepts ±2 minor units, and a later tip of up to 30% only for restaurants', () => {
    expect(scoreReceiptMatch(receipt({}), txn({ amount: -2873n }), noRates)?.factors.amount).toEqual({
      kind: 'exact',
      gap: 2n,
    });
    expect(scoreReceiptMatch(receipt({}), txn({ amount: -2874n }), noRates)).toBeNull();

    const bistro = receipt({ merchant: 'Le Petit Bistro', total: 4000n, tipAllowed: true });
    const line = txn({ payee: 'LE PETIT BISTRO PARIS', amount: -4800n });
    const tipped = scoreReceiptMatch(bistro, line, noRates)!;
    expect(tipped.factors).toEqual({
      amount: { kind: 'tip', gap: 800n, bps: 2000n },
      days: 1,
      merchant: 0.9,
    });
    expect(tipped.score).toBeCloseTo(0.36 + 0.17 + 0.315, 4);
    expect(scoreReceiptMatch({ ...bistro, tipAllowed: false }, line, noRates)).toBeNull();
    expect(scoreReceiptMatch(bistro, { ...line, amount: -5201n }, noRates)).toBeNull(); // 30.03%
    expect(scoreReceiptMatch(bistro, { ...line, amount: -3900n }, noRates)).toBeNull(); // less than the receipt
  });

  it('keeps to the ±5 day window and scores nearer dates higher', () => {
    expect(scoreReceiptMatch(receipt({}), txn({ date: d('2026-10-11') }), noRates)).toBeNull();
    expect(scoreReceiptMatch(receipt({}), txn({ date: d('2026-09-29') }), noRates)).toBeNull();
    const five = scoreReceiptMatch(receipt({}), txn({ date: d('2026-10-10') }), noRates)!;
    const same = scoreReceiptMatch(receipt({}), txn({ date: d('2026-10-05') }), noRates)!;
    expect(five.factors.days).toBe(5);
    expect(scoreReceiptMatch(receipt({}), txn({ date: d('2026-10-03') }), noRates)!.factors.days).toBe(-2);
    expect(same.score - five.score).toBeCloseTo(0.2 * 0.75, 4);
  });

  it('pairs purchases with money out and refunds with money in', () => {
    const refund = receipt({ total: -1000n });
    expect(scoreReceiptMatch(refund, txn({ amount: 1000n }), noRates)).not.toBeNull();
    expect(scoreReceiptMatch(refund, txn({ amount: -1000n }), noRates)).toBeNull();
    expect(scoreReceiptMatch(receipt({ total: 1000n }), txn({ amount: 1000n }), noRates)).toBeNull();
  });

  it('rejects a different card, but not an unknown one', () => {
    expect(
      scoreReceiptMatch(receipt({ cardLast4: '1234' }), txn({ accountLast4: '9999' }), noRates),
    ).toBeNull();
    expect(
      scoreReceiptMatch(receipt({ cardLast4: '1234' }), txn({ accountLast4: '1234' }), noRates),
    ).not.toBeNull();
    expect(scoreReceiptMatch(receipt({ cardLast4: '1234' }), txn({}), noRates)).not.toBeNull();
  });

  it('offers but does not link a receipt whose merchant could not be read', () => {
    const [result] = matchReceipts([receipt({ merchant: '' })], [txn({ date: d('2026-10-05') })], noRates);
    expect(result!.link).toBeNull();
    expect(result!.candidates).toHaveLength(1);
    expect(result!.candidates[0]!.score).toBeCloseTo(0.65, 4);
  });

  it('leaves receipts without a date or total in the inbox', () => {
    expect(scoreReceiptMatch(receipt({ date: null }), txn({}), noRates)).toBeNull();
    expect(scoreReceiptMatch(receipt({ total: 0n }), txn({}), noRates)).toBeNull();
  });
});

describe('foreign receipts (CUR-04, Phase 5 exit criterion 2)', () => {
  const paris = receipt({
    merchant: 'Galeries Lafayette',
    total: 4000n,
    currency: EUR,
    date: d('2026-11-12'),
  });
  const card = txn({ payee: 'GALERIES LAFAYETTE PARIS FR', amount: -4360n, date: d('2026-11-13') });

  it('matches €40.00 to a $43.60 statement line within ±3% and stores the actual rate', () => {
    const [result] = matchReceipts([paris], [card], rateOf);
    expect(result!.link).toMatchObject({
      transactionId: 't1',
      factors: { amount: { kind: 'fx', dayRate: '1.0912', bps: -11n }, days: 1, merchant: 0.9 },
      fx: { rate: '1.0900000000', source: 'implied' },
    });
    expect(result!.link!.score).toBeCloseTo(0.45 * (1 - (11 / 300) * 0.5) + 0.17 + 0.315, 4);
  });

  it('rejects charges more than 3% off the day rate, unless the difference can be a tip', () => {
    expect(scoreReceiptMatch(paris, { ...card, amount: -4500n }, rateOf)).toBeNull(); // +3.09%
    const tipped = scoreReceiptMatch({ ...paris, tipAllowed: true }, { ...card, amount: -4500n }, rateOf)!;
    expect(tipped.factors.amount).toEqual({ kind: 'fx', dayRate: '1.0912', bps: 309n });
    // The charge includes a tip, so the implied rate would be wrong: keep the day's rate.
    expect(tipped.fx).toEqual({ rate: '1.0912', source: 'reference' });
  });

  it('needs a rate for the day', () => {
    expect(scoreReceiptMatch(paris, card, noRates)).toBeNull();
  });

  it('converts across minor-unit exponents (¥10,000 → $65.43)', () => {
    const tokyo = receipt({ merchant: 'Lawson', total: 10_000n, currency: JPY });
    const c = scoreReceiptMatch(tokyo, txn({ payee: 'LAWSON', amount: -6543n }), rateOf)!;
    expect(c.factors.amount).toEqual({ kind: 'fx', dayRate: '0.0065', bps: 66n });
    expect(c.fx).toEqual({ rate: '0.0065430000', source: 'implied' });
  });
});

describe('assignment', () => {
  it('does not guess between two identical transactions', () => {
    const coffee = receipt({ merchant: 'Blue Bottle Coffee', total: 450n });
    const [result] = matchReceipts(
      [coffee],
      [
        txn({ transactionId: 'a', payee: 'SQ *BLUE BOTTLE COFFEE', amount: -450n }),
        txn({ transactionId: 'b', payee: 'SQ *BLUE BOTTLE COFFEE', amount: -450n }),
      ],
      noRates,
    );
    expect(result!.link).toBeNull();
    expect(result!.candidates.map((c) => c.transactionId)).toEqual(['a', 'b']);
  });

  it('assigns one-to-one by score, so each receipt gets its own fill-up', () => {
    const fillUp = (id: string, date: string) =>
      receipt({ id, merchant: 'Shell', total: 1000n, date: d(date) });
    const line = (id: string, date: string) =>
      txn({ transactionId: id, payee: 'SHELL OIL 57444', amount: -1000n, date: d(date) });
    const results = matchReceipts(
      [fillUp('r-late', '2026-11-04'), fillUp('r-early', '2026-11-01')],
      [line('t-early', '2026-11-01'), line('t-late', '2026-11-04')],
      noRates,
    );
    expect(results.map((r) => [r.receiptId, r.link?.transactionId])).toEqual([
      ['r-late', 't-late'],
      ['r-early', 't-early'],
    ]);
    // A transaction linked to another receipt is no longer offered.
    expect(results.map((r) => r.candidates.map((c) => c.transactionId))).toEqual([['t-late'], ['t-early']]);
  });

  it('gives a contested transaction to one receipt and leaves the other in the inbox', () => {
    const [first, second] = matchReceipts(
      [receipt({ id: 'r1' }), receipt({ id: 'r2' })],
      [txn({ merchantId: 'walmart' })],
      noRates,
    );
    expect(first!.link?.transactionId).toBe('t1');
    expect(second!.link).toBeNull();
    expect(second!.candidates).toEqual([]);
  });

  it('never links a transaction twice, and a link is always the best candidate', () => {
    const day = (n: number): CalendarDate => addDays(d('2026-10-01'), n);
    const receiptArb = fc.record({
      total: fc.constantFrom(450n, 1000n, 2871n),
      day: fc.integer({ min: 0, max: 12 }),
      merchant: fc.constantFrom('Shell', 'Walmart', 'Blue Bottle Coffee', ''),
      tipAllowed: fc.boolean(),
    });
    const txnArb = fc.record({
      amount: fc.constantFrom(-450n, -1000n, -1100n, -2871n, 1000n),
      day: fc.integer({ min: 0, max: 12 }),
      payee: fc.constantFrom('SHELL OIL 57444', 'WAL-MART #1234', 'SQ *BLUE BOTTLE COFFEE', 'AMAZON'),
    });
    fc.assert(
      fc.property(fc.array(receiptArb, { maxLength: 8 }), fc.array(txnArb, { maxLength: 8 }), (rs, ts) => {
        const results = matchReceipts(
          rs.map((r, i) =>
            receipt({
              id: `r${i}`,
              total: r.total,
              date: day(r.day),
              merchant: r.merchant,
              tipAllowed: r.tipAllowed,
            }),
          ),
          ts.map((t, i) =>
            txn({ transactionId: `t${i}`, amount: t.amount, date: day(t.day), payee: t.payee }),
          ),
          noRates,
        );
        const linked = results.flatMap((r) => (r.link ? [r.link.transactionId] : []));
        expect(new Set(linked).size).toBe(linked.length);
        for (const r of results) {
          if (r.link) {
            expect(r.candidates[0]).toBe(r.link);
            expect(r.link.score).toBeGreaterThanOrEqual(RECEIPT_AUTO_LINK_SCORE);
          }
          for (const c of r.candidates) expect(c.score).toBeGreaterThan(0);
          for (const c of r.candidates) expect(c.score).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});

describe('merchantSimilarity', () => {
  it('treats a brand that prefixes the statement descriptor as a strong match', () => {
    expect(merchantSimilarity('SHELL', 'SHELL OIL')).toBe(0.9);
    expect(merchantSimilarity('LE PETIT BISTRO PARIS', 'LE PETIT BISTRO')).toBe(0.9);
    expect(merchantSimilarity('SHELLY', 'SHELL OIL')).toBeLessThan(0.9);
    expect(merchantSimilarity('', 'SHELL')).toBe(0);
  });
});
