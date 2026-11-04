/**
 * Global search (RPT-05) and ask-your-data (RPT-06; ADR-0019 §3, §4). Search reads under the caller's RLS. For a question, AI turns the
 * words into a plan, which is checked; every number then comes from a query here, and no figure goes to the provider.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  asCurrencyCode,
  calendarDate,
  convert,
  matchSnippet,
  money,
  parseDecimal,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import type { AskAnswerDto, SearchResultsDto } from '@montra/schemas';
import { AiService } from '../ai/ai.service.js';
import { AppError } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { FxRatesService } from '../fx/fx.service.js';
import { searchFilter, tsQueryOf } from '../transactions/search-filter.js';

type Ctx = { workspaceId: string; userId: string };
const TRANSACTIONS = 50;
const SIDE_LISTS = 10;
const ASK_TRANSACTIONS = 20;

@Injectable()
export class SearchService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(FxRatesService) private readonly fx: FxRatesService,
  ) {}

  async search(ctx: Ctx, q: string): Promise<SearchResultsDto> {
    return this.db.run(ctx, async (trx) => {
      const filter = await searchFilter(trx, ctx, this.crypto, q);
      const { terms, amounts, tags } = filter.query;
      if (!terms.length && !amounts.length && !tags.length) {
        return { query: q, transactions: [], moreTransactions: false, payees: [], receipts: [] };
      }
      const { rows } = await sql<{
        id: string;
        d: string;
        payee: string | null;
        description: string;
        amount: string | null;
        currency: string | null;
      }>`
        select t.id, t.txn_date::text as d, t.payee_raw as payee, t.description,
               t.spec->>'amount' as amount, t.spec->>'currency' as currency
          from app.transaction t
         where t.workspace_id = ${ctx.workspaceId} and t.deleted_at is null and ${filter.where}
         order by t.txn_date desc, t.id desc
         limit ${TRANSACTIONS + 1}`.execute(trx);
      const ts = tsQueryOf(terms);
      const payees = ts
        ? (
            await sql<{ name: string; n: string; last: string }>`
              select t.payee_raw as name, count(*)::text as n, max(t.txn_date)::text as last
                from app.transaction t
               where t.workspace_id = ${ctx.workspaceId} and t.deleted_at is null and t.payee_raw is not null
                 and to_tsvector('simple', t.payee_raw) @@ to_tsquery('simple', ${ts})
                 and ${filter.where}
               group by t.payee_raw order by count(*) desc limit ${SIDE_LISTS}`.execute(trx)
          ).rows
        : [];
      // Amounts and tags are about transactions: a receipt can't be held to them, so it isn't listed as if it had been.
      const receipts =
        ts && !amounts.length && !tags.length
          ? (
              await sql<{
                id: string;
                merchant: string | null;
                d: string | null;
                total: string | null;
                currency: string | null;
                ocr: string | null;
              }>`
              select r.id, r.merchant, r.receipt_date::text as d, r.total_minor::text as total, r.currency, r.ocr_text as ocr
                from app.receipt r
               where r.workspace_id = ${ctx.workspaceId} and r.deleted_at is null
                 and r.search @@ to_tsquery('simple', ${ts})
               order by r.receipt_date desc nulls last limit ${SIDE_LISTS}`.execute(trx)
            ).rows
          : [];
      return {
        query: q,
        transactions: rows.slice(0, TRANSACTIONS).map((r) => ({
          id: r.id,
          date: calendarDate(r.d),
          payee: r.payee,
          description: r.description,
          amount: r.amount,
          currency: r.currency ? asCurrencyCode(r.currency) : null,
          matchedNote: filter.notes.get(r.id) ?? null,
        })),
        moreTransactions: rows.length > TRANSACTIONS,
        payees: payees.map((p) => ({ name: p.name, count: Number(p.n), lastDate: calendarDate(p.last) })),
        receipts: receipts.map((r) => ({
          id: r.id,
          merchant: r.merchant,
          date: r.d ? calendarDate(r.d) : null,
          total: r.total,
          currency: r.currency ? asCurrencyCode(r.currency) : null,
          snippet: r.ocr ? matchSnippet(r.ocr, terms) : null,
        })),
      };
    });
  }

  // ----- Ask-your-data ---------------------------------------------------------------------------------------

  async ask(ctx: Ctx, question: string): Promise<AskAnswerDto> {
    const plan = await this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const categories = await trx
        .selectFrom('app.ledger_account')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('is_category', '=', true)
        .where('archived_at', 'is', null)
        .execute();
      const runtime = await this.ai.runtime(trx, ctx, { type: 'question', id: ctx.workspaceId });
      if (!runtime.available) {
        throw new AppError(409, 'ai.off', 'Asking questions needs AI. You can turn it on in settings.');
      }
      const res = await this.ai.gateway.answerQuestion(
        {
          question,
          categories: [...new Set(categories.map((c) => c.name))],
          today: todayIn(ws.time_zone),
        },
        { ...runtime.ctx, parkLocal: false },
      );
      if (!res.ok) {
        throw new AppError(
          res.reason === 'off' ? 409 : 503,
          res.reason === 'off' ? 'ai.off' : 'ai.unavailable',
          'That could not be answered right now. Try again in a moment.',
        );
      }
      return { value: res.value, categories };
    });
    const p = plan.value;
    if (!p.understood || p.periods.length === 0) {
      return {
        question,
        understood: false,
        metric: null,
        categories: [],
        payee: null,
        currency: null,
        periods: [],
        transactions: [],
      };
    }
    const wanted = new Set(p.categories.map((c) => c.toLowerCase()));
    const ids = plan.categories.filter((c) => wanted.has(c.name.toLowerCase())).map((c) => c.id);

    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const base = ws.base_currency;
      const last = p.periods.reduce((m, x) => (x.to > m ? x.to : m), p.periods[0]!.to);
      const entities = await trx
        .selectFrom('app.entity')
        .select('functional_currency')
        .where('workspace_id', '=', ctx.workspaceId)
        .execute();
      const used = [...new Set(entities.map((e) => e.functional_currency))];
      const rates = await this.fx.table(trx, [...used, base], last as CalendarDate, last as CalendarDate);
      const inBase = (amount: bigint, currency: string): bigint => {
        if (currency === base) return amount;
        const r = rates.get(currency, base, last as CalendarDate);
        return r
          ? convert(money(amount, asCurrencyCode(currency)), asCurrencyCode(base), parseDecimal(r.rate))
              .amount
          : 0n;
      };
      const categoryFilter = ids.length ? sql`and p.ledger_account_id = any(${ids}::uuid[])` : sql``;
      const payeeFilter = p.payee
        ? sql`and exists (select 1 from app.journal_entry je join app.transaction t
              on t.workspace_id = je.workspace_id and t.id = je.transaction_id
              where je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
                and t.payee_raw ilike ${`%${p.payee.replace(/[%_\\]/g, '')}%`})`
        : sql``;
      const periods: AskAnswerDto['periods'] = [];
      for (const period of p.periods) {
        const { rows } = await sql<{ currency: string; income: string; expense: string }>`
          select e.functional_currency as currency,
                 coalesce(sum(-p.functional_amount_minor) filter (where a.type = 'income'), 0)::text as income,
                 coalesce(sum(p.functional_amount_minor) filter (where a.type = 'expense'), 0)::text as expense
            from app.posting p
            join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
            join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
           where p.workspace_id = ${ctx.workspaceId} and p.entry_date between ${period.from} and ${period.to}
             and a.type in ('income', 'expense') ${categoryFilter} ${payeeFilter}
           group by 1`.execute(trx);
        let income = 0n;
        let expense = 0n;
        for (const r of rows) {
          income += inBase(BigInt(r.income), r.currency);
          expense += inBase(BigInt(r.expense), r.currency);
        }
        const amount = p.metric === 'income' ? income : p.metric === 'net' ? income - expense : expense;
        periods.push({
          label: period.label,
          from: period.from as CalendarDate,
          to: period.to as CalendarDate,
          amount: String(amount),
          drill: {
            from: period.from as CalendarDate,
            to: period.to as CalendarDate,
            ...(ids.length ? { categoryIds: ids } : {}),
            ...(p.payee ? { q: `"${p.payee.replace(/"/g, '')}"` } : {}),
          },
        });
      }
      const first = p.periods[0]!;
      const { rows: txns } = await sql<{
        id: string;
        d: string;
        payee: string | null;
        description: string;
        amount: string | null;
        currency: string | null;
      }>`
        select distinct on (t.txn_date, t.id) t.id, t.txn_date::text as d, t.payee_raw as payee, t.description,
               t.spec->>'amount' as amount, t.spec->>'currency' as currency
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
         where p.workspace_id = ${ctx.workspaceId} and p.entry_date between ${first.from} and ${first.to}
           and t.deleted_at is null
           and ${p.metric === 'income' ? sql`a.type = 'income'` : p.metric === 'net' ? sql`a.type in ('income', 'expense')` : sql`a.type = 'expense'`}
           ${categoryFilter} ${payeeFilter}
         order by t.txn_date desc, t.id desc limit ${ASK_TRANSACTIONS}`.execute(trx);
      return {
        question,
        understood: true,
        metric: p.metric,
        categories: plan.categories
          .filter((c) => ids.includes(c.id))
          .map((c) => c.name)
          .filter((n, i, all) => all.indexOf(n) === i),
        payee: p.payee,
        currency: asCurrencyCode(base),
        periods,
        transactions: txns.map((t) => ({
          id: t.id,
          date: calendarDate(t.d),
          payee: t.payee,
          description: t.description,
          amount: t.amount,
          currency: t.currency ? asCurrencyCode(t.currency) : null,
          matchedNote: null,
        })),
      };
    });
  }
}
