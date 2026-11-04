/**
 * The rent roll, arrears, rent payments and security deposits (RNT-04, RNT-05, RNT-10; ADR-0018). What a charge has been paid
 * is derived from the lease's payments each time it's read. A security deposit is a liability until it's forfeited.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type LeaseRow, type Trx } from '@montra/db';
import {
  addDays,
  applyRentPayments,
  asCurrencyCode,
  calendarDate,
  endOfMonth,
  lateFee,
  rentPeriods,
  startOfMonth,
  type CalendarDate,
  type ChargeInput,
  type ChargeState,
  type JournalEntryDraft,
} from '@montra/domain';
import type {
  ArrearsDto,
  DepositEventRequest,
  LeaseCandidateDto,
  LeaseDto,
  RentChargeDto,
  RentPaymentDto,
  RentPaymentRequest,
  RentRollDto,
  UpdateChargeRequest,
} from '@montra/schemas';
import { PaymentLinks } from '../business/payment-links.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { NOT_OWNED, TransactionPoster, type SplitSpec } from '../transactions/poster.js';
import { leaseStatus, PropertiesService } from './properties.service.js';
import { categoryOnLine, rentalEntity, SCH_E, todayOf, type Ctx } from './shared.js';

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

export interface LeaseState {
  lease: LeaseRow;
  charges: (ChargeState & { periodStart: CalendarDate; version: number })[];
  credit: bigint;
  paid: bigint;
}

@Injectable()
export class RentService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  // ----- What's owed, derived ------------------------------------------------------------------------------

  /** Every lease's charges with what's been paid applied, oldest first. */
  async leaseStates(
    trx: Trx,
    ctx: Ctx,
    leases: readonly LeaseRow[],
    today: CalendarDate,
  ): Promise<LeaseState[]> {
    if (leases.length === 0) return [];
    const ids = leases.map((l) => l.id);
    const [charges, payments] = await Promise.all([
      trx
        .selectFrom('app.rent_charge')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', 'in', ids)
        .execute(),
      trx
        .selectFrom('app.rent_payment')
        .select(['lease_id', (eb) => eb.fn.sum<string>('amount_minor').as('total')])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', 'in', ids)
        .groupBy('lease_id')
        .execute(),
    ]);
    const paidBy = new Map(payments.map((p) => [p.lease_id, BigInt(p.total)]));
    return leases.map((lease) => {
      const own = charges.filter((c) => c.lease_id === lease.id);
      const meta = new Map(own.map((c) => [c.id, c]));
      const inputs: ChargeInput[] = own.map((c) => ({
        id: c.id,
        kind: c.kind,
        due: iso(c.due_date),
        amount: BigInt(c.amount_minor),
        waived: c.waived_at !== null,
      }));
      const paid = paidBy.get(lease.id) ?? 0n;
      const res = applyRentPayments(inputs, paid, today, lease.late_grace_days);
      return {
        lease,
        paid,
        credit: res.credit,
        charges: res.charges.map((c) => ({
          ...c,
          periodStart: iso(meta.get(c.id)!.period_start),
          version: Number(meta.get(c.id)!.version),
        })),
      };
    });
  }

  private async entityLeases(trx: Trx, ctx: Ctx, entityId: string): Promise<LeaseRow[]> {
    return trx
      .selectFrom('app.lease')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .execute();
  }

  private async names(trx: Trx, ctx: Ctx, entityId: string) {
    const [units, properties, tenants] = await Promise.all([
      trx
        .selectFrom('app.unit')
        .select(['id', 'label', 'property_id', 'market_rent_minor', 'archived_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .execute(),
      trx
        .selectFrom('app.property')
        .select(['id', 'name', 'archived_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .execute(),
      trx
        .selectFrom('app.lease_tenant as lt')
        .innerJoin('app.tenant as t', (j) =>
          j.onRef('t.workspace_id', '=', 'lt.workspace_id').onRef('t.id', '=', 'lt.tenant_id'),
        )
        .select(['lt.lease_id', 't.name', 't.payee_keys'])
        .where('t.workspace_id', '=', ctx.workspaceId)
        .where('t.entity_id', '=', entityId)
        .execute(),
    ]);
    return {
      unit: new Map(units.map((u) => [u.id, u])),
      units,
      property: new Map(properties.map((p) => [p.id, p])),
      tenantsOf: (leaseId: string) => tenants.filter((t) => t.lease_id === leaseId),
    };
  }

  private chargeDto(leaseId: string, c: LeaseState['charges'][number]): RentChargeDto {
    return {
      id: c.id,
      leaseId,
      kind: c.kind,
      periodStart: c.periodStart,
      dueDate: c.due,
      amount: String(c.amount),
      paid: String(c.paid),
      open: String(c.open),
      status: c.status,
      daysLate: c.daysLate,
      version: c.version,
    };
  }

  // ----- Rent roll (RNT-04) --------------------------------------------------------------------------------

  async rentRoll(ctx: Ctx, entityId: string, month?: CalendarDate): Promise<RentRollDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await rentalEntity(trx, ctx, entityId);
      const today = todayOf(e);
      const start = startOfMonth(month ?? today);
      const end = endOfMonth(start);
      const leases = await this.entityLeases(trx, ctx, entityId);
      const states = await this.leaseStates(trx, ctx, leases, today);
      const n = await this.names(trx, ctx, entityId);
      const rows: RentRollDto['rows'] = [];
      for (const s of states) {
        const charges = s.charges.filter((c) => c.due >= start && c.due <= end);
        if (charges.length === 0) continue;
        const unit = n.unit.get(s.lease.unit_id);
        const owed = charges.filter((c) => c.status !== 'waived');
        rows.push({
          leaseId: s.lease.id,
          propertyId: s.lease.property_id,
          propertyName: n.property.get(s.lease.property_id)?.name ?? '',
          unitId: s.lease.unit_id,
          unitLabel: unit?.label ?? '',
          tenants: n.tenantsOf(s.lease.id).map((t) => t.name),
          charges: charges.map((c) => this.chargeDto(s.lease.id, c)),
          expected: String(owed.reduce((t, c) => t + c.amount, 0n)),
          paid: String(owed.reduce((t, c) => t + c.paid, 0n)),
          open: String(owed.reduce((t, c) => t + c.open, 0n)),
          credit: String(s.credit),
        });
      }
      rows.sort((a, b) =>
        `${a.propertyName} ${a.unitLabel}`.localeCompare(`${b.propertyName} ${b.unitLabel}`),
      );
      const leased = new Set(
        leases
          .filter((l) => {
            const stop = l.ended_on ? iso(l.ended_on) : l.end_date ? iso(l.end_date) : null;
            return iso(l.start_date) <= end && (stop === null || stop >= start);
          })
          .map((l) => l.unit_id),
      );
      const sum = (k: 'expected' | 'paid' | 'open') => String(rows.reduce((t, r) => t + BigInt(r[k]), 0n));
      return {
        entityId,
        month: start,
        currency: asCurrencyCode(e.currency),
        rows,
        expected: sum('expected'),
        paid: sum('paid'),
        open: sum('open'),
        vacant: n.units
          .filter((u) => !u.archived_at && !leased.has(u.id) && !n.property.get(u.property_id)?.archived_at)
          .map((u) => ({
            unitId: u.id,
            propertyName: n.property.get(u.property_id)?.name ?? '',
            unitLabel: u.label,
            marketRent: u.market_rent_minor !== null ? String(u.market_rent_minor) : null,
          })),
      };
    });
  }

  // ----- Arrears (RNT-05) ----------------------------------------------------------------------------------

  async arrears(ctx: Ctx, entityId: string): Promise<ArrearsDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await rentalEntity(trx, ctx, entityId);
      const today = todayOf(e);
      const states = await this.leaseStates(trx, ctx, await this.entityLeases(trx, ctx, entityId), today);
      const n = await this.names(trx, ctx, entityId);
      const rows: ArrearsDto['rows'] = [];
      for (const s of states) {
        const late = s.charges.filter((c) => c.open > 0n && c.status === 'late');
        // A fee is owed once assessed, even within its own grace.
        const fees = s.charges.filter((c) => c.kind === 'late_fee' && c.open > 0n);
        const owed = [...new Set([...late, ...fees])];
        if (owed.length === 0) continue;
        const rent = owed.filter((c) => c.kind === 'rent').reduce((t, c) => t + c.open, 0n);
        const feesOwed = owed.filter((c) => c.kind === 'late_fee').reduce((t, c) => t + c.open, 0n);
        const oldest = owed.reduce((a, b) => (b.due < a.due ? b : a));
        rows.push({
          leaseId: s.lease.id,
          propertyName: n.property.get(s.lease.property_id)?.name ?? '',
          unitLabel: n.unit.get(s.lease.unit_id)?.label ?? '',
          tenants: n.tenantsOf(s.lease.id).map((t) => t.name),
          rentOwed: String(rent),
          feesOwed: String(feesOwed),
          total: String(rent + feesOwed),
          oldestDue: oldest.due,
          daysLate: Math.max(...owed.map((c) => c.daysLate)),
          charges: owed.map((c) => this.chargeDto(s.lease.id, c)),
        });
      }
      rows.sort((a, b) => b.daysLate - a.daysLate);
      return {
        entityId,
        currency: asCurrencyCode(e.currency),
        total: String(rows.reduce((t, r) => t + BigInt(r.total), 0n)),
        rows,
      };
    });
  }

  /** A late fee is charged once per period, when rent is past its grace. A waived one isn't brought back. */
  async assessLateFees(trx: Trx, ctx: Ctx, entityId: string, today: CalendarDate): Promise<number> {
    const leases = await this.entityLeases(trx, ctx, entityId);
    const billable = leases.filter((l) => BigInt(l.late_fee_flat_minor) > 0n || l.late_fee_bps > 0);
    let added = 0;
    for (const s of await this.leaseStates(trx, ctx, billable, today)) {
      const assessed = new Set(s.charges.filter((c) => c.kind === 'late_fee').map((c) => c.periodStart));
      for (const c of s.charges) {
        if (c.kind !== 'rent' || c.status !== 'late' || assessed.has(c.periodStart)) continue;
        const fee = lateFee(
          {
            graceDays: s.lease.late_grace_days,
            flat: BigInt(s.lease.late_fee_flat_minor),
            bps: s.lease.late_fee_bps,
            cap: s.lease.late_fee_cap_minor !== null ? BigInt(s.lease.late_fee_cap_minor) : null,
          },
          c.amount,
        );
        if (fee <= 0n) continue;
        await trx
          .insertInto('app.rent_charge')
          .values({
            workspace_id: ctx.workspaceId,
            id: newId(),
            entity_id: entityId,
            lease_id: s.lease.id,
            kind: 'late_fee',
            period_start: c.periodStart,
            due_date: addDays(c.due, s.lease.late_grace_days + 1),
            amount_minor: fee,
          })
          .onConflict((oc) => oc.columns(['workspace_id', 'lease_id', 'kind', 'period_start']).doNothing())
          .execute();
        added++;
      }
    }
    return added;
  }

  async updateCharge(ctx: Ctx, id: string, req: UpdateChargeRequest): Promise<RentChargeDto> {
    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .updateTable('app.rent_charge')
        .set({
          ...(req.amount !== undefined ? { amount_minor: req.amount } : {}),
          ...(req.waived !== undefined ? { waived_at: req.waived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returning(['lease_id'])
        .executeTakeFirst();
      if (!row) {
        const exists = await trx
          .selectFrom('app.rent_charge')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!exists) throw notFound('Charge');
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      const lease = await this.properties.leaseRow(trx, ctx, row.lease_id);
      const e = await rentalEntity(trx, ctx, lease.entity_id);
      const [s] = await this.leaseStates(trx, ctx, [lease], todayOf(e));
      return this.chargeDto(
        lease.id,
        s!.charges.find((c) => c.id === id)!,
      );
    });
  }

  // ----- Rent payments (RNT-04) ----------------------------------------------------------------------------

  async listPayments(ctx: Ctx, leaseId: string): Promise<RentPaymentDto[]> {
    return this.db.run(ctx, async (trx) => {
      await this.properties.leaseRow(trx, ctx, leaseId);
      const rows = await trx
        .selectFrom('app.rent_payment as p')
        .innerJoin('app.transaction as t', (j) =>
          j.onRef('t.workspace_id', '=', 'p.workspace_id').onRef('t.id', '=', 'p.transaction_id'),
        )
        .select(['p.id', 'p.lease_id', 'p.transaction_id', 'p.amount_minor', 'p.source', 't.txn_date'])
        .where('p.workspace_id', '=', ctx.workspaceId)
        .where('p.lease_id', '=', leaseId)
        .orderBy('t.txn_date', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        leaseId: r.lease_id,
        transactionId: r.transaction_id,
        date: iso(r.txn_date),
        amount: String(r.amount_minor),
        source: r.source,
      }));
    });
  }

  /** Lines that could be this lease's money, nearest today first. Any account: they might land in a personal one. */
  async candidates(ctx: Ctx, leaseId: string): Promise<LeaseCandidateDto[]> {
    return this.db.run(ctx, async (trx) => {
      const lease = await this.properties.leaseRow(trx, ctx, leaseId);
      const e = await rentalEntity(trx, ctx, lease.entity_id);
      const today = todayOf(e);
      const { rows } = await sql<{
        id: string;
        d: string;
        amount: string;
        payer: string | null;
        account_id: string;
      }>`
        select t.id, t.txn_date::text as d, (t.spec->>'amount') as amount,
               coalesce(t.payee_raw, t.description) as payer, t.spec->>'accountId' as account_id
          from app.transaction t
         where t.workspace_id = ${ctx.workspaceId}
           and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
           and t.spec->>'currency' = ${e.currency}
           and (t.spec->>'amount')::bigint > 0
           and t.txn_date between ${addDays(today, -60)} and ${addDays(today, 7)}
           and ${NOT_OWNED}
         order by abs(t.txn_date - ${today}::date), t.id
         limit 20`.execute(trx);
      return rows.map((r) => ({
        transactionId: r.id,
        date: calendarDate(r.d),
        amount: r.amount,
        payer: r.payer,
        accountId: r.account_id,
      }));
    });
  }

  async recordPayment(ctx: Ctx, leaseId: string, req: RentPaymentRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      await this.recordPaymentIn(trx, ctx, leaseId, req, 'manual');
      return this.properties.leaseDtoById(trx, ctx, leaseId);
    });
  }

  async recordPaymentIn(
    trx: Trx,
    ctx: Ctx,
    leaseId: string,
    req: RentPaymentRequest,
    source: 'auto' | 'manual',
  ): Promise<void> {
    const lease = await this.properties.leaseRow(trx, ctx, leaseId);
    const e = await rentalEntity(trx, ctx, lease.entity_id);
    const income = await categoryOnLine(trx, ctx, lease.entity_id, SCH_E.RENTS);
    const splitsFor = (amount: bigint): SplitSpec[] => [
      {
        accountId: income,
        amount: String(amount),
        memberId: null,
        propertyId: lease.property_id,
        unitId: lease.unit_id,
      },
    ];
    const owner = { leaseId };
    let transactionId: string;
    let amount: bigint;
    let depositSpec: unknown = null;
    if ('transactionId' in req) {
      const t = await trx
        .selectFrom('app.transaction')
        .select(['spec', 'payee_key'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      const size = BigInt((t.spec as { amount?: string } | null)?.amount ?? '0');
      const taken = await this.links.takeOver(trx, ctx, req.transactionId, owner, splitsFor(size), {
        sign: 1,
        currency: e.currency,
      });
      transactionId = req.transactionId;
      amount = taken.amount;
      depositSpec = taken.previous;
      if (t.payee_key) await this.learnPayeeKey(trx, ctx, leaseId, t.payee_key);
    } else {
      amount = BigInt(req.amount);
      const tenants = await this.tenantNames(trx, ctx, leaseId);
      transactionId = await this.links.create(trx, ctx, {
        entityId: lease.entity_id,
        accountId: req.accountId,
        date: req.date,
        amount,
        currency: e.currency,
        payee: tenants.join(', ') || 'Rent',
        payeeKey: null,
        description: 'Rent',
        source: 'rent',
        owner,
        splits: splitsFor(amount),
      });
    }
    await trx
      .insertInto('app.rent_payment')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: lease.entity_id,
        lease_id: leaseId,
        transaction_id: transactionId,
        amount_minor: amount,
        source,
        deposit_spec: depositSpec ? JSON.stringify(depositSpec) : null,
        created_by: ctx.userId,
      })
      .execute();
  }

  async removePayment(ctx: Ctx, leaseId: string, paymentId: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const p = await trx
        .selectFrom('app.rent_payment')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', '=', leaseId)
        .where('id', '=', paymentId)
        .executeTakeFirst();
      if (!p) throw notFound('Payment');
      await trx
        .deleteFrom('app.rent_payment')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', paymentId)
        .execute();
      await this.links.release(trx, ctx, p.transaction_id, p.deposit_spec);
    });
  }

  private async tenantNames(trx: Trx, ctx: Ctx, leaseId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('app.lease_tenant as lt')
      .innerJoin('app.tenant as t', (j) =>
        j.onRef('t.workspace_id', '=', 'lt.workspace_id').onRef('t.id', '=', 'lt.tenant_id'),
      )
      .select('t.name')
      .where('lt.workspace_id', '=', ctx.workspaceId)
      .where('lt.lease_id', '=', leaseId)
      .orderBy('t.name')
      .execute();
    return rows.map((r) => r.name);
  }

  /** The name this payment came under is this tenant's from now on, so the next one links by itself. */
  private async learnPayeeKey(trx: Trx, ctx: Ctx, leaseId: string, key: string): Promise<void> {
    await sql`
      update app.tenant t set payee_keys = array_append(t.payee_keys, ${key})
       where t.workspace_id = ${ctx.workspaceId} and not (${key} = any(t.payee_keys))
         and t.id = (select lt.tenant_id from app.lease_tenant lt
                      where lt.workspace_id = ${ctx.workspaceId} and lt.lease_id = ${leaseId}
                      order by lt.tenant_id limit 1)`.execute(trx);
  }

  // ----- Security deposits (RNT-10) ------------------------------------------------------------------------

  private async depositAccount(trx: Trx, ctx: Ctx, entityId: string): Promise<string> {
    const a = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('system_role', '=', 'security_deposits_held')
      .executeTakeFirst();
    if (!a) throw unprocessable('rental.category', 'This portfolio is missing its security deposits account');
    return a.id;
  }

  private async depositHeld(trx: Trx, ctx: Ctx, leaseId: string): Promise<bigint> {
    const events = await trx
      .selectFrom('app.security_deposit_event')
      .select(['kind', 'amount_minor'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('lease_id', '=', leaseId)
      .execute();
    return events.reduce(
      (t, ev) => (ev.kind === 'received' ? t + BigInt(ev.amount_minor) : t - BigInt(ev.amount_minor)),
      0n,
    );
  }

  async addDepositEvent(ctx: Ctx, leaseId: string, req: DepositEventRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      await this.addDepositEventIn(trx, ctx, leaseId, req, 'manual');
      return this.properties.leaseDtoById(trx, ctx, leaseId);
    });
  }

  async addDepositEventIn(
    trx: Trx,
    ctx: Ctx,
    leaseId: string,
    req: DepositEventRequest,
    source: 'auto' | 'manual',
  ): Promise<void> {
    const lease = await this.properties.leaseRow(trx, ctx, leaseId);
    const e = await rentalEntity(trx, ctx, lease.entity_id);
    const liability = await this.depositAccount(trx, ctx, lease.entity_id);
    const held = await this.depositHeld(trx, ctx, leaseId);
    const tags = { propertyId: lease.property_id, unitId: lease.unit_id };
    const owner = { depositLeaseId: leaseId };
    const tenants = (await this.tenantNames(trx, ctx, leaseId)).join(', ') || 'Tenant';
    let kind: 'received' | 'returned' | 'forfeited';
    let date: CalendarDate;
    let amount: bigint;
    let transactionId: string;
    let depositSpec: unknown = null;
    let notes: string | null = null;

    if (req.kind === 'received') {
      const t = await trx
        .selectFrom('app.transaction')
        .select('spec')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      const size = BigInt((t.spec as { amount?: string } | null)?.amount ?? '0');
      const taken = await this.links.takeOver(
        trx,
        ctx,
        req.transactionId,
        owner,
        [{ accountId: liability, amount: String(size), memberId: null, ...tags }],
        { sign: 1, currency: e.currency },
      );
      kind = 'received';
      date = taken.date;
      amount = taken.amount;
      transactionId = req.transactionId;
      depositSpec = taken.previous;
    } else if (req.kind === 'received_new' || req.kind === 'returned') {
      amount = BigInt(req.amount);
      kind = req.kind === 'returned' ? 'returned' : 'received';
      date = req.date;
      notes = req.kind === 'returned' ? (req.notes ?? null) : null;
      if (kind === 'returned' && amount > held) {
        throw unprocessable('deposit.more_than_held', 'This is more than is held for this lease');
      }
      const signed = kind === 'returned' ? -amount : amount;
      transactionId = await this.links.create(trx, ctx, {
        entityId: lease.entity_id,
        accountId: req.accountId,
        date,
        amount: signed,
        currency: e.currency,
        payee: tenants,
        payeeKey: null,
        description: kind === 'returned' ? 'Security deposit returned' : 'Security deposit',
        source: 'security_deposit',
        owner,
        splits: [{ accountId: liability, amount: String(signed), memberId: null, ...tags }],
      });
    } else {
      // No cash moves: what was held becomes income.
      amount = BigInt(req.amount);
      kind = 'forfeited';
      date = req.date;
      notes = req.notes ?? null;
      if (amount > held)
        throw unprocessable('deposit.more_than_held', 'This is more than is held for this lease');
      const income = await categoryOnLine(trx, ctx, lease.entity_id, SCH_E.RENTS);
      transactionId = newId();
      const currency = asCurrencyCode(e.currency);
      const line = (lineNo: number, accountId: string, signed: bigint) => ({
        lineNo,
        accountId,
        accountEntityId: lease.entity_id,
        currency,
        amount: signed,
        functionalAmount: signed,
        fxRate: null,
        memberId: null,
        memo: null,
        ...tags,
      });
      const draft: JournalEntryDraft = {
        entityId: lease.entity_id,
        functionalCurrency: currency,
        entryDate: date,
        kind: 'adjustment',
        description: 'Security deposit forfeited',
        postings: [line(1, liability, amount), line(2, income, -amount)],
      };
      await trx
        .insertInto('app.transaction')
        .values({
          workspace_id: ctx.workspaceId,
          id: transactionId,
          primary_entity_id: lease.entity_id,
          txn_date: date,
          payee_raw: tenants,
          description: 'Security deposit forfeited',
          status: 'posted',
          source: 'security_deposit',
          review_state: 'reviewed',
          // Not a bank line, so there's nothing to edit; this keeps it owned by the lease.
          spec: JSON.stringify({ type: 'adjustment', ...owner }),
          posted_at: new Date(),
          created_by: ctx.userId,
        })
        .execute();
      await this.poster.repost(trx, ctx, transactionId, [draft], { fresh: true });
    }
    await trx
      .insertInto('app.security_deposit_event')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: lease.entity_id,
        lease_id: leaseId,
        kind,
        event_date: date,
        amount_minor: amount,
        transaction_id: transactionId,
        deposit_spec: depositSpec ? JSON.stringify(depositSpec) : null,
        source,
        notes,
        created_by: ctx.userId,
      })
      .execute();
  }

  async removeDepositEvent(ctx: Ctx, leaseId: string, eventId: string): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      const ev = await trx
        .selectFrom('app.security_deposit_event')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', '=', leaseId)
        .where('id', '=', eventId)
        .executeTakeFirst();
      if (!ev) throw notFound('Deposit event');
      const held = await this.depositHeld(trx, ctx, leaseId);
      if (ev.kind === 'received' && BigInt(ev.amount_minor) > held) {
        throw unprocessable('deposit.later_events', 'Remove what was returned or forfeited first');
      }
      await trx
        .deleteFrom('app.security_deposit_event')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', eventId)
        .execute();
      await this.links.release(trx, ctx, ev.transaction_id, ev.deposit_spec);
      return this.properties.leaseDtoById(trx, ctx, leaseId);
    });
  }

  // ----- For the forecast and calendar ----------------------------------------------------------------------

  /** Rent still expected in a range: open charges, and months not yet charged. One overdue is still expected. */
  async expectedBetween(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    from: CalendarDate,
    to: CalendarDate,
    today: CalendarDate,
  ): Promise<
    {
      leaseId: string;
      date: CalendarDate;
      amount: bigint;
      name: string;
      accountId: string | null;
      late: boolean;
    }[]
  > {
    const leases = await this.entityLeases(trx, ctx, entityId);
    if (leases.length === 0) return [];
    const n = await this.names(trx, ctx, entityId);
    const out: {
      leaseId: string;
      date: CalendarDate;
      amount: bigint;
      name: string;
      accountId: string | null;
      late: boolean;
    }[] = [];
    for (const s of await this.leaseStates(trx, ctx, leases, today)) {
      if (leaseStatus(s.lease, today) === 'ended' && !s.charges.some((c) => c.open > 0n)) continue;
      const unit = n.unit.get(s.lease.unit_id)?.label ?? '';
      const property = n.property.get(s.lease.property_id)?.name ?? '';
      const name = `${property} · ${unit}`;
      const charged = new Set(s.charges.filter((c) => c.kind === 'rent').map((c) => c.periodStart));
      for (const c of s.charges) {
        if (c.open <= 0n || c.due > to) continue;
        out.push({
          leaseId: s.lease.id,
          date: c.due < from ? from : c.due,
          amount: c.open,
          name,
          accountId: s.lease.deposit_account_id,
          late: c.due < today,
        });
      }
      let credit = s.credit;
      for (const p of rentPeriods(
        {
          start: iso(s.lease.start_date),
          end: s.lease.end_date ? iso(s.lease.end_date) : null,
          endedOn: s.lease.ended_on ? iso(s.lease.ended_on) : null,
          dueDay: s.lease.due_day,
        },
        to,
      )) {
        if (charged.has(p.periodStart) || p.due < from) continue;
        const rent = BigInt(s.lease.rent_minor);
        const fromCredit = credit < rent ? credit : rent;
        credit -= fromCredit;
        if (rent > fromCredit) {
          out.push({
            leaseId: s.lease.id,
            date: p.due,
            amount: rent - fromCredit,
            name,
            accountId: s.lease.deposit_account_id,
            late: false,
          });
        }
      }
    }
    return out;
  }
}
