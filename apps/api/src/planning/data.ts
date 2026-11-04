/**
 * Reads for planning (Phase 6, ADR-0015): categories with their groups, category activity per period (from
 * the monthly read model, or postings for pay periods), deposits for expected-income matching and account
 * balances. Everything runs in the caller's RLS context, so restricted amounts follow the payslip rule.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  addDays,
  calendarDate,
  diffDays,
  endOfMonth,
  occurrencesBetween,
  startOfMonth,
  todayIn,
  type CalendarDate,
  type Cadence,
  type GroupKind,
  type Period,
} from '@montra/domain';
import { notFound } from '../common/errors.js';
import { Db } from '../db/database.js';

export type Ctx = { workspaceId: string; userId: string };

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface PlanCategory {
  id: string;
  name: string;
  type: 'income' | 'expense';
  groupId: string | null;
  groupName: string | null;
  /** Null for system accounts without a group (uncategorized, FX, fees). */
  kind: GroupKind | null;
  systemRole: string | null;
}

export interface EntityInfo {
  id: string;
  name: string;
  type: string;
  currency: string;
  baseCurrency: string;
  timeZone: string;
}

export interface ActivityFilter {
  /** FAM-06: only this member's postings. */
  memberId?: string | null;
  /** Recommendations (stored, visible to partners) never use restricted amounts. */
  includeRestricted?: boolean;
}

export interface Deposit {
  transactionId: string;
  date: CalendarDate;
  payeeKey: string | null;
  accountId: string;
  amount: bigint;
  /** Set when a payslip owns this deposit (ADR-0016). */
  employerId: string | null;
}

export interface IncomeItem {
  id: string;
  name: string;
  memberId: string | null;
  sourceType: 'salary' | 'business' | 'rent' | 'other';
  amount: bigint;
  currency: string;
  cadence: Cadence;
  nextDate: CalendarDate;
  accountId: string | null;
  payeeKey: string | null;
  employerId: string | null;
}

export interface IncomeOccurrence {
  item: IncomeItem;
  date: CalendarDate;
  actual: Deposit | null;
}

const isMonth = (p: Period) => p.start === startOfMonth(p.start) && p.end === endOfMonth(p.start);

@Injectable()
export class PlanningData {
  constructor(@Inject(Db) readonly db: Db) {}

  async entity(trx: Trx, ctx: Ctx, entityId: string): Promise<EntityInfo> {
    const row = await trx
      .selectFrom('app.entity as e')
      .innerJoin('app.workspace as w', 'w.id', 'e.workspace_id')
      .select(['e.id', 'e.name', 'e.type', 'e.functional_currency', 'w.base_currency', 'w.time_zone'])
      .where('e.workspace_id', '=', ctx.workspaceId)
      .where('e.id', '=', entityId)
      .executeTakeFirst();
    if (!row) throw notFound('Entity');
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      currency: row.functional_currency,
      baseCurrency: row.base_currency,
      timeZone: row.time_zone,
    };
  }

  async today(trx: Trx, ctx: Ctx): Promise<CalendarDate> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('time_zone')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return todayIn(ws.time_zone);
  }

  async categories(trx: Trx, ctx: Ctx, entityId: string): Promise<PlanCategory[]> {
    const rows = await trx
      .selectFrom('app.ledger_account as a')
      .leftJoin('app.category_group as g', 'g.id', 'a.category_group_id')
      .select([
        'a.id',
        'a.name',
        'a.type',
        'a.system_role',
        'g.id as group_id',
        'g.name as group_name',
        'g.kind',
      ])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.entity_id', '=', entityId)
      .where('a.is_category', '=', true)
      .where('a.archived_at', 'is', null)
      .orderBy('g.sort_order')
      .orderBy('a.sort_order')
      .orderBy('a.name')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as 'income' | 'expense',
      groupId: r.group_id,
      groupName: r.group_name,
      kind: (r.kind as GroupKind | null) ?? null,
      systemRole: r.system_role,
    }));
  }

  /**
   * Activity per category (functional minor units, debit positive) for each period, keyed by period start.
   * Calendar months read the monthly read model; pay periods sum postings by day.
   */
  async activity(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    periods: readonly Period[],
    f: ActivityFilter = {},
  ): Promise<Map<CalendarDate, Map<string, bigint>>> {
    const out = new Map<CalendarDate, Map<string, bigint>>(periods.map((p) => [p.start, new Map()]));
    if (!periods.length) return out;
    const first = periods[0]!.start;
    const last = periods[periods.length - 1]!.end;
    const add = (start: CalendarDate, account: string, v: bigint) => {
      const m = out.get(start);
      if (m && v !== 0n) m.set(account, (m.get(account) ?? 0n) + v);
    };
    if (periods.every(isMonth)) {
      let q = trx
        .selectFrom('app.category_activity_monthly')
        .select(['ledger_account_id', 'month'])
        .select((eb) => eb.fn.sum<string>('activity_minor').as('v'))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('month', '>=', first)
        .where('month', '<=', last)
        .groupBy(['ledger_account_id', 'month']);
      if (f.memberId) q = q.where('member_key', '=', f.memberId);
      if (f.includeRestricted === false) q = q.where('restricted', '=', false);
      for (const r of await q.execute()) add(calendarDate(String(r.month)), r.ledger_account_id, BigInt(r.v));
      return out;
    }
    let q = trx
      .selectFrom('app.posting')
      .select(['ledger_account_id', 'entry_date'])
      .select((eb) => eb.fn.sum<string>('functional_amount_minor').as('v'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('entry_date', '>=', first)
      .where('entry_date', '<=', last)
      .groupBy(['ledger_account_id', 'entry_date']);
    if (f.memberId) q = q.where('member_id', '=', f.memberId);
    if (f.includeRestricted === false) q = q.where('restricted', '=', false);
    const starts = periods.map((p) => p.start);
    for (const r of await q.execute()) {
      const d = calendarDate(String(r.entry_date));
      // Periods are contiguous: the last start on or before the date.
      let i = starts.length - 1;
      while (i > 0 && starts[i]! > d) i--;
      if (d <= periods[i]!.end) add(starts[i]!, r.ledger_account_id, BigInt(r.v));
    }
    return out;
  }

  /**
   * What payslips withheld per period: gross − net, in the viewer's RLS (who sees gross sees this too). Budgets and
   * the dashboard plan on take-home pay (04 §8), though the ledger's income category holds gross (PAY-05).
   */
  async payslipWithheld(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    periods: readonly Period[],
    f: ActivityFilter = {},
  ): Promise<Map<CalendarDate, bigint>> {
    const out = new Map<CalendarDate, bigint>(periods.map((p) => [p.start, 0n]));
    if (!periods.length || f.includeRestricted === false) return out;
    let q = trx
      .selectFrom('app.payslip')
      .select(['pay_date', 'gross_minor', 'net_minor'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('status', '=', 'posted')
      .where('pay_date', '>=', periods[0]!.start)
      .where('pay_date', '<=', periods[periods.length - 1]!.end);
    if (f.memberId) q = q.where('member_id', '=', f.memberId);
    const rows = await q.execute();
    for (const r of rows) {
      const d = calendarDate(String(r.pay_date));
      const p = periods.find((x) => d >= x.start && d <= x.end);
      if (p) out.set(p.start, out.get(p.start)! + BigInt(r.gross_minor) - BigInt(r.net_minor));
    }
    return out;
  }

  /** Posted deposits (positive standard transactions) of an entity in [from, to], for income matching. */
  async deposits(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Deposit[]> {
    const { rows } = await sql<{
      id: string;
      d: string;
      payee_key: string | null;
      account_id: string;
      amount: string;
      employer_id: string | null;
    }>`
      select t.id, t.txn_date::text as d, t.payee_key, t.spec->>'accountId' as account_id, t.spec->>'amount' as amount,
             t.spec->>'employerId' as employer_id
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${entityId}
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and (t.spec->>'amount')::bigint > 0 and t.txn_date between ${from} and ${to}
       order by t.txn_date, t.id`.execute(trx);
    return rows.map((r) => ({
      transactionId: r.id,
      date: calendarDate(r.d),
      payeeKey: r.payee_key,
      accountId: r.account_id,
      amount: BigInt(r.amount),
      employerId: r.employer_id,
    }));
  }

  async incomeItems(trx: Trx, ctx: Ctx, entityId: string, memberId?: string | null): Promise<IncomeItem[]> {
    let q = trx
      .selectFrom('app.expected_income')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('active', '=', true)
      .orderBy('next_date')
      .orderBy('id');
    if (memberId) q = q.where('member_id', '=', memberId);
    return (await q.execute()).map((r) => ({
      id: r.id,
      name: r.name,
      memberId: r.member_id,
      sourceType: r.source_type,
      amount: BigInt(r.amount_minor),
      currency: r.currency,
      cadence: r.cadence,
      nextDate: calendarDate(r.next_date),
      accountId: r.account_id,
      payeeKey: r.payee_key,
      employerId: r.employer_id,
    }));
  }

  /**
   * Expected income occurrences in [from, to] with the deposit that fulfilled each one (04 §8: the actual
   * deposit replaces the expectation). A deposit matches within −3/+5 days, into the item's account when set,
   * from the item's payee when set (any amount), otherwise within ±10% of the expected amount. A payslip's deposit
   * is its employer's pay whatever the statement calls it, and nobody else's (PAY-07).
   */
  matchIncome(
    items: readonly IncomeItem[],
    deposits: readonly Deposit[],
    from: CalendarDate,
    to: CalendarDate,
  ): IncomeOccurrence[] {
    const used = new Set<string>();
    const occ: IncomeOccurrence[] = [];
    for (const item of items) {
      for (const date of occurrencesBetween(item.nextDate, item.cadence, from, to))
        occ.push({ item, date, actual: null });
    }
    occ.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.item.id < b.item.id ? -1 : 1));
    for (const o of occ) {
      let best: Deposit | null = null;
      for (const d of deposits) {
        if (used.has(d.transactionId)) continue;
        const gap = diffDays(d.date, o.date);
        if (gap < -3 || gap > 5) continue;
        const own = d.employerId !== null && d.employerId === o.item.employerId;
        if (d.employerId !== null && !own) continue;
        if (!own) {
          if (o.item.accountId && d.accountId !== o.item.accountId) continue;
          if (o.item.payeeKey) {
            if (d.payeeKey !== o.item.payeeKey) continue;
          } else {
            const diff = d.amount - o.item.amount;
            if ((diff < 0n ? -diff : diff) * 10n > o.item.amount) continue;
          }
        }
        const bestOwn = best !== null && best.employerId !== null;
        const closer = !best || Math.abs(diffDays(d.date, o.date)) < Math.abs(diffDays(best.date, o.date));
        if (own ? !bestOwn || closer : !bestOwn && closer) best = d;
      }
      if (best) {
        used.add(best.transactionId);
        o.actual = best;
      }
    }
    return occ;
  }

  /** Balance (account currency) of each account at the end of each date: Σ daily deltas through the date. */
  async balances(
    trx: Trx,
    ctx: Ctx,
    accountIds: readonly string[],
    dates: readonly CalendarDate[],
  ): Promise<Map<string, Map<CalendarDate, bigint>>> {
    const out = new Map<string, Map<CalendarDate, bigint>>(accountIds.map((a) => [a, new Map()]));
    if (!accountIds.length || !dates.length) return out;
    const { rows } = await sql<{ account: string; d: string; v: string }>`
      select b.ledger_account_id as account, d.d::text as d, sum(b.delta_minor)::text as v
        from unnest(${sql.val([...dates])}::date[]) as d(d)
        join app.account_balance_daily b on b.date <= d.d
       where b.workspace_id = ${ctx.workspaceId} and b.ledger_account_id = any(${sql.val([...accountIds])}::uuid[])
       group by 1, 2`.execute(trx);
    for (const r of rows) out.get(r.account)?.set(calendarDate(r.d), BigInt(r.v));
    for (const m of out.values()) for (const d of dates) if (!m.has(d)) m.set(d, 0n);
    return out;
  }
}

/** Month starts for the `n` months before the month of `date` (oldest first). */
export function previousMonths(date: CalendarDate, n: number): Period[] {
  const out: Period[] = [];
  let start = startOfMonth(date);
  for (let i = 0; i < n; i++) {
    start = startOfMonth(addDays(start, -1));
    out.unshift({ start, end: endOfMonth(start) });
  }
  return out;
}
