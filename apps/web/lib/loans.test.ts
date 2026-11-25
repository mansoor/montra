import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import { initialLoanTerms, readLoanTerms } from '@/components/accounts/loan-tracking';
import { defaultInterestMethod, expectedSplit, ordinalCategory, suggestedLateFee } from './loans';

// $15,000 at 7.56%, $301 a month, financed 28 Sep with the first payment due 27 Oct (ADR-0024 §13).
const daily = {
  interestMethod: 'daily' as const,
  ratePpm: 75600,
  payment: '30100',
  scheduledBalance: '1500000',
};
const next = {
  date: calendarDate('2025-10-27'),
  interest: '9010',
  principal: '21090',
  accruesFrom: calendarDate('2025-09-28'),
  lateFee: '1505',
};

describe('loan helpers', () => {
  it('starts a loan on daily interest and a mortgage on monthly', () => {
    expect(defaultInterestMethod('loan')).toBe('daily');
    expect(defaultInterestMethod('mortgage')).toBe('monthly');
    expect(defaultInterestMethod('line_of_credit')).toBe('monthly');
  });

  it('works out a daily loan’s split to the day it’s paid', () => {
    expect(expectedSplit(daily, next, '2025-10-27')).toEqual({ interest: 9010n, principal: 21090n });
    expect(expectedSplit(daily, next, '2025-10-28')).toEqual({ interest: 9321n, principal: 20779n });
  });

  it('clears what’s owed on the last payment', () => {
    const last = { ...next, principal: '20000' };
    expect(expectedSplit({ ...daily, scheduledBalance: '20000' }, last, '2025-10-28')).toEqual({
      interest: dailyOn(20000n, 30),
      principal: 20000n,
    });
  });

  it('keeps a monthly loan’s figures whatever the date', () => {
    const monthly = { ...daily, interestMethod: 'monthly' as const };
    expect(expectedSplit(monthly, { ...next, accruesFrom: null }, '2025-11-30')).toEqual({
      interest: 9010n,
      principal: 21090n,
    });
  });

  it('reads a rate to four decimals and sends it in ppm (migration 0096)', () => {
    const t = (key: string) => key;
    const terms = (rate: string) =>
      readLoanTerms(
        { ...initialLoanTerms('mortgage', '2026-11-24'), principal: '941000', rate },
        'USD',
        'en-US',
        t,
      );
    expect(terms('5.625')).toMatchObject({ ok: true, value: { ratePpm: 56_250, termMonths: 360 } });
    expect(terms('6.4375')).toMatchObject({ ok: true, value: { ratePpm: 64_375 } });
    expect(terms('7.56')).toMatchObject({ ok: true, value: { ratePpm: 75_600 } });
    expect(terms('5.12345')).toEqual({ ok: false, fields: { rate: 'account.loan.rate_invalid' } });
    expect(terms('50.5')).toEqual({ ok: false, fields: { rate: 'account.loan.rate_invalid' } });
  });

  it('suggests the late fee only past the grace period', () => {
    expect(suggestedLateFee({ graceDays: 10 }, next, '2025-11-06')).toBe(0n);
    expect(suggestedLateFee({ graceDays: 10 }, next, '2025-11-07')).toBe(1505n);
    expect(suggestedLateFee({ graceDays: 10 }, next, '')).toBe(0n);
  });

  it('names the day of the month the English way', () => {
    expect([1, 2, 3, 4, 11, 12, 21, 22, 23, 27].map((d) => ordinalCategory(d, 'en'))).toEqual([
      'one',
      'two',
      'few',
      'other',
      'other',
      'other',
      'one',
      'two',
      'few',
      'other',
    ]);
  });
});

/** Daily interest at 7.56% on a balance for some days, half up: (b × 756 × days) ÷ 3,650,000, as in basis points. */
function dailyOn(balance: bigint, days: number): bigint {
  const n = balance * 756n * BigInt(days);
  const q = n / 3_650_000n;
  return (n % 3_650_000n) * 2n >= 3_650_000n ? q + 1n : q;
}
