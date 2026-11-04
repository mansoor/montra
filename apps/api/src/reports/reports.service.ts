/**
 * The report catalogue (RPT-01..03, RCP-09; ADR-0019 §1, §2). Every report returns one shape, so filters, drill-down, saving and export
 * are written once. Numbers are read under the viewer's RLS, and reports with a richer screen of their own feed this from the same
 * services, so they agree. Consolidated figures are in the base currency, at the period end's rate.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  asCurrencyCode,
  calendarDate,
  convert,
  money,
  parseDecimal,
  startOfMonth,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import type {
  CreateSavedReportRequest,
  DrillDto,
  ReportDto,
  ReportFilters,
  ReportRowDto,
  ReportType,
  SavedReportDto,
} from '@montra/schemas';
import { BusinessReportsService } from '../business/business-reports.service.js';
import { notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { FxRatesService } from '../fx/fx.service.js';
import { MemberReportsService } from '../payslips/member-reports.service.js';
import { BudgetsService } from '../planning/budgets.service.js';
import { FlowService } from '../planning/flow.service.js';
import { RentalReportsService } from '../rentals/rental-reports.service.js';

type Ctx = { workspaceId: string; userId: string };
type Body = Omit<ReportDto, 'type' | 'from' | 'to' | 'uses'> & { from?: CalendarDate; to?: CalendarDate };

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));
const MAX_ROWS = 500;
const MAX_LEDGER_ROWS = 5000;

const USES: Record<ReportType, string[]> = {
  spending: [
    'from',
    'to',
    'entityId',
    'accountIds',
    'categoryIds',
    'tags',
    'propertyId',
    'memberId',
    'groupBy',
  ],
  'income-expense': ['from', 'to', 'entityId', 'accountIds', 'categoryIds', 'tags', 'propertyId', 'memberId'],
  'budget-actual': ['from', 'entityId'],
  'cash-flow': ['from', 'to', 'entityId', 'accountIds'],
  'net-worth': ['from', 'to', 'entityId'],
  pnl: ['from', 'to', 'entityId', 'accountIds', 'categoryIds', 'tags', 'propertyId', 'memberId'],
  'schedule-c': ['to', 'entityId'],
  'schedule-e': ['to', 'entityId'],
  'general-ledger': ['from', 'to', 'entityId', 'accountIds'],
  'trial-balance': ['to', 'entityId'],
  'balance-sheet': ['to', 'entityId'],
  'by-member': ['from', 'to', 'entityId'],
  items: ['from', 'to', 'entityId', 'categoryIds', 'groupBy'],
};

const row = (
  key: string,
  cells: Record<string, string | null>,
  drill: DrillDto | null = null,
  emphasis = false,
): ReportRowDto => ({ key, cells, drill, emphasis });

/** Conditions on `app.posting as p` joined to `journal_entry as je`, shared by every report that reads postings. */
function postingFilters(
  f: ReportFilters,
  ctx: Ctx,
  from: CalendarDate | null,
  to: CalendarDate,
): RawBuilder<unknown>[] {
  const out: RawBuilder<unknown>[] = [sql`p.workspace_id = ${ctx.workspaceId}`, sql`p.entry_date <= ${to}`];
  if (from) out.push(sql`p.entry_date >= ${from}`);
  if (f.entityId) out.push(sql`p.entity_id = ${f.entityId}`);
  if (f.categoryIds?.length) out.push(sql`p.ledger_account_id = any(${f.categoryIds}::uuid[])`);
  if (f.propertyId) out.push(sql`p.property_id = ${f.propertyId}`);
  if (f.memberId === 'household') out.push(sql`p.member_id is null`);
  else if (f.memberId) out.push(sql`p.member_id = ${f.memberId}`);
  if (f.accountIds?.length) {
    out.push(sql`exists (select 1 from app.posting x where x.workspace_id = p.workspace_id
      and x.journal_entry_id = p.journal_entry_id and x.ledger_account_id = any(${f.accountIds}::uuid[]))`);
  }
  if (f.tags?.length) {
    const lowered = f.tags.map((t) => t.toLowerCase());
    out.push(sql`exists (select 1 from app.journal_entry e
      join app.transaction_tag tt on tt.workspace_id = e.workspace_id and tt.transaction_id = e.transaction_id
      join app.tag g on g.workspace_id = tt.workspace_id and g.id = tt.tag_id
      where e.workspace_id = p.workspace_id and e.id = p.journal_entry_id and lower(g.name) = any(${lowered}::text[]))`);
  }
  return out;
}
const whereAll = (parts: RawBuilder<unknown>[]) => sql.join(parts, sql` and `);

/** Amounts in several currencies brought to one, at one date's rate (ADR-0019 §2). */
class Converter {
  usedRate = false;
  missingRate = false;
  constructor(
    readonly currency: string,
    private readonly rate: (from: string) => string | null,
  ) {}

  to(amount: bigint, from: string): bigint {
    if (from === this.currency) return amount;
    const r = this.rate(from);
    if (!r) {
      this.missingRate = true;
      return 0n;
    }
    this.usedRate = true;
    return convert(money(amount, asCurrencyCode(from)), asCurrencyCode(this.currency), parseDecimal(r))
      .amount;
  }

  notes(): string[] {
    return [...(this.usedRate ? ['converted'] : []), ...(this.missingRate ? ['no_rate'] : [])];
  }
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FxRatesService) private readonly fx: FxRatesService,
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(BusinessReportsService) private readonly business: BusinessReportsService,
    @Inject(RentalReportsService) private readonly rentals: RentalReportsService,
    @Inject(MemberReportsService) private readonly members: MemberReportsService,
  ) {}

  async run(ctx: Ctx, type: ReportType, filters: ReportFilters): Promise<ReportDto> {
    const { today } = await this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      if (filters.entityId) {
        const e = await trx
          .selectFrom('app.entity')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', filters.entityId)
          .executeTakeFirst();
        if (!e) throw notFound('Entity');
      }
      return { today: todayIn(ws.time_zone) };
    });
    const to = (filters.to ?? today) as CalendarDate;
    const from = (filters.from ?? (`${to.slice(0, 4)}-01-01` as CalendarDate)) as CalendarDate;
    if (from > to) throw unprocessable('report.dates', 'The start date is after the end date');
    const f = { ...filters, from, to };
    const body = await this.build(ctx, type, f, from, to);
    const notes =
      body.rows.length >= MAX_ROWS && type !== 'general-ledger' ? [...body.notes, 'truncated'] : body.notes;
    return { type, from: body.from ?? from, to: body.to ?? to, uses: USES[type], ...body, notes };
  }

  private build(
    ctx: Ctx,
    type: ReportType,
    f: ReportFilters,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Body> {
    switch (type) {
      case 'spending':
        return this.spending(ctx, f, from, to);
      case 'income-expense':
        return this.incomeExpense(ctx, f, from, to);
      case 'budget-actual':
        return this.budgetActual(ctx, f, from);
      case 'cash-flow':
        return this.cashFlow(ctx, f, from, to);
      case 'net-worth':
        return this.netWorth(ctx, f, from, to);
      case 'pnl':
        return this.pnl(ctx, f, from, to);
      case 'schedule-c':
        return this.scheduleC(ctx, f, to);
      case 'schedule-e':
        return this.scheduleE(ctx, f, to);
      case 'general-ledger':
        return this.generalLedger(ctx, f, from, to);
      case 'trial-balance':
        return this.trialBalance(ctx, f, to);
      case 'balance-sheet':
        return this.balanceSheet(ctx, f, to);
      case 'by-member':
        return this.byMember(ctx, f, from, to);
      case 'items':
        return this.items(ctx, f, from, to);
    }
  }

  /** The currency for this report, and how to reach it from each entity's. */
  private async converter(trx: Trx, ctx: Ctx, f: ReportFilters, to: CalendarDate): Promise<Converter> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('base_currency')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    const entities = await trx
      .selectFrom('app.entity')
      .select(['id', 'functional_currency'])
      .where('workspace_id', '=', ctx.workspaceId)
      .execute();
    const chosen = f.entityId ? entities.find((e) => e.id === f.entityId) : null;
    const currency = chosen ? chosen.functional_currency : ws.base_currency;
    const used = [...new Set(entities.map((e) => e.functional_currency))];
    if (used.every((c) => c === currency)) return new Converter(currency, () => null);
    const rates = await this.fx.table(trx, [...used, currency], to, to);
    return new Converter(currency, (c) => rates.get(c, currency, to)?.rate ?? null);
  }

  private requireEntity(f: ReportFilters): string {
    if (!f.entityId) throw unprocessable('report.entity_required', 'Choose which books this report is for');
    return f.entityId;
  }

  // ----- Spending -------------------------------------------------------------------------------------------

  private async spending(ctx: Ctx, f: ReportFilters, from: CalendarDate, to: CalendarDate): Promise<Body> {
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const by = f.groupBy === 'payee' || f.groupBy === 'tag' ? f.groupBy : 'category';
      const where = whereAll([...postingFilters(f, ctx, from, to), sql`a.type = 'expense'`]);
      const base = sql`from app.posting p
        join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
        join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
        join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id`;
      const { rows } =
        by === 'category'
          ? await sql<{ key: string; label: string; currency: string; amount: string }>`
              select a.id as key, a.name as label, e.functional_currency as currency,
                     sum(p.functional_amount_minor)::text as amount
                ${base} where ${where} group by a.id, a.name, e.functional_currency`.execute(trx)
          : by === 'payee'
            ? await sql<{ key: string; label: string; currency: string; amount: string }>`
                select coalesce(t.payee_raw, je.description, '') as key, coalesce(t.payee_raw, je.description, '') as label,
                       e.functional_currency as currency, sum(p.functional_amount_minor)::text as amount
                  ${base}
                  left join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
                 where ${where} group by 1, 2, e.functional_currency`.execute(trx)
            : await sql<{ key: string; label: string; currency: string; amount: string }>`
                select g.name as key, g.name as label, e.functional_currency as currency,
                       sum(p.functional_amount_minor)::text as amount
                  ${base}
                  join app.transaction_tag tt on tt.workspace_id = je.workspace_id and tt.transaction_id = je.transaction_id
                  join app.tag g on g.workspace_id = tt.workspace_id and g.id = tt.tag_id
                 where ${where} group by g.name, e.functional_currency`.execute(trx);
      const merged = new Map<string, { label: string; amount: bigint }>();
      for (const r of rows) {
        const cur = merged.get(r.key) ?? { label: r.label, amount: 0n };
        cur.amount += c.to(BigInt(r.amount), r.currency);
        merged.set(r.key, cur);
      }
      const total = [...merged.values()].reduce((t, r) => t + r.amount, 0n);
      const common: DrillDto = { from, to, ...(f.entityId ? { entityId: f.entityId } : {}) };
      const sorted = [...merged.entries()]
        .filter(([, r]) => r.amount !== 0n)
        .sort((a, b) => (b[1].amount > a[1].amount ? 1 : b[1].amount < a[1].amount ? -1 : 0))
        .slice(0, MAX_ROWS);
      return {
        currency: asCurrencyCode(c.currency),
        columns: [
          { key: by, kind: 'text' as const },
          { key: 'amount', kind: 'money' as const },
          { key: 'share', kind: 'percent' as const },
        ],
        rows: sorted.map(([key, r]) =>
          row(
            key,
            {
              [by]: r.label,
              amount: String(r.amount),
              share: total > 0n ? (Number((r.amount * 1000n) / total) / 10).toFixed(1) : null,
            },
            by === 'category'
              ? { ...common, categoryIds: [key] }
              : by === 'payee'
                ? { ...common, q: `"${r.label.replace(/"/g, '')}"` }
                : { ...common, q: `tag:${r.label.replace(/\s/g, '')}` },
          ),
        ),
        totals: { [by]: null, amount: String(total), share: null },
        chart: { kind: 'bar', x: by, y: ['amount'] },
        // A transaction with two tags counts under both, so the rows can add up to more than was spent.
        notes: [...c.notes(), ...(by === 'tag' ? ['tags_overlap'] : [])],
      };
    });
  }

  // ----- Income and expense by month --------------------------------------------------------------------------

  private async incomeExpense(
    ctx: Ctx,
    f: ReportFilters,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Body> {
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const { rows } = await sql<{ month: string; currency: string; income: string; expense: string }>`
        select date_trunc('month', p.entry_date)::date::text as month, e.functional_currency as currency,
               coalesce(sum(-p.functional_amount_minor) filter (where a.type = 'income'), 0)::text as income,
               coalesce(sum(p.functional_amount_minor) filter (where a.type = 'expense'), 0)::text as expense
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
         where ${whereAll([...postingFilters(f, ctx, from, to), sql`a.type in ('income', 'expense')`])}
         group by 1, 2 order by 1`.execute(trx);
      const months = new Map<string, { income: bigint; expense: bigint }>();
      for (const r of rows) {
        const m = months.get(r.month) ?? { income: 0n, expense: 0n };
        m.income += c.to(BigInt(r.income), r.currency);
        m.expense += c.to(BigInt(r.expense), r.currency);
        months.set(r.month, m);
      }
      let income = 0n;
      let expense = 0n;
      const out = [...months.entries()].map(([month, m]) => {
        income += m.income;
        expense += m.expense;
        const start = iso(month);
        return row(
          month,
          {
            month,
            income: String(m.income),
            expense: String(m.expense),
            net: String(m.income - m.expense),
          },
          {
            from: start < from ? from : start,
            to: endOfMonthWithin(start, to),
            ...(f.entityId ? { entityId: f.entityId } : {}),
          },
        );
      });
      return {
        currency: asCurrencyCode(c.currency),
        columns: [
          { key: 'month', kind: 'date' as const },
          { key: 'income', kind: 'money' as const },
          { key: 'expense', kind: 'money' as const },
          { key: 'net', kind: 'money' as const },
        ],
        rows: out,
        totals: {
          month: null,
          income: String(income),
          expense: String(expense),
          net: String(income - expense),
        },
        chart: { kind: 'line', x: 'month', y: ['income', 'expense'] },
        notes: c.notes(),
      };
    });
  }

  // ----- Budget against actual ---------------------------------------------------------------------------------

  private async budgetActual(ctx: Ctx, f: ReportFilters, from: CalendarDate): Promise<Body> {
    const budgets = await this.budgets.list(ctx, f.entityId);
    const budget = budgets.find((b) => b.memberId === null) ?? budgets[0];
    if (!budget) {
      const currency = await this.db.run(ctx, (trx) => this.converter(trx, ctx, f, from));
      return {
        currency: asCurrencyCode(currency.currency),
        columns: columns(
          ['category', 'text'],
          ['assigned', 'money'],
          ['activity', 'money'],
          ['available', 'money'],
        ),
        rows: [],
        totals: null,
        chart: null,
        notes: ['no_budget'],
      };
    }
    const period = await this.budgets.period(ctx, budget.id, startOfMonth(from));
    const rows: ReportRowDto[] = [];
    const span = { from: period.start, to: period.end, entityId: budget.entityId };
    for (const g of period.groups) {
      rows.push(
        row(
          `group:${g.id}`,
          { category: g.name, assigned: g.assigned, activity: g.activity, available: g.available },
          null,
          true,
        ),
      );
      for (const l of g.lines) {
        rows.push(
          row(
            l.categoryId,
            { category: l.name, assigned: l.assigned, activity: l.activity, available: l.available },
            { ...span, categoryIds: [l.categoryId] },
          ),
        );
      }
    }
    for (const u of period.unbudgeted) {
      rows.push(
        row(
          u.categoryId,
          { category: u.name, assigned: '0', activity: u.activity, available: String(-BigInt(u.activity)) },
          { ...span, categoryIds: [u.categoryId] },
        ),
      );
    }
    return {
      from: period.start,
      to: period.end,
      currency: budget.currency,
      columns: columns(
        ['category', 'text'],
        ['assigned', 'money'],
        ['activity', 'money'],
        ['available', 'money'],
      ),
      rows,
      totals: {
        category: null,
        assigned: period.assigned,
        activity: period.activity,
        available: period.available,
      },
      chart: null,
      notes: [],
    };
  }

  // ----- Cash flow -----------------------------------------------------------------------------------------------

  private async cashFlow(ctx: Ctx, f: ReportFilters, from: CalendarDate, to: CalendarDate): Promise<Body> {
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const accountFilter = f.accountIds?.length
        ? sql`p.ledger_account_id = any(${f.accountIds}::uuid[])`
        : sql`b.kind in ('checking', 'savings', 'cash')`;
      const { rows } = await sql<{
        month: string;
        currency: string;
        inflow: string;
        outflow: string;
        transfers: string;
      }>`
        select date_trunc('month', p.entry_date)::date::text as month, e.functional_currency as currency,
               coalesce(sum(p.functional_amount_minor) filter (where je.kind <> 'transfer' and p.functional_amount_minor > 0), 0)::text as inflow,
               coalesce(sum(-p.functional_amount_minor) filter (where je.kind <> 'transfer' and p.functional_amount_minor < 0), 0)::text as outflow,
               coalesce(sum(p.functional_amount_minor) filter (where je.kind = 'transfer'), 0)::text as transfers
          from app.posting p
          join app.bank_account b on b.workspace_id = p.workspace_id and b.ledger_account_id = p.ledger_account_id
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
         where p.workspace_id = ${ctx.workspaceId} and p.entry_date between ${from} and ${to}
           and je.kind <> 'opening_balance' and ${accountFilter}
           ${f.entityId ? sql`and p.entity_id = ${f.entityId}` : sql``}
         group by 1, 2 order by 1`.execute(trx);
      const months = new Map<string, { inflow: bigint; outflow: bigint; transfers: bigint }>();
      for (const r of rows) {
        const m = months.get(r.month) ?? { inflow: 0n, outflow: 0n, transfers: 0n };
        m.inflow += c.to(BigInt(r.inflow), r.currency);
        m.outflow += c.to(BigInt(r.outflow), r.currency);
        m.transfers += c.to(BigInt(r.transfers), r.currency);
        months.set(r.month, m);
      }
      const totals = { inflow: 0n, outflow: 0n, transfers: 0n };
      const out = [...months.entries()].map(([month, m]) => {
        totals.inflow += m.inflow;
        totals.outflow += m.outflow;
        totals.transfers += m.transfers;
        const start = iso(month);
        return row(
          month,
          {
            month,
            inflow: String(m.inflow),
            outflow: String(m.outflow),
            transfers: String(m.transfers),
            net: String(m.inflow - m.outflow + m.transfers),
          },
          {
            from: start < from ? from : start,
            to: endOfMonthWithin(start, to),
            ...(f.entityId ? { entityId: f.entityId } : {}),
            ...(f.accountIds?.length ? { accountIds: f.accountIds } : {}),
          },
        );
      });
      return {
        currency: asCurrencyCode(c.currency),
        columns: columns(
          ['month', 'date'],
          ['inflow', 'money'],
          ['outflow', 'money'],
          ['transfers', 'money'],
          ['net', 'money'],
        ),
        rows: out,
        totals: {
          month: null,
          inflow: String(totals.inflow),
          outflow: String(totals.outflow),
          transfers: String(totals.transfers),
          net: String(totals.inflow - totals.outflow + totals.transfers),
        },
        chart: { kind: 'bar', x: 'month', y: ['inflow', 'outflow'] },
        notes: c.notes(),
      };
    });
  }

  // ----- Net worth ------------------------------------------------------------------------------------------------

  private async netWorth(ctx: Ctx, f: ReportFilters, from: CalendarDate, to: CalendarDate): Promise<Body> {
    const months = Math.min(
      60,
      Math.max(
        1,
        (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
          Number(to.slice(5, 7)) -
          Number(from.slice(5, 7)) +
          1,
      ),
    );
    const n = await this.flow.netWorth(ctx, { date: to, entityId: f.entityId ?? null, months });
    return {
      currency: n.currency,
      columns: columns(
        ['date', 'date'],
        ['assets', 'money'],
        ['liabilities', 'money'],
        ['net_worth', 'money'],
      ),
      rows: n.trend.map((p) =>
        row(p.date, { date: p.date, assets: p.assets, liabilities: p.liabilities, net_worth: p.netWorth }),
      ),
      totals: null,
      chart: { kind: 'line', x: 'date', y: ['net_worth'] },
      notes: [],
    };
  }

  // ----- P&L ---------------------------------------------------------------------------------------------------------

  private async pnl(ctx: Ctx, f: ReportFilters, from: CalendarDate, to: CalendarDate): Promise<Body> {
    const entityId = this.requireEntity(f);
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const { rows } = await sql<{ id: string; name: string; type: 'income' | 'expense'; amount: string }>`
        select a.id, a.name, a.type,
               sum(case when a.type = 'income' then -p.functional_amount_minor else p.functional_amount_minor end)::text as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         where ${whereAll([...postingFilters(f, ctx, from, to), sql`a.type in ('income', 'expense')`])}
         group by a.id, a.name, a.type having sum(p.functional_amount_minor) <> 0 order by a.name`.execute(
        trx,
      );
      const section = (type: 'income' | 'expense') => rows.filter((r) => r.type === type);
      const sum = (list: typeof rows) => list.reduce((t, r) => t + BigInt(r.amount), 0n);
      const income = sum(section('income'));
      const expense = sum(section('expense'));
      const span = { entityId, from, to };
      const lines = (list: typeof rows) =>
        list.map((r) => row(r.id, { category: r.name, amount: r.amount }, { ...span, categoryIds: [r.id] }));
      return {
        currency: asCurrencyCode(c.currency),
        columns: columns(['category', 'text'], ['amount', 'money']),
        rows: [
          row('income', { category: 'income', amount: String(income) }, null, true),
          ...lines(section('income')),
          row('expense', { category: 'expense', amount: String(expense) }, null, true),
          ...lines(section('expense')),
        ],
        totals: { category: 'net', amount: String(income - expense) },
        chart: null,
        notes: ['section_labels'],
      };
    });
  }

  // ----- Schedules C and E ----------------------------------------------------------------------------------------------

  private async scheduleC(ctx: Ctx, f: ReportFilters, to: CalendarDate): Promise<Body> {
    const entityId = this.requireEntity(f);
    const year = Number(to.slice(0, 4));
    const s = await this.business.scheduleC(ctx, entityId, year);
    const drillSpan = {
      entityId,
      from: `${year}-01-01` as CalendarDate,
      to: `${year}-12-31` as CalendarDate,
    };
    return {
      from: drillSpan.from,
      to: drillSpan.to,
      currency: s.currency,
      columns: columns(['line', 'text'], ['item', 'text'], ['amount', 'money']),
      rows: [
        ...s.lines.map((l) =>
          row(
            l.code,
            { line: l.line, item: l.label, amount: l.amount },
            l.categoryIds.length ? { ...drillSpan, categoryIds: l.categoryIds } : null,
          ),
        ),
        ...s.unmapped.map((u) =>
          row(
            u.categoryId,
            { line: null, item: u.name, amount: u.amount },
            { ...drillSpan, categoryIds: [u.categoryId] },
          ),
        ),
      ],
      totals: { line: null, item: 'net', amount: s.netProfit },
      chart: null,
      notes: ['tax_not_advice', ...(s.unmapped.length ? ['unmapped'] : [])],
    };
  }

  private async scheduleE(ctx: Ctx, f: ReportFilters, to: CalendarDate): Promise<Body> {
    const entityId = this.requireEntity(f);
    const year = Number(to.slice(0, 4));
    const s = await this.rentals.scheduleE(ctx, entityId, year);
    const drillSpan = {
      entityId,
      from: `${year}-01-01` as CalendarDate,
      to: `${year}-12-31` as CalendarDate,
    };
    const rows: ReportRowDto[] = [];
    for (const p of s.properties) {
      const key = p.propertyId ?? 'none';
      rows.push(row(`property:${key}`, { line: null, item: p.name || null, amount: p.net }, null, true));
      for (const l of p.lines) {
        rows.push(
          row(
            `${key}:${l.code}`,
            { line: l.line, item: l.label, amount: l.amount },
            l.categoryIds.length
              ? {
                  ...drillSpan,
                  categoryIds: l.categoryIds,
                  ...(p.propertyId ? { propertyId: p.propertyId } : {}),
                }
              : null,
          ),
        );
      }
    }
    for (const u of s.unmapped) {
      rows.push(
        row(
          `unmapped:${u.categoryId}`,
          { line: null, item: u.name, amount: u.amount },
          { ...drillSpan, categoryIds: [u.categoryId] },
        ),
      );
    }
    return {
      from: drillSpan.from,
      to: drillSpan.to,
      currency: s.currency,
      columns: columns(['line', 'text'], ['item', 'text'], ['amount', 'money']),
      rows,
      totals: { line: null, item: 'net', amount: s.totalNet },
      chart: null,
      notes: ['tax_not_advice', ...(s.unmapped.length ? ['unmapped'] : [])],
    };
  }

  // ----- General ledger, trial balance and balance sheet ------------------------------------------------------------------

  private async generalLedger(
    ctx: Ctx,
    f: ReportFilters,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Body> {
    const entityId = this.requireEntity(f);
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const scope = f.accountIds?.length
        ? sql`and p.ledger_account_id = any(${f.accountIds}::uuid[])`
        : sql``;
      const { rows: opening } = await sql<{ id: string; amount: string }>`
        select p.ledger_account_id as id, sum(p.functional_amount_minor)::text as amount from app.posting p
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId} and p.entry_date < ${from} ${scope}
         group by 1`.execute(trx);
      const { rows: lines } = await sql<{
        id: string;
        account_id: string;
        account: string;
        d: string;
        description: string;
        payee: string | null;
        amount: string;
      }>`
        select p.id, a.id as account_id, a.name as account, p.entry_date::text as d, je.description, t.payee_raw as payee,
               p.functional_amount_minor::text as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          left join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
           and p.entry_date between ${from} and ${to} ${scope}
         order by a.name, a.id, p.entry_date, p.id
         limit ${MAX_LEDGER_ROWS + 1}`.execute(trx);
      const openings = new Map(opening.map((o) => [o.id, BigInt(o.amount)]));
      const truncated = lines.length > MAX_LEDGER_ROWS;
      const out: ReportRowDto[] = [];
      let current: string | null = null;
      let balance = 0n;
      for (const l of lines.slice(0, MAX_LEDGER_ROWS)) {
        if (l.account_id !== current) {
          current = l.account_id;
          balance = openings.get(l.account_id) ?? 0n;
          out.push(
            row(
              `account:${l.account_id}`,
              { date: null, description: l.account, debit: null, credit: null, balance: String(balance) },
              { entityId, accountIds: [l.account_id], from, to },
              true,
            ),
          );
        }
        const amount = BigInt(l.amount);
        balance += amount;
        out.push(
          row(l.id, {
            date: l.d,
            description: [l.payee, l.description].filter(Boolean).join(' · '),
            debit: amount > 0n ? String(amount) : null,
            credit: amount < 0n ? String(-amount) : null,
            balance: String(balance),
          }),
        );
      }
      return {
        currency: asCurrencyCode(c.currency),
        columns: columns(
          ['date', 'date'],
          ['description', 'text'],
          ['debit', 'money'],
          ['credit', 'money'],
          ['balance', 'money'],
        ),
        rows: out,
        totals: null,
        chart: null,
        notes: truncated ? ['ledger_truncated'] : [],
      };
    });
  }

  /** Every account's balance as of a date, debits positive. */
  private async balances(trx: Trx, ctx: Ctx, entityId: string, to: CalendarDate) {
    const { rows } = await sql<{
      id: string;
      name: string;
      type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
      amount: string;
    }>`
      select a.id, a.name, a.type, sum(p.functional_amount_minor)::text as amount
        from app.posting p
        join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
       where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId} and p.entry_date <= ${to}
       group by a.id, a.name, a.type
      having sum(p.functional_amount_minor) <> 0
       order by a.type, a.name`.execute(trx);
    return rows;
  }

  private async trialBalance(ctx: Ctx, f: ReportFilters, to: CalendarDate): Promise<Body> {
    const entityId = this.requireEntity(f);
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const rows = await this.balances(trx, ctx, entityId, to);
      let debit = 0n;
      let credit = 0n;
      const out = rows.map((r) => {
        const amount = BigInt(r.amount);
        if (amount > 0n) debit += amount;
        else credit -= amount;
        return row(
          r.id,
          {
            account: r.name,
            debit: amount > 0n ? String(amount) : null,
            credit: amount < 0n ? String(-amount) : null,
          },
          { entityId, accountIds: [r.id], to },
        );
      });
      return {
        from: to,
        to,
        currency: asCurrencyCode(c.currency),
        columns: columns(['account', 'text'], ['debit', 'money'], ['credit', 'money']),
        rows: out,
        totals: { account: null, debit: String(debit), credit: String(credit) },
        chart: null,
        notes: [],
      };
    });
  }

  private async balanceSheet(ctx: Ctx, f: ReportFilters, to: CalendarDate): Promise<Body> {
    const entityId = this.requireEntity(f);
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const rows = await this.balances(trx, ctx, entityId, to);
      const of = (type: string) => rows.filter((r) => r.type === type);
      const sign = (r: (typeof rows)[number]) => (r.type === 'asset' ? BigInt(r.amount) : -BigInt(r.amount));
      const total = (list: typeof rows) => list.reduce((t, r) => t + sign(r), 0n);
      const assets = total(of('asset'));
      const liabilities = total(of('liability'));
      // What's been earned and not yet closed to equity; there are no closing entries in this ledger.
      const retained = -[...of('income'), ...of('expense')].reduce((t, r) => t + BigInt(r.amount), 0n);
      const equity = total(of('equity')) + retained;
      const section = (key: string, list: typeof rows, sum: bigint) => [
        row(key, { account: key, amount: String(sum) }, null, true),
        ...list.map((r) =>
          row(r.id, { account: r.name, amount: String(sign(r)) }, { entityId, accountIds: [r.id], to }),
        ),
      ];
      return {
        from: to,
        to,
        currency: asCurrencyCode(c.currency),
        columns: columns(['account', 'text'], ['amount', 'money']),
        rows: [
          ...section('assets', of('asset'), assets),
          ...section('liabilities', of('liability'), liabilities),
          ...section('equity', of('equity'), equity),
          row('retained', { account: 'retained', amount: String(retained) }),
        ],
        totals: { account: 'liabilities_and_equity', amount: String(liabilities + equity) },
        chart: null,
        notes: ['section_labels'],
      };
    });
  }

  // ----- By member -------------------------------------------------------------------------------------------------------

  private async byMember(ctx: Ctx, f: ReportFilters, from: CalendarDate, to: CalendarDate): Promise<Body> {
    const r = await this.members.byMember(ctx, { from, to, ...(f.entityId ? { entityId: f.entityId } : {}) });
    const income = r.members.reduce((t, m) => t + BigInt(m.income), 0n);
    const spending = r.members.reduce((t, m) => t + BigInt(m.spending), 0n);
    return {
      currency: r.currency,
      columns: columns(['member', 'text'], ['income', 'money'], ['spending', 'money'], ['share', 'percent']),
      rows: r.members.map((m) =>
        row(
          m.memberId ?? 'household',
          { member: m.name, income: m.income, spending: m.spending, share: m.spendingShare.toFixed(1) },
          { memberId: m.memberId ?? 'household', from, to, ...(f.entityId ? { entityId: f.entityId } : {}) },
        ),
      ),
      totals: { member: null, income: String(income), spending: String(spending), share: null },
      chart: { kind: 'bar', x: 'member', y: ['spending'] },
      notes: [],
    };
  }

  // ----- Items on receipts (RCP-09) ----------------------------------------------------------------------------------------

  private async items(ctx: Ctx, f: ReportFilters, from: CalendarDate, to: CalendarDate): Promise<Body> {
    return this.db.run(ctx, async (trx) => {
      const c = await this.converter(trx, ctx, f, to);
      const by = f.groupBy === 'store' || f.groupBy === 'category' ? f.groupBy : 'item';
      const conditions: RawBuilder<unknown>[] = [
        sql`r.workspace_id = ${ctx.workspaceId}`,
        sql`r.deleted_at is null`,
        sql`r.receipt_date between ${from} and ${to}`,
      ];
      if (f.entityId) conditions.push(sql`coalesce(l.entity_id, r.entity_id) = ${f.entityId}`);
      if (f.categoryIds?.length) conditions.push(sql`l.category_id = any(${f.categoryIds}::uuid[])`);
      const label =
        by === 'store'
          ? sql`coalesce(r.merchant, r.merchant_raw, '')`
          : by === 'category'
            ? sql`coalesce(a.name, '')`
            : sql`lower(coalesce(l.expanded_name, l.raw_text))`;
      const { rows } = await sql<{
        label: string;
        currency: string;
        amount: string;
        lines: string;
        stores: string;
      }>`
        select ${label} as label, coalesce(r.currency, e.functional_currency) as currency,
               sum(l.line_total_minor - l.discount_minor)::text as amount, count(*)::text as lines,
               string_agg(distinct coalesce(r.merchant, r.merchant_raw, ''), ', ') as stores
          from app.receipt_line l
          join app.receipt r on r.workspace_id = l.workspace_id and r.id = l.receipt_id
          join app.entity e on e.workspace_id = r.workspace_id and e.id = r.entity_id
          left join app.ledger_account a on a.workspace_id = l.workspace_id and a.id = l.category_id
         where ${whereAll(conditions)}
         group by 1, 2`.execute(trx);
      const merged = new Map<string, { amount: bigint; lines: number; stores: Set<string> }>();
      for (const r of rows) {
        const m = merged.get(r.label) ?? { amount: 0n, lines: 0, stores: new Set<string>() };
        m.amount += c.to(BigInt(r.amount), r.currency);
        m.lines += Number(r.lines);
        for (const s of r.stores.split(', ')) if (s) m.stores.add(s);
        merged.set(r.label, m);
      }
      const total = [...merged.values()].reduce((t, r) => t + r.amount, 0n);
      const sorted = [...merged.entries()]
        .sort((a, b) => (b[1].amount > a[1].amount ? 1 : b[1].amount < a[1].amount ? -1 : 0))
        .slice(0, MAX_ROWS);
      return {
        currency: asCurrencyCode(c.currency),
        columns: columns([by, 'text'], ['stores', 'text'], ['lines', 'number'], ['amount', 'money']),
        rows: sorted.map(([key, r]) =>
          row(key, {
            [by]: key,
            stores: [...r.stores].sort().join(', '),
            lines: String(r.lines),
            amount: String(r.amount),
          }),
        ),
        totals: { [by]: null, stores: null, lines: null, amount: String(total) },
        chart: null,
        notes: c.notes(),
      };
    });
  }

  // ----- Saved reports (RPT-02) ---------------------------------------------------------------------------------------------

  async listSaved(ctx: Ctx): Promise<SavedReportDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.saved_report')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('user_id', '=', ctx.userId)
        .orderBy('name')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type as ReportType,
        filters: r.filters,
        version: Number(r.version),
      }));
    });
  }

  async createSaved(ctx: Ctx, req: CreateSavedReportRequest): Promise<SavedReportDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await trx
        .insertInto('app.saved_report')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          user_id: ctx.userId,
          name: req.name,
          type: req.type,
          filters: JSON.stringify(req.filters),
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'user_id', 'name'])
            .doUpdateSet({ type: req.type, filters: JSON.stringify(req.filters) }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        id: r.id,
        name: r.name,
        type: r.type as ReportType,
        filters: r.filters,
        version: Number(r.version),
      };
    });
  }

  async removeSaved(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .deleteFrom('app.saved_report')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numDeletedRows) throw notFound('Saved report');
    });
  }
}

function columns(...list: [string, ReportDto['columns'][number]['kind']][]): ReportDto['columns'] {
  return list.map(([key, kind]) => ({ key, kind }));
}

/** The last day of a month, but not past the report's end. */
function endOfMonthWithin(start: CalendarDate, to: CalendarDate): CalendarDate {
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${start.slice(0, 7)}-${String(last).padStart(2, '0')}` as CalendarDate;
  return end > to ? to : end;
}
