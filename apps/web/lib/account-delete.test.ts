import { describe, expect, it } from 'vitest';
import { canDeleteAccounts, deleteStep } from './account-delete';

// Deleting an account added by mistake (ACC-14).
describe('deleting an account', () => {
  it('is offered to owners and admins only', () => {
    expect(canDeleteAccounts('owner')).toBe(true);
    expect(canDeleteAccounts('admin')).toBe(true);
    for (const role of ['partner', 'member', 'viewer', 'accountant'] as const)
      expect(canDeleteAccounts(role), role).toBe(false);
    expect(canDeleteAccounts(null)).toBe(false);
  });

  it('asks to confirm an empty account, and shows why one with history stays', () => {
    expect(deleteStep({ blockers: [], reason: null, trashedTransactions: 0 })).toEqual({
      kind: 'confirm',
      trashedTransactions: 0,
    });
    // The owner's Auto Loan: its one transaction in the Trash goes with it, and the confirm says so.
    expect(deleteStep({ blockers: [], reason: null, trashedTransactions: 1 })).toEqual({
      kind: 'confirm',
      trashedTransactions: 1,
    });
    const reason = 'This account has 12 transactions. Archive it instead, or remove them first.';
    expect(deleteStep({ blockers: [{ code: 'transactions', count: 12 }], reason })).toEqual({
      kind: 'blocked',
      reason,
    });
  });
});
