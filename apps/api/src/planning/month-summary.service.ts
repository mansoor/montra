/**
 * Month in review (FLOW-01, AIA-01): one month's money in and out against the months before, the clearest changes, the
 * biggest purchases, how the budget went and next month's budget from recent months. Code computes every figure; the
 * AI words them (summarize_month, checked for invented numbers and cached by its input), and plain sentences stand in
 * when AI is off or unavailable.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  addMonths,
  biggestChanges,
  budgetSuggestions,
  calendarDate,
  endOfMonth,
  formatMoney,
  keptPercent,
  meanMinor,
  money,
  startOfMonth,
  type CalendarDate,
  type Period,
} from '@montra/domain';
import type { MonthSummaryDto, MonthSummaryQuery } from '@montra/schemas';
import { notFound } from '../common/errors.js';
import { Db } from '../db/database.js';
import { AiService } from '../ai/ai.service.js';
import { BudgetsService, specOf } from './budgets.service.js';
import { PlanningData, type Ctx } from './data.js';
import { formatFigures } from './wording.js';

type Money = MonthSummaryDto['currency'];
const s = (v: bigint) => v.toString();
const monthOf = (start: CalendarDate): Period => ({ start, end: endOfMonth(start) });

@Injectable()
export class MonthSummaryService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PlanningData) private readonly data: PlanningData,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  async month(ctx: Ctx, q: MonthSummaryQuery): Promise<MonthSummaryDto> {
    return this.db.run(ctx, async (trx) => {
      const entityId = q.entityId ?? (await this.defaultEntity(trx, ctx));
      const memberId = q.memberId ?? null;
      const entity = await this.data.entity(trx, ctx, entityId);
      const currency = entity.currency as Money;
      const today = await this.data.today(trx, ctx);
      const thisMonth = startOfMonth(today);
      // Default: last month, the latest one that's over. A later month than this one means this one.
      const asked = q.month ? startOfMonth(q.month) : addMonths(thisMonth, -1);
      const month = monthOf(asked > thisMonth ? thisMonth : asked);
      const complete = month.end < today;
      const before = [3, 2, 1].map((n) => monthOf(addMonths(month.start, -n)));

      const cats = await this.data.categories(trx, ctx, entityId);
      const incomeIds = cats.filter((c) => c.type === 'income').map((c) => c.id);
      // Payroll taxes and deductions are part of pay, not spending (04 §8), as on Home.
      const spend = cats.filter((c) => c.type === 'expense' && c.kind !== 'system');
      const names = new Map(cats.map((c) => [c.id, c.name]));
      const filter = memberId ? { memberId } : {};
      const periods = [...before, month];
      const act = await this.data.activity(trx, ctx, entityId, periods, filter);
      const withheld = await this.data.payslipWithheld(trx, ctx, entityId, periods, filter);
      const of = (p: Period, id: string) => act.get(p.start)?.get(id) ?? 0n;
      const incomeIn = (p: Period) =>
        -incomeIds.reduce((t, id) => t + of(p, id), 0n) - (withheld.get(p.start) ?? 0n);
      const spentIn = (p: Period) => spend.reduce((t, c) => t + of(p, c.id), 0n);
      const income = incomeIn(month);
      const spent = spentIn(month);
      // "Usual" is the months before that have any data: a new workspace has no usual yet.
      const known = before.filter((p) => incomeIn(p) !== 0n || spentIn(p) !== 0n);
      const usual = known.length
        ? {
            income: meanMinor(known.map(incomeIn)),
            spent: meanMinor(known.map(spentIn)),
            months: known.length,
          }
        : null;
      const last = before[2]!;
      const previous = known.includes(last) ? { income: incomeIn(last), spent: spentIn(last) } : null;

      const rows = spend.map((c) => ({
        categoryId: c.id,
        spent: of(month, c.id),
        before: known.map((p) => of(p, c.id)),
      }));
      const top = rows
        .filter((r) => r.spent > 0n)
        .sort((a, b) => (b.spent > a.spent ? 1 : b.spent < a.spent ? -1 : 0))
        .slice(0, 6);
      const usualOf = (r: (typeof rows)[number]) => (r.before.length ? meanMinor(r.before) : null);
      // A change worth saying is at least 2% of a usual month's spending (and 10.00).
      const min = usual && usual.spent / 50n > 1000n ? usual.spent / 50n : 1000n;
      const changes = biggestChanges(rows, { min });
      const named = <T extends { categoryId: string }>(x: T) => ({
        ...x,
        name: names.get(x.categoryId) ?? '',
      });

      // Bills, debt and savings are expected: the purchases worth naming are everyday ones.
      const everyday = spend
        .filter((c) => !['fixed', 'debt', 'savings'].includes(c.kind ?? ''))
        .map((c) => c.id);
      const largest = await this.largest(trx, ctx, entityId, memberId, month, everyday);
      const needsReview = await this.needsReview(trx, ctx, entityId, month);

      // The budget: how this month went, and next month's from the last three months.
      const budgetRow = await trx
        .selectFrom('app.budget')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('archived_at', 'is', null)
        .where((eb) => (memberId ? eb('member_id', '=', memberId) : eb('member_id', 'is', null)))
        .executeTakeFirst();
      const monthly = budgetRow && specOf(budgetRow).type === 'monthly' ? budgetRow : null;
      let budget: MonthSummaryDto['budget'] = null;
      if (monthly) {
        const c = await this.budgets.compute(trx, ctx, monthly.id, month.start);
        const lines = [...c.results[c.results.length - 1]!.lines.values()].filter((l) =>
          spend.some((x) => x.id === l.categoryId),
        );
        const over = lines
          .map((l) => ({ l, set: l.assigned + l.moved }))
          .filter(({ l, set }) => set > 0n && l.activity > set)
          .sort((a, b) => (b.l.activity - b.set > a.l.activity - a.set ? 1 : -1))
          .slice(0, 3);
        const assigned = lines.reduce((t, l) => t + l.assigned + l.moved, 0n);
        // Nothing set this month: there's nothing to compare with.
        if (assigned > 0n)
          budget = {
            budgetId: monthly.id,
            assigned: s(assigned),
            spent: s(lines.reduce((t, l) => t + l.activity, 0n)),
            over: over.map(({ l, set }) =>
              named({
                categoryId: l.categoryId,
                assigned: s(set),
                spent: s(l.activity),
                overBy: s(l.activity - set),
              }),
            ),
          };
      }
      let suggestions: MonthSummaryDto['suggestions'] = null;
      const next = monthOf(addMonths(month.start, 1));
      if (complete && next.start === thisMonth) {
        const now = monthly ? await this.budgets.compute(trx, ctx, monthly.id) : null;
        const set = now ? now.results[now.results.length - 1]!.lines : null;
        const lines = budgetSuggestions(
          spend
            .filter((c) => !['savings', 'debt'].includes(c.kind ?? ''))
            .map((c) => ({
              categoryId: c.id,
              history: [...before.slice(1), month].map((p) => of(p, c.id)),
              current: set?.get(c.id)?.assigned ?? null,
            })),
          { min: 1000n },
        );
        suggestions = lines.length
          ? {
              period: next,
              lines: lines.map((l) =>
                named({
                  categoryId: l.categoryId,
                  current: l.current === null ? null : s(l.current),
                  suggested: s(l.suggested),
                }),
              ),
            }
          : null;
      }

      const dto: Omit<MonthSummaryDto, 'story'> = {
        entityId,
        memberId,
        currency,
        month,
        complete,
        nav: { previous: before[2]!.start, next: month.start === thisMonth ? null : next.start },
        income: s(income),
        spent: s(spent),
        left: s(income - spent),
        keptPercent: keptPercent(income, spent),
        previous: previous ? { income: s(previous.income), spent: s(previous.spent) } : null,
        usual: usual ? { income: s(usual.income), spent: s(usual.spent), months: usual.months } : null,
        categories: top.map((r) => {
          const u = usualOf(r);
          return named({ categoryId: r.categoryId, spent: s(r.spent), usual: u === null ? null : s(u) });
        }),
        changes: {
          up: changes.up.map((c) =>
            named({ categoryId: c.categoryId, spent: s(c.spent), usual: s(c.usual), change: s(c.change) }),
          ),
          down: changes.down.map((c) =>
            named({ categoryId: c.categoryId, spent: s(c.spent), usual: s(c.usual), change: s(c.change) }),
          ),
        },
        largest,
        budget,
        suggestions,
        needsReview,
      };
      return { ...dto, story: await this.story(trx, ctx, dto) };
    });
  }

  /** The AI's wording of the figures, or plain sentences from them. */
  private async story(
    trx: Trx,
    ctx: Ctx,
    d: Omit<MonthSummaryDto, 'story'>,
  ): Promise<MonthSummaryDto['story']> {
    const label = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${d.month.start}T00:00:00Z`));
    const fmt = (v: string) => formatMoney(money(BigInt(v), d.currency));
    const abs = (v: string) => (v.startsWith('-') ? v.slice(1) : v);
    const figures: Record<string, string> = { moneyIn: d.income, moneyOut: d.spent, leftOver: d.left };
    const moneyKeys = ['moneyIn', 'moneyOut', 'leftOver'];
    const add = (k: string, v: string, isMoney = true) => {
      figures[k] = v;
      if (isMoney) moneyKeys.push(k);
    };
    if (d.keptPercent !== null) add('shareOfMoneyInKept', `${d.keptPercent}%`, false);
    if (d.usual) add('usualMoneyOut', d.usual.spent);
    for (const c of d.changes.up) add(`moreThanUsual: ${c.name}`, c.change);
    for (const c of d.changes.down) add(`lessThanUsual: ${c.name}`, abs(c.change));
    for (const c of d.categories.slice(0, 3)) add(`spent: ${c.name}`, c.spent);
    if (d.largest[0]) add(`biggestPurchase: ${d.largest[0].payee}`, d.largest[0].amount);
    for (const o of d.budget?.over ?? []) add(`overBudget: ${o.name}`, o.overBy);
    if (d.needsReview > 0) add('transactionsStillToReview', String(d.needsReview), false);
    for (const l of d.suggestions?.lines.slice(0, 4) ?? []) {
      add(`suggested: ${l.name}`, l.suggested);
      if (l.current !== null) add(`budgetNow: ${l.name}`, l.current);
    }
    const names = [
      ...new Set([
        ...d.categories.map((c) => c.name),
        ...d.changes.up.map((c) => c.name),
        ...d.changes.down.map((c) => c.name),
        ...(d.budget?.over.map((o) => o.name) ?? []),
        ...(d.suggestions?.lines.map((l) => l.name) ?? []),
        ...d.largest.slice(0, 1).map((l) => l.payee),
      ]),
    ];

    const runtime = await this.ai.runtime(trx, ctx, { type: 'planning', id: ctx.workspaceId });
    if (runtime.available) {
      const res = await this.ai.gateway.summarizeMonth(
        {
          month: label,
          complete: d.complete,
          figures: formatFigures(d.currency, { figures, money: moneyKeys }),
          names,
        },
        { ...runtime.ctx, parkLocal: false },
      );
      if (res.ok) return { ...res.value, by: 'ai' };
    }

    // Plain sentences from the same figures.
    const income = BigInt(d.income);
    const headline =
      income > 0n
        ? `${d.complete ? 'In' : 'So far in'} ${label} you kept ${fmt(d.left)} of the ${fmt(d.income)} that came in.`
        : `${d.complete ? 'In' : 'So far in'} ${label} you spent ${fmt(d.spent)}.`;
    const points = [
      `Money in ${fmt(d.income)}, money out ${fmt(d.spent)}${d.usual ? ` (usually ${fmt(d.usual.spent)} out)` : ''}.`,
      ...d.changes.up.slice(0, 2).map((c) => `${c.name}: ${fmt(c.spent)}, ${fmt(c.change)} more than usual.`),
      ...d.changes.down
        .slice(0, 1)
        .map((c) => `${c.name}: ${fmt(c.spent)}, ${fmt(abs(c.change))} less than usual.`),
      ...d.largest.slice(0, 1).map((l) => `Biggest purchase: ${l.payee}, ${fmt(l.amount)}.`),
      ...(d.budget?.over.slice(0, 1).map((o) => `${o.name} went ${fmt(o.overBy)} over budget.`) ?? []),
    ].slice(0, 5);
    const budgetNote = d.suggestions
      ? `From your last three months, ${d.suggestions.lines.length === 1 ? 'one category' : `${d.suggestions.lines.length} categories`} could use a different budget this month.`
      : null;
    return { headline, points, budgetNote, by: 'plain' };
  }

  /** The biggest single purchases: one line each, voided ones left out. */
  private async largest(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    memberId: string | null,
    month: Period,
    spendIds: string[],
  ): Promise<MonthSummaryDto['largest']> {
    if (!spendIds.length) return [];
    const { rows } = await sql<{ id: string; d: string; payee: string; category: string; v: string }>`
      select t.id, t.txn_date::text as d,
             coalesce(py.display_name, nullif(t.payee_raw, ''), nullif(t.description, ''), '') as payee,
             a.name as category, sum(p.functional_amount_minor)::text as v
        from app.posting p
        join app.journal_entry j on j.id = p.journal_entry_id
        join app.transaction t on t.id = j.transaction_id
        join app.ledger_account a on a.id = p.ledger_account_id
        left join app.payee py on py.id = t.payee_id
       where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
         and p.ledger_account_id = any(${spendIds}::uuid[])
         and p.entry_date between ${month.start} and ${month.end}
         and t.deleted_at is null and j.reverses_entry_id is null
         and not exists (select 1 from app.journal_entry r
                          where r.workspace_id = j.workspace_id and r.reverses_entry_id = j.id)
         ${memberId ? sql`and p.member_id = ${memberId}` : sql``}
       group by t.id, t.txn_date, py.display_name, t.payee_raw, t.description, a.name
      having sum(p.functional_amount_minor) > 0
       order by sum(p.functional_amount_minor) desc, t.id
       limit 3`.execute(trx);
    return rows.map((r) => ({
      transactionId: r.id,
      date: calendarDate(r.d),
      payee: r.payee,
      categoryName: r.category,
      amount: r.v,
    }));
  }

  private async needsReview(trx: Trx, ctx: Ctx, entityId: string, month: Period): Promise<number> {
    const row = await trx
      .selectFrom('app.transaction')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('primary_entity_id', '=', entityId)
      .where('review_state', '=', 'needs_review')
      .where('status', '=', 'posted')
      .where('deleted_at', 'is', null)
      .where('txn_date', '>=', month.start)
      .where('txn_date', '<=', month.end)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  private async defaultEntity(trx: Trx, ctx: Ctx): Promise<string> {
    const row = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('archived_at', 'is', null)
      .orderBy(sql`case when type = 'personal' then 0 else 1 end`)
      .orderBy('created_at')
      .executeTakeFirst();
    if (!row) throw notFound('Entity');
    return row.id;
  }
}
