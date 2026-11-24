/**
 * Numbers kept sealed at rest with their last four beside them in the clear, for "••••1234": a business's tax account
 * numbers (BIZ-26, `business/tax-ids.ts`) and an account's full number (ACC-16, `accounts/account-number.ts`).
 *
 * - The sealed column is named `*_enc`, so the audit trigger writes "[redacted]" for it (migration 0089).
 * - The backup catalog (`data/catalog.ts`, ENCRYPTED and LAST4) unseals it into the archive and seals it again on
 *   restore, filling in the last four.
 * - The full number is only unsealed on the server, for a Show after a recent sign-in (`auditReveal` logs each one) or
 *   an output that needs it. It is never logged, put in an error or sent to AI.
 */
import type { Trx } from '@montra/db';
import type { FieldCrypto } from './crypto.service.js';

export interface SealedNumber {
  enc: Buffer | null;
  last4: string | null;
}

/** Seals a number (null or empty clears it) bound to the workspace and `label`, with its last four. */
export async function sealNumber(
  crypto: FieldCrypto,
  trx: Trx,
  workspaceId: string,
  label: string,
  value: string | null,
): Promise<SealedNumber> {
  const v = value || null;
  return { enc: await crypto.encrypt(trx, workspaceId, label, v), last4: v ? v.slice(-4) : null };
}

/** The audit entry for one number shown in full: who, what and which field; never the number. */
export async function auditReveal(
  trx: Trx,
  ctx: { workspaceId: string; userId: string },
  action: string,
  subject: { type: string; id: string },
  diff: Record<string, unknown> = {},
): Promise<void> {
  await trx
    .insertInto('app.audit_log')
    .values({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.userId,
      action,
      subject_type: subject.type,
      subject_id: subject.id,
      diff: JSON.stringify(diff),
    })
    .execute();
}
