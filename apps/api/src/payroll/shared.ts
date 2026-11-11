/** Helpers shared by the payroll services (ADR-0034). */
import { sql } from 'kysely';
import type { PayrollPersonRow, Trx } from '@montra/db';
import { AppError } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { businessEntity, type BusinessEntity, type Ctx } from '../business/shared.js';

export type { Ctx };

/**
 * The business, for payroll: personal data needs write access to it (ADR-0034 §2). A read-only grant gets a clear
 * refusal rather than an empty list that looks like no one is employed.
 */
export async function payrollEntity(trx: Trx, ctx: Ctx, entityId: string): Promise<BusinessEntity> {
  const e = await businessEntity(trx, ctx, entityId);
  const { rows } = await sql<{ ok: boolean }>`select app.can_write_entity(${entityId}::uuid) as ok`.execute(
    trx,
  );
  if (!rows[0]?.ok) {
    throw new AppError(403, 'payroll.no_access', 'Payroll needs permission to change this business');
  }
  return e;
}

/** Sealed column labels: `<table>.<column without _enc>`, as the backup catalog names them. */
export const sealer = (crypto: FieldCrypto, trx: Trx, ctx: Ctx) => ({
  seal: (label: string, value: string | null | undefined) =>
    crypto.encrypt(trx, ctx.workspaceId, label, value),
  open: (label: string, value: Buffer | null) => crypto.decrypt(trx, ctx.workspaceId, label, value),
});

/** Logs a look at personal data in the audit log (PRL-05). Owners read it in Settings → Activity. */
export async function auditView(
  trx: Trx,
  ctx: Ctx,
  action: 'payroll.revealed' | 'payroll.form_downloaded' | 'payroll.document_viewed',
  subjectType: string,
  subjectId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await trx
    .insertInto('app.audit_log')
    .values({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.userId,
      action,
      subject_type: subjectType,
      subject_id: subjectId,
      diff: JSON.stringify(detail),
    })
    .execute();
}

export const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');

export const personName = (p: Pick<PayrollPersonRow, 'first_name' | 'middle_name' | 'last_name'>) =>
  [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');

/** "1 Elm St, Apt 2\nAustin, TX 78701" from a person's address parts; null when there's none. */
export function formatAddress(
  p: Pick<PayrollPersonRow, 'address_line1' | 'address_line2' | 'city' | 'region' | 'postal_code'>,
): string | null {
  const street = [p.address_line1, p.address_line2].filter(Boolean).join(', ');
  const place = [p.city, [p.region, p.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const out = [street, place].filter(Boolean).join('\n');
  return out || null;
}
