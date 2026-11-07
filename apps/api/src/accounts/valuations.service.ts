/**
 * Market value of investment and other valued accounts (ADR-0025). A value from a statement posts the difference from the
 * ledger as a change in value, against Investment gains and losses: it moves net worth, never income. Gain over time is
 * worked out from those changes and the money put in.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  accountProfile,
  annualizedBps,
  balanceHistoryDates,
  balanceRangeStart,
  calendarDate,
  compareDates,
  performance,
  performancePeriods,
  todayIn,
  valueAndInvested,
  type BalanceRange,
  type CalendarDate,
  type JournalEntryDraft,
  type ValueChange,
} from '@montra/domain';
import type { AccountValuationDto, AddValuationsRequest, InvestmentPerformanceDto } from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';

type Ctx = { workspaceId: string; userId: string };

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

@Injectable()
export class ValuationsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  private async account(trx: Trx, ctx: Ctx, accountId: string) {
    const a = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select(['a.id', 'a.entity_id', 'a.currency', 'a.type', 'b.kind'])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.ledger_account_id', '=', accountId)
      .executeTakeFirst();
    if (!a) throw notFound('Account');
    if (accountProfile(a.kind).balanceWord !== 'value') {
      throw unprocessable(
        'valuation.kind',
        'Only investments and other assets have a market value to update',
      );
    }
    return a;
  }

  /** Whether some of this account's money is private to someone else, so its value can't be worked out from what's seen. */
  private async hidden(trx: Trx, ctx: Ctx, accountId: string): Promise<boolean> {
    const { rows } = await sql<{ hidden: boolean }>`
      select app.account_has_hidden_postings(${ctx.workspaceId}::uuid, ${accountId}::uuid) as hidden`.execute(
      trx,
    );
    return rows[0]?.hidden ?? false;
  }

  private async today(trx: Trx, ctx: Ctx): Promise<CalendarDate> {
    const w = await trx
      .selectFrom('app.workspace')
      .select('time_zone')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return todayIn(w.time_zone);
  }

  async list(ctx: Ctx, accountId: string): Promise<AccountValuationDto[]> {
    return this.db.run(ctx, async (trx) => {
      await this.account(trx, ctx, accountId);
      const rows = await trx
        .selectFrom('app.account_valuation')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('account_id', '=', accountId)
        .orderBy('value_date', 'desc')
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        date: iso(r.value_date),
        value: String(r.value_minor),
        change: String(r.change_minor),
        note: r.note,
      }));
    });
  }

  /** The natural balance at the end of a date, counting every posting: the caller has checked nothing is hidden. */
  private async balanceOn(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    type: string,
    date: CalendarDate,
  ): Promise<bigint> {
    const { rows } = await sql<{ total: string | null }>`
      select sum(amount_minor)::text as total from app.posting
       where workspace_id = ${ctx.workspaceId} and ledger_account_id = ${accountId} and entry_date <= ${date}`.execute(
      trx,
    );
    const debit = BigInt(rows[0]?.total ?? '0');
    return type === 'liability' ? -debit : debit;
  }

  private async post(
    trx: Trx,
    ctx: Ctx,
    a: { id: string; entity_id: string; currency: string },
    date: CalendarDate,
    change: bigint,
    description: string,
  ): Promise<string> {
    const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
    const gains = resolver.systemAccount(a.entity_id, 'investment_gains');
    const entity = resolver.entity(a.entity_id);
    if (a.currency !== entity.functionalCurrency) {
      throw unprocessable(
        'valuation.currency',
        'Values can be updated only on accounts in the currency of their books',
      );
    }
    const draft: JournalEntryDraft = {
      entityId: a.entity_id,
      functionalCurrency: entity.functionalCurrency,
      entryDate: date,
      kind: 'valuation',
      description,
      postings: [
        {
          lineNo: 1,
          accountId: a.id,
          accountEntityId: a.entity_id,
          currency: a.currency,
          amount: change,
          functionalAmount: change,
          fxRate: null,
        },
        {
          lineNo: 2,
          accountId: gains.id,
          accountEntityId: a.entity_id,
          currency: gains.currency,
          amount: -change,
          functionalAmount: -change,
          fxRate: null,
        },
      ],
    };
    const [entryId] = await this.ledger.post(trx, ctx, null, [draft]);
    return entryId!;
  }

  /**
   * Values from statements, oldest first. Each posts what the ledger lacked that day. A value before the latest one
   * would change what that one meant, so it's refused: remove the later ones first.
   */
  async add(ctx: Ctx, accountId: string, req: AddValuationsRequest): Promise<AccountValuationDto[]> {
    await this.db.run(ctx, async (trx) => {
      const a = await this.account(trx, ctx, accountId);
      if (await this.hidden(trx, ctx, accountId)) {
        throw unprocessable(
          'valuation.private',
          'Some of this account’s money is private to someone else, so only they can update its value',
        );
      }
      const today = await this.today(trx, ctx);
      const latest = await trx
        .selectFrom('app.account_valuation')
        .select('value_date')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('account_id', '=', accountId)
        .orderBy('value_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      let after = latest ? iso(latest.value_date) : null;
      for (const v of req.values) {
        if (compareDates(v.date, today) > 0)
          throw unprocessable('valuation.future', 'A value can’t be in the future');
        if (after && compareDates(v.date, after) < 0) {
          throw unprocessable('valuation.order', `Values have to be on or after ${after}, the latest one`);
        }
        after = v.date;
        const change = BigInt(v.value) - (await this.balanceOn(trx, ctx, accountId, a.type, v.date));
        const entryId =
          change === 0n
            ? null
            : await this.post(
                trx,
                ctx,
                a,
                v.date,
                change,
                v.note ? `Value update: ${v.note}` : 'Value update',
              );
        await trx
          .insertInto('app.account_valuation')
          .values({
            workspace_id: ctx.workspaceId,
            id: newId(),
            entity_id: a.entity_id,
            account_id: accountId,
            value_date: v.date,
            value_minor: v.value,
            change_minor: change,
            entry_id: entryId,
            note: v.note ?? null,
          })
          .execute();
      }
    });
    return this.list(ctx, accountId);
  }

  /** Takes back the latest value, by posting its change the other way. Earlier ones stay as they were. */
  async removeLatest(ctx: Ctx, accountId: string, valuationId: string): Promise<AccountValuationDto[]> {
    await this.db.run(ctx, async (trx) => {
      const a = await this.account(trx, ctx, accountId);
      const latest = await trx
        .selectFrom('app.account_valuation')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('account_id', '=', accountId)
        .orderBy('value_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!latest || latest.id !== valuationId) {
        throw unprocessable('valuation.not_latest', 'Only the latest value can be removed');
      }
      const change = BigInt(latest.change_minor);
      if (change !== 0n)
        await this.post(trx, ctx, a, iso(latest.value_date), -change, 'Value update removed');
      await trx
        .deleteFrom('app.account_valuation')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', latest.id)
        .execute();
    });
    return this.list(ctx, accountId);
  }

  async performance(ctx: Ctx, accountId: string, range: BalanceRange): Promise<InvestmentPerformanceDto> {
    return this.db.run(ctx, async (trx) => {
      const a = await this.account(trx, ctx, accountId);
      const empty = {
        accountId,
        currency: a.currency,
        range,
        hidden: false,
        from: null,
        to: null,
        summary: null,
        points: [],
        periods: [],
      };
      if (await this.hidden(trx, ctx, accountId)) return { ...empty, hidden: true };
      const today = await this.today(trx, ctx);
      const { rows } = await sql<{ d: string; delta: string; valuation: string }>`
        select p.entry_date::text as d, sum(p.amount_minor)::text as delta,
               coalesce(sum(p.amount_minor) filter (where e.kind = 'valuation'), 0)::text as valuation
          from app.posting p
          join app.journal_entry e on e.workspace_id = p.workspace_id and e.id = p.journal_entry_id
         where p.workspace_id = ${ctx.workspaceId} and p.ledger_account_id = ${accountId} and p.entry_date <= ${today}
         group by 1
         order by 1`.execute(trx);
      const sign = a.type === 'liability' ? -1n : 1n;
      const changes: ValueChange[] = rows.map((r) => ({
        date: calendarDate(r.d),
        delta: sign * BigInt(r.delta),
        valuation: sign * BigInt(r.valuation),
      }));
      if (!changes.length) return empty;
      const from = balanceRangeStart(range, today, changes[0]!.date);
      const total = performance(changes, from, today);
      const figures = (p: ReturnType<typeof performance>) => ({
        start: String(p.start),
        end: String(p.end),
        moneyIn: String(p.moneyIn),
        moneyOut: String(p.moneyOut),
        gain: String(p.gain),
        returnBps: p.returnBps,
      });
      return {
        ...empty,
        from,
        to: today,
        summary: { ...figures(total), annualizedBps: annualizedBps(total.returnBps, from, today) },
        points: valueAndInvested(changes, balanceHistoryDates(from, today)).map((p) => ({
          date: p.date,
          value: String(p.value),
          invested: String(p.invested),
        })),
        periods: performancePeriods(from, today)
          .map((p) => ({ ...p, ...figures(performance(changes, p.from, p.to)) }))
          .reverse(),
      };
    });
  }
}
