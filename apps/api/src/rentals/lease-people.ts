/**
 * The people on a lease besides the tenants who sign, and what the lease cost to set up (RNT-18, RNT-19; ADR-0038).
 * Helpers shared by the lease services. Tenants who sign stay in `lease_tenant` and are the only payers.
 */
import { newId, type LeaseRow, type Trx } from '@montra/db';
import type { LeaseCostDto, LeasePersonDto, LeasePersonRequest } from '@montra/schemas';
import { calendarDate } from '@montra/domain';
import { notFound, unprocessable } from '../common/errors.js';
import type { FieldCrypto } from '../crypto/crypto.service.js';
import type { Ctx } from './shared.js';

/** Sealed column labels, as the backup catalog names them (`<table>.<column without _enc>`). */
export const TENANT_DOB = 'tenant.birth_date';
export const PERSON_DOB = 'lease_person.birth_date';

/** A contact of this portfolio, optionally of one role. Archived ones aren't offered for anything new. */
export async function portfolioContact(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  id: string,
  role?: 'broker',
): Promise<{ id: string; company_name: string }> {
  const c = await trx
    .selectFrom('app.rental_contact')
    .select(['id', 'company_name', 'role', 'archived_at'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('entity_id', '=', entityId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!c || c.archived_at) throw unprocessable('rental.contact', 'Choose one of this portfolio’s contacts');
  if (role && c.role !== role)
    throw unprocessable('lease.broker', 'Choose a contact whose role is broker or agent');
  return c;
}

/** Adds a co-signer or occupant. A co-signer who is a tenant can't also sign the same lease. */
export async function insertLeasePerson(
  trx: Trx,
  ctx: Ctx,
  crypto: FieldCrypto,
  lease: Pick<LeaseRow, 'id' | 'entity_id'>,
  req: LeasePersonRequest,
): Promise<string> {
  if (req.tenantId) {
    const t = await trx
      .selectFrom('app.tenant')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', lease.entity_id)
      .where('id', '=', req.tenantId)
      .executeTakeFirst();
    if (!t) throw unprocessable('lease.tenant', 'Choose tenants of this portfolio');
    const [signs, already] = await Promise.all([
      trx
        .selectFrom('app.lease_tenant')
        .select('tenant_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', '=', lease.id)
        .where('tenant_id', '=', req.tenantId)
        .executeTakeFirst(),
      trx
        .selectFrom('app.lease_person')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', '=', lease.id)
        .where('tenant_id', '=', req.tenantId)
        .executeTakeFirst(),
    ]);
    if (signs) throw unprocessable('lease.person_is_signer', 'They already sign this lease as a tenant');
    if (already) throw unprocessable('lease.person_twice', 'They’re already on this lease');
  }
  const next = await trx
    .selectFrom('app.lease_person')
    .select((eb) => eb.fn.coalesce(eb.fn.max('sort_order'), eb.val(-1)).as('n'))
    .where('workspace_id', '=', ctx.workspaceId)
    .where('lease_id', '=', lease.id)
    .executeTakeFirstOrThrow();
  const id = newId();
  // A co-signer who is one of the tenants keeps their details on the tenant record.
  const own = !req.tenantId;
  await trx
    .insertInto('app.lease_person')
    .values({
      workspace_id: ctx.workspaceId,
      id,
      entity_id: lease.entity_id,
      lease_id: lease.id,
      role: req.role,
      tenant_id: req.tenantId ?? null,
      name: own ? (req.name ?? null) : null,
      relationship: req.relationship ?? null,
      email: own ? (req.email ?? null) : null,
      phone: own ? (req.phone ?? null) : null,
      mailing_address: own ? (req.mailingAddress ?? null) : null,
      birth_date_enc: own
        ? await crypto.encrypt(trx, ctx.workspaceId, PERSON_DOB, req.dateOfBirth ?? null)
        : null,
      notes: req.notes ?? null,
      sort_order: Number(next.n) + 1,
    })
    .execute();
  return id;
}

/** Co-signers and occupants on a lease, in the order added. A tenant co-signer shows the tenant's details. */
export async function leasePeople(trx: Trx, ctx: Ctx, leaseId: string): Promise<LeasePersonDto[]> {
  const rows = await trx
    .selectFrom('app.lease_person as p')
    .leftJoin('app.tenant as t', (j) =>
      j.onRef('t.workspace_id', '=', 'p.workspace_id').onRef('t.id', '=', 'p.tenant_id'),
    )
    .select([
      'p.id',
      'p.role',
      'p.tenant_id',
      'p.name',
      'p.relationship',
      'p.email',
      'p.phone',
      'p.mailing_address',
      'p.birth_date_enc',
      'p.notes',
      'p.version',
      't.name as t_name',
      't.email as t_email',
      't.phone as t_phone',
      't.mailing_address as t_address',
    ])
    .where('p.workspace_id', '=', ctx.workspaceId)
    .where('p.lease_id', '=', leaseId)
    .orderBy('p.sort_order')
    .orderBy('p.created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    tenantId: r.tenant_id,
    name: (r.tenant_id ? r.t_name : r.name) ?? '',
    relationship: r.relationship,
    email: r.tenant_id ? (r.t_email ?? null) : r.email,
    phone: r.tenant_id ? (r.t_phone ?? null) : r.phone,
    mailingAddress: r.tenant_id ? (r.t_address ?? null) : r.mailing_address,
    hasDateOfBirth: r.birth_date_enc !== null,
    notes: r.notes,
    version: Number(r.version),
  }));
}

/** A lease's broker's fee and legal fees, by date. The date is the transaction's: a bank line keeps its own. */
export async function leaseCosts(trx: Trx, ctx: Ctx, leaseId: string): Promise<LeaseCostDto[]> {
  const rows = await trx
    .selectFrom('app.lease_cost as c')
    .innerJoin('app.transaction as t', (j) =>
      j.onRef('t.workspace_id', '=', 'c.workspace_id').onRef('t.id', '=', 'c.transaction_id'),
    )
    .leftJoin('app.rental_contact as k', (j) =>
      j.onRef('k.workspace_id', '=', 'c.workspace_id').onRef('k.id', '=', 'c.contact_id'),
    )
    .select([
      'c.id',
      'c.kind',
      'c.amount_minor',
      'c.contact_id',
      'c.transaction_id',
      'c.notes',
      't.txn_date',
      'k.company_name',
    ])
    .where('c.workspace_id', '=', ctx.workspaceId)
    .where('c.lease_id', '=', leaseId)
    .orderBy('t.txn_date')
    .orderBy('c.created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    date: calendarDate(String(r.txn_date).slice(0, 10)),
    amount: String(r.amount_minor),
    contactId: r.contact_id,
    contactName: r.company_name ?? null,
    transactionId: r.transaction_id,
    notes: r.notes,
  }));
}

export async function leasePersonRow(trx: Trx, ctx: Ctx, id: string) {
  const r = await trx
    .selectFrom('app.lease_person')
    .selectAll()
    .where('workspace_id', '=', ctx.workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!r) throw notFound('Person');
  return r;
}

/** Writes a look at a sealed date of birth to the audit log. Owners read it in Settings → Activity. */
export async function auditReveal(
  trx: Trx,
  ctx: Ctx,
  subjectType: 'tenant' | 'lease_person',
  subjectId: string,
): Promise<void> {
  await trx
    .insertInto('app.audit_log')
    .values({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.userId,
      action: 'rental.revealed',
      subject_type: subjectType,
      subject_id: subjectId,
      diff: JSON.stringify({ field: 'dateOfBirth' }),
    })
    .execute();
}
