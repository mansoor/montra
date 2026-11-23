/** Deleting an account added by mistake (ACC-14): pure helpers for Settings → Accounts. */
import type { AccountDeletionDto, MemberRole } from '@montra/api-client';
import { isAdminRole } from './settings';

/** Owners and admins, as the API allows (and as for moving an account to other books). */
export const canDeleteAccounts = (role: MemberRole | null | undefined): boolean =>
  role != null && isAdminRole(role);

/**
 * What Delete does after asking the API: shows why it can't (the account has history, or its opening balance is in
 * closed books), or asks to confirm.
 */
export function deleteStep(
  check: Pick<AccountDeletionDto, 'blockers' | 'reason'>,
): { kind: 'blocked'; reason: string } | { kind: 'confirm' } {
  if (check.blockers.length === 0) return { kind: 'confirm' };
  return { kind: 'blocked', reason: check.reason ?? '' };
}
