/**
 * Recommendations (REC-01..08; design 04 §12, ADR-0015). The rules are the domain engine's; this service gathers
 * their inputs from a budget, stores each result once (dedupe key), asks AI to word it, and applies accepted
 * actions as ordinary budget writes. Stored recommendations never use restricted (payslip) amounts, because
 * partners who can read the entity can read them.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { BudgetRow, RecommendationRow, Trx } from '@montra/db';
import {
  addDays,
  calendarDate,
  draftBudget,
  formatMoney,
  meanMinor,
  money,
  rec01Cuts,
  rec02Overspend,
  rec03Allocate,
  rec04BareBones,
  rec05Realistic,
  rec07Review,
  rec08Buffer,
  spendingPace,
  PACE_KINDS,
  type CalendarDate,
  type GroupKind,
  type PeriodResult,
} from '@montra/domain';
import {
  ProposedActionDto,
  type AcceptRecommendationRequest,
  type RecommendationDto,
  type RecommendationPayloadDto,
  type RecommendationType,
} from '@montra/schemas';
import { z } from 'zod';
import { notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { AiService } from '../ai/ai.service.js';
import { Worker, type Job } from '../jobs/queue.js';
import { RecurringService } from '../recurring/recurring.service.js';
import { BudgetsService, conflict, isBudgetCategory, type ComputedPeriod } from './budgets.service.js';
import { FlowService } from './flow.service.js';
import { GoalsService } from './goals.service.js';
import { PlanningData, type Ctx } from './data.js';
import { wordSummary } from './wording.js';

/** Local hour after which the nightly planning run starts in each workspace (TZ-04). */
export const NIGHTLY_LOCAL_HOUR = 3;

export interface PlanningSettings {
  /** REC-01: 1 (cut first) … 5 (protect); default 3. */
  categoryPriorities: Record<string, number>;
  /** REC-03: debts at or above this APR count as high-interest. */
  highInterestBps: number;
}

export const DEFAULT_SETTINGS: PlanningSettings = { categoryPriorities: {}, highInterestBps: 800 };

interface Draft {
  type: RecommendationType;
  dedupeKey: string;
  periodStart: CalendarDate;
  title: string;
  payload: RecommendationPayloadDto;
  /** Figures that are money (minor units) for the wording. */
  money: string[];
  kind?: 'recommendation' | 'monthly_review';
}

const Actions = z.array(ProposedActionDto).max(50);

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger('Recommendations');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PlanningData) private readonly data: PlanningData,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(GoalsService) private readonly goals: GoalsService,
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(RecurringService) private readonly recurring: RecurringService,
  ) {}

  // ----- Jobs (TZ-04) ------------------------------------------------------------------------------------

  register(): void {
    // Hourly: queue the nightly run for every workspace whose local time has passed the run hour.
    this.worker.register('planning.hourly', async () => {
      await this.schedule(nextHour(new Date()));
      return this.db.run({}, async (trx) => {
        const { rows } = await sql<{ n: number }>`
          select app.enqueue_workspace_nightly('planning.nightly', ${NIGHTLY_LOCAL_HOUR}) as n`.execute(trx);
        return { queued: rows[0]!.n };
      });
    });
    // Nightly per workspace: materialize schedules, then refresh recommendations.
    this.worker.register('planning.nightly', async (job: Job) => {
      if (!job.workspace_id || !job.created_by) throw new Error('Job without workspace or user');
      const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
      const materialized = await this.recurring.materialize(ctx);
      const recs = await this.run(ctx);
      return { ...materialized, ...recs };
    });
    this.worker.register('planning.recommend', async (job: Job) => {
      if (!job.workspace_id || !job.created_by) throw new Error('Job without workspace or user');
      return this.run({ workspaceId: job.workspace_id, userId: job.created_by });
    });
  }

  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'planning.hourly', ${at})`.execute(trx),
    );
  }

  // ----- Settings --------------------------------------------------------------------------------------------

  async settings(ctx: Ctx): Promise<PlanningSettings> {
    return this.db.run(ctx, (trx) => this.settingsIn(trx, ctx));
  }

  private async settingsIn(trx: Trx, ctx: Ctx): Promise<PlanningSettings> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('priorities')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    const p = (ws.priorities ?? {}) as Partial<PlanningSettings>;
    return { ...DEFAULT_SETTINGS, ...p };
  }

  async updateSettings(ctx: Ctx, patch: Partial<PlanningSettings>): Promise<PlanningSettings> {
    return this.db.run(ctx, async (trx) => {
      const next = { ...(await this.settingsIn(trx, ctx)), ...patch };
      await trx
        .updateTable('app.workspace')
        .set({ priorities: JSON.stringify(next) })
        .where('id', '=', ctx.workspaceId)
        .execute();
      return next;
    });
  }

  // ----- Run ---------------------------------------------------------------------------------------------

  /** Evaluates every rule for every household budget the user can write; returns the number created. */
  async run(ctx: Ctx): Promise<{ created: number; expired: number }> {
    return this.db.run(ctx, async (trx) => {
      const budgets = await trx
        .selectFrom('app.budget')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('member_id', 'is', null)
        .where('archived_at', 'is', null)
        .execute();
      const settings = await this.settingsIn(trx, ctx);
      let created = 0;
      let expired = 0;
      for (const b of budgets) {
        const c = await this.budgets.compute(trx, ctx, b.id, undefined, { includeRestricted: false });
        const drafts = await this.evaluate(trx, ctx, b, c, settings);
        for (const d of drafts) if (await this.store(trx, ctx, b, c.currency, d)) created++;
        const prev = c.results.length > 1 ? c.results[c.results.length - 2]!.start : c.period.start;
        const res = await trx
          .updateTable('app.recommendation')
          .set({ status: 'expired' })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('budget_id', '=', b.id)
          .where('status', '=', 'open')
          .where((eb) =>
            eb.or([
              eb.and([eb('type', '<>', 'REC-07'), eb('period_start', '<', c.period.start)]),
              eb.and([eb('type', '=', 'REC-07'), eb('period_start', '<', prev)]),
            ]),
          )
          .executeTakeFirst();
        expired += Number(res.numUpdatedRows);
      }
      return { created, expired };
    });
  }

  private async store(trx: Trx, ctx: Ctx, b: BudgetRow, currency: string, d: Draft): Promise<boolean> {
    const row = await trx
      .insertInto('app.recommendation')
      .values({
        workspace_id: ctx.workspaceId,
        entity_id: b.entity_id,
        budget_id: b.id,
        type: d.type,
        period_start: d.periodStart,
        dedupe_key: d.dedupeKey,
        payload: JSON.stringify({ ...d.payload, title: d.title, money: d.money }),
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'dedupe_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) return false;
    try {
      const wording = await wordSummary(this.ai, trx, ctx, currency, {
        kind: d.kind ?? 'recommendation',
        title: d.title,
        figures: d.payload.figures,
        money: d.money,
        names: d.payload.subjects.map((x) => x.name),
      });
      if (wording)
        await trx.updateTable('app.recommendation').set({ wording }).where('id', '=', row.id).execute();
    } catch (e) {
      this.logger.warn(`Wording failed for ${d.dedupeKey}: ${(e as Error).message}`);
    }
    return true;
  }

  /** Runs the REC rules on one computed budget period. */
  async evaluate(
    trx: Trx,
    ctx: Ctx,
    b: BudgetRow,
    c: ComputedPeriod,
    settings: PlanningSettings,
  ): Promise<Draft[]> {
    const out: Draft[] = [];
    const r = c.results[c.results.length - 1]!;
    const previous = c.results.slice(-4, -1);
    const start = c.period.start;
    const kinds = new Map<string, GroupKind | null>(c.categories.map((x) => [x.id, x.kind]));
    const names = new Map(c.categories.map((x) => [x.id, x.name]));
    const budgetCats = c.categories.filter(isBudgetCategory);
    const fmt = (v: bigint) => formatMoney(money(v, c.currency));
    const subject = (id: string, amount: bigint | null) => ({
      id,
      name: names.get(id) ?? '',
      amount: amount === null ? null : String(amount),
    });
    const base = { currency: c.currency as RecommendationPayloadDto['currency'], review: null };
    // Floor for cuts: the lowest recent month (up to 3), and never below what is already spent this period.
    const minActivity = (id: string) => {
      const xs = previous.map((p) => p.lines.get(id)?.activity ?? 0n);
      const low = xs.length ? xs.reduce((m, v) => (v < m ? v : m)) : 0n;
      const spent = r.lines.get(id)?.activity ?? 0n;
      return low > spent ? low : spent;
    };
    const current = c.today >= c.period.start && c.today <= c.period.end;

    // REC-01: planned spending > expected income.
    if (b.method !== 'category_limits') {
      const cuts = rec01Cuts(
        r.leftToAssign,
        budgetCats.map((cat) => {
          const l = r.lines.get(cat.id);
          const used = previous.reduce((t, p) => t + (p.lines.get(cat.id)?.activity ?? 0n), 0n);
          const planned = previous.reduce((t, p) => t + (p.lines.get(cat.id)?.assigned ?? 0n), 0n);
          return {
            categoryId: cat.id,
            kind: cat.kind!,
            assigned: l?.assigned ?? 0n,
            floor: minActivity(cat.id),
            // Unset priorities: fun is cut before daily living.
            priority: settings.categoryPriorities[cat.id] ?? (cat.kind === 'fun' ? 2 : 3),
            usageRatio: planned > 0n ? Number(used) / Number(planned) : 1,
          };
        }),
      );
      if (cuts && cuts.cuts.length) {
        out.push({
          type: 'REC-01',
          dedupeKey: `REC-01:${b.id}:${start}`,
          periodStart: start,
          title: `Your plan is ${fmt(cuts.deficit)} more than your income`,
          payload: {
            ...base,
            figures: {
              overAssigned: String(cuts.deficit),
              proposedCutsTotal: String(cuts.covered),
              stillOverAfterCuts: String(cuts.uncovered),
            },
            subjects: cuts.cuts.map((x) => subject(x.categoryId, x.from - x.to)),
            actions: cuts.cuts.map((x) => ({
              kind: 'assign' as const,
              categoryId: x.categoryId,
              from: String(x.from),
              to: String(x.to),
            })),
          },
          money: ['overAssigned', 'proposedCutsTotal', 'stillOverAfterCuts'],
        });
      }
    }

    // REC-02: on pace to overspend by ≥ 10%.
    if (current) {
      const paced = budgetCats.map((cat) => {
        const l = r.lines.get(cat.id);
        const total = l ? l.available + l.activity : 0n;
        return {
          categoryId: cat.id,
          kind: cat.kind!,
          assigned: total,
          available: l?.available ?? 0n,
          pace:
            l && total > 0n && PACE_KINDS.has(cat.kind!)
              ? spendingPace(c.period, c.today, total, l.activity)
              : null,
        };
      });
      for (const line of paced) {
        const res = rec02Overspend(line, paced);
        if (!res) continue;
        out.push({
          type: 'REC-02',
          dedupeKey: `REC-02:${line.categoryId}:${start}`,
          periodStart: start,
          title: `${names.get(line.categoryId)} is on pace to overspend by ${fmt(res.overspend)}`,
          payload: {
            ...base,
            figures: {
              projectedOverspend: String(res.overspend),
              daysLeftInPeriod: `${res.daysLeft} days`,
              spendLessPerDayBy: String(res.perDayReduction),
            },
            subjects: [
              subject(line.categoryId, res.overspend),
              ...res.moves.map((m) => subject(m.from!, m.amount)),
            ],
            actions: [
              ...res.moves.map((m) => ({
                kind: 'move' as const,
                from: m.from,
                to: m.to,
                amount: String(m.amount),
              })),
              {
                kind: 'reduce_daily' as const,
                categoryId: line.categoryId,
                perDay: String(res.perDayReduction),
                days: res.daysLeft,
              },
            ],
          },
          money: ['projectedOverspend', 'spendLessPerDayBy'],
        });
      }
    }

    // REC-03 / REC-04: income that arrived higher, or that is late.
    const arrived = c.income.occurrences.filter((o) => o.actual);
    const actualSum = arrived.reduce((t, o) => t + o.actual!.amount, 0n);
    const expectedSum = arrived.reduce((t, o) => t + o.item.amount, 0n);
    if (actualSum > expectedSum) {
      const goals = (await this.goals.toDtos(trx, ctx, await this.goalRows(trx, ctx, b.entity_id))).filter(
        (g) => !g.archived,
      );
      const ef = goals.find((g) => g.type === 'emergency_fund' && g.target);
      const funCat = budgetCats.find((x) => x.kind === 'fun');
      const alloc = rec03Allocate(actualSum, expectedSum, {
        emergencyFund: ef
          ? { goalId: ef.id, categoryId: ef.categoryId, gap: BigInt(ef.target!) - BigInt(ef.progress.saved) }
          : null,
        debts: goals
          .filter((g) => g.type === 'debt_payoff' && g.payoff)
          .flatMap((g) =>
            g.payoff!.debts.map((d) => ({
              goalId: g.id,
              categoryId: g.categoryId,
              accountId: d.accountId,
              rateBps: d.rateBps,
              balance: BigInt(d.balance),
            })),
          ),
        goals: goals
          .filter((g) => (g.type === 'savings' || g.type === 'sinking_fund') && g.target)
          .map((g) => ({
            goalId: g.id,
            categoryId: g.categoryId,
            gap: BigInt(g.target!) - BigInt(g.progress.saved),
            due: g.dueDate,
          })),
        funCategoryId: funCat?.id ?? null,
        highInterestBps: settings.highInterestBps,
      });
      if (alloc) {
        const goalNames = new Map(goals.map((g) => [g.id, g.name]));
        out.push({
          type: 'REC-03',
          dedupeKey: `REC-03:${b.id}:${start}`,
          periodStart: start,
          title: `Your income came in ${fmt(alloc.surplus)} higher than expected`,
          payload: {
            ...base,
            figures: {
              extraIncome: String(alloc.surplus),
              expectedIncome: String(expectedSum),
              receivedIncome: String(actualSum),
            },
            subjects: alloc.allocations
              .filter((a) => a.categoryId || a.id)
              .map((a) => ({
                id: (a.categoryId ?? a.id)!,
                name: names.get(a.categoryId ?? '') ?? goalNames.get(a.id ?? '') ?? '',
                amount: String(a.amount),
              })),
            actions: alloc.allocations.flatMap((a): ProposedActionDto[] =>
              a.categoryId
                ? [{ kind: 'move' as const, from: null, to: a.categoryId, amount: String(a.amount) }]
                : a.target !== 'unassigned' && a.target !== 'debt' && a.id
                  ? [{ kind: 'fund_goal' as const, goalId: a.id, amount: String(a.amount) }]
                  : [],
            ),
          },
          money: ['extraIncome', 'expectedIncome', 'receivedIncome'],
        });
      }
    }
    const late = c.income.occurrences.filter((o) => !o.actual && o.date < addDays(c.today, -3));
    // PAY-07: a payslip more than 10% under the pattern counts like late income.
    const short = c.income.occurrences.filter((o) => o.actual && o.actual.amount * 10n < o.item.amount * 9n);
    const fc = current ? await this.flow.forecastIn(trx, ctx, 30, b.entity_id) : null;
    const low = fc?.accounts.find((a) => a.kind === 'cash' && a.lowBalance);
    if (current && (late.length || short.length || low)) {
      const bare = rec04BareBones(
        budgetCats.map((cat) => ({
          categoryId: cat.id,
          kind: cat.kind!,
          assigned: r.lines.get(cat.id)?.assigned ?? 0n,
          floor: cat.kind === 'debt' ? (r.lines.get(cat.id)?.assigned ?? 0n) : minActivity(cat.id),
        })),
      );
      if (bare.cuts.length) {
        const drivers = low?.lowBalance?.drivers ?? [];
        out.push({
          type: 'REC-04',
          dedupeKey: `REC-04:${b.id}:${start}`,
          periodStart: start,
          title: low
            ? `${low.name} may drop below ${fmt(BigInt(low.threshold))} on ${low.lowBalance!.date}`
            : late.length
              ? `Expected income hasn't arrived: ${late.map((o) => o.item.name).join(', ')}`
              : `Your pay came in lower than expected: ${short.map((o) => o.item.name).join(', ')}`,
          payload: {
            ...base,
            figures: {
              budgetCutsWouldFree: String(bare.saves),
              ...(low
                ? {
                    forecastBalanceThatDay: String(low.lowBalance!.balance),
                    dayItDropsBelowWarning: low.lowBalance!.date,
                  }
                : {}),
              ...(late.length
                ? { incomeNotYetArrived: String(late.reduce((t, o) => t + o.item.amount, 0n)) }
                : {}),
              ...(short.length
                ? {
                    payBelowExpectedBy: String(
                      short.reduce((t, o) => t + o.item.amount - o.actual!.amount, 0n),
                    ),
                  }
                : {}),
            },
            subjects: drivers
              .filter((x) => x.sourceId)
              .map((x) => ({ id: x.sourceId!, name: x.name, amount: x.amount })),
            actions: bare.cuts.map((x) => ({
              kind: 'assign' as const,
              categoryId: x.categoryId,
              from: String(x.from),
              to: String(x.to),
            })),
          },
          money: [
            'budgetCutsWouldFree',
            'forecastBalanceThatDay',
            'incomeNotYetArrived',
            'payBelowExpectedBy',
          ],
        });
      }
    }

    // REC-05: consistently under- or over-set for 3 periods.
    if (previous.length === 3) {
      for (const cat of budgetCats) {
        const res = rec05Realistic(
          previous.map((p) => {
            const l = p.lines.get(cat.id);
            return { assigned: (l?.assigned ?? 0n) + (l?.moved ?? 0n), activity: l?.activity ?? 0n };
          }),
        );
        const now = r.lines.get(cat.id)?.assigned ?? 0n;
        if (!res || res.suggested === now) continue;
        out.push({
          type: 'REC-05',
          dedupeKey: `REC-05:${cat.id}:${start}`,
          periodStart: start,
          title: `${cat.name} has been ${res.direction === 'over' ? 'over' : 'under'} budget for 3 periods; try ${fmt(res.suggested)}`,
          payload: {
            ...base,
            figures: { suggestedAmount: String(res.suggested), currentAmount: String(now) },
            subjects: [subject(cat.id, res.suggested)],
            actions: [{ kind: 'assign', categoryId: cat.id, from: String(now), to: String(res.suggested) }],
          },
          money: ['suggestedAmount', 'currentAmount'],
        });
      }
    }

    // REC-06: subscription price increases (detected by the insights job, AI-09).
    const increases = await trx
      .selectFrom('app.insight')
      .select(['id', 'payee_key', 'data'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', b.entity_id)
      .where('kind', '=', 'price_increase')
      .where('status', '=', 'open')
      .where('created_at', '>=', new Date(Date.now() - 45 * 86_400_000))
      .execute();
    for (const i of increases) {
      const d = i.data as { from?: string; to?: string; percent?: number };
      if (!d.from || !d.to) continue;
      const item = await trx
        .selectFrom('app.recurring_item')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where(
          sql<boolean>`lower(regexp_replace(coalesce(spec->>'payee', name), '[^a-zA-Z0-9]+', ' ', 'g')) like ${'%' + (i.payee_key ?? '').toLowerCase() + '%'}`,
        )
        .executeTakeFirst();
      const label = item?.name ?? i.payee_key ?? 'A subscription';
      out.push({
        type: 'REC-06',
        dedupeKey: `REC-06:${i.id}`,
        periodStart: start,
        title: `${label} went up ${d.percent ?? ''}%`.replace(' %', ''),
        payload: {
          ...base,
          figures: { previousPrice: d.from, newPrice: d.to, increase: `${d.percent ?? ''}%` },
          subjects: item ? [{ id: item.id, name: item.name, amount: d.to }] : [],
          actions: item ? [{ kind: 'review_subscription', recurringItemId: item.id }] : [],
        },
        money: ['previousPrice', 'newPrice'],
      });
    }

    // REC-07: monthly review of the period that just ended (in the first days of the new one).
    const prev = c.results.length > 1 ? c.results[c.results.length - 2]! : null;
    if (prev && c.today <= addDays(c.period.start, 4)) {
      out.push(await this.review(trx, ctx, b, c, prev, names, kinds, base));
    }

    // REC-08: irregular income (business, rent) → budget from last month's income, keep a buffer.
    const items = await this.data.incomeItems(trx, ctx, b.entity_id);
    if (prev && items.some((i) => i.sourceType === 'business' || i.sourceType === 'rent')) {
      const lastIncome = await this.actualIncome(trx, ctx, b.entity_id, prev, c);
      const expenses = meanMinor(previous.map((p) => p.activity));
      const buffer = await this.savingsBalance(trx, ctx, b.entity_id, c.today);
      const res = rec08Buffer(lastIncome, expenses, buffer);
      if (res.bufferGap > 0n) {
        out.push({
          type: 'REC-08',
          dedupeKey: `REC-08:${b.id}:${start}`,
          periodStart: start,
          title: `With irregular income, budget from last month's ${fmt(res.budgetIncome)} and build a ${fmt(res.bufferTarget)} buffer`,
          payload: {
            ...base,
            figures: {
              incomeToBudgetFrom: String(res.budgetIncome),
              bufferTarget: String(res.bufferTarget),
              stillNeededForBuffer: String(res.bufferGap),
            },
            subjects: [],
            actions: [],
          },
          money: ['incomeToBudgetFrom', 'bufferTarget', 'stillNeededForBuffer'],
        });
      }
    }
    return out;
  }

  private async review(
    trx: Trx,
    ctx: Ctx,
    b: BudgetRow,
    c: ComputedPeriod,
    prev: PeriodResult,
    names: Map<string, string>,
    kinds: Map<string, GroupKind | null>,
    base: { currency: RecommendationPayloadDto['currency']; review: null },
  ): Promise<Draft> {
    const fmt = (v: bigint) => formatMoney(money(v, c.currency));
    const income = await this.actualIncome(trx, ctx, b.entity_id, prev, c);
    const lines = [...prev.lines.values()]
      .filter((l) => kinds.get(l.categoryId))
      .map((l) => ({
        categoryId: l.categoryId,
        kind: kinds.get(l.categoryId)!,
        assigned: l.assigned + l.moved,
        activity: l.activity,
      }));
    const review = rec07Review(income, lines);
    const leakFigures = review.leaks.map(
      (l) => [`overBudget: ${names.get(l.categoryId) ?? ''}`, String(l.overBy)] as const,
    );
    const history = c.results.slice(-4, -1);
    const next = draftBudget(
      [...new Set(history.flatMap((p) => [...p.lines.keys()]))].map((id) => ({
        categoryId: id,
        history: history.map((p) => p.lines.get(id)?.activity ?? 0n),
      })),
    );
    return {
      type: 'REC-07',
      kind: 'monthly_review',
      dedupeKey: `REC-07:${b.id}:${prev.start}`,
      periodStart: prev.start,
      title: `Your review for the period starting ${prev.start}: you spent ${fmt(review.spent)} of ${fmt(review.income)}`,
      payload: {
        ...base,
        figures: {
          income: String(review.income),
          spent: String(review.spent),
          incomeMinusSpending: String(review.saved),
          ...Object.fromEntries(leakFigures),
        },
        subjects: review.leaks.map((l) => ({
          id: l.categoryId,
          name: names.get(l.categoryId) ?? '',
          amount: String(l.overBy),
        })),
        actions: next
          .filter(
            (n) => n.suggested !== (c.results[c.results.length - 1]!.lines.get(n.categoryId)?.assigned ?? 0n),
          )
          .map((n) => ({
            kind: 'assign' as const,
            categoryId: n.categoryId,
            from: String(c.results[c.results.length - 1]!.lines.get(n.categoryId)?.assigned ?? 0n),
            to: String(n.suggested),
          })),
        review: {
          income: String(review.income),
          spent: String(review.spent),
          saved: String(review.saved),
          wentWell: review.wentWell.map(
            (w) => `${names.get(w.categoryId) ?? ''}: ${fmt(w.under)} under budget`,
          ),
          leaks: review.leaks.map((l) => ({
            categoryId: l.categoryId,
            name: names.get(l.categoryId) ?? '',
            overBy: String(l.overBy),
          })),
          nextMonth: next.map((n) => ({
            categoryId: n.categoryId,
            name: names.get(n.categoryId) ?? '',
            suggested: String(n.suggested),
          })),
        },
      },
      money: ['income', 'spent', 'incomeMinusSpending', ...leakFigures.map(([k]) => k)],
    };
  }

  private async actualIncome(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    p: { start: CalendarDate; end: CalendarDate },
    c: ComputedPeriod,
  ) {
    const incomeCats = new Set(c.categories.filter((x) => x.type === 'income').map((x) => x.id));
    const act = (await this.data.activity(trx, ctx, entityId, [p], { includeRestricted: false })).get(
      p.start,
    )!;
    let v = 0n;
    for (const [id, a] of act) if (incomeCats.has(id)) v -= a;
    return v;
  }

  private async savingsBalance(trx: Trx, ctx: Ctx, entityId: string, today: CalendarDate): Promise<bigint> {
    const ids = (
      await trx
        .selectFrom('app.bank_account as b')
        .innerJoin('app.ledger_account as a', 'a.id', 'b.ledger_account_id')
        .select('a.id')
        .where('a.workspace_id', '=', ctx.workspaceId)
        .where('a.entity_id', '=', entityId)
        .where('b.kind', '=', 'savings')
        .execute()
    ).map((r) => r.id);
    const bal = await this.data.balances(trx, ctx, ids, [today]);
    return ids.reduce((t, id) => t + (bal.get(id)?.get(today) ?? 0n), 0n);
  }

  private goalRows(trx: Trx, ctx: Ctx, entityId: string) {
    return trx
      .selectFrom('app.goal')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('archived_at', 'is', null)
      .execute();
  }

  // ----- API ---------------------------------------------------------------------------------------------

  async list(
    ctx: Ctx,
    opts: { entityId?: string; status?: RecommendationDto['status'] },
  ): Promise<RecommendationDto[]> {
    const rows = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.recommendation')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!opts.entityId, (q) => q.where('entity_id', '=', opts.entityId!))
        .where('status', '=', opts.status ?? 'open')
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
    );
    return rows.map(toDto);
  }

  async dismiss(ctx: Ctx, id: string): Promise<RecommendationDto> {
    return this.db.run(ctx, async (trx) => {
      await this.loadOpen(trx, ctx, id);
      const row = await trx
        .updateTable('app.recommendation')
        .set({ status: 'dismissed', resolved_at: new Date(), resolved_by: ctx.userId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row);
    });
  }

  /** Applies the proposed (or edited) actions to the budget's current period, in one transaction. */
  async accept(ctx: Ctx, id: string, req: AcceptRecommendationRequest): Promise<RecommendationDto> {
    return this.db.run(ctx, async (trx) => {
      const rec = await this.loadOpen(trx, ctx, id);
      const proposed = Actions.parse((rec.payload as { actions?: unknown }).actions ?? []);
      const actions = req.actions ?? proposed;
      const writes = actions.filter(
        (a) => a.kind === 'assign' || a.kind === 'move' || a.kind === 'fund_goal',
      );
      if (writes.length) {
        if (!rec.budget_id)
          throw unprocessable('recommendation.budget', 'This recommendation has no budget to change');
        const budget = await this.budgets.load(trx, ctx, rec.budget_id);
        const version = req.version ?? Number(budget.version);
        const c = await this.budgets.compute(trx, ctx, budget.id);
        const bumped = await trx
          .updateTable('app.budget')
          .set((eb) => ({ version: eb('version', '+', 1n) }))
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', budget.id)
          .where('version', '=', BigInt(version))
          .returning('id')
          .executeTakeFirst();
        if (!bumped) throw conflict();
        const periodId = await this.budgets.ensurePeriod(trx, ctx, budget.id, c.period);
        const budgetable = new Set(c.categories.filter(isBudgetCategory).map((x) => x.id));
        const check = (cat: string | null) => {
          if (cat !== null && !budgetable.has(cat))
            throw unprocessable('budget.category', 'Unknown budget category in the actions');
        };
        for (const a of writes) {
          if (a.kind === 'assign') {
            check(a.categoryId);
            await trx
              .insertInto('app.budget_line')
              .values({
                workspace_id: ctx.workspaceId,
                budget_period_id: periodId,
                category_id: a.categoryId,
                assigned_minor: a.to,
              })
              .onConflict((oc) =>
                oc
                  .columns(['workspace_id', 'budget_period_id', 'category_id'])
                  .doUpdateSet({ assigned_minor: a.to }),
              )
              .execute();
          } else {
            let to: string | null;
            let from: string | null = null;
            if (a.kind === 'move') {
              check(a.from);
              check(a.to);
              from = a.from;
              to = a.to;
            } else {
              const goal = await trx
                .selectFrom('app.goal')
                .select('category_id')
                .where('workspace_id', '=', ctx.workspaceId)
                .where('id', '=', a.goalId)
                .executeTakeFirst();
              if (!goal?.category_id) continue; // goals funded through accounts: advice only
              to = goal.category_id;
              check(to);
            }
            if (from === to) continue;
            await trx
              .insertInto('app.budget_move')
              .values({
                workspace_id: ctx.workspaceId,
                budget_period_id: periodId,
                from_category_id: from,
                to_category_id: to,
                amount_minor: a.amount,
                note: `Recommendation ${rec.type}`,
                moved_by: ctx.userId,
              })
              .execute();
          }
        }
      }
      const row = await trx
        .updateTable('app.recommendation')
        .set({
          status: req.actions ? 'edited' : 'accepted',
          resolved_at: new Date(),
          resolved_by: ctx.userId,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row);
    });
  }

  private async loadOpen(trx: Trx, ctx: Ctx, id: string): Promise<RecommendationRow> {
    const row = await trx
      .selectFrom('app.recommendation')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Recommendation');
    if (row.status !== 'open')
      throw unprocessable('recommendation.resolved', 'This recommendation was already resolved');
    return row;
  }
}

function toDto(r: RecommendationRow): RecommendationDto {
  const p = r.payload as RecommendationPayloadDto & { title?: string };
  return {
    id: r.id,
    type: r.type,
    entityId: r.entity_id,
    budgetId: r.budget_id,
    periodStart: calendarDate(String(r.period_start)),
    status: r.status,
    title: p.title ?? r.type,
    wording: r.wording,
    payload: {
      currency: p.currency,
      figures: p.figures ?? {},
      subjects: p.subjects ?? [],
      actions: p.actions ?? [],
      review: p.review ?? null,
    },
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

/** The top of the next hour (UTC). */
export function nextHour(now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}
