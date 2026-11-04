/**
 * P&L, income by customer, expenses by vendor, Schedule C, estimated tax and the missing-receipt list (BIZ-09, BIZ-10,
 * BIZ-12, AI-10). All cash basis, read straight from postings under RLS. Tax figures are estimates, not tax advice.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  asCurrencyCode,
  estimatedTaxPeriods,
  marginBps,
  taxSetAside,
  taxSetAsideTarget,
  type CalendarDate,
} from '@montra/domain';
import type {
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
import { businessEntity, dateOf, TAX_COUNTRY, todayOf, type BusinessEntity, type Ctx } from './shared.js';

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
      const from = q.from ?? (`${today.slice(0, 4)}-01-01` as CalendarDate);
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
      const { rows: monthly } = await sql<{ month: string; revenue: string; expenses: string }>`
        select date_trunc('month', p.entry_date)::date::text as month,
               coalesce(sum(-p.functional_amount_minor) filter (where a.type = 'income'), 0)::text as revenue,
               coalesce(sum(p.functional_amount_minor) filter (where a.type = 'expense'), 0)::text as expenses
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and a.type in ('income', 'expense') and p.entry_date between ${from} and ${to}
         group by 1 order by 1`.execute(trx);
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
      const y = year ?? Number(todayOf(e).slice(0, 4));
      const { rows } = await sql<{
        id: string;
        name: string;
        type: 'income' | 'expense';
        code: string | null;
        system_role: string | null;
        amount: string;
      }>`
        select a.id, a.name, a.type, a.tax_line_code as code, a.system_role,
               sum(case when a.type = 'income' then -p.functional_amount_minor else p.functional_amount_minor end)::text as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${e.id}
           and a.type in ('income', 'expense')
           and p.entry_date between ${`${y}-01-01`} and ${`${y}-12-31`}
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
        .where('trip_date', '>=', `${y}-01-01`)
        .where('trip_date', '<=', `${y}-12-31`)
        .executeTakeFirst();
      const mileage = BigInt(trips?.total ?? '0');

      const byCode = new Map<string, { amount: bigint; ids: string[] }>();
      const unmapped: ScheduleCDto['unmapped'] = [];
      let grossReceipts = 0n;
      let otherIncome = 0n;
      for (const r of rows) {
        const amount = BigInt(r.amount);
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
      const actualCar = byCode.get(CAR_AND_TRUCK);
      return {
        entityId: e.id,
        year: y,
        currency: asCurrencyCode(e.currency),
        lines,
        grossReceipts: String(income),
        totalExpenses: String(totalExpenses),
        netProfit: String(income - totalExpenses),
        unmapped,
        warnings: mileage > 0n && actualCar && actualCar.amount !== 0n ? ['mileage_and_actual_car'] : [],
      };
    });
  }

  /** AI-10: categories of this business with no line, and spending that isn't on the form because of it. */
  async suggestTaxLines(ctx: Ctx, entityId: string): Promise<TaxLineSuggestionDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
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
        .where('form', '=', SCHEDULE_C)
        .orderBy('sort_order')
        .execute();
      const runtime = await this.ai.runtime(trx, ctx, { type: 'business', id: e.id });
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
    const e = await businessEntity(trx, ctx, entityId);
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
         where workspace_id = ${ctx.workspaceId} and entity_id = ${entityId}
           and trip_date between ${start} and ${through}
      ) x group by d order by d`.execute(trx);
    const taxableProfit = (to: CalendarDate) =>
      days.reduce((t, r) => (r.d <= to ? t + BigInt(r.profit) : t), 0n);
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
        })),
      };
    });
  }
}

export type { BusinessEntity };
