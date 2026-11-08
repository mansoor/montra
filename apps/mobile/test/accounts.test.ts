import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { AccountDto, NetWorthDto } from '@montra/schemas';
import { createApi } from '../src/api/client';
import {
  accountSections,
  accountsWithProperties,
  assetFigures,
  countedProperties,
  isOverdue,
  loanPayingAccounts,
  loanPaymentDate,
} from '../src/features/accounts';

const account = (over: Partial<AccountDto>): AccountDto =>
  ({
    id: 'a',
    entityId: 'p',
    name: 'Account',
    kind: 'checking',
    type: 'asset',
    currency: 'USD',
    institution: null,
    last4: null,
    balance: { amount: '0', currency: 'USD' },
    archived: false,
    hidden: false,
    loanId: null,
    loanAccountId: null,
    purchasePrice: null,
    purchaseDate: null,
    dueDate: null,
    ...over,
  }) as AccountDto;

describe('accountSections', () => {
  it('shows each type what it needs', () => {
    const on = (a: Partial<AccountDto>) =>
      Object.entries(accountSections(account(a)))
        .filter(([, v]) => v)
        .map(([k]) => k);
    expect(on({ kind: 'checking' })).toEqual([]);
    expect(on({ kind: 'savings' })).toEqual(['interest']);
    expect(on({ kind: 'investment' })).toEqual(['performance']);
    expect(on({ kind: 'credit_card' })).toEqual(['statement']);
    expect(on({ kind: 'line_of_credit' })).toEqual(['statement']);
    expect(on({ kind: 'mortgage', loanId: 'l1' })).toEqual(['loan']);
    expect(on({ kind: 'loan' })).toEqual(['untrackedLoan']);
    expect(on({ kind: 'asset' })).toEqual(['asset']);
    expect(on({ kind: 'liability' })).toEqual(['dueDate']);
  });
});

describe('assetFigures', () => {
  const loan = account({ id: 'm', name: 'Mortgage', balance: { amount: '30000000', currency: 'USD' } });

  it('gives equity against the linked loan and the change since purchase', () => {
    const home = account({
      kind: 'asset',
      balance: { amount: '45000000', currency: 'USD' },
      loanAccountId: 'm',
      purchasePrice: '40000000',
    });
    expect(assetFigures(home, [loan])).toEqual({
      value: 45000000n,
      loan: { name: 'Mortgage', owed: 30000000n },
      equity: 15000000n,
      purchasePrice: 40000000n,
      change: 5000000n,
    });
  });

  it('has no equity without a loan, and no change without a price', () => {
    const car = account({ kind: 'asset', balance: { amount: '900000', currency: 'USD' } });
    expect(assetFigures(car, [loan])).toMatchObject({ loan: null, equity: null, change: null });
  });
});

describe('loanPayingAccounts', () => {
  it('keeps open cash accounts in the loan’s books and currency, the usual one first', () => {
    const out = loanPayingAccounts({ entityId: 'p', currency: 'USD', payingAccountId: 's' }, [
      account({ id: 'c', kind: 'checking' }),
      account({ id: 's', kind: 'savings' }),
      account({ id: 'card', kind: 'credit_card' }),
      account({ id: 'eur', kind: 'checking', currency: 'EUR' }),
      account({ id: 'biz', kind: 'checking', entityId: 'b' }),
      account({ id: 'old', kind: 'checking', archived: true }),
    ]);
    expect(out.map((a) => a.id)).toEqual(['s', 'c']);
  });
});

describe('dates', () => {
  const today = calendarDate('2026-11-07');

  it('dates a payment today unless it’s overdue', () => {
    expect(loanPaymentDate({ date: '2026-11-15' as never }, today)).toBe('2026-11-07');
    expect(loanPaymentDate({ date: '2026-11-01' as never }, today)).toBe('2026-11-01');
  });

  it('is overdue only past its date with something owed', () => {
    expect(isOverdue('2026-11-01', '100', today)).toBe(true);
    expect(isOverdue('2026-11-01', '0', today)).toBe(false);
    expect(isOverdue('2026-11-07', '100', today)).toBe(false);
    expect(isOverdue(null, '100', today)).toBe(false);
  });
});

describe('accountsWithProperties', () => {
  const worth = {
    currency: 'USD',
    properties: [
      { propertyId: 'h1', entityId: 'r', name: 'Duplex', value: '25000000' },
      { propertyId: 'h2', entityId: 'r', name: 'Sold', value: '0' },
    ],
  } as Pick<NetWorthDto, 'currency' | 'properties'>;
  const accounts = [
    account({ id: 'c', balance: { amount: '100000', currency: 'USD' } }),
    account({
      id: 'cc',
      kind: 'credit_card',
      type: 'liability',
      balance: { amount: '20000', currency: 'USD' },
    }),
  ];

  it('counts your share of rental properties in what you have and the net', () => {
    expect(countedProperties(worth).map((p) => p.name)).toEqual(['Duplex']);
    const s = accountsWithProperties(accounts, worth);
    expect(s.assets).toEqual([{ currency: 'USD', amount: 25100000n }]);
    expect(s.liabilities).toEqual([{ currency: 'USD', amount: 20000n }]);
    expect(s.net).toEqual([{ currency: 'USD', amount: 25080000n }]);
  });

  it('is the accounts alone before net worth has loaded', () => {
    expect(countedProperties(null)).toEqual([]);
    expect(accountsWithProperties(accounts, null).net).toEqual([{ currency: 'USD', amount: 80000n }]);
  });
});

describe('account detail calls', () => {
  it('reads each type’s figures and records a loan payment', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const api = createApi({
      baseUrl: 'http://api',
      token: async () => null,
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
        return new Response(JSON.stringify(url.includes('/statement') ? { data: null } : { data: [] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    await api.loans('w', 'p');
    await api.loanSchedule('w', 'l');
    await api.cardStatement('w', 'a');
    await api.accountPerformance('w', 'a');
    await api.interestEarned('w', 'a');
    await api.netWorth('w', 1);
    await api.recordLoanPayment('w', 'l', { number: 3, accountId: 'c', date: calendarDate('2026-11-07') });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://api/v1/workspaces/w', '')}`)).toEqual([
      'GET /loans?entityId=p',
      'GET /loans/l/schedule',
      'GET /accounts/a/statement',
      'GET /accounts/a/performance?range=1y',
      'GET /accounts/a/interest-earned',
      'GET /net-worth?months=1',
      'POST /loans/l/payments',
    ]);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ number: 3, accountId: 'c', date: '2026-11-07' });
  });
});
