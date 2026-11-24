/** Deleting an account added by mistake (ACC-14): pure helpers for Settings → Accounts. */
import type { AccountDeletionDto, MemberRole } from '@montra/api-client';
import { isAdminRole } from './settings';

/** Owners and admins, as the API allows (and as for moving an account to other books). */
export const canDeleteAccounts = (role: MemberRole | null | undefined): boolean =>
  role != null && isAdminRole(role);

/**
 * What Delete does after asking the API: shows why it can't (the account has history, its opening balance is in closed
 * books, or a legal hold keeps its trashed transactions), or asks to confirm, naming the transactions in the Trash that
 * go with it for good.
 */
export function deleteStep(
  check: Pick<AccountDeletionDto, 'blockers' | 'reason'> &
    Partial<Pick<AccountDeletionDto, 'trashedTransactions'>>,
): { kind: 'blocked'; reason: string } | { kind: 'confirm'; trashedTransactions: number } {
  if (check.blockers.length === 0)
    return { kind: 'confirm', trashedTransactions: check.trashedTransactions ?? 0 };
  return { kind: 'blocked', reason: check.reason ?? '' };
}
