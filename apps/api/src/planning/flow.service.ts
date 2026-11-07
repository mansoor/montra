/**
 * Money flow (FLOW-01..07, FAM-09, UP-14; design 04 §11, ADR-0015): dashboard, Sankey, forecast, calendar and
 * net worth. Read-only; numbers come from the read models, budgets and schedules, and each one carries the
 * transactions-list filter (`drill`) that reproduces it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  PACE_KINDS,
  accountProfile,
  addDays,
  addMonths,
  burnItems,
  calendarDate,
  convert,
  dailyAverage,
  diffDays,
  divRound,
  endOfMonth,
  estimatedTaxPeriods,
  forecast as simulate,
  kindsWhere,
  money,
  occurrencesBetween,
  parseDecimal,
  periodContaining,
  spendingPace,
  startOfMonth,
  type CalendarDate,
  type CurrencyCode,
  type ForecastItem,
  type Period,
} from '@montra/domain';
import type {
  CalendarDto,
  CalendarItemDto,
  DashboardDto,
  DrillDto,
  ForecastDto,
  NetWorthDto,
  SankeyDto,
} from '@montra/schemas';
import { notFound } from '../common/errors.js';
import { Db } from '../db/database.js';
import { BillsService } from '../business/bills.service.js';
import { BusinessReportsService } from '../business/business-reports.service.js';
import { InvoicesService } from '../business/invoices.service.js';
import { LoansService } from '../rentals/loans.service.js';
import { CardsService } from '../accounts/cards.service.js';
import { leaseStatus } from '../rentals/properties.service.js';
import { RentService } from '../rentals/rent.service.js';
import { FxRatesService } from '../fx/fx.service.js';
import type { TransactionSpec } from '../transactions/poster.js';
import { BudgetsService, isBudgetCategory } from './budgets.service.js';
import { occurrenceTotal, PlanningData, previousMonths, type Ctx } from './data.js';

type Money = CalendarItemDto['currency'];

interface CashAccount {
  id: string;
  entityId: string;
  name: string;
  kind: string;
  type: 'asset' | 'liability';
  currency: string;
  lowBalance: bigint;
  creditLimit: bigint | null;
}

const BURN_KINDS = new Set(['daily', 'fun']);
const s = (v: bigint) => String(v);

/** A scheduled amount from a transaction spec, per account (account currency, signed). */
function specLegs(spec: TransactionSpec): { accountId: string; amount: bigint; currency: string }[] {
  if (spec.type === 'standard')
    return [{ accountId: spec.accountId, amount: BigInt(spec.amount), currency: spec.currency }];
  return [
    { accountId: spec.fromAccountId, amount: -BigInt(spec.amount), currency: spec.currency },
    { accountId: spec.toAccountId, amount: BigInt(spec.amountIn ?? spec.amount), currency: spec.currency },
  ];
}

@Injectable()
export class FlowService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PlanningData) private readonly data: PlanningData,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(FxRatesService) private readonly fx: FxRatesService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(BillsService) private readonly bills: BillsService,
    @Inject(BusinessReportsService) private readonly businessReports: BusinessReportsService,
    @Inject(RentService) private readonly rent: RentService,
    @Inject(LoansService) private readonly loans: LoansService,
    @Inject(CardsService) private readonly cards: CardsService,
  ) {}

  // ----- Accounts ----------------------------------------------------------------------------------------

  private async accounts(trx: Trx, ctx: Ctx, entityId?: string | null): Promise<CashAccount[]> {
    const rows = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', 'a.id', 'b.ledger_account_id')
      .select([
        'a.id',
        'a.entity_id',
        'a.name',
        'a.type',
        'a.currency',
        'b.kind',
        'b.low_balance_minor',
        'b.credit_limit_minor',
      ])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.archived_at', 'is', null)
      .$if(!!entityId, (q) => q.where('a.entity_id', '=', entityId!))
      .orderBy('a.sort_order')
      .orderBy('a.name')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      name: r.name,
      kind: r.kind,
      type: r.type as 'asset' | 'liability',
      currency: r.currency,
      lowBalance: BigInt(r.low_balance_minor),
      creditLimit: r.credit_limit_minor !== null ? BigInt(r.credit_limit_minor) : null,
    }));
  }

  // ----- Calendar (FLOW-05, UP-14) ----------------------------------------------------------------------

  async calendar(
    ctx: Ctx,
    from: CalendarDate,
    to: CalendarDate,
    entityId?: string | null,
  ): Promise<CalendarDto> {
    return this.db.run(ctx, (trx) => this.calendarIn(trx, ctx, from, to, entityId));
  }

  async calendarIn(
    trx: Trx,
    ctx: Ctx,
    from: CalendarDate,
    to: CalendarDate,
    entityId?: string | null,
  ): Promise<CalendarDto> {
    const today = await this.data.today(trx, ctx);
    const items: CalendarItemDto[] = [];
    const push = (i: Omit<CalendarItemDto, 'priceChange' | 'variable'> & { variable?: boolean }) =>
      items.push({ variable: false, priceChange: null, ...i });

    // Materialized occurrences: scheduled (upcoming or overdue) and posted ones from schedules (paid).
    const txns = await trx
      .selectFrom('app.transaction')
      .select(['id', 'txn_date', 'status', 'description', 'payee_raw', 'spec', 'recurring_item_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('deleted_at', 'is', null)
      .where('txn_date', '>=', from)
      .where('txn_date', '<=', to)
      .where((eb) => eb.or([eb('status', '=', 'scheduled'), eb('recurring_item_id', 'is not', null)]))
      .where('status', '<>', 'void')
      .$if(!!entityId, (q) => q.where('primary_entity_id', '=', entityId!))
      .execute();
    for (const t of txns) {
      const spec = t.spec as TransactionSpec | null;
      if (!spec) continue;
      const leg = specLegs(spec)[0]!;
      const date = calendarDate(String(t.txn_date));
      push({
        date,
        kind: spec.type === 'transfer' ? 'scheduled' : leg.amount >= 0n ? 'payday' : 'bill',
        name: t.description || t.payee_raw || 'Scheduled',
        amount: s(leg.amount),
        currency: leg.currency as Money,
        sourceId: t.recurring_item_id ?? t.id,
        accountId: leg.accountId,
        status: t.status === 'scheduled' ? (date < today ? 'overdue' : 'upcoming') : 'paid',
      });
    }

    // Schedules beyond what has been materialized.
    const recurring = await trx
      .selectFrom('app.recurring_item')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'active')
      .where('next_date', '<=', to)
      .$if(!!entityId, (q) => q.where('primary_entity_id', '=', entityId!))
      .execute();
    for (const r of recurring) {
      const spec = r.spec as TransactionSpec;
      const leg = specLegs(spec)[0]!;
      const start = calendarDate(r.next_date) > from ? calendarDate(r.next_date) : from;
      for (const date of occurrencesBetween(
        calendarDate(r.start_date),
        r.cadence,
        start,
        to,
        r.end_date ? calendarDate(r.end_date) : null,
      )) {
        push({
          date,
          kind: spec.type === 'transfer' ? 'scheduled' : leg.amount >= 0n ? 'payday' : 'bill',
          name: r.name,
          amount: s(leg.amount),
          currency: leg.currency as Money,
          sourceId: r.id,
          accountId: leg.accountId,
          status: 'upcoming',
        });
      }
    }

    // Paydays from expected income (matched ones are paid).
    const entities = entityId ? [entityId] : await this.entityIds(trx, ctx);
    for (const e of entities) {
      const incomeItems = await this.data.incomeItems(trx, ctx, e);
      if (!incomeItems.length) continue;
      const deposits = await this.data.deposits(trx, ctx, e, addDays(from, -3), addDays(to, 5));
      for (const o of this.data.matchIncome(incomeItems, deposits, from, to)) {
        push({
          date: o.date,
          kind: 'payday',
          name: o.item.name,
          amount: s(occurrenceTotal(o)),
          currency: o.item.currency as Money,
          sourceId: o.item.id,
          accountId: o.item.accountId,
          status: !o.pending.length ? 'paid' : o.date < today ? 'overdue' : 'upcoming',
        });
      }
    }

    // Loan payments due (RNT-08, ADR-0024).
    for (const e of entities) {
      const dues = await this.loans.dueBetween(trx, ctx, e, from, to);
      if (!dues.length) continue;
      const money = (await this.data.entity(trx, ctx, e)).currency as Money;
      for (const l of dues) {
        push({
          date: l.date,
          kind: 'mortgage',
          name: l.name,
          amount: s(-l.amount),
          currency: money,
          sourceId: l.loanId,
          accountId: l.payingAccountId,
          status: l.date < today ? 'overdue' : 'upcoming',
        });
      }
    }

    // Other money owed, on the date it's due, while any of it is (ADR-0027).
    const owedOn = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select(['a.id', 'a.name', 'a.currency', 'b.due_date'])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.due_date', 'is not', null)
      .where('b.due_date', '>=', from)
      .where('b.due_date', '<=', to)
      .where('a.archived_at', 'is', null)
      .$if(!!entityId, (q) => q.where('a.entity_id', '=', entityId!))
      .execute();
    if (owedOn.length) {
      const balances = await this.data.balances(
        trx,
        ctx,
        owedOn.map((a) => a.id),
        [today],
      );
      for (const a of owedOn) {
        const owed = -(balances.get(a.id)?.get(today) ?? 0n);
        if (owed <= 0n) continue;
        const date = calendarDate(String(a.due_date).slice(0, 10));
        push({
          date,
          kind: 'bill',
          name: a.name,
          amount: s(-owed),
          currency: a.currency as Money,
          sourceId: a.id,
          accountId: a.id,
          status: date < today ? 'overdue' : 'upcoming',
        });
      }
    }

    // Card and line-of-credit payments due: this statement's, and the next one from what's been charged since (ADR-0026).
    for (const c of await this.cards.statementsIn(trx, ctx, { entityId })) {
      const dues = [
        { date: c.dueDate, amount: BigInt(c.due), estimate: false },
        { date: c.nextDueDate, amount: BigInt(c.sinceStatement), estimate: true },
      ];
      for (const d of dues) {
        if (d.amount <= 0n || d.date < from || d.date > to) continue;
        push({
          date: d.date,
          kind: 'card_due',
          name: c.name,
          amount: s(-d.amount),
          currency: c.currency as Money,
          sourceId: c.accountId,
          accountId: c.accountId,
          status: d.date < today ? 'overdue' : 'upcoming',
        });
      }
    }

    // Goal due dates.
    const goals = await trx
      .selectFrom('app.goal as g')
      .innerJoin('app.entity as e', (j) =>
        j.onRef('e.workspace_id', '=', 'g.workspace_id').onRef('e.id', '=', 'g.entity_id'),
      )
      .select(['g.id', 'g.name', 'g.due_date', 'g.target_minor', 'e.functional_currency'])
      .where('g.workspace_id', '=', ctx.workspaceId)
      .where('g.archived_at', 'is', null)
      .where('g.due_date', '>=', from)
      .where('g.due_date', '<=', to)
      .$if(!!entityId, (q) => q.where('g.entity_id', '=', entityId!))
      .execute();
    for (const g of goals) {
      push({
        date: calendarDate(String(g.due_date)),
        kind: 'goal_due',
        name: g.name,
        amount: s(-(g.target_minor !== null ? BigInt(g.target_minor) : 0n)),
        currency: g.functional_currency as Money,
        sourceId: g.id,
        accountId: null,
        status: 'upcoming',
      });
    }
    // A business's open invoices and bills, and its estimated-tax dates (BIZ-05, BIZ-06, BIZ-09).
    const inRange = (d: CalendarDate) => d >= from && d <= to;
    for (const i of await this.invoices.openInvoices(trx, ctx, entityId ?? undefined)) {
      if (!inRange(i.dueDate)) continue;
      push({
        date: i.dueDate,
        kind: 'invoice',
        name: `${i.partyName} · ${i.number}`,
        amount: s(i.open),
        currency: i.currency as Money,
        sourceId: i.id,
        accountId: null,
        status: i.dueDate < today ? 'overdue' : 'upcoming',
      });
    }
    for (const b of await this.bills.openBills(trx, ctx, entityId ?? undefined)) {
      if (!inRange(b.dueDate)) continue;
      push({
        date: b.dueDate,
        kind: 'bill',
        name: b.partyName,
        amount: s(-b.amount),
        currency: b.currency as Money,
        sourceId: b.id,
        accountId: null,
        status: b.dueDate < today ? 'overdue' : 'upcoming',
      });
    }
    const businesses = await trx
      .selectFrom('app.entity')
      .select(['id', 'type'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', 'in', ['business', 'rental'])
      .where('archived_at', 'is', null)
      .$if(!!entityId, (q) => q.where('id', '=', entityId!))
      .execute();
    for (const b of businesses) {
      // The payment for a tax year falls due up to January of the next one.
      for (const year of new Set([Number(from.slice(0, 4)) - 1, Number(to.slice(0, 4))])) {
        // Most views hold no tax date, and the amounts take a scan of the year: look only when there's one to show.
        if (!estimatedTaxPeriods(year).some((p) => inRange(p.due))) continue;
        const estimate = await this.businessReports.taxEstimateIn(trx, ctx, b.id, year);
        // A landlord may owe no estimated tax at all: dates show once they've set a rate.
        if (b.type === 'rental' && estimate.rateBps === null) continue;
        for (const p of estimate.periods) {
          if (!inRange(p.due)) continue;
          push({
            date: p.due,
            kind: 'tax_due',
            name: `Estimated tax Q${p.quarter}`,
            amount: s(-BigInt(p.target)),
            currency: estimate.currency,
            sourceId: b.id,
            accountId: null,
            status: p.due < today ? 'paid' : 'upcoming',
          });
        }
      }
    }
    // A portfolio's rent, mortgage payments, lease ends and reminders (RNT-04, RNT-08, RNT-12).
    for (const r of businesses) {
      if (r.type !== 'rental') continue;
      const money = (await this.data.entity(trx, ctx, r.id)).currency as Money;
      for (const x of await this.rent.expectedBetween(trx, ctx, r.id, from, to, today)) {
        if (!inRange(x.due)) continue;
        push({
          date: x.due,
          kind: 'rent',
          name: x.name,
          amount: s(x.amount),
          currency: money,
          sourceId: x.leaseId,
          accountId: x.accountId,
          status: x.late ? 'overdue' : 'upcoming',
        });
      }
      const leases = await trx
        .selectFrom('app.lease as l')
        .innerJoin('app.unit as u', (j) =>
          j.onRef('u.workspace_id', '=', 'l.workspace_id').onRef('u.id', '=', 'l.unit_id'),
        )
        .innerJoin('app.property as p', (j) =>
          j.onRef('p.workspace_id', '=', 'l.workspace_id').onRef('p.id', '=', 'l.property_id'),
        )
        .select(['l.id', 'l.start_date', 'l.end_date', 'l.ended_on', 'u.label', 'p.name'])
        .where('l.workspace_id', '=', ctx.workspaceId)
        .where('l.entity_id', '=', r.id)
        .where('l.ended_on', 'is', null)
        .where('l.end_date', '>=', from)
        .where('l.end_date', '<=', to)
        .execute();
      for (const l of leases) {
        if (leaseStatus(l, today) !== 'active') continue;
        push({
          date: calendarDate(String(l.end_date).slice(0, 10)),
          kind: 'lease_end',
          name: `${l.name} · ${l.label}`,
          amount: '0',
          currency: money,
          sourceId: l.id,
          accountId: null,
          status: 'upcoming',
        });
      }
      const reminders = await trx
        .selectFrom('app.rental_reminder')
        .select(['id', 'title', 'due_date'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', r.id)
        .where('done_at', 'is', null)
        .where('due_date', '>=', from)
        .where('due_date', '<=', to)
        .execute();
      for (const x of reminders) {
        const date = calendarDate(String(x.due_date).slice(0, 10));
        push({
          date,
          kind: 'reminder',
          name: x.title,
          amount: '0',
          currency: money,
          sourceId: x.id,
          accountId: null,
          status: date < today ? 'overdue' : 'upcoming',
        });
      }
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
    return { from, to, items };
  }

  private async entityIds(trx: Trx, ctx: Ctx): Promise<string[]> {
    const rows = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .execute();
    return rows.map((r) => r.id);
  }

  // ----- Net worth (FLOW-07) ----------------------------------------------------------------------------

  async netWorth(
    ctx: Ctx,
    opts: { date?: CalendarDate; entityId?: string | null; months?: number } = {},
  ): Promise<NetWorthDto> {
    return this.db.run(ctx, (trx) => this.netWorthIn(trx, ctx, opts));
  }

  async netWorthIn(
    trx: Trx,
    ctx: Ctx,
    opts: { date?: CalendarDate; entityId?: string | null; months?: number },
  ): Promise<NetWorthDto> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('base_currency')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    const base = ws.base_currency as CurrencyCode;
    const date = opts.date ?? (await this.data.today(trx, ctx));
    const n = opts.months ?? 12;
    const trendDates = [
      ...Array.from({ length: n }, (_, i) => addDays(startOfMonth(addMonths(date, -(n - 1 - i))), -1)),
      date,
    ];
    const accounts = await this.accounts(trx, ctx, opts.entityId);
    const balances = await this.data.balances(
      trx,
      ctx,
      accounts.map((a) => a.id),
      trendDates,
    );
    // FLOW-07: your share of what each property is worth, or what it cost until a value's entered. Without it a
    // mortgage would count with nothing to set against it. One figure, so the trend moves only when one is bought.
    const properties = await trx
      .selectFrom('app.property as p')
      .innerJoin('app.entity as e', (j) =>
        j.onRef('e.workspace_id', '=', 'p.workspace_id').onRef('e.id', '=', 'p.entity_id'),
      )
      .select([
        'p.id',
        'p.entity_id',
        'p.name',
        'p.purchase_date',
        'p.ownership_bps',
        'p.current_value_minor',
        'p.purchase_price_minor',
        'e.functional_currency',
      ])
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.archived_at', 'is', null)
      .$if(!!opts.entityId, (q) => q.where('p.entity_id', '=', opts.entityId!))
      .orderBy('p.name')
      .execute();
    const rates = await this.fx.table(
      trx,
      [
        ...new Set([
          ...accounts.map((a) => a.currency),
          ...properties.map((p) => p.functional_currency),
          base,
        ]),
      ],
      trendDates[0]!,
      date,
    );
    const valueOf = (a: CashAccount, d: CalendarDate, balance: bigint): bigint => {
      if (a.currency === base) return balance;
      const r = rates.get(a.currency, base, d);
      // Without a rate the account is left out of the converted totals rather than guessed.
      return r ? convert(money(balance, a.currency), base, parseDecimal(r.rate)).amount : 0n;
    };
    const propertyValue = (p: (typeof properties)[number], d: CalendarDate): bigint => {
      const worth = p.current_value_minor ?? p.purchase_price_minor;
      if (worth === null) return 0n;
      if (p.purchase_date && calendarDate(String(p.purchase_date).slice(0, 10)) > d) return 0n;
      const share = divRound(BigInt(worth) * BigInt(p.ownership_bps), 10_000n);
      if (p.functional_currency === base) return share;
      const r = rates.get(p.functional_currency, base, d);
      return r ? convert(money(share, p.functional_currency), base, parseDecimal(r.rate)).amount : 0n;
    };
    const point = (d: CalendarDate) => {
      let assets = properties.reduce((t, p) => t + propertyValue(p, d), 0n);
      let liabilities = 0n;
      for (const a of accounts) {
        const v = valueOf(a, d, balances.get(a.id)?.get(d) ?? 0n);
        if (a.type === 'asset') assets += v;
        else liabilities -= v;
      }
      return { date: d, assets: s(assets), liabilities: s(liabilities), netWorth: s(assets - liabilities) };
    };
    const now = point(date);
    return {
      date,
      currency: base,
      assets: now.assets,
      liabilities: now.liabilities,
      netWorth: now.netWorth,
      accounts: accounts.map((a) => {
        const balance = balances.get(a.id)?.get(date) ?? 0n;
        return {
          accountId: a.id,
          entityId: a.entityId,
          name: a.name,
          kind: a.type,
          balance: s(balance),
          accountCurrency: a.currency as Money,
          value: s(valueOf(a, date, balance)),
        };
      }),
      properties: properties
        .map((p) => ({
          propertyId: p.id,
          entityId: p.entity_id,
          name: p.name,
          value: s(propertyValue(p, date)),
        }))
        .filter((p) => p.value !== '0'),
      trend: trendDates.map(point),
    };
  }

  // ----- Forecast (FLOW-03) -----------------------------------------------------------------------------

  async forecast(ctx: Ctx, days: number, entityId?: string | null): Promise<ForecastDto> {
    return this.db.run(ctx, (trx) => this.forecastIn(trx, ctx, days, entityId));
  }

  async forecastIn(trx: Trx, ctx: Ctx, days: number, entityId?: string | null): Promise<ForecastDto> {
    const today = await this.data.today(trx, ctx);
    const from = addDays(today, 1);
    const last = addDays(today, days);
    const accounts = (await this.accounts(trx, ctx, entityId)).filter(
      (a) => accountProfile(a.kind).forecast !== null,
    );
    const ids = new Set(accounts.map((a) => a.id));
    const balances = await this.data.balances(trx, ctx, [...ids], [today]);
    const items: ForecastItem[] = [];
    const add = (i: ForecastItem) => {
      if (ids.has(i.accountId) && i.amount !== 0n) items.push(i);
    };

    // Scheduled transactions and schedules beyond them.
    const scheduled = await trx
      .selectFrom('app.transaction')
      .select(['id', 'txn_date', 'description', 'spec', 'recurring_item_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'scheduled')
      .where('deleted_at', 'is', null)
      .where('txn_date', '>=', from)
      .where('txn_date', '<=', last)
      .execute();
    for (const t of scheduled) {
      const spec = t.spec as TransactionSpec | null;
      if (!spec) continue;
      for (const leg of specLegs(spec)) {
        add({
          date: calendarDate(String(t.txn_date)),
          accountId: leg.accountId,
          amount: leg.amount,
          kind: 'recurring',
          name: t.description || 'Scheduled',
          sourceId: t.recurring_item_id ?? t.id,
        });
      }
    }
    const recurring = await trx
      .selectFrom('app.recurring_item')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'active')
      .where('next_date', '<=', last)
      .execute();
    for (const r of recurring) {
      const spec = r.spec as TransactionSpec;
      const start = calendarDate(r.next_date) > from ? calendarDate(r.next_date) : from;
      for (const date of occurrencesBetween(
        calendarDate(r.start_date),
        r.cadence,
        start,
        last,
        r.end_date ? calendarDate(r.end_date) : null,
      )) {
        for (const leg of specLegs(spec)) {
          add({
            date,
            accountId: leg.accountId,
            amount: leg.amount,
            kind:
              spec.type === 'transfer' &&
              leg.amount < 0n &&
              accounts.find((a) => a.id === spec.toAccountId)?.kind === 'credit_card'
                ? 'card_payment'
                : 'recurring',
            name: r.name,
            sourceId: r.id,
          });
        }
      }
    }

    // What each card's payment rule pays, from its account to the card: this statement, then the next (ADR-0026).
    for (const c of await this.cards.statementsIn(trx, ctx, { entityId })) {
      if (!c.planned || !ids.has(c.planned.fromAccountId) || !ids.has(c.accountId)) continue;
      const card = await trx
        .selectFrom('app.bank_account')
        .select(['pay_rule', 'pay_fixed_minor', 'min_payment_minor'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('ledger_account_id', '=', c.accountId)
        .executeTakeFirstOrThrow();
      const since = BigInt(c.sinceStatement);
      const next =
        card.pay_rule === 'statement'
          ? since
          : card.pay_rule === 'minimum'
            ? card.min_payment_minor !== null && BigInt(card.min_payment_minor) < since
              ? BigInt(card.min_payment_minor)
              : since
            : card.pay_fixed_minor !== null
              ? BigInt(card.pay_fixed_minor)
              : 0n;
      const payments = [
        { date: c.planned.date < from ? from : c.planned.date, amount: BigInt(c.planned.amount) },
        { date: c.nextDueDate, amount: next },
      ];
      for (const p of payments) {
        if (p.amount <= 0n || p.date > last) continue;
        for (const [accountId, amount] of [
          [c.planned.fromAccountId, -p.amount],
          [c.accountId, p.amount],
        ] as const) {
          add({ date: p.date, accountId, amount, kind: 'card_payment', name: c.name, sourceId: c.accountId });
        }
      }
    }

    // Expected income not yet received, and discretionary burn, per entity.
    const entities = [...new Set(accounts.map((a) => a.entityId))];
    const rentals = new Set(
      (
        await trx
          .selectFrom('app.entity')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('type', '=', 'rental')
          .execute()
      ).map((r) => r.id),
    );
    for (const e of entities) {
      const cash = accounts.filter((a) => a.entityId === e && accountProfile(a.kind).forecast === 'cash');
      const primary =
        cash
          .filter((a) => a.kind === 'checking')
          .sort((a, b) =>
            (balances.get(b.id)?.get(today) ?? 0n) > (balances.get(a.id)?.get(today) ?? 0n) ? 1 : -1,
          )[0] ?? cash[0];
      // Open invoices and bills (BIZ-05, BIZ-06). One past its date is still expected, so it counts from tomorrow.
      if (primary) {
        for (const i of await this.invoices.openInvoices(trx, ctx, e)) {
          if (i.dueDate > last) continue;
          add({
            date: i.dueDate < from ? from : i.dueDate,
            accountId: primary.id,
            amount: i.open,
            kind: 'invoice',
            name: `${i.partyName} · ${i.number}`,
            sourceId: i.id,
          });
        }
        for (const b of await this.bills.openBills(trx, ctx, e)) {
          if (b.dueDate > last) continue;
          add({
            date: b.dueDate < from ? from : b.dueDate,
            accountId: primary.id,
            amount: -b.amount,
            kind: 'bill',
            name: b.partyName,
            sourceId: b.id,
          });
        }
      }
      // Rent still to come, overdue rent counting from tomorrow, and mortgage payments (RNT-04, RNT-08).
      if (primary && rentals.has(e)) {
        for (const x of await this.rent.expectedBetween(trx, ctx, e, from, last, today)) {
          add({
            date: x.date,
            accountId: accounts.some((a) => a.id === x.accountId) ? x.accountId! : primary.id,
            amount: x.amount,
            kind: 'rent',
            name: x.name,
            sourceId: x.leaseId,
          });
        }
      }
      // Loan payments, from the account each is paid from (ADR-0024).
      for (const l of await this.loans.dueBetween(trx, ctx, e, from, last)) {
        const accountId = l.payingAccountId && ids.has(l.payingAccountId) ? l.payingAccountId : primary?.id;
        if (accountId) {
          add({
            date: l.date,
            accountId,
            amount: -l.amount,
            kind: 'mortgage',
            name: l.name,
            sourceId: l.loanId,
          });
        }
      }
      const incomeItems = await this.data.incomeItems(trx, ctx, e);
      if (incomeItems.length) {
        const deposits = await this.data.deposits(trx, ctx, e, addDays(today, -8), last);
        for (const o of this.data.matchIncome(incomeItems, deposits, from, last)) {
          for (const leg of o.pending) {
            const accountId = leg.accountId ?? primary?.id;
            if (accountId)
              add({
                date: o.date,
                accountId,
                amount: leg.amount,
                kind: 'income',
                name: o.item.name,
                sourceId: o.item.id,
              });
          }
        }
      }
      if (!primary) continue;
      for (const b of await this.burn(trx, ctx, e, today, last)) {
        for (const i of burnItems(primary.id, b.amount, b.from, b.days)) add(i);
      }
    }

    const results = simulate(
      accounts.map((a) => ({
        accountId: a.id,
        start: balances.get(a.id)?.get(today) ?? 0n,
        threshold:
          accountProfile(a.kind).forecast === 'card'
            ? a.creditLimit !== null
              ? -a.creditLimit
              : -(10n ** 15n)
            : a.lowBalance,
      })),
      items,
      from,
      days,
    );
    return {
      from,
      days,
      accounts: accounts.map((a, i) => {
        const r = results[i]!;
        const item = (x: ForecastItem) => ({
          date: x.date,
          kind: x.kind,
          name: x.name,
          amount: s(x.amount),
          sourceId: x.sourceId,
        });
        return {
          accountId: a.id,
          name: a.name,
          kind: accountProfile(a.kind).forecast === 'card' ? ('card' as const) : ('cash' as const),
          currency: a.currency as Money,
          threshold: s(
            accountProfile(a.kind).forecast === 'card'
              ? a.creditLimit !== null
                ? -a.creditLimit
                : 0n
              : a.lowBalance,
          ),
          start: s(balances.get(a.id)?.get(today) ?? 0n),
          balances: r.balances.map(s),
          // Burn is one item a day; the chart shows it as a line, so only scheduled items are listed.
          items: r.items.filter((x) => x.kind !== 'burn').map(item),
          lowBalance: r.lowBalance
            ? {
                date: r.lowBalance.date,
                balance: s(r.lowBalance.balance),
                drivers: r.lowBalance.drivers.map(item),
              }
            : null,
        };
      }),
    };
  }

  /**
   * Discretionary burn (04 §11): what's left of the variable (daily, fun) budgets spread over the rest of the
   * current period, then the 3-month daily average of that spending.
   */
  private async burn(trx: Trx, ctx: Ctx, entityId: string, today: CalendarDate, last: CalendarDate) {
    const months = previousMonths(today, 3);
    const cats = (await this.data.categories(trx, ctx, entityId)).filter(
      (c) => c.kind && BURN_KINDS.has(c.kind),
    );
    const ids = new Set(cats.map((c) => c.id));
    const history = await this.data.activity(trx, ctx, entityId, months);
    let total = 0n;
    for (const m of history.values()) for (const [c, v] of m) if (ids.has(c)) total += v;
    const avg = dailyAverage(total > 0n ? total : 0n, diffDays(months[2]!.end, months[0]!.start) + 1);

    const budget = await trx
      .selectFrom('app.budget')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('member_id', 'is', null)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    const out: { amount: bigint; from: CalendarDate; days: number }[] = [];
    let next = addDays(today, 1);
    if (budget) {
      const c = await this.budgets.compute(trx, ctx, budget.id);
      const r = c.results[c.results.length - 1]!;
      let remaining = 0n;
      for (const [id, l] of r.lines) if (ids.has(id) && l.available > 0n) remaining += l.available;
      const end = c.period.end < last ? c.period.end : last;
      const days = diffDays(end, next) + 1;
      if (days > 0) out.push({ amount: remaining, from: next, days });
      next = addDays(c.period.end, 1);
    }
    const rest = diffDays(last, next) + 1;
    if (rest > 0) out.push({ amount: avg * BigInt(rest), from: next, days: rest });
    return out;
  }

  // ----- Sankey (FLOW-02, FLOW-06) ----------------------------------------------------------------------

  async sankey(ctx: Ctx, from: CalendarDate, to: CalendarDate, entityId?: string | null): Promise<SankeyDto> {
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const entities = await trx
        .selectFrom('app.entity')
        .select(['id', 'name', 'functional_currency'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('archived_at', 'is', null)
        .$if(!!entityId, (q) => q.where('id', '=', entityId!))
        .orderBy('created_at')
        .execute();
      if (entityId && !entities.length) throw notFound('Entity');
      const wholeMonths = from === startOfMonth(from) && to === endOfMonth(to);
      const periods: Period[] = [];
      if (wholeMonths) {
        for (let m = from; m <= to; m = addMonths(m, 1)) periods.push({ start: m, end: endOfMonth(m) });
      } else periods.push({ start: from, end: to });

      const nodes = new Map<string, SankeyDto['nodes'][number]>();
      const links: SankeyDto['links'] = [];
      const node = (
        id: string,
        kind: SankeyDto['nodes'][number]['kind'],
        label: string,
        drill: DrillDto | null,
      ) => {
        if (!nodes.has(id)) nodes.set(id, { id, kind, label, value: '0', drill });
        return nodes.get(id)!;
      };
      const link = (source: string, target: string, value: bigint) => {
        if (value <= 0n) return;
        links.push({ source, target, value: s(value) });
        const t = nodes.get(target)!;
        t.value = s(BigInt(t.value) + value);
        if (nodes.get(source)!.kind === 'income' || nodes.get(source)!.kind === 'deficit') {
          const sn = nodes.get(source)!;
          sn.value = s(BigInt(sn.value) + value);
        }
      };

      for (const e of entities) {
        const cats = await this.data.categories(trx, ctx, e.id);
        const activity = await this.data.activity(trx, ctx, e.id, periods);
        const sum = new Map<string, bigint>();
        for (const m of activity.values()) for (const [c, v] of m) sum.set(c, (sum.get(c) ?? 0n) + v);
        const entityNode = `entity:${e.id}`;
        node(entityNode, 'entity', e.name, { entityId: e.id, from, to });
        let income = 0n;
        let spent = 0n;
        for (const c of cats.filter((x) => x.type === 'income')) {
          const v = -(sum.get(c.id) ?? 0n);
          if (v <= 0n) continue;
          node(`income:${c.id}`, 'income', c.name, { entityId: e.id, categoryIds: [c.id], from, to });
          link(`income:${c.id}`, entityNode, v);
          income += v;
        }
        const groups = new Map<
          string,
          { label: string; ids: string[]; total: bigint; cats: [string, string, bigint][] }
        >();
        for (const c of cats.filter((x) => x.type === 'expense')) {
          const v = sum.get(c.id) ?? 0n;
          if (v <= 0n) continue;
          const key = c.groupId ?? `other:${e.id}`;
          const g = groups.get(key) ?? { label: c.groupName ?? 'Other', ids: [], total: 0n, cats: [] };
          g.ids.push(c.id);
          g.total += v;
          g.cats.push([c.id, c.name, v]);
          groups.set(key, g);
          spent += v;
        }
        for (const [key, g] of groups) {
          const gid = `group:${key}`;
          node(gid, 'group', g.label, { entityId: e.id, categoryIds: g.ids, from, to });
          link(entityNode, gid, g.total);
          for (const [id, name, v] of g.cats) {
            node(`category:${id}`, 'category', name, { entityId: e.id, categoryIds: [id], from, to });
            link(gid, `category:${id}`, v);
          }
        }
        // Savings and debt paydown: net money into savings accounts and onto loans in the window.
        const { rows } = await sql<{ id: string; name: string; kind: string; v: string }>`
          select a.id, a.name, b.kind,
                 (coalesce(sum(d.functional_delta_minor), 0)
                  - coalesce((select sum(p.functional_amount_minor)
                                from app.posting p
                                join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
                               where p.workspace_id = a.workspace_id and p.ledger_account_id = a.id
                                 and je.kind = 'valuation' and p.entry_date between ${from} and ${to}), 0))::text as v
            from app.bank_account b
            join app.ledger_account a on a.id = b.ledger_account_id
            left join app.account_balance_daily d on d.ledger_account_id = a.id and d.date between ${from} and ${to}
           where a.workspace_id = ${ctx.workspaceId} and a.entity_id = ${e.id}
             and b.kind = any(${sql.val(kindsWhere((t) => t.moneyFlow !== null))}::text[])
           group by 1, 2, 3`.execute(trx);
        let moved = 0n;
        for (const r of rows) {
          const v = BigInt(r.v);
          if (v <= 0n) continue;
          const kind = accountProfile(r.kind).moneyFlow;
          if (!kind) continue;
          node(`${kind}:${r.id}`, kind, r.name, { entityId: e.id, accountIds: [r.id], from, to });
          link(entityNode, `${kind}:${r.id}`, v);
          moved += v;
        }
        const left = income - spent - moved;
        if (left > 0n) {
          node(`unspent:${e.id}`, 'unspent', 'Not spent', null);
          link(entityNode, `unspent:${e.id}`, left);
        } else if (left < 0n) {
          node(`deficit:${e.id}`, 'deficit', 'From savings or credit', null);
          link(`deficit:${e.id}`, entityNode, -left);
        }
      }
      // Entity nodes show what flowed through them.
      for (const n of nodes.values()) {
        if (n.kind !== 'entity') continue;
        const inflow = links.filter((l) => l.target === n.id).reduce((t, l) => t + BigInt(l.value), 0n);
        n.value = s(inflow);
      }
      return {
        from,
        to,
        currency: (entities.length === 1 ? entities[0]!.functional_currency : ws.base_currency) as Money,
        nodes: [...nodes.values()],
        links,
      };
    });
  }

  // ----- Dashboard (FLOW-01, FAM-09) --------------------------------------------------------------------

  async dashboard(
    ctx: Ctx,
    opts: { entityId?: string | null; memberId?: string | null },
  ): Promise<DashboardDto> {
    return this.db.run(ctx, async (trx) => {
      const entityId = opts.entityId ?? (await this.defaultEntity(trx, ctx));
      const memberId = opts.memberId ?? null;
      const entity = await this.data.entity(trx, ctx, entityId);
      const today = await this.data.today(trx, ctx);
      const budget = await trx
        .selectFrom('app.budget')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('archived_at', 'is', null)
        .where((eb) => (memberId ? eb('member_id', '=', memberId) : eb('member_id', 'is', null)))
        .executeTakeFirst();

      let period: Period = periodContaining({ type: 'monthly' }, today);
      let income = 0n;
      let spent = 0n;
      let leftToSpend: bigint | null = null;
      let leftToAssign: bigint | null = null;
      let spendIds: string[] = [];
      let incomeIds: string[] = [];
      let pace: DashboardDto['pace'] = [];
      const cats = await this.data.categories(trx, ctx, entityId);
      incomeIds = cats.filter((c) => c.type === 'income').map((c) => c.id);
      // Payroll taxes and deductions are part of pay, not spending (04 §8).
      spendIds = cats.filter((c) => c.type === 'expense' && c.kind !== 'system').map((c) => c.id);
      if (budget) {
        const c = await this.budgets.compute(trx, ctx, budget.id);
        period = c.period;
        const r = c.results[c.results.length - 1]!;
        income = c.income.actual;
        spent = r.activity + [...c.unbudgeted.values()].reduce((t, v) => t + v, 0n);
        const kinds = new Map(c.categories.map((x) => [x.id, x.kind]));
        leftToSpend = [...r.lines.values()]
          .filter((l) => kinds.get(l.categoryId) !== 'savings')
          .reduce((t, l) => t + l.available, 0n);
        leftToAssign = budget.method === 'category_limits' ? null : r.leftToAssign;
        const names = new Map(c.categories.map((x) => [x.id, x.name]));
        pace = c.categories
          .filter(isBudgetCategory)
          .flatMap((cat) => {
            const l = r.lines.get(cat.id);
            const total = l ? l.available + l.activity : 0n;
            const p =
              l && total > 0n && PACE_KINDS.has(cat.kind!)
                ? spendingPace(period, today, total, l.activity)
                : null;
            return l && p && p.status === 'over' ? [{ l, total, p }] : [];
          })
          .sort((a, b) => (b.p.projected - b.total > a.p.projected - a.total ? 1 : -1))
          .slice(0, 5)
          .map(({ l, total, p }) => ({
            categoryId: l.categoryId,
            name: names.get(l.categoryId) ?? '',
            assigned: s(total),
            activity: s(l.activity),
            pace: { expectedByToday: s(p.expectedByToday), projected: s(p.projected), status: p.status },
            drill: { entityId, categoryIds: [l.categoryId], from: period.start, to: period.end },
          }));
      } else {
        const act = (await this.data.activity(trx, ctx, entityId, [period], { memberId })).get(period.start)!;
        for (const [c, v] of act) {
          if (incomeIds.includes(c)) income -= v;
          else if (spendIds.includes(c)) spent += v;
        }
        income -=
          (await this.data.payslipWithheld(trx, ctx, entityId, [period], { memberId })).get(period.start) ??
          0n;
      }

      const upcoming = (await this.calendarIn(trx, ctx, today, addDays(today, 13), entityId)).items.filter(
        (i) => i.status !== 'paid',
      );
      const nw = await this.netWorthIn(trx, ctx, { date: today, months: 6 });
      const fc = await this.forecastIn(trx, ctx, 30, entityId);
      const open = await trx
        .selectFrom('app.recommendation')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('status', '=', 'open')
        .executeTakeFirstOrThrow();
      const memberDrill = memberId ? { memberId } : {};
      return {
        entityId,
        memberId,
        currency: entity.currency as Money,
        period: { start: period.start, end: period.end },
        budgetId: budget?.id ?? null,
        income: {
          amount: s(income),
          drill: { entityId, ...memberDrill, categoryIds: incomeIds, from: period.start, to: period.end },
        },
        spent: {
          amount: s(spent),
          drill: { entityId, ...memberDrill, categoryIds: spendIds, from: period.start, to: period.end },
        },
        leftToSpend: leftToSpend !== null ? s(leftToSpend) : null,
        leftToAssign: leftToAssign !== null ? s(leftToAssign) : null,
        pace,
        upcoming,
        netWorth: { current: nw.netWorth, trend: nw.trend },
        lowBalance: fc.accounts
          .filter((a) => a.kind === 'cash' && a.lowBalance)
          .map((a) => ({
            accountId: a.accountId,
            name: a.name,
            date: a.lowBalance!.date,
            balance: a.lowBalance!.balance,
          })),
        openRecommendations: Number(open.n),
      };
    });
  }

  /** The personal entity (or the first one) when the dashboard isn't given an entity. */
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
