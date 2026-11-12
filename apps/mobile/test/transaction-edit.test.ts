import { describe, expect, it } from 'vitest';
import type { TransactionDto } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import { editRules } from '../src/features/transaction-edit';

const server = (over: Partial<TransactionDto> = {}): TransactionDto =>
  ({
    managedBy: null,
    reconciled: false,
    entries: [
      { id: 'e1', entityId: 'p', date: '2026-10-10', kind: 'standard', description: '', postings: [] },
    ],
    ...over,
  }) as TransactionDto;

const row = (over: Partial<LocalTransaction> = {}) => ({
  amount: '-1250',
  accountId: 'checking',
  server: server(),
  ...over,
});

describe('what the phone may change on a transaction (DE-10, DE-15)', () => {
  it('moves an ordinary income or expense to another account', () => {
    expect(editRules(row())).toEqual({
      reconciled: false,
      canMove: true,
      canChangeDate: true,
      canChangeAmount: true,
    });
  });

  it('keeps a reconciled one on its account, amount and date', () => {
    expect(editRules(row({ server: server({ reconciled: true }) }))).toEqual({
      reconciled: true,
      canMove: false,
      canChangeDate: false,
      canChangeAmount: false,
    });
  });

  it('treats a row synced before the flag existed as not reconciled', () => {
    const old = server();
    delete (old as Partial<TransactionDto>).reconciled;
    expect(editRules(row({ server: old })).canMove).toBe(true);
  });

  it("doesn't move what something else manages, a transfer, a journal, or an offline draft without an account", () => {
    expect(editRules(row({ server: server({ managedBy: 'invoice' }) })).canMove).toBe(false);
    const transfer = server({
      entries: [
        { id: 'e1', entityId: 'p', date: '2026-10-10', kind: 'transfer', description: '', postings: [] },
      ],
    });
    expect(editRules(row({ server: transfer })).canMove).toBe(false);
    expect(editRules(row({ amount: null })).canMove).toBe(false);
    expect(editRules(row({ server: null, accountId: null })).canMove).toBe(false);
    expect(editRules(row({ server: null })).canMove).toBe(true);
  });
});
