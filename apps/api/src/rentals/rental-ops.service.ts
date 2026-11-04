/**
 * Shared-expense allocation, reminders, the maintenance log and budgets per property (RNT-07, RNT-12, RNT-13, RNT-14), and
 * accepting a capital improvement flag (RNT-09).
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type MaintenanceRow, type ReminderRow, type Trx } from '@montra/db';
import {
  addDays,
  allocateShared,
  asCurrencyCode,
  calendarDate,
  endOfMonth,
  leaseExpiryWindow,
  startOfMonth,
  type CalendarDate,
} from '@montra/domain';
import type {
  AllocateTransactionRequest,
  AllocationBasis,
  AllocationRuleDto,
  CreateAllocationRuleRequest,
  CreateMaintenanceRequest,
  CreateReminderRequest,
  MaintenanceDto,
  PropertyBudgetDto,
  ReminderDto,
  SavePropertyBudgetRequest,
  TransactionDto,
  UpdateMaintenanceRequest,
  UpdateReminderRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { ownerOf, type SplitSpec, type TransactionSpec } from '../transactions/poster.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { leaseStatus, PropertiesService } from './properties.service.js';
import { rentalEntity, todayOf, type Ctx } from './shared.js';

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));
const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');

type Target = { propertyId: string; percentBps?: number | null };

@Injectable()
export class RentalOpsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
  ) {}

  // ----- Allocation (RNT-07) -----------------------------------------------------------------------------------

  async listRules(ctx: Ctx, entityId: string): Promise<AllocationRuleDto[]> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.allocation_rule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        entityId: r.entity_id,
        name: r.name,
        basis: r.basis,
        targets: (r.targets as Target[]).map((t) => ({
          propertyId: t.propertyId,
          percentBps: t.percentBps ?? null,
        })),
        version: Number(r.version),
      }));
    });
  }

  async createRule(ctx: Ctx, req: CreateAllocationRuleRequest): Promise<{ id: string }> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, req.entityId);
      await this.weights(trx, ctx, req.entityId, req.basis, req.targets);
      const id = newId();
      await trx
        .insertInto('app.allocation_rule')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: req.entityId,
          name: req.name,
          basis: req.basis,
          targets: JSON.stringify(req.targets),
        })
        .execute();
      return { id };
    });
  }

  async removeRule(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .updateTable('app.allocation_rule')
        .set({ archived_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numUpdatedRows) throw notFound('Rule');
    });
  }

  /** What each property's share is weighted by. Units and square footage are read now, so a rule stays current. */
  private async weights(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    basis: AllocationBasis,
    targets: readonly Target[],
  ): Promise<bigint[]> {
    const ids = targets.map((t) => t.propertyId);
    if (new Set(ids).size !== ids.length)
      throw unprocessable('allocation.duplicate', 'A property is listed twice');
    const props = await trx
      .selectFrom('app.property')
      .select(['id', 'sqft'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('id', 'in', ids)
      .execute();
    if (props.length !== ids.length)
      throw unprocessable('allocation.property', 'Choose properties of this portfolio');
    if (basis === 'percent') {
      const bps = targets.map((t) => t.percentBps ?? 0);
      if (bps.reduce((a, b) => a + b, 0) !== 10000) {
        throw unprocessable('allocation.percent', 'The percentages must add up to 100');
      }
      return bps.map(BigInt);
    }
    const units = await trx
      .selectFrom('app.unit')
      .select(['property_id', 'sqft'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('property_id', 'in', ids)
      .where('archived_at', 'is', null)
      .execute();
    const out = ids.map((id) => {
      const own = units.filter((u) => u.property_id === id);
      if (basis === 'units') return BigInt(own.length);
      const prop = props.find((p) => p.id === id)!;
      return BigInt(prop.sqft ?? own.reduce((t, u) => t + (u.sqft ?? 0), 0));
    });
    if (out.some((w) => w <= 0n)) {
      throw unprocessable(
        'allocation.basis',
        basis === 'sqft'
          ? 'Enter the square footage of each property'
          : 'Each property needs at least one unit',
      );
    }
    return out;
  }

  /** Splits each of a transaction's categories across the properties, to the cent. */
  async allocate(ctx: Ctx, transactionId: string, req: AllocateTransactionRequest): Promise<TransactionDto> {
    await this.db.run(ctx, async (trx) => {
      const t = await trx
        .selectFrom('app.transaction')
        .select(['spec', 'primary_entity_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      const spec = t.spec as TransactionSpec | null;
      if (spec?.type !== 'standard' || ownerOf(spec)) {
        throw unprocessable(
          'allocation.not_applicable',
          'This transaction cannot be split across properties',
        );
      }
      let basis: AllocationBasis;
      let targets: Target[];
      if ('ruleId' in req) {
        const rule = await trx
          .selectFrom('app.allocation_rule')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', req.ruleId)
          .executeTakeFirst();
        if (!rule) throw notFound('Rule');
        basis = rule.basis;
        targets = rule.targets as Target[];
      } else {
        basis = req.basis;
        targets = req.targets;
      }
      const weights = await this.weights(trx, ctx, t.primary_entity_id, basis, targets);
      const splits: {
        accountId: string;
        amount: { amount: string; currency: string };
        propertyId: string;
        memberId: string | null;
        memo?: string;
      }[] = [];
      for (const s of spec.splits) {
        allocateShared(BigInt(s.amount), weights).forEach((part, i) => {
          if (part === 0n) return;
          splits.push({
            accountId: s.accountId,
            amount: { amount: String(part), currency: spec.currency },
            propertyId: targets[i]!.propertyId,
            memberId: s.memberId,
            ...(s.memo ? { memo: s.memo } : {}),
          });
        });
      }
      await this.transactions.updateInTrx(trx, ctx, transactionId, { splits } as never, undefined, {
        learn: false,
      });
    });
    return this.transactions.getOrThrow(ctx, transactionId);
  }

  // ----- Reminders (RNT-12) ------------------------------------------------------------------------------------

  async reminders(ctx: Ctx, entityId: string): Promise<ReminderDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await rentalEntity(trx, ctx, entityId);
      const today = todayOf(e);
      const stored = await trx
        .selectFrom('app.rental_reminder')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('done_at', 'is', null)
        .execute();
      const out: ReminderDto[] = stored.map((r) => reminderDto(r, today));
      const leases = await trx
        .selectFrom('app.lease as l')
        .innerJoin('app.unit as u', (j) =>
          j.onRef('u.workspace_id', '=', 'l.workspace_id').onRef('u.id', '=', 'l.unit_id'),
        )
        .innerJoin('app.property as p', (j) =>
          j.onRef('p.workspace_id', '=', 'l.workspace_id').onRef('p.id', '=', 'l.property_id'),
        )
        .select(['l.id', 'l.property_id', 'l.start_date', 'l.end_date', 'l.ended_on', 'u.label', 'p.name'])
        .where('l.workspace_id', '=', ctx.workspaceId)
        .where('l.entity_id', '=', entityId)
        .where('l.end_date', 'is not', null)
        .where('l.ended_on', 'is', null)
        .execute();
      for (const l of leases) {
        const end = iso(l.end_date);
        if (leaseStatus(l, today) !== 'active' || !leaseExpiryWindow(end, today)) continue;
        out.push({
          id: null,
          kind: 'lease_end',
          title: `${l.name} · ${l.label}`,
          propertyId: l.property_id,
          leaseId: l.id,
          dueDate: end,
          active: true,
          overdue: false,
          version: null,
        });
      }
      return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
    });
  }

  async createReminder(ctx: Ctx, req: CreateReminderRequest): Promise<ReminderDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await rentalEntity(trx, ctx, req.entityId);
      if (req.propertyId) {
        const p = await this.properties.row(trx, ctx, req.propertyId);
        if (p.entity_id !== req.entityId)
          throw unprocessable('reminder.property', 'Choose a property of this portfolio');
      }
      const row = await trx
        .insertInto('app.rental_reminder')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: req.entityId,
          property_id: req.propertyId ?? null,
          kind: req.kind,
          title: req.title,
          due_date: req.dueDate,
          lead_days: req.leadDays,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return reminderDto(row, todayOf(e));
    });
  }

  async updateReminder(ctx: Ctx, id: string, req: UpdateReminderRequest): Promise<ReminderDto> {
    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .updateTable('app.rental_reminder')
        .set({
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.dueDate !== undefined ? { due_date: req.dueDate } : {}),
          ...(req.done !== undefined ? { done_at: req.done ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (row) return reminderDto(row, todayOf(await rentalEntity(trx, ctx, row.entity_id)));
      const exists = await trx
        .selectFrom('app.rental_reminder')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      throw exists ? conflict() : notFound('Reminder');
    });
  }

  // ----- Maintenance (RNT-13) ----------------------------------------------------------------------------------

  async listMaintenance(ctx: Ctx, q: { entityId: string; propertyId?: string }): Promise<MaintenanceDto[]> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, q.entityId);
      const rows = await trx
        .selectFrom('app.maintenance_log')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .$if(!!q.propertyId, (x) => x.where('property_id', '=', q.propertyId!))
        .orderBy('reported_on', 'desc')
        .limit(500)
        .execute();
      return this.maintenanceDtos(trx, ctx, rows);
    });
  }

  private async maintenanceDtos(trx: Trx, ctx: Ctx, rows: MaintenanceRow[]): Promise<MaintenanceDto[]> {
    if (rows.length === 0) return [];
    const props = await trx
      .selectFrom('app.property')
      .select(['id', 'name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', [...new Set(rows.map((r) => r.property_id))])
      .execute();
    const unitIds = [...new Set(rows.map((r) => r.unit_id).filter((u): u is string => !!u))];
    const units = unitIds.length
      ? await trx
          .selectFrom('app.unit')
          .select(['id', 'label'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', unitIds)
          .execute()
      : [];
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      propertyId: r.property_id,
      propertyName: props.find((p) => p.id === r.property_id)?.name ?? '',
      unitId: r.unit_id,
      unitLabel: units.find((u) => u.id === r.unit_id)?.label ?? null,
      issue: r.issue,
      vendor: r.vendor,
      cost: r.cost_minor !== null ? String(r.cost_minor) : null,
      status: r.status,
      reportedOn: iso(r.reported_on),
      completedOn: r.completed_on ? iso(r.completed_on) : null,
      fileIds: r.attachment_ids,
      transactionIds: r.transaction_ids,
      notes: r.notes,
      version: Number(r.version),
    }));
  }

  private async checkMaintenanceLinks(
    trx: Trx,
    ctx: Ctx,
    propertyId: string,
    unitId: string | null | undefined,
    fileIds: string[] | undefined,
    transactionIds: string[] | undefined,
  ): Promise<void> {
    if (unitId) {
      const u = await this.properties.unitRow(trx, ctx, unitId);
      if (u.property_id !== propertyId)
        throw unprocessable('maintenance.unit', 'That unit is in another property');
    }
    if (fileIds?.length) {
      const found = await trx
        .selectFrom('app.file')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', fileIds)
        .execute();
      if (found.length !== new Set(fileIds).size) throw notFound('File');
    }
    if (transactionIds?.length) {
      const found = await trx
        .selectFrom('app.transaction')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', transactionIds)
        .execute();
      if (found.length !== new Set(transactionIds).size) throw notFound('Transaction');
    }
  }

  async createMaintenance(ctx: Ctx, req: CreateMaintenanceRequest): Promise<MaintenanceDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.properties.row(trx, ctx, req.propertyId);
      await this.checkMaintenanceLinks(trx, ctx, p.id, req.unitId, req.fileIds, req.transactionIds);
      const row = await trx
        .insertInto('app.maintenance_log')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          property_id: p.id,
          unit_id: req.unitId ?? null,
          issue: req.issue,
          vendor: req.vendor ?? null,
          cost_minor: req.cost ?? null,
          reported_on: req.reportedOn,
          attachment_ids: req.fileIds,
          transaction_ids: req.transactionIds,
          notes: req.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.maintenanceDtos(trx, ctx, [row]))[0]!;
    });
  }

  async updateMaintenance(ctx: Ctx, id: string, req: UpdateMaintenanceRequest): Promise<MaintenanceDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await trx
        .selectFrom('app.maintenance_log')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!r) throw notFound('Maintenance item');
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      await this.checkMaintenanceLinks(trx, ctx, r.property_id, req.unitId, req.fileIds, req.transactionIds);
      const row = await trx
        .updateTable('app.maintenance_log')
        .set({
          ...(req.unitId !== undefined ? { unit_id: req.unitId } : {}),
          ...(req.issue !== undefined ? { issue: req.issue } : {}),
          ...(req.vendor !== undefined ? { vendor: req.vendor } : {}),
          ...(req.cost !== undefined ? { cost_minor: req.cost } : {}),
          ...(req.reportedOn !== undefined ? { reported_on: req.reportedOn } : {}),
          ...(req.fileIds !== undefined ? { attachment_ids: req.fileIds } : {}),
          ...(req.transactionIds !== undefined ? { transaction_ids: req.transactionIds } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
          ...(req.status !== undefined ? { status: req.status } : {}),
          ...(req.completedOn !== undefined ? { completed_on: req.completedOn } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.maintenanceDtos(trx, ctx, [row]))[0]!;
    });
  }

  // ----- Budgets per property (RNT-14) -------------------------------------------------------------------------

  async budget(ctx: Ctx, propertyId: string, month?: CalendarDate): Promise<PropertyBudgetDto> {
    return this.db.run(ctx, (trx) => this.budgetIn(trx, ctx, propertyId, month));
  }

  private async budgetIn(
    trx: Trx,
    ctx: Ctx,
    propertyId: string,
    month?: CalendarDate,
  ): Promise<PropertyBudgetDto> {
    const p = await this.properties.row(trx, ctx, propertyId);
    const e = await rentalEntity(trx, ctx, p.entity_id);
    const start = startOfMonth(month ?? todayOf(e));
    const end = endOfMonth(start);
    const [budget, lines, units] = await Promise.all([
      trx
        .selectFrom('app.property_budget')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('property_id', '=', propertyId)
        .executeTakeFirst(),
      trx
        .selectFrom('app.property_budget_line')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('property_id', '=', propertyId)
        .execute(),
      trx
        .selectFrom('app.unit')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('property_id', '=', propertyId)
        .where('archived_at', 'is', null)
        .execute(),
    ]);
    const { rows: spent } = await sql<{ id: string; name: string; type: string; amount: string }>`
      select a.id, a.name, a.type, sum(p.functional_amount_minor)::text as amount
        from app.posting p
        join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
       where p.workspace_id = ${ctx.workspaceId} and p.property_id = ${propertyId}
         and p.entry_date between ${start} and ${end} and a.type in ('income', 'expense')
       group by a.id, a.name, a.type`.execute(trx);
    const { rows: rent } = await sql<{ expected: string }>`
      select coalesce(sum(c.amount_minor), 0)::text as expected
        from app.rent_charge c
        join app.lease l on l.workspace_id = c.workspace_id and l.id = c.lease_id
       where c.workspace_id = ${ctx.workspaceId} and l.property_id = ${propertyId}
         and c.kind = 'rent' and c.waived_at is null and c.due_date between ${start} and ${end}`.execute(trx);
    const names = lines.length
      ? await trx
          .selectFrom('app.ledger_account')
          .select(['id', 'name'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where(
            'id',
            'in',
            lines.map((l) => l.category_id),
          )
          .execute()
      : [];
    const reservePerUnit = BigInt(budget?.capex_reserve_per_unit_minor ?? 0);
    const reserve = reservePerUnit * BigInt(units.length);
    const expected = BigInt(rent[0]?.expected ?? '0');
    const planned = lines.reduce((t, l) => t + BigInt(l.amount_minor), 0n);
    const expenses = spent.filter((s) => s.type === 'expense');
    const lineIds = new Set(lines.map((l) => l.category_id));
    return {
      propertyId,
      month: start,
      currency: asCurrencyCode(e.currency),
      units: units.length,
      capexReservePerUnit: String(reservePerUnit),
      capexReserve: String(reserve),
      expectedRent: String(expected),
      receivedRent: String(
        spent.filter((s) => s.type === 'income').reduce((t, s) => t - BigInt(s.amount), 0n),
      ),
      planned: String(planned),
      spent: String(expenses.reduce((t, s) => t + BigInt(s.amount), 0n)),
      expectedNet: String(expected - planned - reserve),
      lines: [
        ...lines.map((l) => ({
          categoryId: l.category_id,
          name: names.find((n) => n.id === l.category_id)?.name ?? '',
          planned: String(l.amount_minor),
          spent: expenses.find((s) => s.id === l.category_id)?.amount ?? '0',
        })),
        // Spending nobody planned for still shows.
        ...expenses
          .filter((s) => !lineIds.has(s.id))
          .map((s) => ({ categoryId: s.id, name: s.name, planned: '0', spent: s.amount })),
      ].sort((a, b) => a.name.localeCompare(b.name)),
      version: budget ? Number(budget.version) : null,
    };
  }

  async saveBudget(ctx: Ctx, propertyId: string, req: SavePropertyBudgetRequest): Promise<PropertyBudgetDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.properties.row(trx, ctx, propertyId);
      const ids = [...new Set(req.lines.map((l) => l.categoryId))];
      if (ids.length !== req.lines.length)
        throw unprocessable('budget.category', 'A category is listed twice');
      if (ids.length) {
        const cats = await trx
          .selectFrom('app.ledger_account')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', p.entity_id)
          .where('type', '=', 'expense')
          .where('id', 'in', ids)
          .execute();
        if (cats.length !== ids.length)
          throw unprocessable('budget.category', 'Choose expense categories of this portfolio');
      }
      await trx
        .insertInto('app.property_budget')
        .values({
          workspace_id: ctx.workspaceId,
          property_id: p.id,
          entity_id: p.entity_id,
          capex_reserve_per_unit_minor: req.capexReservePerUnit,
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'property_id'])
            .doUpdateSet({ capex_reserve_per_unit_minor: req.capexReservePerUnit }),
        )
        .execute();
      await trx
        .deleteFrom('app.property_budget_line')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('property_id', '=', p.id)
        .execute();
      if (req.lines.length) {
        await trx
          .insertInto('app.property_budget_line')
          .values(
            req.lines.map((l) => ({
              workspace_id: ctx.workspaceId,
              property_id: p.id,
              entity_id: p.entity_id,
              category_id: l.categoryId,
              amount_minor: l.amount,
            })),
          )
          .execute();
      }
      return this.budgetIn(trx, ctx, p.id);
    });
  }

  // ----- Capital improvements (RNT-09) -------------------------------------------------------------------------

  /**
   * Moves an expense to the property's improvements account and starts depreciating it. An asset, not an expense: it no
   * longer reduces this year's profit, and depreciation does that over time instead.
   */
  async capitalize(trx: Trx, ctx: Ctx, transactionId: string, propertyId: string): Promise<void> {
    const p = await this.properties.row(trx, ctx, propertyId);
    const e = await rentalEntity(trx, ctx, p.entity_id);
    const t = await trx
      .selectFrom('app.transaction')
      .select(['spec', 'txn_date', 'payee_raw', 'description'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .executeTakeFirst();
    if (!t) throw notFound('Transaction');
    const spec = t.spec as TransactionSpec | null;
    if (spec?.type !== 'standard' || ownerOf(spec) || BigInt(spec.amount) >= 0n) {
      throw unprocessable('capital.not_applicable', 'This transaction cannot be capitalized');
    }
    let account = p.improvements_account_id;
    if (!account) {
      account = newId();
      await trx
        .insertInto('app.ledger_account')
        .values({
          workspace_id: ctx.workspaceId,
          id: account,
          entity_id: p.entity_id,
          name: `${p.name} improvements`,
          type: 'asset',
          currency: e.currency,
          is_category: false,
        })
        .execute();
      await trx
        .updateTable('app.property')
        .set({ improvements_account_id: account })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.id)
        .execute();
    }
    const splits: SplitSpec[] = spec.splits.map((s) => ({ ...s }));
    await this.transactions.updateInTrx(
      trx,
      ctx,
      transactionId,
      {
        splits: splits.map((s) => ({
          accountId: account!,
          amount: { amount: s.amount, currency: spec.currency },
          memberId: s.memberId,
          propertyId: p.id,
          ...(s.unitId ? { unitId: s.unitId } : {}),
        })),
      } as never,
      undefined,
      { learn: false },
    );
    await trx
      .insertInto('app.depreciation_schedule')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: p.entity_id,
        property_id: p.id,
        name: t.payee_raw || t.description || 'Improvement',
        basis_minor: -BigInt(spec.amount),
        in_service_date: iso(t.txn_date),
        method: p.type === 'commercial' ? 'SL_39' : 'SL_27_5',
        transaction_id: transactionId,
      })
      .execute();
  }
}

function reminderDto(r: ReminderRow, today: CalendarDate): ReminderDto {
  const due = iso(r.due_date);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    propertyId: r.property_id,
    leaseId: null,
    dueDate: due,
    active: addDays(due, -r.lead_days) <= today,
    overdue: due < today,
    version: Number(r.version),
  };
}
