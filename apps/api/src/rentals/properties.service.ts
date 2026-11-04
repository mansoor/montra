/**
 * Properties, units, tenants and leases (RNT-01..03; ADR-0018). A unit's occupied or vacant status follows from its leases.
 * Creating or extending a lease writes its rent charges; nightly keeps them a month ahead.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type LeaseRow, type PropertyRow, type TenantRow, type Trx, type UnitRow } from '@montra/db';
import {
  addDays,
  asCurrencyCode,
  calendarDate,
  rentPeriods,
  startOfMonth,
  type CalendarDate,
} from '@montra/domain';
import type {
  CreateLeaseRequest,
  CreatePropertyRequest,
  CreateTenantRequest,
  CreateUnitRequest,
  LeaseDto,
  LeaseStatus,
  PropertyDto,
  TenantDto,
  UnitDto,
  UpdateLeaseRequest,
  UpdatePropertyRequest,
  UpdateTenantRequest,
  UpdateUnitRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { bathsToTenths, rentalEntity, tenthsToBaths, todayOf, type Ctx } from './shared.js';

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

export const leaseStatus = (
  l: Pick<LeaseRow, 'start_date' | 'end_date' | 'ended_on'>,
  today: CalendarDate,
): LeaseStatus => {
  if (l.ended_on && iso(l.ended_on) <= today) return 'ended';
  if (iso(l.start_date) > today) return 'upcoming';
  if (l.end_date && iso(l.end_date) < today) return 'ended';
  return 'active';
};

/** Charges are written this far ahead: through next month, so the coming rent shows on the roll and in the forecast. */
export function chargeHorizon(today: CalendarDate): CalendarDate {
  return addDays(startOfMonth(addDays(startOfMonth(addDays(startOfMonth(today), 32)), 32)), -1);
}

@Injectable()
export class PropertiesService {
  constructor(@Inject(Db) private readonly db: Db) {}

  // ----- Properties ------------------------------------------------------------------------------------------

  async list(ctx: Ctx, entityId: string): Promise<PropertyDto[]> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.property')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .orderBy('name')
        .execute();
      const out: PropertyDto[] = [];
      for (const r of rows) out.push(await this.dto(trx, ctx, r));
      return out;
    });
  }

  async get(ctx: Ctx, id: string): Promise<PropertyDto> {
    return this.db.run(ctx, async (trx) => this.dto(trx, ctx, await this.row(trx, ctx, id)));
  }

  async row(trx: Trx, ctx: Ctx, id: string): Promise<PropertyRow> {
    const r = await trx
      .selectFrom('app.property')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Property');
    return r;
  }

  async create(ctx: Ctx, req: CreatePropertyRequest): Promise<PropertyDto> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, req.entityId);
      const id = newId();
      await trx
        .insertInto('app.property')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: req.entityId,
          name: req.name,
          address: req.address ?? null,
          type: req.type,
          purchase_date: req.purchaseDate ?? null,
          purchase_price_minor: req.purchasePrice ?? null,
          land_value_minor: req.landValue ?? null,
          cash_invested_minor: req.cashInvested ?? null,
          ownership_bps: req.ownershipBps,
          current_value_minor: req.currentValue ?? null,
          sqft: req.sqft ?? null,
          created_by: ctx.userId,
        })
        .execute();
      // A single-family home is one unit; it needs no setting up.
      const units: CreateUnitRequest[] = req.units.length ? req.units : [{ label: 'Main' }];
      for (const u of units) await this.insertUnit(trx, ctx, req.entityId, id, u);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  async update(ctx: Ctx, id: string, req: UpdatePropertyRequest): Promise<PropertyDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      const row = await trx
        .updateTable('app.property')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.address !== undefined ? { address: req.address } : {}),
          ...(req.type !== undefined ? { type: req.type } : {}),
          ...(req.purchaseDate !== undefined ? { purchase_date: req.purchaseDate } : {}),
          ...(req.purchasePrice !== undefined ? { purchase_price_minor: req.purchasePrice } : {}),
          ...(req.landValue !== undefined ? { land_value_minor: req.landValue } : {}),
          ...(req.cashInvested !== undefined ? { cash_invested_minor: req.cashInvested } : {}),
          ...(req.ownershipBps !== undefined ? { ownership_bps: req.ownershipBps } : {}),
          ...(req.currentValue !== undefined ? { current_value_minor: req.currentValue } : {}),
          ...(req.sqft !== undefined ? { sqft: req.sqft } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.dto(trx, ctx, row);
    });
  }

  private async insertUnit(trx: Trx, ctx: Ctx, entityId: string, propertyId: string, u: CreateUnitRequest) {
    await trx
      .insertInto('app.unit')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: entityId,
        property_id: propertyId,
        label: u.label,
        beds: u.beds ?? null,
        baths_tenths: u.baths ? bathsToTenths(u.baths) : null,
        sqft: u.sqft ?? null,
        market_rent_minor: u.marketRent ?? null,
      })
      .execute();
  }

  async createUnit(ctx: Ctx, propertyId: string, req: CreateUnitRequest): Promise<PropertyDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.row(trx, ctx, propertyId);
      await this.insertUnit(trx, ctx, p.entity_id, p.id, req);
      return this.dto(trx, ctx, p);
    });
  }

  async updateUnit(ctx: Ctx, id: string, req: UpdateUnitRequest): Promise<PropertyDto> {
    return this.db.run(ctx, async (trx) => {
      const u = await this.unitRow(trx, ctx, id);
      if (BigInt(u.version) !== BigInt(req.version)) throw conflict();
      await trx
        .updateTable('app.unit')
        .set({
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.beds !== undefined ? { beds: req.beds } : {}),
          ...(req.baths !== undefined ? { baths_tenths: req.baths ? bathsToTenths(req.baths) : null } : {}),
          ...(req.sqft !== undefined ? { sqft: req.sqft } : {}),
          ...(req.marketRent !== undefined ? { market_rent_minor: req.marketRent } : {}),
          ...(req.underRepair !== undefined ? { under_repair: req.underRepair } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return this.dto(trx, ctx, await this.row(trx, ctx, u.property_id));
    });
  }

  async unitRow(trx: Trx, ctx: Ctx, id: string): Promise<UnitRow> {
    const u = await trx
      .selectFrom('app.unit')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!u) throw notFound('Unit');
    return u;
  }

  private async dto(trx: Trx, ctx: Ctx, p: PropertyRow): Promise<PropertyDto> {
    const e = await rentalEntity(trx, ctx, p.entity_id);
    const today = todayOf(e);
    const units = await trx
      .selectFrom('app.unit')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('property_id', '=', p.id)
      .orderBy('label')
      .execute();
    const leases = await trx
      .selectFrom('app.lease')
      .select(['id', 'unit_id', 'start_date', 'end_date', 'ended_on'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('property_id', '=', p.id)
      .execute();
    const unitDtos: UnitDto[] = units.map((u) => {
      const current = leases.find((l) => l.unit_id === u.id && leaseStatus(l, today) === 'active');
      return {
        id: u.id,
        propertyId: u.property_id,
        label: u.label,
        beds: u.beds,
        baths: u.baths_tenths !== null ? tenthsToBaths(u.baths_tenths) : null,
        sqft: u.sqft,
        marketRent: u.market_rent_minor !== null ? String(u.market_rent_minor) : null,
        status: current ? 'occupied' : u.under_repair ? 'under_repair' : 'vacant',
        currentLeaseId: current?.id ?? null,
        archived: u.archived_at !== null,
        version: Number(u.version),
      };
    });
    return {
      id: p.id,
      entityId: p.entity_id,
      name: p.name,
      address: p.address,
      type: p.type,
      purchaseDate: p.purchase_date ? iso(p.purchase_date) : null,
      purchasePrice: p.purchase_price_minor !== null ? String(p.purchase_price_minor) : null,
      landValue: p.land_value_minor !== null ? String(p.land_value_minor) : null,
      cashInvested: p.cash_invested_minor !== null ? String(p.cash_invested_minor) : null,
      ownershipBps: p.ownership_bps,
      currentValue: p.current_value_minor !== null ? String(p.current_value_minor) : null,
      sqft: p.sqft,
      units: unitDtos,
      archived: p.archived_at !== null,
      version: Number(p.version),
    };
  }

  // ----- Tenants ---------------------------------------------------------------------------------------------

  async listTenants(ctx: Ctx, entityId: string): Promise<TenantDto[]> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.tenant')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .orderBy('name')
        .execute();
      return rows.map(tenantDto);
    });
  }

  async createTenant(ctx: Ctx, req: CreateTenantRequest): Promise<TenantDto> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, req.entityId);
      const row = await trx
        .insertInto('app.tenant')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: req.entityId,
          name: req.name,
          email: req.email ?? null,
          phone: req.phone ?? null,
          notes: req.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return tenantDto(row);
    });
  }

  async updateTenant(ctx: Ctx, id: string, req: UpdateTenantRequest): Promise<TenantDto> {
    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .updateTable('app.tenant')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.email !== undefined ? { email: req.email } : {}),
          ...(req.phone !== undefined ? { phone: req.phone } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (row) return tenantDto(row);
      const exists = await trx
        .selectFrom('app.tenant')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      throw exists ? conflict() : notFound('Tenant');
    });
  }

  // ----- Leases ----------------------------------------------------------------------------------------------

  async listLeases(ctx: Ctx, q: { entityId: string; propertyId?: string }): Promise<LeaseDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await rentalEntity(trx, ctx, q.entityId);
      const rows = await trx
        .selectFrom('app.lease')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .$if(!!q.propertyId, (x) => x.where('property_id', '=', q.propertyId!))
        .orderBy('start_date', 'desc')
        .execute();
      const out: LeaseDto[] = [];
      for (const r of rows) out.push(await this.leaseDto(trx, ctx, r, e.currency, todayOf(e)));
      return out;
    });
  }

  async getLease(ctx: Ctx, id: string): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => this.leaseDtoById(trx, ctx, id));
  }

  async leaseDtoById(trx: Trx, ctx: Ctx, id: string): Promise<LeaseDto> {
    const r = await this.leaseRow(trx, ctx, id);
    const e = await rentalEntity(trx, ctx, r.entity_id);
    return this.leaseDto(trx, ctx, r, e.currency, todayOf(e));
  }

  async leaseRow(trx: Trx, ctx: Ctx, id: string): Promise<LeaseRow> {
    const r = await trx
      .selectFrom('app.lease')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Lease');
    return r;
  }

  private async assertNoOverlap(
    trx: Trx,
    ctx: Ctx,
    unitId: string,
    start: CalendarDate,
    end: CalendarDate | null,
    except?: string,
  ): Promise<void> {
    const others = await trx
      .selectFrom('app.lease')
      .select(['id', 'start_date', 'end_date', 'ended_on'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('unit_id', '=', unitId)
      .execute();
    for (const o of others) {
      if (o.id === except) continue;
      const oEnd = o.ended_on ? iso(o.ended_on) : o.end_date ? iso(o.end_date) : null;
      if (
        start <= (oEnd ?? ('9999-12-31' as CalendarDate)) &&
        iso(o.start_date) <= (end ?? ('9999-12-31' as CalendarDate))
      ) {
        throw unprocessable('lease.overlap', 'This unit already has a lease for those dates');
      }
    }
  }

  private async setTenants(
    trx: Trx,
    ctx: Ctx,
    leaseId: string,
    entityId: string,
    ids: string[],
  ): Promise<void> {
    const found = await trx
      .selectFrom('app.tenant')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('id', 'in', ids)
      .execute();
    if (found.length !== new Set(ids).size)
      throw unprocessable('lease.tenant', 'Choose tenants of this portfolio');
    await trx
      .deleteFrom('app.lease_tenant')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('lease_id', '=', leaseId)
      .execute();
    await trx
      .insertInto('app.lease_tenant')
      .values(
        [...new Set(ids)].map((tenant_id) => ({
          workspace_id: ctx.workspaceId,
          lease_id: leaseId,
          tenant_id,
        })),
      )
      .execute();
  }

  async createLease(ctx: Ctx, req: CreateLeaseRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      const u = await this.unitRow(trx, ctx, req.unitId);
      const e = await rentalEntity(trx, ctx, u.entity_id);
      if (req.endDate && req.endDate < req.startDate) {
        throw unprocessable('lease.dates', 'The lease ends before it starts');
      }
      await this.assertNoOverlap(trx, ctx, u.id, req.startDate, req.endDate ?? null);
      const id = newId();
      await trx
        .insertInto('app.lease')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: u.entity_id,
          property_id: u.property_id,
          unit_id: u.id,
          start_date: req.startDate,
          end_date: req.endDate ?? null,
          rent_minor: req.rent,
          due_day: req.dueDay,
          late_grace_days: req.lateGraceDays,
          late_fee_flat_minor: req.lateFeeFlat,
          late_fee_bps: req.lateFeeBps,
          late_fee_cap_minor: req.lateFeeCap ?? null,
          deposit_minor: req.deposit,
          deposit_account_id: req.depositAccountId ?? null,
          attachment_ids: req.fileIds,
          notes: req.notes ?? null,
          created_by: ctx.userId,
        })
        .execute();
      await this.setTenants(trx, ctx, id, u.entity_id, req.tenantIds);
      const row = await this.leaseRow(trx, ctx, id);
      await this.ensureCharges(trx, ctx, row, todayOf(e));
      return this.leaseDto(trx, ctx, row, e.currency, todayOf(e));
    });
  }

  async updateLease(ctx: Ctx, id: string, req: UpdateLeaseRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.leaseRow(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      const e = await rentalEntity(trx, ctx, r.entity_id);
      const end = req.endDate !== undefined ? req.endDate : r.end_date ? iso(r.end_date) : null;
      if (end && end < iso(r.start_date))
        throw unprocessable('lease.dates', 'The lease ends before it starts');
      const endedOn = req.endedOn !== undefined ? req.endedOn : r.ended_on ? iso(r.ended_on) : null;
      await this.assertNoOverlap(trx, ctx, r.unit_id, iso(r.start_date), endedOn ?? end, id);
      const row = await trx
        .updateTable('app.lease')
        .set({
          ...(req.endDate !== undefined ? { end_date: req.endDate } : {}),
          ...(req.endedOn !== undefined ? { ended_on: req.endedOn } : {}),
          ...(req.rent !== undefined ? { rent_minor: req.rent } : {}),
          ...(req.dueDay !== undefined ? { due_day: req.dueDay } : {}),
          ...(req.lateGraceDays !== undefined ? { late_grace_days: req.lateGraceDays } : {}),
          ...(req.lateFeeFlat !== undefined ? { late_fee_flat_minor: req.lateFeeFlat } : {}),
          ...(req.lateFeeBps !== undefined ? { late_fee_bps: req.lateFeeBps } : {}),
          ...(req.lateFeeCap !== undefined ? { late_fee_cap_minor: req.lateFeeCap } : {}),
          ...(req.deposit !== undefined ? { deposit_minor: req.deposit } : {}),
          ...(req.depositAccountId !== undefined ? { deposit_account_id: req.depositAccountId } : {}),
          ...(req.fileIds !== undefined ? { attachment_ids: req.fileIds } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (req.tenantIds) await this.setTenants(trx, ctx, id, r.entity_id, req.tenantIds);
      // Rent no longer due stops being owed once they've moved out or the lease ended sooner.
      const stop = endedOn ?? end;
      if (stop) {
        await trx
          .deleteFrom('app.rent_charge')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('lease_id', '=', id)
          .where('due_date', '>', stop)
          .execute();
      }
      await this.ensureCharges(trx, ctx, row, todayOf(e));
      return this.leaseDto(trx, ctx, row, e.currency, todayOf(e));
    });
  }

  /** Writes any rent charges not there yet. Existing ones keep their amounts: an edited charge stays edited. */
  async ensureCharges(trx: Trx, ctx: Ctx, l: LeaseRow, today: CalendarDate): Promise<number> {
    const periods = rentPeriods(
      {
        start: iso(l.start_date),
        end: l.end_date ? iso(l.end_date) : null,
        endedOn: l.ended_on ? iso(l.ended_on) : null,
        dueDay: l.due_day,
      },
      chargeHorizon(today),
    );
    if (periods.length === 0) return 0;
    const res = await trx
      .insertInto('app.rent_charge')
      .values(
        periods.map((p) => ({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: l.entity_id,
          lease_id: l.id,
          kind: 'rent' as const,
          period_start: p.periodStart,
          due_date: p.due,
          amount_minor: BigInt(l.rent_minor),
        })),
      )
      .onConflict((oc) => oc.columns(['workspace_id', 'lease_id', 'kind', 'period_start']).doNothing())
      .executeTakeFirst();
    return Number(res.numInsertedOrUpdatedRows ?? 0);
  }

  private async leaseDto(
    trx: Trx,
    ctx: Ctx,
    r: LeaseRow,
    currency: string,
    today: CalendarDate,
  ): Promise<LeaseDto> {
    const [unit, property, tenants, events] = await Promise.all([
      trx
        .selectFrom('app.unit')
        .select('label')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.unit_id)
        .executeTakeFirst(),
      trx
        .selectFrom('app.property')
        .select('name')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.property_id)
        .executeTakeFirst(),
      trx
        .selectFrom('app.lease_tenant as lt')
        .innerJoin('app.tenant as t', (j) =>
          j.onRef('t.workspace_id', '=', 'lt.workspace_id').onRef('t.id', '=', 'lt.tenant_id'),
        )
        .select(['t.id', 't.name'])
        .where('lt.workspace_id', '=', ctx.workspaceId)
        .where('lt.lease_id', '=', r.id)
        .orderBy('t.name')
        .execute(),
      trx
        .selectFrom('app.security_deposit_event')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', '=', r.id)
        .orderBy('event_date')
        .orderBy('created_at')
        .execute(),
    ]);
    const held = events.reduce(
      (t, ev) => (ev.kind === 'received' ? t + BigInt(ev.amount_minor) : t - BigInt(ev.amount_minor)),
      0n,
    );
    return {
      id: r.id,
      entityId: r.entity_id,
      propertyId: r.property_id,
      propertyName: property?.name ?? '',
      unitId: r.unit_id,
      unitLabel: unit?.label ?? '',
      tenants,
      status: leaseStatus(r, today),
      startDate: iso(r.start_date),
      endDate: r.end_date ? iso(r.end_date) : null,
      endedOn: r.ended_on ? iso(r.ended_on) : null,
      rent: String(r.rent_minor),
      dueDay: r.due_day,
      lateGraceDays: r.late_grace_days,
      lateFeeFlat: String(r.late_fee_flat_minor),
      lateFeeBps: r.late_fee_bps,
      lateFeeCap: r.late_fee_cap_minor !== null ? String(r.late_fee_cap_minor) : null,
      deposit: String(r.deposit_minor),
      depositHeld: String(held),
      depositEvents: events.map((ev) => ({
        id: ev.id,
        kind: ev.kind,
        date: iso(ev.event_date),
        amount: String(ev.amount_minor),
        transactionId: ev.transaction_id,
        source: ev.source,
        notes: ev.notes,
      })),
      depositAccountId: r.deposit_account_id,
      fileIds: r.attachment_ids,
      notes: r.notes,
      currency: asCurrencyCode(currency),
      version: Number(r.version),
    };
  }
}

function tenantDto(t: TenantRow): TenantDto {
  return {
    id: t.id,
    entityId: t.entity_id,
    name: t.name,
    email: t.email,
    phone: t.phone,
    notes: t.notes,
    version: Number(t.version),
  };
}
