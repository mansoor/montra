/**
 * Budgets (BUD-01..10, FAM-06, UP-11; design 04 §8, ADR-0015). Only intent is stored (lines, moves, the
 * income override); every number in a period view comes from the domain engine walking the periods in order.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { BudgetRow, Trx } from '@montra/db';
import {
  calendarDate,
  computeBudget,
  copyAmounts,
  draftBudget,
  fiftyThirtyTwenty,
  isPeriodStart,
  periodContaining,
  periodsBetween,
  shiftPeriod,
  sinkingFundMonthly,
  spendingPace,
  PACE_KINDS,
  type CalendarDate,
  type GroupKind,
  type Period,
  type PeriodInput,
  type PeriodResult,
  type PeriodSpec,
  type RolloverMode,
} from '@montra/domain';
import type {
  AssignRequest,
  BudgetDto,
  BudgetGroupDto,
  BudgetLineDto,
  BudgetMoveDto,
  BudgetPeriodDto,
  CopyBudgetRequest,
  CreateBudgetRequest,
  DraftBudgetDto,
  DraftBudgetRequest,
  MoveRequest,
  UpdateBudgetPeriodRequest,
  UpdateBudgetRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { AiService } from '../ai/ai.service.js';
import {
  occurrenceTotal,
  PlanningData,
  previousMonths,
  type ActivityFilter,
  type Ctx,
  type IncomeOccurrence,
  type PlanCategory,
} from './data.js';
import { wordSummary } from './wording.js';

/** How far back the engine walks to compute carried-in amounts (5 years of months). */
const MAX_WALK = 60;

/** Group kinds whose categories get budget lines. */
const BUDGET_KINDS: ReadonlySet<GroupKind> = new Set([
  'fixed',
  'daily',
  'fun',
  'savings',
  'debt',
  'business',
  'rental',
]);

export const isBudgetCategory = (c: PlanCategory) =>
  c.type === 'expense' && c.kind !== null && BUDGET_KINDS.has(c.kind);

export interface ComputedPeriod {
  budget: BudgetRow;
  spec: PeriodSpec;
  currency: string;
  period: Period;
  today: CalendarDate;
  categories: PlanCategory[];
  /** All computed periods, oldest first; the last one is `period`. */
  results: PeriodResult[];
  income: { expected: bigint; actual: bigint; budgeted: bigint; occurrences: IncomeOccurrence[] };
  status: 'open' | 'closed';
  /** Unbudgeted expense activity (system categories without a group). */
  unbudgeted: Map<string, bigint>;
}

export const specOf = (b: Pick<BudgetRow, 'period_type' | 'anchor_date'>): PeriodSpec => ({
  type: b.period_type,
  anchor: b.anchor_date ? calendarDate(b.anchor_date) : null,
});

export const conflict = () =>
  new AppError(409, 'version.conflict', 'The budget was changed by someone else; reload and try again');

@Injectable()
export class BudgetsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PlanningData) private readonly data: PlanningData,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  // ----- Budgets ---------------------------------------------------------------------------------------

  async create(ctx: Ctx, req: CreateBudgetRequest): Promise<BudgetDto> {
    return this.db.run(ctx, async (trx) => {
      const existing = await trx
        .selectFrom('app.budget')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', req.entityId)
        .where('archived_at', 'is', null)
        .$if(req.memberId === null, (q) => q.where('member_id', 'is', null))
        .$if(req.memberId !== null, (q) => q.where('member_id', '=', req.memberId!))
        .executeTakeFirst();
      if (existing) throw new AppError(409, 'budget.exists', 'This entity (or member) already has a budget');
      if (req.periodType !== 'monthly' && req.anchorDate === null) {
        throw unprocessable('budget.anchor_required', 'Weekly and biweekly budgets need an anchor date');
      }
      const row = await trx
        .insertInto('app.budget')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: req.entityId,
          member_id: req.memberId,
          name: req.name,
          method: req.method,
          period_type: req.periodType,
          anchor_date: req.periodType === 'monthly' ? null : req.anchorDate,
          savings_target_minor: req.savingsTarget,
          revenue_target_minor: req.revenueTarget,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.toDto(trx, ctx, row);
    });
  }

  async list(ctx: Ctx, entityId?: string): Promise<BudgetDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.budget')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!entityId, (q) => q.where('entity_id', '=', entityId!))
        .orderBy('archived_at', (ob) => ob.nullsFirst())
        .orderBy('created_at')
        .execute();
      return Promise.all(rows.map((r) => this.toDto(trx, ctx, r)));
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateBudgetRequest): Promise<BudgetDto> {
    return this.db.run(ctx, async (trx) => {
      await this.load(trx, ctx, id);
      const row = await trx
        .updateTable('app.budget')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.method !== undefined ? { method: req.method } : {}),
          ...(req.savingsTarget !== undefined ? { savings_target_minor: req.savingsTarget } : {}),
          ...(req.revenueTarget !== undefined ? { revenue_target_minor: req.revenueTarget } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row) throw conflict();
      return this.toDto(trx, ctx, row);
    });
  }

  // ----- Periods ---------------------------------------------------------------------------------------

  async period(ctx: Ctx, id: string, start?: CalendarDate): Promise<BudgetPeriodDto> {
    return this.db.run(ctx, async (trx) => this.periodDto(trx, ctx, await this.compute(trx, ctx, id, start)));
  }

  async assign(
    ctx: Ctx,
    id: string,
    start: CalendarDate,
    categoryId: string,
    req: AssignRequest,
  ): Promise<BudgetPeriodDto> {
    return this.write(ctx, id, start, req.version, async (trx, budget, periodId) => {
      await this.budgetCategory(trx, ctx, budget, categoryId);
      const rollover =
        req.rolloverMode ?? (await this.inheritedRollover(trx, ctx, budget.id, start, categoryId));
      await trx
        .insertInto('app.budget_line')
        .values({
          workspace_id: ctx.workspaceId,
          budget_period_id: periodId,
          category_id: categoryId,
          assigned_minor: req.assigned,
          rollover_mode: rollover,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'budget_period_id', 'category_id']).doUpdateSet({
            assigned_minor: req.assigned,
            ...(req.rolloverMode ? { rollover_mode: req.rolloverMode } : {}),
          }),
        )
        .execute();
    });
  }

  async move(ctx: Ctx, id: string, start: CalendarDate, req: MoveRequest): Promise<BudgetPeriodDto> {
    return this.write(ctx, id, start, req.version, async (trx, budget, periodId) => {
      for (const c of [req.from, req.to]) if (c) await this.budgetCategory(trx, ctx, budget, c);
      await trx
        .insertInto('app.budget_move')
        .values({
          workspace_id: ctx.workspaceId,
          budget_period_id: periodId,
          from_category_id: req.from,
          to_category_id: req.to,
          amount_minor: req.amount,
          note: req.note ?? null,
          moved_by: ctx.userId,
        })
        .execute();
    });
  }

  async moves(ctx: Ctx, id: string, start: CalendarDate): Promise<BudgetMoveDto[]> {
    return this.db.run(ctx, async (trx) => {
      await this.load(trx, ctx, id);
      const rows = await trx
        .selectFrom('app.budget_move as m')
        .innerJoin('app.budget_period as p', (j) =>
          j.onRef('p.workspace_id', '=', 'm.workspace_id').onRef('p.id', '=', 'm.budget_period_id'),
        )
        .selectAll('m')
        .where('p.workspace_id', '=', ctx.workspaceId)
        .where('p.budget_id', '=', id)
        .where('p.start_date', '=', start)
        .orderBy('m.moved_at', 'desc')
        .execute();
      return rows.map((m) => ({
        id: m.id,
        from: m.from_category_id,
        to: m.to_category_id,
        amount: String(m.amount_minor),
        note: m.note,
        movedBy: m.moved_by,
        movedAt: m.moved_at.toISOString(),
      }));
    });
  }

  /** BUD-09: last period's assigned amounts, or the 3-period average of activity. */
  async copy(ctx: Ctx, id: string, start: CalendarDate, req: CopyBudgetRequest): Promise<BudgetPeriodDto> {
    return this.write(ctx, id, start, req.version, async (trx, budget, periodId) => {
      const spec = specOf(budget);
      const previous = [3, 2, 1].map((n) => shiftPeriod(spec, start, -n));
      const prevRow = await trx
        .selectFrom('app.budget_period')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('budget_id', '=', budget.id)
        .where('start_date', '=', previous[2]!.start)
        .executeTakeFirst();
      const assigned = new Map<string, bigint>();
      if (prevRow) {
        const lines = await trx
          .selectFrom('app.budget_line')
          .select(['category_id', 'assigned_minor'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('budget_period_id', '=', prevRow.id)
          .execute();
        for (const l of lines) assigned.set(l.category_id, BigInt(l.assigned_minor));
      }
      const budgetable = new Set(
        (await this.data.categories(trx, ctx, budget.entity_id)).filter(isBudgetCategory).map((c) => c.id),
      );
      const activity = await this.data.activity(trx, ctx, budget.entity_id, previous, this.filter(budget));
      const amounts = copyAmounts(req.from, {
        assigned,
        activity: previous.map((p) => activity.get(p.start) ?? new Map<string, bigint>()),
      });
      const existing = new Map(
        (
          await trx
            .selectFrom('app.budget_line')
            .select(['category_id', 'assigned_minor'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('budget_period_id', '=', periodId)
            .execute()
        ).map((l) => [l.category_id, BigInt(l.assigned_minor)]),
      );
      for (const [categoryId, amount] of amounts) {
        if (!budgetable.has(categoryId)) continue;
        if (!req.overwrite && (existing.get(categoryId) ?? 0n) !== 0n) continue;
        const rollover = await this.inheritedRollover(trx, ctx, budget.id, start, categoryId);
        await trx
          .insertInto('app.budget_line')
          .values({
            workspace_id: ctx.workspaceId,
            budget_period_id: periodId,
            category_id: categoryId,
            assigned_minor: String(amount),
            rollover_mode: rollover,
          })
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'budget_period_id', 'category_id'])
              .doUpdateSet({ assigned_minor: String(amount) }),
          )
          .execute();
      }
    });
  }

  async updatePeriod(
    ctx: Ctx,
    id: string,
    start: CalendarDate,
    req: UpdateBudgetPeriodRequest,
  ): Promise<BudgetPeriodDto> {
    return this.write(ctx, id, start, req.version, async (trx, _budget, periodId) => {
      await trx
        .updateTable('app.budget_period')
        .set({ expected_income_minor: req.expectedIncome })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', periodId)
        .execute();
    });
  }

  // ----- Draft (BUD-02) --------------------------------------------------------------------------------

  async draft(ctx: Ctx, req: DraftBudgetRequest): Promise<DraftBudgetDto> {
    return this.db.run(ctx, async (trx) => {
      const entity = await this.data.entity(trx, ctx, req.entityId);
      const today = await this.data.today(trx, ctx);
      const months = previousMonths(today, req.months);
      const categories = (await this.data.categories(trx, ctx, req.entityId)).filter(isBudgetCategory);
      const activity = await this.data.activity(trx, ctx, req.entityId, months);
      const recurring = await this.recurringMonthly(trx, ctx, req.entityId);
      const lines = draftBudget(
        categories.map((c) => ({
          categoryId: c.id,
          history: months.map((m) => activity.get(m.start)?.get(c.id) ?? 0n),
          recurringMonthly: recurring.get(c.id) ?? null,
        })),
      );
      const byId = new Map(categories.map((c) => [c.id, c]));
      const income = await this.expectedMonthlyIncome(trx, ctx, req.entityId, today);
      const dto: DraftBudgetDto = {
        entityId: req.entityId,
        currency: entity.currency as DraftBudgetDto['currency'],
        months: months.map((m) => m.start),
        expectedIncome: String(income),
        lines: lines.map((l) => ({
          categoryId: l.categoryId,
          name: byId.get(l.categoryId)!.name,
          groupKind: byId.get(l.categoryId)!.kind!,
          suggested: String(l.suggested),
          history: months.map((m) => String(activity.get(m.start)?.get(l.categoryId) ?? 0n)),
          fixed: l.fixed,
          source: l.source,
        })),
        explanation: null,
      };
      const total = lines.reduce((s, l) => s + l.suggested, 0n);
      dto.explanation = await wordSummary(this.ai, trx, ctx, entity.currency, {
        kind: 'draft_budget',
        title: `Draft budget from the last ${months.length} month${months.length === 1 ? '' : 's'}`,
        figures: {
          months: String(months.length),
          expectedIncome: String(income),
          totalSuggested: String(total),
          fixedBills: String(lines.filter((l) => l.fixed).reduce((s, l) => s + l.suggested, 0n)),
        },
        money: ['expectedIncome', 'totalSuggested', 'fixedBills'],
        names: lines.slice(0, 8).map((l) => byId.get(l.categoryId)!.name),
      });
      return dto;
    });
  }

  // ----- Engine ----------------------------------------------------------------------------------------

  async load(trx: Trx, ctx: Ctx, id: string): Promise<BudgetRow> {
    const row = await trx
      .selectFrom('app.budget')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Budget');
    return row;
  }

  filter(budget: Pick<BudgetRow, 'member_id'>, includeRestricted = true): ActivityFilter {
    return { memberId: budget.member_id, includeRestricted };
  }

  /** Computes a budget's periods from its first one through `start` (default: the current period). */
  async compute(
    trx: Trx,
    ctx: Ctx,
    id: string,
    start?: CalendarDate,
    opts: { includeRestricted?: boolean } = {},
  ): Promise<ComputedPeriod> {
    const budget = await this.load(trx, ctx, id);
    const spec = specOf(budget);
    const entity = await this.data.entity(trx, ctx, budget.entity_id);
    const today = await this.data.today(trx, ctx);
    const period = start ? this.checkStart(spec, start) : periodContaining(spec, today);
    const rows = await trx
      .selectFrom('app.budget_period')
      .select(['id', 'start_date', 'expected_income_minor', 'status'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('budget_id', '=', id)
      .where('start_date', '<=', period.start)
      .orderBy('start_date')
      .execute();
    const firstStored = rows[0] ? calendarDate(rows[0].start_date) : period.start;
    let first = firstStored < period.start ? firstStored : period.start;
    const earliest = shiftPeriod(spec, period.start, -(MAX_WALK - 1)).start;
    if (first < earliest) first = earliest;
    const periods = periodsBetween(spec, first, period.start);
    const byStart = new Map(rows.map((r) => [calendarDate(r.start_date), r]));
    const periodIds = rows.map((r) => r.id);

    const lines = periodIds.length
      ? await trx
          .selectFrom('app.budget_line')
          .select(['budget_period_id', 'category_id', 'assigned_minor', 'rollover_mode'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('budget_period_id', 'in', periodIds)
          .execute()
      : [];
    const moves = periodIds.length
      ? await trx
          .selectFrom('app.budget_move')
          .select(['budget_period_id', 'from_category_id', 'to_category_id', 'amount_minor'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('budget_period_id', 'in', periodIds)
          .execute()
      : [];
    const categories = await this.data.categories(trx, ctx, budget.entity_id);
    const budgetable = new Set(categories.filter(isBudgetCategory).map((c) => c.id));
    const incomeCats = new Set(categories.filter((c) => c.type === 'income').map((c) => c.id));
    const unbudgetedCats = new Set(
      categories.filter((c) => c.type === 'expense' && c.kind === null).map((c) => c.id),
    );
    const filter = this.filter(budget, opts.includeRestricted ?? true);
    const activity = await this.data.activity(trx, ctx, budget.entity_id, periods, filter);
    const withheld = await this.data.payslipWithheld(trx, ctx, budget.entity_id, periods, filter);

    // Income: expected items matched to deposits, over the whole walk.
    const items = (await this.data.incomeItems(trx, ctx, budget.entity_id, budget.member_id)).filter(
      (i) => i.currency === entity.currency,
    );
    const deposits = items.length
      ? await this.data.deposits(trx, ctx, budget.entity_id, periods[0]!.start, period.end)
      : [];
    const occurrences = this.data.matchIncome(items, deposits, periods[0]!.start, period.end);

    const incomeOf = (p: Period) => {
      const act = activity.get(p.start) ?? new Map<string, bigint>();
      let actual = 0n;
      for (const [c, v] of act) if (incomeCats.has(c)) actual -= v;
      actual -= withheld.get(p.start) ?? 0n;
      const occ = occurrences.filter((o) => o.date >= p.start && o.date <= p.end);
      const override = byStart.get(p.start)?.expected_income_minor;
      const expected =
        override !== null && override !== undefined
          ? BigInt(override)
          : occ.reduce((s, o) => s + o.item.amount, 0n);
      const budgeted =
        override !== null && override !== undefined
          ? BigInt(override)
          : occ.length
            ? occ.reduce((s, o) => s + occurrenceTotal(o), 0n)
            : actual;
      return { expected, actual, budgeted, occurrences: occ };
    };

    const inputs: PeriodInput[] = periods.map((p) => {
      const row = byStart.get(p.start);
      const act = activity.get(p.start) ?? new Map<string, bigint>();
      const spend = new Map<string, bigint>();
      for (const [c, v] of act) if (budgetable.has(c)) spend.set(c, v);
      return {
        start: p.start,
        end: p.end,
        income: incomeOf(p).budgeted,
        lines: new Map(
          lines
            .filter((l) => row && l.budget_period_id === row.id && budgetable.has(l.category_id))
            .map((l) => [l.category_id, { assigned: BigInt(l.assigned_minor), rollover: l.rollover_mode }]),
        ),
        activity: spend,
        moves: moves
          .filter((m) => row && m.budget_period_id === row.id)
          .map((m) => ({ from: m.from_category_id, to: m.to_category_id, amount: BigInt(m.amount_minor) })),
      };
    });
    const results = computeBudget(inputs);
    const lastActivity = activity.get(period.start) ?? new Map<string, bigint>();
    const unbudgeted = new Map([...lastActivity].filter(([c, v]) => unbudgetedCats.has(c) && v !== 0n));
    return {
      budget,
      spec,
      currency: entity.currency,
      period,
      today,
      categories,
      results,
      income: incomeOf(period),
      status: byStart.get(period.start)?.status ?? 'open',
      unbudgeted,
    };
  }

  async periodDto(trx: Trx, ctx: Ctx, c: ComputedPeriod): Promise<BudgetPeriodDto> {
    const r = c.results[c.results.length - 1]!;
    const current = c.today >= c.period.start && c.today <= c.period.end;
    const goals = await trx
      .selectFrom('app.goal')
      .select(['id', 'category_id', 'target_minor', 'due_date', 'type'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', c.budget.entity_id)
      .where('archived_at', 'is', null)
      .where('category_id', 'is not', null)
      .execute();
    const goalByCat = new Map(goals.map((g) => [g.category_id!, g]));
    const s = (v: bigint) => String(v);
    const groups = new Map<string, BudgetGroupDto>();
    const assignedByKind = new Map<GroupKind, bigint>();
    for (const cat of c.categories.filter(isBudgetCategory)) {
      const l = r.lines.get(cat.id);
      const assigned = l?.assigned ?? 0n;
      const activity = l?.activity ?? 0n;
      const available = l?.available ?? 0n;
      const budgetTotal = available + activity;
      const pace =
        current && budgetTotal > 0n && PACE_KINDS.has(cat.kind!)
          ? spendingPace(c.period, c.today, budgetTotal, activity)
          : null;
      const g = goalByCat.get(cat.id);
      const line: BudgetLineDto = {
        categoryId: cat.id,
        name: cat.name,
        assigned: s(assigned),
        carriedIn: s(l?.carriedIn ?? 0n),
        activity: s(activity),
        moved: s(l?.moved ?? 0n),
        available: s(available),
        rolloverMode: l?.rollover ?? 'carry_surplus',
        pace: pace
          ? { expectedByToday: s(pace.expectedByToday), projected: s(pace.projected), status: pace.status }
          : null,
        goal:
          g && g.target_minor && g.due_date
            ? {
                goalId: g.id,
                monthlyNeeded: s(
                  sinkingFundMonthly(
                    BigInt(g.target_minor),
                    l?.carriedIn ?? 0n,
                    c.period.start,
                    calendarDate(g.due_date),
                  ),
                ),
              }
            : null,
      };
      const key = cat.groupId!;
      let group = groups.get(key);
      if (!group) {
        group = {
          id: key,
          name: cat.groupName!,
          kind: cat.kind!,
          assigned: '0',
          activity: '0',
          available: '0',
          lines: [],
        };
        groups.set(key, group);
      }
      group.lines.push(line);
      group.assigned = s(BigInt(group.assigned) + assigned);
      group.activity = s(BigInt(group.activity) + activity);
      group.available = s(BigInt(group.available) + available);
      assignedByKind.set(cat.kind!, (assignedByKind.get(cat.kind!) ?? 0n) + assigned + (l?.moved ?? 0n));
    }
    const names = new Map(c.categories.map((x) => [x.id, x.name]));
    const split = fiftyThirtyTwenty(c.income.budgeted, assignedByKind);
    const spendingActivity = [...r.lines.values()].reduce((sum, l) => sum + l.activity, 0n);
    const savingsTarget = c.budget.savings_target_minor !== null ? BigInt(c.budget.savings_target_minor) : 0n;
    const everythingElse = c.income.budgeted - savingsTarget;
    const savedSoFar = c.income.actual - spendingActivity;
    return {
      budget: await this.toDto(trx, ctx, c.budget),
      start: c.period.start,
      end: c.period.end,
      status: c.status,
      current,
      income: {
        expected: s(c.income.expected),
        actual: s(c.income.actual),
        budgeted: s(c.income.budgeted),
        items: c.income.occurrences.map((o) => ({
          expectedIncomeId: o.item.id,
          name: o.item.name,
          date: o.date,
          expected: s(o.item.amount),
          actual: o.actual ? s(o.actual.amount) : null,
        })),
      },
      carriedUnassigned: s(r.carriedUnassigned),
      assigned: s(r.assigned),
      activity: s(r.activity),
      available: s(r.available),
      leftToAssign: s(r.leftToAssign),
      groups: [...groups.values()],
      unbudgeted: [...c.unbudgeted].map(([id, v]) => ({
        categoryId: id,
        name: names.get(id) ?? id,
        activity: s(v),
      })),
      light:
        c.budget.method === 'light'
          ? {
              savingsTarget: s(savingsTarget),
              saved: s(savedSoFar > 0n ? savedSoFar : 0n),
              everythingElse: {
                budget: s(everythingElse),
                activity: s(spendingActivity),
                available: s(everythingElse - spendingActivity),
              },
            }
          : null,
      fiftyThirtyTwenty: {
        base: s(split.base),
        needs: { amount: s(split.needs), percent: split.percents.needs },
        wants: { amount: s(split.wants), percent: split.percents.wants },
        savings: { amount: s(split.savings), percent: split.percents.savings },
      },
    };
  }

  async toDto(trx: Trx, ctx: Ctx, b: BudgetRow): Promise<BudgetDto> {
    const entity = await this.data.entity(trx, ctx, b.entity_id);
    return {
      id: b.id,
      entityId: b.entity_id,
      memberId: b.member_id,
      name: b.name,
      method: b.method,
      periodType: b.period_type,
      anchorDate: b.anchor_date ? calendarDate(b.anchor_date) : null,
      savingsTarget: b.savings_target_minor !== null ? String(b.savings_target_minor) : null,
      revenueTarget: b.revenue_target_minor !== null ? String(b.revenue_target_minor) : null,
      currency: entity.currency as BudgetDto['currency'],
      archived: b.archived_at !== null,
      version: Number(b.version),
    };
  }

  // ----- Helpers ---------------------------------------------------------------------------------------

  private checkStart(spec: PeriodSpec, start: CalendarDate): Period {
    if (!isPeriodStart(spec, start)) {
      throw unprocessable('budget.period_start', `${start} is not the first day of a budget period`);
    }
    return periodContaining(spec, start);
  }

  /**
   * Runs a write against one period: checks and bumps the budget's version (409 on a stale version),
   * creates the period row on first write, then returns the recomputed period.
   */
  async write(
    ctx: Ctx,
    id: string,
    start: CalendarDate,
    version: number,
    fn: (trx: Trx, budget: BudgetRow, periodId: string) => Promise<void>,
  ): Promise<BudgetPeriodDto> {
    return this.db.run(ctx, async (trx) => {
      const budget = await this.load(trx, ctx, id);
      if (budget.archived_at) throw unprocessable('budget.archived', 'The budget is archived');
      const period = this.checkStart(specOf(budget), start);
      const bumped = await trx
        .updateTable('app.budget')
        .set((eb) => ({ version: eb('version', '+', 1n) }))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(version))
        .returningAll()
        .executeTakeFirst();
      if (!bumped) throw conflict();
      const periodId = await this.ensurePeriod(trx, ctx, id, period);
      await fn(trx, bumped, periodId);
      return this.periodDto(trx, ctx, await this.compute(trx, ctx, id, start));
    });
  }

  async ensurePeriod(trx: Trx, ctx: Ctx, budgetId: string, p: Period): Promise<string> {
    const inserted = await trx
      .insertInto('app.budget_period')
      .values({ workspace_id: ctx.workspaceId, budget_id: budgetId, start_date: p.start, end_date: p.end })
      .onConflict((oc) => oc.columns(['workspace_id', 'budget_id', 'start_date']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) return inserted.id;
    const row = await trx
      .selectFrom('app.budget_period')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('budget_id', '=', budgetId)
      .where('start_date', '=', p.start)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async budgetCategory(trx: Trx, ctx: Ctx, budget: BudgetRow, categoryId: string): Promise<void> {
    const cat = (await this.data.categories(trx, ctx, budget.entity_id)).find((c) => c.id === categoryId);
    if (!cat || !isBudgetCategory(cat)) {
      throw unprocessable('budget.category', 'Budget lines need a spending category of the budget’s entity');
    }
  }

  /** A new line keeps the category's latest rollover mode in earlier periods (default carry_surplus). */
  private async inheritedRollover(
    trx: Trx,
    ctx: Ctx,
    budgetId: string,
    start: CalendarDate,
    categoryId: string,
  ): Promise<RolloverMode> {
    const row = await trx
      .selectFrom('app.budget_line as l')
      .innerJoin('app.budget_period as p', (j) =>
        j.onRef('p.workspace_id', '=', 'l.workspace_id').onRef('p.id', '=', 'l.budget_period_id'),
      )
      .select('l.rollover_mode')
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.budget_id', '=', budgetId)
      .where('p.start_date', '<', start)
      .where('l.category_id', '=', categoryId)
      .orderBy('p.start_date', 'desc')
      .executeTakeFirst();
    return row?.rollover_mode ?? 'carry_surplus';
  }

  /** Monthly amount of active recurring bills per category (BUD-02 fills categories without history). */
  async recurringMonthly(trx: Trx, ctx: Ctx, entityId: string): Promise<Map<string, bigint>> {
    const { rows } = await sql<{ category_id: string; amount: string; cadence: string }>`
      select r.spec->'splits'->0->>'accountId' as category_id, r.spec->>'amount' as amount, r.cadence
        from app.recurring_item r
       where r.workspace_id = ${ctx.workspaceId} and r.primary_entity_id = ${entityId} and r.status = 'active'
         and r.spec->>'type' = 'standard' and jsonb_array_length(r.spec->'splits') = 1`.execute(trx);
    const perMonth: Record<string, [bigint, bigint]> = {
      weekly: [52n, 12n],
      biweekly: [26n, 12n],
      semimonthly: [2n, 1n],
      monthly: [1n, 1n],
      quarterly: [1n, 3n],
      yearly: [1n, 12n],
    };
    const out = new Map<string, bigint>();
    for (const r of rows) {
      const [num, den] = perMonth[r.cadence] ?? [1n, 1n];
      const amount = -BigInt(r.amount); // outflows are negative on the account
      if (amount <= 0n) continue;
      out.set(r.category_id, (out.get(r.category_id) ?? 0n) + (amount * num + den - 1n) / den);
    }
    return out;
  }

  /** Expected take-home income for the month containing `date`. */
  async expectedMonthlyIncome(trx: Trx, ctx: Ctx, entityId: string, date: CalendarDate): Promise<bigint> {
    const entity = await this.data.entity(trx, ctx, entityId);
    const month = periodContaining({ type: 'monthly' }, date);
    const items = (await this.data.incomeItems(trx, ctx, entityId)).filter(
      (i) => i.currency === entity.currency,
    );
    return this.data.matchIncome(items, [], month.start, month.end).reduce((s, o) => s + o.item.amount, 0n);
  }
}
