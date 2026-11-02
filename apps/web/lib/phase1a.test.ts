import { describe, expect, it } from 'vitest';
import { ApiError, type TransactionDto } from '@montra/api-client';
import { summarizeBulk, toBulkSet, toggleSelection } from './bulk';
import { friendlyMessage, toFormErrors } from './errors';
import { evaluateJournal, toJournalLines, type JournalLine } from './journal';
import { maxSeq, needsRefresh } from './sync';
import { buildPatch, isEmptyPatch, parseTags, toEditState } from './transaction-edit';
import { defaultAccess, grantsFor, inviteLink } from './settings';

const posting = (
  accountId: string,
  debit: string | null,
  credit: string | null,
  extra: Partial<TransactionDto['entries'][number]['postings'][number]> = {},
) => ({
  lineNo: 1,
  accountId,
  accountName: accountId,
  debit,
  credit,
  currency: 'USD',
  memberId: null,
  memo: null,
  isCategory: accountId !== 'visa',
  systemRole: null,
  ...extra,
});

const txn = (postings: ReturnType<typeof posting>[], over: Partial<TransactionDto> = {}): TransactionDto => ({
  id: 't1',
  date: '2026-10-05',
  payee: 'Costco',
  description: '',
  status: 'posted',
  reviewState: 'needs_review',
  categorization: null,
  merchant: null,
  source: 'manual',
  version: '4',
  memo: 'weekly shop',
  tags: ['food'],
  recurringItemId: null,
  foreign: null,
  tripId: null,
  localTime: null,
  accountId: null,
  splits: null,
  amount: { amount: '-12000', currency: 'USD' },
  entries: [{ id: 'e', entityId: 'P', date: '2026-10-05', kind: 'standard', description: '', postings }],
  ...over,
});

const accounts = new Set(['visa']);

describe('transaction editor model', () => {
  it('reads category, member and tags from a single-category transaction', () => {
    const s = toEditState(
      txn([posting('visa', null, '12000'), posting('groceries', '12000', null, { memberId: 'm1' })]),
      accounts,
    );
    expect(s).toMatchObject({
      accountId: 'visa',
      direction: 'expense',
      amount: '120.00',
      mode: 'category',
      categoryId: 'groceries',
      memberId: 'm1',
      tags: 'food',
      memo: 'weekly shop',
      ledgerEditable: true,
    });
  });

  it('reads split lines and resends splits when the amount changes', () => {
    const initial = toEditState(
      txn([
        posting('visa', null, '12000'),
        posting('groceries', '8000', null),
        posting('office', '4000', null),
      ]),
      accounts,
    );
    expect(initial.mode).toBe('splits');
    expect(initial.splits.map((l) => [l.accountId, l.amount])).toEqual([
      ['groceries', '80.00'],
      ['office', '40.00'],
    ]);
    const changed = {
      ...initial,
      amount: '130.00',
      splits: [initial.splits[0]!, { ...initial.splits[1]!, amount: '50.00' }],
    };
    const r = buildPatch(initial, changed);
    expect(r).toEqual({
      ok: true,
      patch: {
        amount: { amount: '-13000', currency: 'USD' },
        splits: [
          { accountId: 'groceries', amount: { amount: '-8000', currency: 'USD' } },
          { accountId: 'office', amount: { amount: '-5000', currency: 'USD' } },
        ],
      },
    });
  });

  it('sends only changed fields, and nothing when untouched', () => {
    const initial = toEditState(
      txn([posting('visa', null, '12000'), posting('groceries', '12000', null)]),
      accounts,
    );
    expect(buildPatch(initial, initial)).toEqual({ ok: true, patch: {} });
    expect(isEmptyPatch({})).toBe(true);
    const r = buildPatch(initial, {
      ...initial,
      categoryId: 'dining',
      payee: '  ',
      tags: 'food, Travel, travel',
      memberId: '',
      memo: 'weekly shop',
    });
    expect(r).toEqual({ ok: true, patch: { categoryId: 'dining', payee: null, tags: ['food', 'Travel'] } });
  });

  it('rejects an invalid amount and treats transfers as non-ledger edits', () => {
    const initial = toEditState(
      txn([posting('visa', null, '12000'), posting('groceries', '12000', null)]),
      accounts,
    );
    expect(buildPatch(initial, { ...initial, amount: '1.234' })).toMatchObject({
      ok: false,
      field: 'amount',
    });
    const transfer = toEditState(
      txn(
        [
          posting('visa', '5000', null, { isCategory: false }),
          posting('chk', null, '5000', { isCategory: false }),
        ],
        {
          entries: [
            {
              id: 'e',
              entityId: 'P',
              date: '2026-10-05',
              kind: 'transfer',
              description: '',
              postings: [posting('visa', '5000', null, { isCategory: false })],
            },
          ],
        },
      ),
      accounts,
    );
    expect(transfer.ledgerEditable).toBe(false);
    expect(buildPatch(transfer, { ...transfer, amount: '1', payee: 'Card payment' })).toEqual({
      ok: true,
      patch: { payee: 'Card payment' },
    });
  });

  it('parses tags without duplicates', () => {
    expect(parseTags(' a, b ,, A, c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('manual journal', () => {
  const l = (key: string, accountId: string, debit: string, credit: string): JournalLine => ({
    key,
    accountId,
    debit,
    credit,
  });

  it('balances only when debits equal credits on valid lines', () => {
    expect(evaluateJournal([l('a', 'x', '100.00', ''), l('b', 'y', '', '60')], 'USD')).toMatchObject({
      totalDebit: 10000n,
      totalCredit: 6000n,
      difference: 4000n,
      balanced: false,
    });
    const ok = evaluateJournal([l('a', 'x', '100', ''), l('b', 'y', '', '60'), l('c', 'z', '', '40')], 'USD');
    expect(ok).toMatchObject({ difference: 0n, balanced: true, lineErrors: {} });
    expect(toJournalLines([l('a', 'x', '100', ''), l('b', 'y', '', '100')], 'USD')).toEqual([
      { accountId: 'x', debit: '10000' },
      { accountId: 'y', credit: '10000' },
    ]);
  });

  it('flags lines with both, neither, or no account', () => {
    const s = evaluateJournal(
      [l('a', 'x', '1', '1'), l('b', 'y', '', ''), l('c', '', '5', ''), l('d', 'z', '-3', '')],
      'USD',
    );
    expect(Object.keys(s.lineErrors).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(s.balanced).toBe(false);
  });
});

describe('bulk edit', () => {
  it('maps actions to the API set and validates input', () => {
    expect(toBulkSet({ kind: 'reviewed' })).toEqual({ reviewState: 'reviewed' });
    expect(toBulkSet({ kind: 'member', memberId: null })).toEqual({ memberId: null });
    expect(toBulkSet({ kind: 'addTags', tags: 'trip, trip, work' })).toEqual({ addTags: ['trip', 'work'] });
    expect(toBulkSet({ kind: 'category', categoryId: '' })).toEqual({ error: 'Choose a category' });
    expect(toBulkSet({ kind: 'removeTags', tags: ' , ' })).toEqual({ error: 'Enter at least one tag' });
  });

  it('summarizes results in plain language', () => {
    expect(summarizeBulk({ updated: ['a', 'b'], skipped: [] })).toBe('Updated 2.');
    expect(
      summarizeBulk({
        updated: ['a'],
        skipped: [
          { id: 'b', reason: 'transaction.reconciled' },
          { id: 'c', reason: 'transaction.reconciled' },
        ],
      }),
    ).toBe('Updated 1. Skipped 2 (reconciled).');
  });

  it('toggles selection and select-all', () => {
    const one = toggleSelection(new Set(), 'a', ['a', 'b']);
    expect([...one]).toEqual(['a']);
    expect([...toggleSelection(one, 'all', ['a', 'b'])]).toEqual(['a', 'b']);
    expect(toggleSelection(new Set(['a', 'b']), 'all', ['a', 'b']).size).toBe(0);
  });
});

describe('sync polling', () => {
  it('refreshes only for visible tables and compares sequences as bigints', () => {
    expect(needsRefresh([{ seq: '1', table: 'idempotency_key', id: 'x', op: 'insert' }])).toBe(false);
    expect(needsRefresh([{ seq: '2', table: 'transaction', id: 'x', op: 'update' }])).toBe(true);
    expect(maxSeq('9', '10')).toBe('10');
    expect(maxSeq('9007199254740993', '9007199254740992')).toBe('9007199254740993');
  });
});

describe('friendly errors', () => {
  it('explains locked and reconciled conflicts', () => {
    expect(friendlyMessage(new ApiError(409, 'period.locked', 'locked'))).toMatch(/books are closed/);
    expect(toFormErrors(new ApiError(409, 'transaction.reconciled', 'x')).form).toMatch(/reconciled/);
    expect(friendlyMessage(new ApiError(412, 'version.mismatch', 'x'))).toMatch(/Reload/);
    expect(friendlyMessage(new ApiError(422, 'other', 'Server says no'))).toBe('Server says no');
  });
});

describe('settings helpers', () => {
  const ws = {
    id: 'w',
    name: 'Home',
    baseCurrency: 'USD',
    timeZone: 'UTC',
    role: 'owner' as const,
    entities: [
      {
        id: 'P',
        type: 'personal' as const,
        name: 'Personal',
        functionalCurrency: 'USD',
        lockedThrough: null,
      },
      { id: 'B', type: 'business' as const, name: 'Studio', functionalCurrency: 'USD', lockedThrough: null },
    ],
  };

  it('builds invite links and sends only non-default grants', () => {
    expect(inviteLink('http://localhost:3000/', 'abc_DEF-123')).toBe(
      'http://localhost:3000/invite/abc_DEF-123',
    );
    expect(defaultAccess('partner', 'personal')).toBe('write');
    expect(defaultAccess('viewer', 'personal')).toBe('read');
    expect(defaultAccess('partner', 'business')).toBe('none');
    expect(grantsFor(ws, 'partner', { P: 'write', B: 'read' })).toEqual([{ entityId: 'B', access: 'read' }]);
    expect(grantsFor(ws, 'accountant', { B: 'read' })).toEqual([{ entityId: 'B', access: 'read' }]);
  });
});
