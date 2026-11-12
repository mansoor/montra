/**
 * P&L, income by customer, expenses by vendor, Schedule C, estimated tax and the missing-receipt list (BIZ-09, BIZ-10,
 * BIZ-12, AI-10). All cash basis, read straight from postings under RLS. Tax figures are estimates, not tax advice.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  addMonths,
  asCurrencyCode,
  calendarDate,
  compareDates,
  endOfMonth,
  monthsEnding,
  startOfMonth,
  summarizeBusinessMonths,
  daysBetween,
  depreciationForYear,
  divRound,
  estimatedTaxPeriods,
  fiscalYearOf,
  fiscalYearRange,
  marginBps,
  taxSetAside,
  taxSetAsideTarget,
  type CalendarDate,
  type DepreciationMethod,
} from '@montra/domain';
import type {
  BusinessDashboardDto,
  BusinessDashboardQuery,
  MissingReceiptsDto,
  PartyKind,
  PartyReportDto,
  PnlDto,
  ScheduleCDto,
  TaxEstimateDto,
  TaxLineDto,
  TaxLineSuggestionDto,
} from '@montra/schemas';
import { AiService } from '../ai/ai.service.js';
import { Db } from '../db/database.js';
import { BusinessService } from './business.service.js';
import { GAIN_LOSS_SUBTYPE, MILEAGE_REIMBURSEMENTS_SUBTYPE } from './asset-accounts.js';
import { assetCandidates } from './expense-details.js';
import {
  businessEntity,
  taxedEntity,
  dateOf,
  TAX_COUNTRY,
  todayOf,
  type BusinessEntity,
  type Ctx,
} from './shared.js';

const SCHEDULE_C = 'schedule_c';
const CAR_AND_TRUCK = 'US_SCH_C_L9';

@Injectable()
export class BusinessReportsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(BusinessService) private readonly business: BusinessService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  // ----- P&L ---------------------------------------------------------------------------------------------

  async pnl(ctx: Ctx, q: { entityId: string; from?: CalendarDate; to?: CalendarDate }): Promise<PnlDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, q.entityId);
      const today = todayOf(e);
      // The fiscal year to date by default (ADR-0037 §2).
      const from =
        q.from ?? fiscalYearRange(fiscalYearOf(today, e.fiscalYearStartMonth), e.fiscalYearStartMonth).from;
      const to = q.to ?? today;
      const { rows } = await sql<{
        id: string;
        name: string;
        type: 'income' | 'expense';
        group_name: string | null;
        tax_line_code: string | null;
        amount: string;
      }>`
        select a.id, a.name, a.type, g.name as group_name, a.tax_line_code,
               sum(case when a.type = 'income' then -p.functional_amount_minor else p.functional_amount_minor end)::text as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          left join app.category_group g on g.workspace_id = a.workspace_id and g.id = a.category_group_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and a.type in ('income', 'expense') and p.entry_date between ${from} and ${to}
         group by a.id, a.name, a.type, g.name, a.tax_line_code
        having sum(p.functional_amount_minor) <> 0
         order by a.name`.execute(trx);
      const monthly = await pnlMonths(trx, ctx, e.id, from, to);
      const line = (r: (typeof rows)[number]) => ({
        categoryId: r.id,
        name: r.name,
        group: r.group_name,
        taxLineCode: r.tax_line_code,
        amount: r.amount,
      });
      const income = rows.filter((r) => r.type === 'income');
      const expense = rows.filter((r) => r.type === 'expense');
      const revenue = income.reduce((t, r) => t + BigInt(r.amount), 0n);
      const expenses = expense.reduce((t, r) => t + BigInt(r.amount), 0n);
      return {
        entityId: e.id,
        from,
        to,
        currency: asCurrencyCode(e.currency),
        revenue: String(revenue),
        expenses: String(expenses),
        netProfit: String(revenue - expenses),
        marginBps: marginBps(revenue, expenses),
        income: income.map(line),
        expense: expense.map(line),
        months: monthly.map((m) => ({ month: dateOf(m.month), revenue: m.revenue, expenses: m.expenses })),
      };
    });
  }

  // ----- The landing page (ADR-0032) ---------------------------------------------------------------------------

  async dashboard(ctx: Ctx, entityId: string, q: BusinessDashboardQuery): Promise<BusinessDashboardDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const today = todayOf(e);
      const thisMonth = startOfMonth(today);
      const first = await sql<{ d: string | null }>`
        select min(entry_date)::text as d from app.posting
         where workspace_id = ${ctx.workspaceId} and entity_id = ${e.id}`.execute(trx);
      const firstMonth = first.rows[0]?.d ? startOfMonth(dateOf(first.rows[0].d)) : thisMonth;
      const periods: { start: CalendarDate; end: CalendarDate }[] = [];
      for (let m = thisMonth; periods.length < 60 && compareDates(m, firstMonth) >= 0; m = addMonths(m, -1))
        periods.push({ start: m, end: endOfMonth(m) });
      const chosen = q.month && compareDates(q.month, thisMonth) < 0 ? q.month : thisMonth;
      const months = monthsEnding(chosen, q.months);
      const from = months[0]!.start;
      const to = months[months.length - 1]!.end;
      // A balance is as of today at most: later-dated entries (a scheduled payment) haven't happened yet.
      const cashTo = compareDates(to, today) > 0 ? today : to;

      // Revenue and expenses: the P&L's own query, so a month here is the P&L for that month.
      const pnl = new Map((await pnlMonths(trx, ctx, e.id, from, to)).map((m) => [m.month, m]));

      // Money in and out: per journal entry, the net movement on the business's bank, cash and card accounts, so a
      // transfer between two of them nets to nothing. Opening balances, corrections and revaluations aren't money moving.
      const { rows: flows } = await sql<{ month: string; money_in: string; money_out: string }>`
        with moves as (
          select date_trunc('month', p.entry_date)::date as month, p.journal_entry_id, sum(p.functional_amount_minor) as net
            from app.posting p
            join app.bank_account b on b.workspace_id = p.workspace_id and b.ledger_account_id = p.ledger_account_id
            join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
           where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
             and b.kind in ('checking', 'savings', 'cash', 'credit_card', 'line_of_credit')
             and je.kind not in ('opening_balance', 'adjustment', 'valuation', 'fx_revaluation', 'depreciation', 'closing')
             and p.entry_date between ${from} and ${to}
           group by 1, 2
        )
        select month::text,
               coalesce(sum(net) filter (where net > 0), 0)::text as money_in,
               coalesce(-sum(net) filter (where net < 0), 0)::text as money_out
          from moves group by 1`.execute(trx);
      const flow = new Map(flows.map((f) => [dateOf(f.month), f]));

      // Cash on hand: bank and cash balances at each month's end.
      const { rows: cash } = await sql<{ month: string | null; delta: string }>`
        select case when p.entry_date < ${from} then null else date_trunc('month', p.entry_date)::date::text end as month,
               sum(p.functional_amount_minor)::text as delta
          from app.posting p
          join app.bank_account b on b.workspace_id = p.workspace_id and b.ledger_account_id = p.ledger_account_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and b.kind in ('checking', 'savings', 'cash') and p.entry_date <= ${cashTo}
         group by 1`.execute(trx);
      let balance = BigInt(cash.find((c) => c.month === null)?.delta ?? '0');
      const cashDelta = new Map(cash.filter((c) => c.month).map((c) => [dateOf(c.month), BigInt(c.delta)]));

      const monthly = months.map((m) => {
        const p = pnl.get(m.start);
        const f = flow.get(m.start);
        balance += cashDelta.get(m.start) ?? 0n;
        const revenue = BigInt(p?.revenue ?? '0');
        const expenses = BigInt(p?.expenses ?? '0');
        return {
          start: m.start,
          end: m.end,
          moneyIn: f?.money_in ?? '0',
          moneyOut: f?.money_out ?? '0',
          revenue: String(revenue),
          expenses: String(expenses),
          profit: String(revenue - expenses),
          cashOnHand: String(balance),
        };
      });
      const totals = summarizeBusinessMonths(monthly);

      const { rows: inv } = await sql<{ open: string; overdue: boolean }>`
        select (i.total_minor - coalesce((select sum(ip.amount_minor) from app.invoice_payment ip
                                           where ip.workspace_id = i.workspace_id and ip.invoice_id = i.id), 0))::text as open,
               i.due_date < ${today} as overdue
          from app.invoice i
         where i.workspace_id = ${ctx.workspaceId} and i.entity_id = ${e.id} and i.status = 'sent'`.execute(
        trx,
      );
      const { rows: bills } = await sql<{ amount: string; overdue: boolean }>`
        select amount_minor::text as amount, due_date < ${today} as overdue
          from app.bill
         where workspace_id = ${ctx.workspaceId} and entity_id = ${e.id} and status = 'open'`.execute(trx);
      const open = (rows: { amount: bigint; overdue: boolean }[]) => {
        const live = rows.filter((r) => r.amount > 0n);
        const late = live.filter((r) => r.overdue);
        const sum = (rs: typeof live) => String(rs.reduce((t, r) => t + r.amount, 0n));
        return { count: live.length, amount: sum(live), overdueCount: late.length, overdueAmount: sum(late) };
      };

      return {
        entityId: e.id,
        currency: asCurrencyCode(e.currency),
        months: q.months,
        month: { start: chosen, end: endOfMonth(chosen) },
        current: chosen === thisMonth,
        periods,
        monthly,
        totals: {
          moneyIn: String(totals.moneyIn),
          moneyOut: String(totals.moneyOut),
          revenue: String(totals.revenue),
          expenses: String(totals.expenses),
          profit: String(totals.profit),
          marginBps: totals.marginBps,
        },
        openInvoices: open(inv.map((r) => ({ amount: BigInt(r.open), overdue: r.overdue }))),
        openBills: open(bills.map((r) => ({ amount: BigInt(r.amount), overdue: r.overdue }))),
      };
    });
  }

  // ----- Income by customer, expenses by vendor ------------------------------------------------------------

  async byParty(
    ctx: Ctx,
    q: { entityId: string; kind: PartyKind; from?: CalendarDate; to?: CalendarDate },
  ): Promise<PartyReportDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, q.entityId);
      const today = todayOf(e);
      const from = q.from ?? (`${today.slice(0, 4)}-01-01` as CalendarDate);
      const to = q.to ?? today;
      const income = q.kind === 'customer';
      const { rows } = await sql<{
        key: string | null;
        linked_party: string | null;
        party_name: string | null;
        name: string | null;
        amount: string;
        n: number;
      }>`
        select t.payee_key as key, py.id as linked_party, py.name as party_name,
               max(coalesce(t.payee_raw, nullif(t.description, ''))) as name,
               sum(${income ? sql`-p.functional_amount_minor` : sql`p.functional_amount_minor`})::text as amount,
               count(distinct t.id)::int as n
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
          left join app.invoice_payment ip on ip.workspace_id = t.workspace_id and ip.transaction_id = t.id
          left join app.invoice i on i.workspace_id = ip.workspace_id and i.id = ip.invoice_id
          left join app.bill b on b.workspace_id = t.workspace_id and b.transaction_id = t.id
          left join app.business_party py on py.workspace_id = t.workspace_id and py.id = coalesce(i.party_id, b.party_id)
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and a.type = ${income ? 'income' : 'expense'} and p.entry_date between ${from} and ${to}
         group by t.payee_key, py.id, py.name`.execute(trx);
      // A linked payment says whose it is; a statement name seen on one counts as theirs too. One row each, in their name.
      const aliases = await this.business.partyAliases(trx, ctx, e.id);
      const merged = new Map<
        string,
        { name: string; payeeKey: string | null; amount: bigint; count: number }
      >();
      for (const r of rows) {
        const alias = r.key ? aliases.get(`${q.kind}:${r.key}`) : undefined;
        const id = r.linked_party ?? alias?.partyId ?? r.key ?? '';
        const cur = merged.get(id);
        if (cur) {
          cur.amount += BigInt(r.amount);
          cur.count += r.n;
        } else {
          merged.set(id, {
            name: r.party_name ?? alias?.name ?? r.name ?? '',
            payeeKey: r.key,
            amount: BigInt(r.amount),
            count: r.n,
          });
        }
      }
      const sorted = [...merged.values()]
        .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
        .map((r) => ({ ...r, amount: String(r.amount) }));
      return {
        entityId: e.id,
        kind: q.kind,
        from,
        to,
        currency: asCurrencyCode(e.currency),
        total: String(sorted.reduce((t, r) => t + BigInt(r.amount), 0n)),
        rows: sorted,
      };
    });
  }

  // ----- Schedule C --------------------------------------------------------------------------------------

  async taxLines(ctx: Ctx, form?: string): Promise<TaxLineDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('ref.tax_line')
        .selectAll()
        .where('country', '=', TAX_COUNTRY)
        .$if(!!form, (q) => q.where('form', '=', form!))
        .orderBy('sort_order')
        .execute();
      return rows.map((r) => ({
        code: r.code,
        form: r.form,
        line: r.line,
        label: r.label,
        deductibleBps: r.deductible_bps,
      }));
    });
  }

  async scheduleC(ctx: Ctx, entityId: string, year?: number): Promise<ScheduleCDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      // The business's fiscal year, named by the year it begins in (ADR-0037 §2); January makes it the calendar year.
      const y = year ?? fiscalYearOf(todayOf(e), e.fiscalYearStartMonth);
      const { from, to } = fiscalYearRange(y, e.fiscalYearStartMonth);
      const { rows } = await sql<{
        id: string;
        name: string;
        type: 'income' | 'expense';
        code: string | null;
        system_role: string | null;
        subtype: string;
        amount: string;
      }>`
        select a.id, a.name, a.type, a.tax_line_code as code, a.system_role, a.subtype,
               sum(case when a.type = 'income' then -p.functional_amount_minor else p.functional_amount_minor end)::text as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and a.type in ('income', 'expense')
           and p.entry_date between ${from} and ${to}
         group by a.id
        having sum(p.functional_amount_minor) <> 0`.execute(trx);
      const refLines = await trx
        .selectFrom('ref.tax_line')
        .selectAll()
        .where('country', '=', TAX_COUNTRY)
        .where('form', '=', SCHEDULE_C)
        .orderBy('sort_order')
        .execute();
      const known = new Set(refLines.map((l) => l.code));
      const trips = await trx
        .selectFrom('app.mileage_trip')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('deduction_minor'), sql<string>`0`).as('total'))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', e.id)
        .where('trip_date', '>=', from)
        .where('trip_date', '<=', to)
        // Only the owner's own trips: a payroll person's is reimbursed through payroll instead (ADR-0035 §8).
        .where('driver', '=', 'owner')
        .executeTakeFirst();
      const mileage = BigInt(trips?.total ?? '0');

      const byCode = new Map<string, { amount: bigint; ids: string[] }>();
      const unmapped: ScheduleCDto['unmapped'] = [];
      let grossReceipts = 0n;
      let otherIncome = 0n;
      let assetSales = 0n;
      // Car and truck expenses of the owner's vehicle: mileage paid back to staff isn't one (ADR-0035 §8).
      let actualCar = 0n;
      for (const r of rows) {
        const amount = BigInt(r.amount);
        // A sale of business property goes on Form 4797, not here (ADR-0035 §5).
        if (r.subtype === GAIN_LOSS_SUBTYPE) {
          assetSales += amount;
          continue;
        }
        if (r.code === CAR_AND_TRUCK && r.subtype !== MILEAGE_REIMBURSEMENTS_SUBTYPE) actualCar += amount;
        if (r.code && known.has(r.code)) {
          const cur = byCode.get(r.code) ?? { amount: 0n, ids: [] };
          cur.amount += amount;
          cur.ids.push(r.id);
          byCode.set(r.code, cur);
          if (r.type === 'income') grossReceipts += amount;
        } else if (r.type === 'income') {
          // Income with no line still counts: leaving it out would understate profit.
          otherIncome += amount;
          unmapped.push({ categoryId: r.id, name: r.name, amount: String(amount) });
        } else {
          unmapped.push({ categoryId: r.id, name: r.name, amount: String(amount) });
        }
      }
      const incomeCodes = new Set(rows.filter((r) => r.type === 'income' && r.code).map((r) => r.code!));
      const lines: ScheduleCDto['lines'] = [];
      let totalExpenses = 0n;
      for (const l of refLines) {
        const hit = byCode.get(l.code);
        const carMileage = l.code === CAR_AND_TRUCK && mileage > 0n ? mileage : null;
        if (!hit && carMileage === null) continue;
        const amount = (hit?.amount ?? 0n) + (carMileage ?? 0n);
        if (!incomeCodes.has(l.code)) totalExpenses += amount;
        lines.push({
          code: l.code,
          line: l.line,
          label: l.label,
          amount: String(amount),
          categoryIds: hit?.ids ?? [],
          mileage: carMileage !== null ? String(carMileage) : null,
          deductibleBps: l.deductible_bps,
        });
      }
      for (const u of unmapped) {
        if (rows.find((r) => r.id === u.categoryId)?.type === 'expense') totalExpenses += BigInt(u.amount);
      }
      const income = grossReceipts + otherIncome;
      return {
        entityId: e.id,
        year: y,
        from,
        to,
        currency: asCurrencyCode(e.currency),
        lines,
        grossReceipts: String(income),
        totalExpenses: String(totalExpenses),
        netProfit: String(income - totalExpenses),
        unmapped,
        assetSales: String(assetSales),
        warnings: mileage > 0n && actualCar !== 0n ? ['mileage_and_actual_car'] : [],
      };
    });
  }

  /** AI-10: categories of this business with no line, and spending that isn't on the form because of it. */
  async suggestTaxLines(ctx: Ctx, entityId: string): Promise<TaxLineSuggestionDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await taxedEntity(trx, ctx, entityId);
      const categories = await trx
        .selectFrom('app.ledger_account as a')
        .leftJoin('app.category_group as g', (j) =>
          j.onRef('g.workspace_id', '=', 'a.workspace_id').onRef('g.id', '=', 'a.category_group_id'),
        )
        .select(['a.id', 'a.name', 'g.name as group_name'])
        .where('a.workspace_id', '=', ctx.workspaceId)
        .where('a.entity_id', '=', e.id)
        .where('a.is_category', '=', true)
        .where('a.tax_line_code', 'is', null)
        .where('a.system_role', 'is', null)
        .where('a.archived_at', 'is', null)
        .execute();
      if (categories.length === 0) return [];
      const lines = await trx
        .selectFrom('ref.tax_line')
        .select(['code', 'label'])
        .where('country', '=', TAX_COUNTRY)
        .where('form', '=', e.type === 'rental' ? 'schedule_e' : SCHEDULE_C)
        .orderBy('sort_order')
        .execute();
      const runtime = await this.ai.runtime(trx, ctx, { type: e.type, id: e.id });
      if (!runtime.available) return [];
      const res = await this.ai.gateway.mapTaxLines(
        {
          lines,
          categories: categories.map((c) => ({ id: c.id, name: c.name, group: c.group_name })),
        },
        { ...runtime.ctx, parkLocal: false },
      );
      if (!res.ok) return [];
      const name = new Map(categories.map((c) => [c.id, c.name]));
      const label = new Map(lines.map((l) => [l.code, l.label]));
      return res.value.map((m) => ({
        categoryId: m.categoryId,
        name: name.get(m.categoryId) ?? '',
        code: m.code,
        label: label.get(m.code) ?? m.code,
        explanation: m.explanation,
      }));
    });
  }

  // ----- Estimated tax (BIZ-09) ----------------------------------------------------------------------------

  async taxEstimate(ctx: Ctx, entityId: string, year?: number): Promise<TaxEstimateDto> {
    return this.db.run(ctx, (trx) => this.taxEstimateIn(trx, ctx, entityId, year));
  }

  async taxEstimateIn(trx: Trx, ctx: Ctx, entityId: string, year?: number): Promise<TaxEstimateDto> {
    const e = await taxedEntity(trx, ctx, entityId);
    const today = todayOf(e);
    const y = year ?? Number(today.slice(0, 4));
    const profile = await this.business.readProfile(trx, ctx, entityId);
    const start = `${y}-01-01` as CalendarDate;
    const yearEnd = `${y}-12-31` as CalendarDate;
    const through = today < yearEnd ? today : yearEnd;
    // After mileage, so this agrees with Schedule C: the deduction isn't in the ledger, but it does lower the tax. One scan
    // of the year, by day: every period and the total are running sums of it.
    const { rows: days } = await sql<{ d: string; profit: string }>`
      select d, sum(amount)::text as profit from (
        select p.entry_date::text as d,
               -p.functional_amount_minor as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
           and a.type in ('income', 'expense') and p.entry_date between ${start} and ${through}
        union all
        select trip_date::text, -deduction_minor
          from app.mileage_trip
         where workspace_id = ${ctx.workspaceId} and entity_id = ${entityId} and driver = 'owner'
           and trip_date between ${start} and ${through}
      ) x group by d order by d`.execute(trx);
    const taxableProfit =
      e.type === 'rental'
        ? await this.rentalProfit(trx, ctx, entityId, y, start, through)
        : (to: CalendarDate) => days.reduce((t, r) => (r.d <= to ? t + BigInt(r.profit) : t), 0n);
    const profit = taxableProfit(through);
    const rate = profile.tax_rate_bps;
    const saved = await this.savedSoFar(trx, ctx, profile.tax_savings_account_id, start, through);
    let seenNext = false;
    const periods: TaxEstimateDto['periods'] = [];
    for (const p of estimatedTaxPeriods(y)) {
      const end = p.through < today ? p.through : today;
      const periodProfit = taxableProfit(end);
      let status: 'past' | 'next' | 'later' = 'later';
      if (p.due < today) status = 'past';
      else if (!seenNext) {
        status = 'next';
        seenNext = true;
      }
      periods.push({
        quarter: p.quarter,
        through: p.through,
        due: p.due,
        profit: String(periodProfit),
        target: String(rate !== null ? taxSetAsideTarget(periodProfit, rate) : 0n),
        status,
      });
    }
    return {
      entityId,
      year: y,
      currency: asCurrencyCode(e.currency),
      rateBps: rate,
      ytdProfit: String(profit),
      target: String(rate !== null ? taxSetAsideTarget(profit, rate) : 0n),
      saved: String(saved),
      toSetAside: String(rate !== null ? taxSetAside(profit, rate, saved) : 0n),
      periods,
    };
  }

  /**
   * A portfolio's taxable profit by date: as on Schedule E, your share of each property, after its depreciation so far
   * this year. Income and costs on no property count whole.
   */
  private async rentalProfit(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    year: number,
    start: CalendarDate,
    through: CalendarDate,
  ): Promise<(to: CalendarDate) => bigint> {
    const { rows } = await sql<{ d: string; property_id: string | null; profit: string }>`
      select p.entry_date::text as d, p.property_id, sum(-p.functional_amount_minor)::text as profit
        from app.posting p
        join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
       where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
         and a.type in ('income', 'expense') and p.entry_date between ${start} and ${through}
       group by 1, 2`.execute(trx);
    const properties = await trx
      .selectFrom('app.property')
      .select(['id', 'ownership_bps'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .execute();
    const schedules = await trx
      .selectFrom('app.depreciation_schedule')
      .select(['property_id', 'basis_minor', 'in_service_date', 'method'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .execute();
    const yearDays = BigInt(daysBetween(start, `${year}-12-31` as CalendarDate) + 1);
    return (to) => {
      const elapsed = BigInt(daysBetween(start, to) + 1);
      const sumFor = (id: string | null) =>
        rows.reduce((t, r) => (r.d <= to && r.property_id === id ? t + BigInt(r.profit) : t), 0n);
      let total = sumFor(null);
      for (const p of properties) {
        const depreciation = schedules
          .filter((d) => d.property_id === p.id)
          .reduce(
            (t, d) =>
              t +
              depreciationForYear(
                BigInt(d.basis_minor),
                calendarDate(String(d.in_service_date).slice(0, 10)),
                year,
                d.method as DepreciationMethod,
              ),
            0n,
          );
        const net = sumFor(p.id) - divRound(depreciation * elapsed, yearDays);
        total += divRound(net * BigInt(p.ownership_bps), 10_000n);
      }
      return total;
    };
  }

  private async savedSoFar(
    trx: Trx,
    ctx: Ctx,
    accountId: string | null,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<bigint> {
    if (!accountId) return 0n;
    const { rows } = await sql<{ total: string }>`
      select coalesce(sum(p.amount_minor), 0)::text as total
        from app.posting p
        join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
       where p.workspace_id = ${ctx.workspaceId} and p.ledger_account_id = ${accountId}
         and p.entry_date between ${from} and ${to} and je.kind = 'transfer'`.execute(trx);
    return BigInt(rows[0]?.total ?? '0');
  }

  // ----- Missing receipts (BIZ-12) -------------------------------------------------------------------------

  async missingReceipts(ctx: Ctx, entityId: string, year?: number): Promise<MissingReceiptsDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const y = year ?? Number(todayOf(e).slice(0, 4));
      const profile = await this.business.readProfile(trx, ctx, entityId);
      const threshold = BigInt(profile.receipt_threshold_minor);
      const { rows } = await sql<{
        id: string;
        d: string;
        payee: string | null;
        amount: string;
        category: string | null;
      }>`
        select t.id, t.txn_date::text as d, coalesce(t.payee_raw, nullif(t.description, '')) as payee,
               abs((t.spec->>'amount')::bigint)::text as amount, t.spec->'splits'->0->>'accountId' as category
          from app.transaction t
         where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${e.id}
           and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
           and (t.spec->>'amount')::bigint <= ${String(-threshold)}::bigint
           and t.txn_date between ${`${y}-01-01`} and ${`${y}-12-31`}
           and not exists (select 1 from app.receipt r where r.workspace_id = t.workspace_id and r.transaction_id = t.id)
           -- A bill's own document is its receipt.
           and not exists (select 1 from app.bill b where b.workspace_id = t.workspace_id and b.transaction_id = t.id
                            and cardinality(b.attachment_ids) > 0)
         order by t.txn_date desc, t.id
         limit 500`.execute(trx);
      const candidates = new Set(
        (
          await assetCandidates(
            trx,
            ctx,
            e.id,
            rows.map((r) => r.id),
          )
        ).map((c) => c.transactionId),
      );
      return {
        entityId: e.id,
        threshold: String(threshold),
        currency: asCurrencyCode(e.currency),
        rows: rows.map((r) => ({
          transactionId: r.id,
          date: dateOf(r.d),
          payee: r.payee,
          amount: r.amount,
          categoryId: r.category,
          assetCandidate: candidates.has(r.id),
        })),
      };
    });
  }
}

export type { BusinessEntity };

/**
 * The P&L month by month (BIZ-10): revenue and expenses of a business between two dates. The P&L report and the
 * landing page both read it, so their figures can't drift apart.
 */
export async function pnlMonths(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<{ month: CalendarDate; revenue: string; expenses: string }[]> {
  const { rows } = await sql<{ month: string; revenue: string; expenses: string }>`
    select date_trunc('month', p.entry_date)::date::text as month,
           coalesce(sum(-p.functional_amount_minor) filter (where a.type = 'income'), 0)::text as revenue,
           coalesce(sum(p.functional_amount_minor) filter (where a.type = 'expense'), 0)::text as expenses
      from app.posting p
      join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
     where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
       and a.type in ('income', 'expense') and p.entry_date between ${from} and ${to}
     group by 1 order by 1`.execute(trx);
  return rows.map((r) => ({ month: dateOf(r.month), revenue: r.revenue, expenses: r.expenses }));
}
