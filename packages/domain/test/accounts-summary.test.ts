import { describe, expect, it } from 'vitest';
import { summarizeAccounts, type SummarizableAccount } from '../src/accounts-summary.js';

const account = (
  name: string,
  kind: string,
  amount: string,
  over: Partial<SummarizableAccount> = {},
): SummarizableAccount => ({
  name,
  kind,
  type: ['credit_card', 'loan', 'mortgage', 'line_of_credit', 'liability'].includes(kind)
    ? 'liability'
    : 'asset',
  currency: 'USD',
  archived: false,
  hidden: false,
  balance: { amount },
  ...over,
});

describe('summarizeAccounts', () => {
  const summary = summarizeAccounts([
    account('Visa', 'credit_card', '30000'),
    account('Rainy day', 'savings', '500000'),
    account('Joint', 'checking', '250000'),
    account('Everyday', 'checking', '100000'),
    account('Car', 'loan', '1000000'),
  ]);

  it('groups by kind, what you have first, and sorts each group by name', () => {
    expect(summary.groups.map((g) => g.kind)).toEqual(['checking', 'savings', 'credit_card', 'loan']);
    expect(summary.groups[0]!.accounts.map((a) => a.name)).toEqual(['Everyday', 'Joint']);
  });

  it('totals each group', () => {
    expect(summary.groups[0]!.totals).toEqual([{ currency: 'USD', amount: 350000n }]);
    expect(summary.groups[2]!).toMatchObject({
      type: 'liability',
      totals: [{ currency: 'USD', amount: 30000n }],
    });
  });

  it('takes what you owe away from what you have, not adds it', () => {
    expect(summary.assets).toEqual([{ currency: 'USD', amount: 850000n }]);
    expect(summary.liabilities).toEqual([{ currency: 'USD', amount: 1030000n }]);
    expect(summary.net).toEqual([{ currency: 'USD', amount: -180000n }]);
  });

  it('never adds different currencies together', () => {
    const mixed = summarizeAccounts([
      account('US', 'checking', '1000'),
      account('EU', 'checking', '2000', { currency: 'EUR' }),
      account('EU card', 'credit_card', '500', { currency: 'EUR' }),
    ]);
    expect(mixed.groups[0]!.totals).toEqual([
      { currency: 'EUR', amount: 2000n },
      { currency: 'USD', amount: 1000n },
    ]);
    expect(mixed.net).toEqual([
      { currency: 'EUR', amount: 1500n },
      { currency: 'USD', amount: 1000n },
    ]);
    expect(mixed.liabilities).toEqual([{ currency: 'EUR', amount: 500n }]);
  });

  it('leaves out archived and hidden accounts, and any group they leave empty', () => {
    const s = summarizeAccounts([
      account('Old', 'savings', '999', { archived: true }),
      account('Private', 'savings', '999', { hidden: true }),
      account('Joint', 'checking', '100'),
    ]);
    expect(s.groups.map((g) => g.kind)).toEqual(['checking']);
    expect(s.net).toEqual([{ currency: 'USD', amount: 100n }]);
  });

  it('handles an overpaid card and an overdrawn account', () => {
    const s = summarizeAccounts([
      account('Card', 'credit_card', '-500'),
      account('Joint', 'checking', '-200'),
    ]);
    expect(s.net).toEqual([{ currency: 'USD', amount: 300n }]);
  });

  it('keeps precision above what a float can hold', () => {
    const s = summarizeAccounts([
      account('A', 'checking', '9007199254740993'),
      account('B', 'checking', '1'),
    ]);
    expect(s.net).toEqual([{ currency: 'USD', amount: 9007199254740994n }]);
  });

  it('has nothing to say about no accounts', () => {
    expect(summarizeAccounts([])).toEqual({ groups: [], assets: [], liabilities: [], net: [] });
  });

  it('still shows a kind it doesn’t know, last', () => {
    const s = summarizeAccounts([account('New', 'crypto', '5'), account('Card', 'credit_card', '1')]);
    expect(s.groups.map((g) => g.kind)).toEqual(['credit_card', 'crypto']);
  });
});
