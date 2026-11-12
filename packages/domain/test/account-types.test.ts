import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS,
  ACCOUNT_PROFILES,
  accountProfile,
  balanceHistoryDates,
  balanceRangeStart,
  balancesOn,
  bpsToPercent,
  calendarDate,
  canSpendFrom,
  kindsWhere,
  receiptAccountId,
  percentToBps,
} from '../src/index.js';

const d = calendarDate;

describe('account types (ADR-0023)', () => {
  it('has a definition for every kind', () => {
    for (const kind of ACCOUNT_KINDS) expect(accountProfile(kind)).toBe(ACCOUNT_PROFILES[kind]);
  });

  // These are the lists the code used to keep in several places. Moving them must not change what any type does.
  it('keeps what each type already did', () => {
    expect(kindsWhere((t) => t.side === 'liability').sort()).toEqual([
      'credit_card',
      'liability',
      'line_of_credit',
      'loan',
      'mortgage',
    ]);
    expect(kindsWhere((t) => t.forecast === 'cash').sort()).toEqual(['cash', 'checking', 'savings']);
    expect(kindsWhere((t) => t.forecast === 'card')).toEqual(['credit_card', 'line_of_credit']);
    expect(kindsWhere((t) => t.moneyFlow === 'savings').sort()).toEqual(['investment', 'savings']);
    expect(kindsWhere((t) => t.moneyFlow === 'debt').sort()).toEqual(['line_of_credit', 'loan', 'mortgage']);
    expect(kindsWhere((t) => t.schedule).sort()).toEqual(['line_of_credit', 'loan', 'mortgage']);
    expect(kindsWhere((t) => t.installment).sort()).toEqual(['loan', 'mortgage']);
    expect(kindsWhere((t) => t.statement).sort()).toEqual(['credit_card', 'line_of_credit']);
    expect(kindsWhere((t) => !t.imports).sort()).toEqual(['asset', 'cash', 'liability']);
  });

  it('only asks about a low balance where a forecast can warn about one', () => {
    for (const kind of ACCOUNT_KINDS) {
      const t = ACCOUNT_PROFILES[kind];
      expect(t.details.includes('lowBalance')).toBe(t.forecast === 'cash');
    }
  });

  it('calls money owed what it is', () => {
    for (const kind of ACCOUNT_KINDS) {
      const t = ACCOUNT_PROFILES[kind];
      expect(t.balanceWord === 'owed').toBe(t.side === 'liability');
    }
  });
});

describe('canSpendFrom', () => {
  it('offers what purchases are paid from, and not retirement plans, investments, property or loans', () => {
    expect(kindsWhere((t) => t.spending)).toEqual([
      'checking',
      'savings',
      'cash',
      'credit_card',
      'line_of_credit',
      'liability',
    ]);
    expect(canSpendFrom({ kind: 'investment' })).toBe(false);
    expect(canSpendFrom({ kind: 'loan' })).toBe(false);
    expect(canSpendFrom({ kind: 'credit_card' })).toBe(true);
  });

  it('never offers an archived account', () => {
    expect(canSpendFrom({ kind: 'checking', archived: true })).toBe(false);
    expect(canSpendFrom({ kind: 'checking', archived: false })).toBe(true);
  });
});

describe('receiptAccountId', () => {
  const accounts = [
    { id: 'chk', last4: '1111' },
    { id: 'visa', last4: '4242' },
    { id: 'amex', last4: null },
  ];
  it('picks the card whose last four digits the receipt shows', () => {
    expect(receiptAccountId(accounts, '4242', ['chk'])).toBe('visa');
  });
  it('otherwise the most recently used, then the first', () => {
    expect(receiptAccountId(accounts, '9999', [null, 'gone', 'amex', 'chk'])).toBe('amex');
    expect(receiptAccountId(accounts, null)).toBe('chk');
    expect(receiptAccountId([], '4242')).toBeNull();
  });
});

describe('percentToBps', () => {
  it('keeps every digit, where floating point would lose one', () => {
    expect(percentToBps('19.99')).toBe(1999);
    expect(percentToBps('4.35')).toBe(435);
    expect(percentToBps('1.1')).toBe(110);
    expect(percentToBps('7')).toBe(700);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('100')).toBe(10_000);
    expect(percentToBps(' 6,5 ')).toBe(650);
  });

  it('refuses what isn’t a percentage', () => {
    for (const bad of ['', 'abc', '-1', '100.01', '101', '1.234', '1e2', '.5']) {
      expect(percentToBps(bad)).toBeNull();
    }
  });

  it('round-trips every rate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (bps) => {
        expect(percentToBps(bpsToPercent(bps))).toBe(bps);
      }),
    );
  });
});

describe('balance history', () => {
  it('starts a range no earlier than the account’s history', () => {
    const today = d('2026-11-06');
    expect(balanceRangeStart('3m', today, d('2020-01-01'))).toBe(d('2026-08-07'));
    expect(balanceRangeStart('1y', today, d('2026-10-01'))).toBe(d('2026-10-01'));
    expect(balanceRangeStart('all', today, d('2020-01-01'))).toBe(d('2020-01-01'));
  });

  it('plots every day for a short span', () => {
    expect(balanceHistoryDates(d('2026-10-30'), d('2026-11-02'))).toEqual([
      d('2026-10-30'),
      d('2026-10-31'),
      d('2026-11-01'),
      d('2026-11-02'),
    ]);
    expect(balanceHistoryDates(d('2026-11-02'), d('2026-11-02'))).toEqual([d('2026-11-02')]);
    expect(balanceHistoryDates(d('2026-11-03'), d('2026-11-02'))).toEqual([]);
  });

  it('stays a few hundred points however long the span, in order, with both ends', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 15_000 }), (span) => {
        const to = d('2026-11-06');
        const from = d(new Date(Date.UTC(2026, 10, 6 - span)).toISOString().slice(0, 10));
        const dates = balanceHistoryDates(from, to);
        expect(dates[0]).toBe(from);
        expect(dates[dates.length - 1]).toBe(to);
        expect(new Set(dates).size).toBe(dates.length);
        expect([...dates].sort()).toEqual(dates);
        expect(dates.length).toBeLessThanOrEqual(520);
      }),
    );
  });

  it('adds up the changes through each date', () => {
    const changes = [
      { date: d('2026-10-01'), delta: 100n },
      { date: d('2026-10-01'), delta: 50n },
      { date: d('2026-10-05'), delta: -30n },
    ];
    expect(
      balancesOn('asset', changes, [d('2026-09-30'), d('2026-10-01'), d('2026-10-04'), d('2026-10-05')]),
    ).toEqual([
      { date: d('2026-09-30'), balance: 0n },
      { date: d('2026-10-01'), balance: 150n },
      { date: d('2026-10-04'), balance: 150n },
      { date: d('2026-10-05'), balance: 120n },
    ]);
  });

  it('shows money owed as a positive amount', () => {
    expect(balancesOn('liability', [{ date: d('2026-10-01'), delta: -500n }], [d('2026-10-01')])).toEqual([
      { date: d('2026-10-01'), balance: 500n },
    ]);
  });
});
