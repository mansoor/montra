import { describe, expect, it } from 'vitest';
import type { AccountDto, TransactionDto, WorkspaceDto } from '@montra/api-client';
import { formatMinor, minorToInput, parseAmountInput } from './money';
import { evaluateSplits, signedTotal, toSplitPayload, type SplitLine } from './splits';
import { groupAccountsByEntity, groupCategories, netPosition, toTransactionRow } from './view-models';

describe('money input', () => {
  it('parses major-unit input into minor units', () => {
    expect(parseAmountInput('12.50', 'USD')).toEqual({ ok: true, minor: 1250n });
    expect(parseAmountInput('1,234', 'USD')).toEqual({ ok: true, minor: 123400n });
    expect(parseAmountInput('1.234,5', 'EUR', 'de-DE')).toEqual({ ok: true, minor: 123450n });
    expect(parseAmountInput('500', 'JPY')).toEqual({ ok: true, minor: 500n });
  });

  it('explains bad input', () => {
    expect(parseAmountInput('', 'USD')).toEqual({ ok: false, error: 'Enter an amount' });
    expect(parseAmountInput('1.234', 'USD')).toEqual({ ok: false, error: 'Use at most 2 decimal places' });
    expect(parseAmountInput('1.5', 'JPY')).toEqual({ ok: false, error: 'JPY has no decimal places' });
    expect(parseAmountInput('abc', 'USD')).toMatchObject({ ok: false });
  });

  it('formats and round-trips minor units', () => {
    expect(formatMinor('-4210', 'USD')).toBe('-$42.10');
    expect(formatMinor(-500n, 'USD', { accounting: true })).toBe('($5.00)');
    expect(minorToInput(1250n, 'USD')).toBe('12.50');
    expect(minorToInput(-5n, 'USD')).toBe('-0.05');
    expect(minorToInput(1234n, 'KWD')).toBe('1.234');
    expect(minorToInput(700n, 'JPY')).toBe('700');
  });
});

describe('split editor', () => {
  const line = (key: string, accountId: string, amount: string): SplitLine => ({ key, accountId, amount });

  it('tracks remaining and only balances when lines add up exactly', () => {
    const s1 = evaluateSplits('120.00', [line('a', 'g', '80.00'), line('b', 'o', '30')], 'USD');
    expect(s1).toMatchObject({ total: 12000n, allocated: 11000n, remaining: 1000n, balanced: false });
    const s2 = evaluateSplits('120.00', [line('a', 'g', '80.00'), line('b', 'o', '40')], 'USD');
    expect(s2).toMatchObject({ remaining: 0n, balanced: true, lineErrors: {} });
    const over = evaluateSplits('120.00', [line('a', 'g', '100'), line('b', 'o', '40')], 'USD');
    expect(over.remaining).toBe(-2000n);
  });

  it('reports missing categories and bad amounts per line', () => {
    const s = evaluateSplits('10', [line('a', '', '5'), line('b', 'o', 'x'), line('c', 'o', '0')], 'USD');
    expect(s.balanced).toBe(false);
    expect(Object.keys(s.lineErrors).sort()).toEqual(['a', 'b', 'c']);
    expect(evaluateSplits('', [line('a', 'g', '5')], 'USD').remaining).toBeNull();
  });

  it('signs the payload by direction', () => {
    const lines = [line('a', 'g', '80'), line('b', 'o', '40'), { ...line('c', 'x', '0.01'), memo: 'paper' }];
    expect(toSplitPayload(lines, 'USD', 'expense')).toEqual([
      { accountId: 'g', amount: { amount: '-8000', currency: 'USD' } },
      { accountId: 'o', amount: { amount: '-4000', currency: 'USD' } },
      { accountId: 'x', amount: { amount: '-1', currency: 'USD' }, memo: 'paper' },
    ]);
    expect(toSplitPayload([line('a', 'g', '5')], 'USD', 'income')[0]!.amount.amount).toBe('500');
    expect(signedTotal(500n, 'expense')).toBe(-500n);
    expect(signedTotal(-500n, 'income')).toBe(500n);
  });
});

describe('view models', () => {
  const ws: WorkspaceDto = {
    id: 'w',
    name: 'Home',
    baseCurrency: 'USD',
    timeZone: 'UTC',
    role: 'owner',
    entities: [
      { id: 'P', type: 'personal', name: 'Personal', functionalCurrency: 'USD' },
      { id: 'B', type: 'business', name: 'Studio', functionalCurrency: 'USD' },
    ],
  };
  const acct = (
    id: string,
    entityId: string,
    type: 'asset' | 'liability',
    amount: string,
    currency = 'USD',
  ): AccountDto => ({
    id,
    entityId,
    name: id,
    kind: type === 'asset' ? 'checking' : 'credit_card',
    type,
    currency,
    institution: null,
    last4: null,
    balance: { amount, currency: currency as AccountDto['balance']['currency'] },
    archived: false,
    hidden: false,
    defaultMemberId: null,
  });

  it('computes net position per currency (assets minus liabilities)', () => {
    const accounts = [
      acct('chk', 'P', 'asset', '250000'),
      acct('visa', 'P', 'liability', '50000'),
      acct('eur', 'P', 'asset', '1000', 'EUR'),
    ];
    expect(netPosition(accounts)).toEqual([
      { currency: 'EUR', amount: 1000n },
      { currency: 'USD', amount: 200000n },
    ]);
  });

  it('groups accounts and categories by entity', () => {
    const groups = groupAccountsByEntity(ws, [
      acct('chk', 'P', 'asset', '0'),
      acct('biz', 'B', 'asset', '0'),
    ]);
    expect(groups.map((g) => [g.entityName, g.accounts.map((a) => a.id)])).toEqual([
      ['Personal', ['chk']],
      ['Studio', ['biz']],
    ]);
    const cats = groupCategories(
      ws,
      [
        {
          id: 'g',
          entityId: 'P',
          name: 'Groceries',
          type: 'expense',
          group: 'Daily living',
          taxLineCode: null,
        },
        { id: 's', entityId: 'P', name: 'Salary', type: 'income', group: 'Income', taxLineCode: null },
        {
          id: 'o',
          entityId: 'B',
          name: 'Office',
          type: 'expense',
          group: 'Business expenses',
          taxLineCode: 'US_SCH_C_L18',
        },
      ],
      'expense',
    );
    expect(cats.map((c) => c.label)).toEqual(['Personal · Daily living', 'Studio · Business expenses']);
  });

  it('summarizes transactions with the API amount and isCategory flags', () => {
    const t = (
      kind: string,
      amount: string | null,
      postings: TransactionDto['entries'][number]['postings'],
    ): TransactionDto => ({
      id: 't',
      date: '2026-10-05',
      payee: 'Costco',
      description: '',
      status: 'posted',
      reviewState: 'reviewed',
      source: 'manual',
      memo: null,
      tags: ['bulk'],
      recurringItemId: null,
      amount: amount === null ? null : { amount, currency: 'USD' },
      version: '1',
      entries: [{ id: 'e', entityId: 'P', date: '2026-10-05', kind, description: '', postings }],
    });
    const p = (
      accountId: string,
      accountName: string,
      debit: string | null,
      credit: string | null,
      extra: { isCategory?: boolean; systemRole?: string | null } = {},
    ) => ({
      lineNo: 1,
      accountId,
      accountName,
      debit,
      credit,
      currency: 'USD',
      memberId: null,
      memo: null,
      isCategory: extra.isCategory ?? !accounts.has(accountId),
      systemRole: extra.systemRole ?? null,
    });
    const accounts = new Map(['visa', 'chk', 'sav'].map((id) => [id, { name: id }]));
    const split = t('standard', '-12000', [
      p('visa', 'Visa', null, '12000'),
      p('g', 'Groceries', '8000', null),
      p('clr', 'Transfers with Studio', '4000', null, {
        isCategory: false,
        systemRole: 'inter_entity_clearing',
      }),
    ]);
    split.entries.push({
      id: 'e2',
      entityId: 'B',
      date: '2026-10-05',
      kind: 'standard',
      description: '',
      postings: [
        p('o', 'Office expense', '4000', null),
        p('oc', 'Owner contribution', null, '4000', { isCategory: false, systemRole: 'owner_contribution' }),
      ],
    });
    expect(toTransactionRow(split, accounts)).toMatchObject({
      title: 'Costco',
      accountName: 'Visa',
      amount: -12000n,
      categories: ['Groceries', 'Office expense'],
      isTransfer: false,
      tags: ['bulk'],
    });
    expect(
      toTransactionRow(
        t('transfer', '-5000', [p('sav', 'Savings', '5000', null), p('chk', 'Checking', null, '5000')]),
        accounts,
      ),
    ).toMatchObject({ accountName: 'Checking', amount: -5000n, categories: ['→ Savings'], isTransfer: true });
    expect(toTransactionRow(t('manual', null, []), accounts).amount).toBeNull();
  });
});
