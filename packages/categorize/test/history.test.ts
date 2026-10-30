import { describe, expect, it } from 'vitest';
import { amountBand, historySuggestion, transferSuggestion } from '../src/index.js';
import { d, item } from './fixtures.js';

describe('amountBand', () => {
  it('follows sign × (1 + floor(2·log2(max(1, |major|))))', () => {
    expect(amountBand(0n, 2)).toBe(0);
    expect(amountBand(50n, 2)).toBe(1); // $0.50 → max(1, 0.5) = 1
    expect(amountBand(100n, 2)).toBe(1); // $1
    expect(amountBand(141n, 2)).toBe(1); // $1.41 < √2
    expect(amountBand(142n, 2)).toBe(2); // $1.42 > √2
    expect(amountBand(200n, 2)).toBe(3); // $2
    expect(amountBand(-4200n, 2)).toBe(-11); // 2·log2(42) = 10.78
    expect(amountBand(100_000n, 2)).toBe(20); // $1000: 2·log2(1000) = 19.93
    expect(amountBand(102_400n, 2)).toBe(21); // $1024 = 2^10 exactly
    expect(amountBand(1000n, 0)).toBe(20); // ¥1000
    expect(amountBand(10n ** 40n, 2)).toBe(1 + Math.floor(2 * 38 * Math.log2(10)));
  });
});

describe('historySuggestion', () => {
  const h = (amountBand: number, categoryId: string, count: number, memberId: string | null = null) => ({
    amountBand,
    categoryId,
    memberId,
    count,
  });

  it('uses the same band first', () => {
    const s = historySuggestion([h(-11, 'cat-fuel', 6), h(-15, 'cat-repairs', 9)], -11);
    expect(s).toEqual({
      categoryId: 'cat-fuel',
      memberId: null,
      confidence: 0.97,
      explanation: 'Similar to 6 past transactions',
    });
  });

  it('scales confidence by share and count', () => {
    const s = historySuggestion([h(-11, 'cat-fuel', 4), h(-11, 'cat-food', 1)], -11)!;
    expect(s.confidence).toBeCloseTo(0.8 * 0.8);
    expect(historySuggestion([h(-11, 'cat-fuel', 2)], -11)!.confidence).toBeCloseTo(0.4);
  });

  it('needs share ≥ 0.8 and at least 2', () => {
    expect(historySuggestion([h(-11, 'cat-fuel', 3), h(-11, 'cat-food', 2)], -11)).toBeNull();
    expect(historySuggestion([h(-11, 'cat-fuel', 1)], -11)).toBeNull();
    expect(historySuggestion([], -11)).toBeNull();
  });

  it('falls back to all bands at 90%', () => {
    const s = historySuggestion([h(-10, 'cat-fuel', 3), h(-12, 'cat-fuel', 3)], -11)!;
    expect(s.categoryId).toBe('cat-fuel');
    expect(s.confidence).toBeCloseTo(0.97 * 0.9);
  });

  it('predicts the member when one dominates the category', () => {
    expect(historySuggestion([h(1, 'c', 5, 'mem-son'), h(1, 'c', 1, null)], 1)!.memberId).toBe('mem-son');
    expect(historySuggestion([h(1, 'c', 3, 'mem-son'), h(1, 'c', 2, 'mem-me')], 1)!.memberId).toBeNull();
  });
});

describe('transferSuggestion', () => {
  const cand = (over = {}) => ({
    transactionId: 't-amex',
    accountId: 'acct-amex',
    accountName: 'Amex',
    accountLast4: '1005',
    amountMinor: 50_000n,
    date: d('2026-10-15'),
    ...over,
  });
  const pay = item({
    payee: null,
    payeeKey: null,
    description: 'AMEX EPAYMENT ACH PMT',
    amountMinor: -50_000n,
  });

  it('is confident with a payment keyword', () => {
    expect(transferSuggestion(pay, [cand()])).toEqual({
      candidate: cand(),
      confidence: 0.95,
      explanation: 'Looks like the payment to Amex ••1005',
    });
  });

  it('counts the last 4 digits as a signal', () => {
    const it2 = item({ payee: null, payeeKey: null, description: 'WEB 1005', amountMinor: -50_000n });
    expect(transferSuggestion(it2, [cand()])!.confidence).toBe(0.95);
  });

  it('caps amount-only pairs at 0.60', () => {
    const it2 = item({ payee: 'Somebody', description: 'Somebody', amountMinor: -50_000n });
    const s = transferSuggestion(it2, [cand({ accountName: 'Savings', accountLast4: null })])!;
    expect(s.confidence).toBe(0.6);
    expect(s.explanation).toBe('Looks like a transfer to Savings');
  });

  it('describes money in as "from"', () => {
    const inflow = item({ payee: null, description: 'Online transfer from savings', amountMinor: 50_000n });
    const s = transferSuggestion(inflow, [
      cand({ accountName: 'Savings', accountLast4: null, amountMinor: -50_000n }),
    ])!;
    expect(s.explanation).toBe('Looks like a transfer from Savings');
  });

  it('requires opposite sign, equal amount, another account and ±3 days', () => {
    expect(transferSuggestion(pay, [cand({ amountMinor: -50_000n })])).toBeNull();
    expect(transferSuggestion(pay, [cand({ amountMinor: 50_001n })])).toBeNull();
    expect(transferSuggestion(pay, [cand({ accountId: pay.accountId })])).toBeNull();
    expect(transferSuggestion(pay, [cand({ date: d('2026-10-18') })])).toBeNull();
    expect(transferSuggestion(pay, [cand({ date: d('2026-10-17') })])).not.toBeNull();
  });

  it('prefers the closest date and caps ties', () => {
    const near = cand({ transactionId: 'near', date: d('2026-10-14') });
    const far = cand({ transactionId: 'far', date: d('2026-10-16') });
    expect(transferSuggestion(pay, [far, near])!.candidate.transactionId).toBe('near');
    const twin = cand({ transactionId: 'twin', accountId: 'acct-visa', date: d('2026-10-14') });
    expect(transferSuggestion(pay, [near, twin])!.confidence).toBe(0.6);
  });
});
