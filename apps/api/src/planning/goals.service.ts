/** Goals, sinking funds and debt payoff (BUD-07, BUD-08, FAM-07; design 04 §8). */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type GoalRow, type Trx } from '@montra/db';
import {
  addDays,
  addMonths,
  calendarDate,
  projectGoal,
  simulatePayoff,
  sinkingFundMonthly,
  startOfMonth,
  type CalendarDate,
  type Debt,
} from '@montra/domain';
import type { CreateGoalRequest, DebtPayoffDto, GoalDto, UpdateGoalRequest } from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { BudgetsService } from './budgets.service.js';
import { PlanningData, type Ctx } from './data.js';

const SAVINGS_GROUP = 'Savings goals';

@Injectable()
export class GoalsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PlanningData) private readonly data: PlanningData,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
  ) {}

  async create(ctx: Ctx, req: CreateGoalRequest): Promise<GoalDto> {
    return this.db.run(ctx, async (trx) => {
      const entity = await this.data.entity(trx, ctx, req.entityId);
      await this.checkAccounts(trx, ctx, req.entityId, req.linkedAccountIds, req.type);
      let categoryId = req.categoryId;
      if (categoryId) {
        const cat = (await this.data.categories(trx, ctx, req.entityId)).find((c) => c.id === categoryId);
        if (!cat || cat.type !== 'expense')
          throw unprocessable('goal.category', 'Pick a spending category of the same entity');
      } else if (req.type !== 'debt_payoff' && req.linkedAccountIds.length === 0) {
        // Money for the goal is set aside in the budget: give it its own category in "Savings goals".
        categoryId = await this.goalCategory(trx, ctx, req.entityId, entity.currency, req.name);
      }
      const row = await trx
        .insertInto('app.goal')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: req.entityId,
          member_id: req.memberId,
          name: req.name,
          type: req.type,
          target_minor: req.target,
          due_date: req.dueDate,
          category_id: categoryId,
          strategy: req.type === 'debt_payoff' ? req.strategy : null,
          linked_account_ids: req.linkedAccountIds,
          extra_payment_minor: req.extraPayment,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.toDtos(trx, ctx, [row]))[0]!;
    });
  }

  async list(ctx: Ctx, entityId?: string): Promise<GoalDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.goal')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!entityId, (q) => q.where('entity_id', '=', entityId!))
        .orderBy('archived_at', (ob) => ob.nullsFirst())
        .orderBy('due_date', (ob) => ob.nullsLast())
        .orderBy('created_at')
        .execute();
      return this.toDtos(trx, ctx, rows);
    });
  }

  async get(ctx: Ctx, id: string): Promise<GoalDto> {
    return this.db.run(
      ctx,
      async (trx) => (await this.toDtos(trx, ctx, [await this.load(trx, ctx, id)]))[0]!,
    );
  }

  async update(ctx: Ctx, id: string, req: UpdateGoalRequest): Promise<GoalDto> {
    return this.db.run(ctx, async (trx) => {
      const goal = await this.load(trx, ctx, id);
      if (req.linkedAccountIds)
        await this.checkAccounts(trx, ctx, goal.entity_id, req.linkedAccountIds, goal.type);
      const next = {
        target: req.target !== undefined ? req.target : goal.target_minor,
        due: req.dueDate !== undefined ? req.dueDate : goal.due_date,
        strategy: req.strategy !== undefined ? req.strategy : goal.strategy,
      };
      if (goal.type === 'sinking_fund' && (next.target === null || next.due === null)) {
        throw unprocessable('goal.sinking_fund', 'A sinking fund needs a target and a due date');
      }
      if (goal.type === 'debt_payoff' && next.strategy === null) {
        throw unprocessable('goal.strategy', 'Choose snowball or avalanche');
      }
      const row = await trx
        .updateTable('app.goal')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.memberId !== undefined ? { member_id: req.memberId } : {}),
          ...(req.target !== undefined ? { target_minor: req.target } : {}),
          ...(req.dueDate !== undefined ? { due_date: req.dueDate } : {}),
          ...(req.categoryId !== undefined ? { category_id: req.categoryId } : {}),
          ...(req.strategy !== undefined && goal.type === 'debt_payoff' ? { strategy: req.strategy } : {}),
          ...(req.linkedAccountIds !== undefined ? { linked_account_ids: req.linkedAccountIds } : {}),
          ...(req.extraPayment !== undefined ? { extra_payment_minor: req.extraPayment } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row)
        throw unprocessable('version.conflict', 'The goal was changed by someone else; reload and try again');
      return (await this.toDtos(trx, ctx, [row]))[0]!;
    });
  }

  // -------------------------------------------------------------------------------------------------------

  private async load(trx: Trx, ctx: Ctx, id: string): Promise<GoalRow> {
    const row = await trx
      .selectFrom('app.goal')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Goal');
    return row;
  }

  private async checkAccounts(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    ids: readonly string[],
    type: GoalRow['type'],
  ) {
    if (!ids.length) return;
    const rows = await trx
      .selectFrom('app.ledger_account as a')
      .innerJoin('app.bank_account as b', 'b.ledger_account_id', 'a.id')
      .select(['a.id', 'a.type'])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.entity_id', '=', entityId)
      .where('a.id', 'in', [...ids])
      .execute();
    const want = type === 'debt_payoff' ? 'liability' : 'asset';
    if (rows.length !== new Set(ids).size || rows.some((r) => r.type !== want)) {
      throw unprocessable(
        'goal.accounts',
        type === 'debt_payoff'
          ? 'Link the debts (cards, loans) to pay off'
          : 'Link savings accounts of the same entity',
      );
    }
  }

  private async goalCategory(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    currency: string,
    name: string,
  ): Promise<string> {
    let group = await trx
      .selectFrom('app.category_group')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('kind', '=', 'savings')
      .orderBy('sort_order')
      .executeTakeFirst();
    if (!group) {
      group = await trx
        .insertInto('app.category_group')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: entityId,
          name: SAVINGS_GROUP,
          kind: 'savings',
          sort_order: 90,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    }
    const existing = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('category_group_id', '=', group.id)
      .where('name', '=', name)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (existing) return existing.id;
    const row = await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: entityId,
        type: 'expense',
        subtype: 'category',
        name: name.slice(0, 200),
        currency,
        is_category: true,
        category_group_id: group.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Progress for each goal: linked balances or the funding category's available (04 §8). */
  async toDtos(trx: Trx, ctx: Ctx, rows: readonly GoalRow[]): Promise<GoalDto[]> {
    if (!rows.length) return [];
    const today = await this.data.today(trx, ctx);
    const monthEnds = [4, 3, 2, 1].map((n) => addDays(startOfMonth(addMonthsBack(today, n - 1)), -1));
    const accountIds = [...new Set(rows.flatMap((r) => r.linked_account_ids))];
    const balances = await this.data.balances(trx, ctx, accountIds, [...monthEnds, today]);
    const debtInfo = accountIds.length
      ? await trx
          .selectFrom('app.ledger_account as a')
          .innerJoin('app.bank_account as b', 'b.ledger_account_id', 'a.id')
          .select(['a.id', 'a.name', 'b.interest_rate_bps', 'b.min_payment_minor'])
          .where('a.workspace_id', '=', ctx.workspaceId)
          .where('a.id', 'in', accountIds)
          .execute()
      : [];
    const info = new Map(debtInfo.map((d) => [d.id, d]));
    // Category-funded goals: the category's available now, and its monthly net additions (last 3 periods).
    const byEntity = new Map<string, Map<string, { available: bigint; added: bigint[] }>>();
    for (const entityId of new Set(rows.filter((r) => r.category_id).map((r) => r.entity_id))) {
      byEntity.set(entityId, await this.categoryFunds(trx, ctx, entityId));
    }
    const entityCurrency = new Map<string, string>();
    for (const r of rows) {
      if (!entityCurrency.has(r.entity_id))
        entityCurrency.set(r.entity_id, (await this.data.entity(trx, ctx, r.entity_id)).currency);
    }

    return rows.map((g) => {
      const target = g.target_minor !== null ? BigInt(g.target_minor) : null;
      const due = g.due_date ? calendarDate(g.due_date) : null;
      let saved = 0n;
      let contributions: bigint[] = [];
      let payoff: DebtPayoffDto | null = null;
      if (g.linked_account_ids.length) {
        const series = [...monthEnds, today].map((d) =>
          g.linked_account_ids.reduce((s, a) => s + (balances.get(a)?.get(d) ?? 0n), 0n),
        );
        if (g.type === 'debt_payoff') {
          const owed = -series[series.length - 1]!;
          // Paid down so far; charging more than was paid shows as no progress, not negative progress.
          saved = target !== null && target > owed ? target - owed : 0n;
          contributions = series.slice(1, 4).map((v, i) => v - series[i]!);
          payoff = this.payoff(g, balances, info, today);
        } else {
          saved = series[series.length - 1]!;
          contributions = series.slice(1, 4).map((v, i) => v - series[i]!);
        }
      } else if (g.category_id) {
        const f = byEntity.get(g.entity_id)?.get(g.category_id);
        saved = f?.available ?? 0n;
        contributions = f?.added ?? [];
      }
      const p = projectGoal(target, saved, contributions, today, due);
      const monthlyNeeded =
        target !== null && due !== null ? sinkingFundMonthly(target, saved, today, due) : null;
      return {
        id: g.id,
        entityId: g.entity_id,
        memberId: g.member_id,
        name: g.name,
        type: g.type,
        target: target !== null ? String(target) : null,
        dueDate: due,
        categoryId: g.category_id,
        strategy: g.strategy,
        linkedAccountIds: g.linked_account_ids,
        extraPayment: g.extra_payment_minor !== null ? String(g.extra_payment_minor) : null,
        currency: entityCurrency.get(g.entity_id) as GoalDto['currency'],
        progress: {
          saved: String(saved),
          percent: p.percent,
          monthlyNeeded: monthlyNeeded !== null ? String(monthlyNeeded) : null,
          monthlyAverage: String(p.monthlyAverage),
          projectedCompletion: p.projectedCompletion,
          onTrack: p.onTrack,
        },
        payoff,
        archived: g.archived_at !== null,
        version: Number(g.version),
      };
    });
  }

  private payoff(
    g: GoalRow,
    balances: Map<string, Map<CalendarDate, bigint>>,
    info: Map<
      string,
      {
        id: string;
        name: string;
        interest_rate_bps: number | null;
        min_payment_minor: string | bigint | null;
      }
    >,
    today: CalendarDate,
  ): DebtPayoffDto {
    const debts: (Debt & { name: string })[] = g.linked_account_ids.map((id) => {
      const owed = -(balances.get(id)?.get(today) ?? 0n);
      const i = info.get(id);
      const min =
        i?.min_payment_minor !== null && i?.min_payment_minor !== undefined
          ? BigInt(i.min_payment_minor)
          : owed > 0n
            ? (owed * 2n + 99n) / 100n // 2% of the balance when no minimum is on file
            : 0n;
      return {
        id,
        name: i?.name ?? id,
        balance: owed > 0n ? owed : 0n,
        rateBps: i?.interest_rate_bps ?? 0,
        minPayment: min,
      };
    });
    const extra = g.extra_payment_minor !== null ? BigInt(g.extra_payment_minor) : 0n;
    const strategy = g.strategy ?? 'avalanche';
    const plan = simulatePayoff(debts, extra, strategy);
    const alt = simulatePayoff(debts, extra, strategy === 'avalanche' ? 'snowball' : 'avalanche');
    const start = startOfMonth(today);
    const dateAfter = (m: number | null) => (m === null ? null : addMonthsBack(start, -m));
    return {
      strategy,
      monthlyPayment: String(plan.monthlyPayment),
      payoffDate: dateAfter(plan.months),
      months: plan.months,
      totalInterest: plan.totalInterest !== null ? String(plan.totalInterest) : null,
      debts: debts.map((d) => {
        const r = plan.debts.find((x) => x.id === d.id)!;
        return {
          accountId: d.id,
          name: d.name,
          balance: String(d.balance),
          rateBps: d.rateBps,
          minPayment: String(d.minPayment),
          payoffDate: dateAfter(r.months),
          interest: r.months !== null ? String(r.interest) : null,
        };
      }),
      alternative: {
        payoffDate: dateAfter(alt.months),
        totalInterest: alt.totalInterest !== null ? String(alt.totalInterest) : null,
      },
    };
  }

  /** For each budget category of an entity's household budget: available now and the last 3 net additions. */
  private async categoryFunds(trx: Trx, ctx: Ctx, entityId: string) {
    const out = new Map<string, { available: bigint; added: bigint[] }>();
    const budget = await trx
      .selectFrom('app.budget')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('member_id', 'is', null)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!budget) return out;
    const c = await this.budgets.compute(trx, ctx, budget.id);
    const recent = c.results.slice(-4, -1);
    for (const [id, l] of c.results[c.results.length - 1]!.lines) {
      out.set(id, {
        available: l.available,
        added: recent.map((r) => {
          const x = r.lines.get(id);
          return x ? x.assigned + x.moved - x.activity : 0n;
        }),
      });
    }
    return out;
  }
}

/** The first of the month `n` months before `date`'s month (negative n: after). */
const addMonthsBack = (date: CalendarDate, n: number): CalendarDate => addMonths(startOfMonth(date), -n);
