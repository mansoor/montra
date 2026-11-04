/**
 * What runs for a business without being asked (ADR-0017): linking payments that are unambiguous, flagging spending on
 * the wrong side of business and personal (BIZ-03), and the tax and margin notes (REC-09, BIZ-09, BIZ-11). All of it only
 * suggests, except a link so clear it can't reasonably be wrong, and the user can undo that.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  addDays,
  autoMatch,
  BILL_MATCH_DAYS,
  calendarDate,
  endOfMonth,
  INVOICE_MATCH_DAYS_AFTER,
  marginBps,
  startOfMonth,
  type CalendarDate,
  type OpenItem,
  type PaymentCandidate,
} from '@montra/domain';
import { AiService } from '../ai/ai.service.js';
import { Db } from '../db/database.js';
import { wordSummary } from '../planning/wording.js';
import { BillsService } from './bills.service.js';
import { BusinessReportsService } from './business-reports.service.js';
import { BusinessService } from './business.service.js';
import { InvoicesService } from './invoices.service.js';
import { NOT_OWNED } from '../transactions/poster.js';
import { businessEntities, profitBetween, todayOf, type BusinessEntity, type Ctx } from './shared.js';

/** Flags interrupt the user: look only at what's recent, and only at so many a night. */
const SEPARATION_DAYS = 30;
const SEPARATION_MAX = 100;
/** The same payee filed on the other side this often means the user files it there. */
const SEPARATION_HISTORY = 2;
/** Reminded this long before an estimated-tax date. */
const TAX_REMINDER_DAYS = 14;

interface Note {
  type: 'REC-09' | 'BIZ-09' | 'BIZ-11';
  dedupeKey: string;
  periodStart: CalendarDate;
  title: string;
  figures: Record<string, string>;
  money: string[];
  actions: unknown[];
  kind?: 'recommendation' | 'monthly_review';
}

@Injectable()
export class BusinessJobs {
  private readonly logger = new Logger('Business');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(BusinessService) private readonly business: BusinessService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(BillsService) private readonly bills: BillsService,
    @Inject(BusinessReportsService) private readonly reports: BusinessReportsService,
  ) {}

  /** The nightly run for one workspace. A failure in one part doesn't stop the rest. */
  async nightly(ctx: Ctx): Promise<{ linked: number; flagged: number; notes: number }> {
    const out = { linked: 0, flagged: 0, notes: 0 };
    for (const [key, fn] of [
      ['linked', () => this.matchPayments(ctx)],
      ['flagged', () => this.flagSeparation(ctx)],
      ['notes', () => this.notes(ctx)],
    ] as const) {
      try {
        out[key] = await fn();
      } catch (e) {
        this.logger.warn(`${key} failed for ${ctx.workspaceId}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  // ----- Matching payments (BIZ-05, BIZ-06) ----------------------------------------------------------------

  /**
   * Links what's unambiguous. Only lines in the business's own accounts: on a shared personal account, one deposit that
   * happens to equal an invoice isn't evidence enough, so those are offered on the invoice instead.
   */
  async matchPayments(ctx: Ctx): Promise<number> {
    const plan = await this.db.run(ctx, async (trx) => {
      const out: { kind: 'invoice' | 'bill'; itemId: string; paymentId: string }[] = [];
      for (const e of await businessEntities(trx, ctx)) {
        const invoices = await this.invoices.openInvoices(trx, ctx, e.id);
        if (invoices.length) {
          const items: OpenItem[] = invoices.map((i) => ({
            id: i.id,
            open: i.open,
            from: i.issueDate,
            to: addDays(i.issueDate, INVOICE_MATCH_DAYS_AFTER),
            reference: i.number,
          }));
          const lines = await this.paymentLines(trx, ctx, e.id, 1, items);
          for (const l of autoMatch(items, lines)) out.push({ kind: 'invoice', ...l });
        }
        const bills = await this.bills.openBills(trx, ctx, e.id);
        if (bills.length) {
          const items: OpenItem[] = bills.map((b) => ({
            id: b.id,
            open: b.amount,
            from: addDays(b.dueDate, -BILL_MATCH_DAYS),
            to: addDays(b.dueDate, BILL_MATCH_DAYS),
            reference: b.reference && b.reference.length >= 4 ? b.reference : null,
          }));
          const lines = await this.paymentLines(trx, ctx, e.id, -1, items);
          // Partly paying a bill is outside R1: a quoted reference still has to be the exact amount.
          const exact = autoMatch(items, lines).filter(
            (l) =>
              lines.find((p) => p.id === l.paymentId)!.amount === items.find((i) => i.id === l.itemId)!.open,
          );
          for (const l of exact) out.push({ kind: 'bill', ...l });
        }
      }
      return out;
    });
    let linked = 0;
    for (const p of plan) {
      // Each in its own transaction: one that can't be linked (a locked period, say) leaves the others.
      try {
        await this.db.run(ctx, async (trx) => {
          const payment = { transactionId: p.paymentId };
          if (p.kind === 'invoice') await this.invoices.recordPaymentIn(trx, ctx, p.itemId, payment, 'auto');
          else await this.bills.payIn(trx, ctx, p.itemId, payment, 'auto');
        });
        linked++;
      } catch (e) {
        this.logger.warn(`Could not link ${p.kind} ${p.itemId}: ${(e as Error).message}`);
      }
    }
    return linked;
  }

  private async paymentLines(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    sign: 1 | -1,
    items: OpenItem[],
  ): Promise<PaymentCandidate[]> {
    const from = items.reduce((m, i) => (i.from < m ? i.from : m), items[0]!.from);
    const to = items.reduce((m, i) => (i.to > m ? i.to : m), items[0]!.to);
    const { rows } = await sql<{ id: string; d: string; amount: string; text: string }>`
      select t.id, t.txn_date::text as d, abs((t.spec->>'amount')::bigint)::text as amount,
             concat_ws(' ', t.payee_raw, t.description, t.raw_description) as text
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${entityId}
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and (t.spec->>'amount')::bigint * ${sign}::bigint > 0
         and t.txn_date between ${from} and ${to}
         and ${NOT_OWNED}
       order by t.txn_date, t.id
       limit 2000`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      date: calendarDate(r.d),
      amount: BigInt(r.amount),
      text: r.text,
    }));
  }

  // ----- Business and personal separation (BIZ-03) -----------------------------------------------------------

  /**
   * First what the user's own filing shows: a payee they've filed on the other side before. Then AI, when it's on, for
   * the rest. Stored on the business, so a partner with no access to it doesn't see a flag naming its categories.
   */
  async flagSeparation(ctx: Ctx): Promise<number> {
    return this.db.run(ctx, async (trx) => {
      const businesses = await businessEntities(trx, ctx);
      if (businesses.length === 0) return 0;
      let flagged = 0;
      for (const b of businesses) flagged += await this.flagFor(trx, ctx, b);
      return flagged;
    });
  }

  private async flagFor(trx: Trx, ctx: Ctx, b: BusinessEntity): Promise<number> {
    const personal = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', '=', 'personal')
      .executeTakeFirst();
    if (!personal) return 0;
    const since = addDays(todayOf(b), -SEPARATION_DAYS);
    const { rows: items } = await sql<{
      id: string;
      entity_id: string;
      payee: string;
      payee_key: string | null;
      amount: string;
      currency: string;
      category_id: string;
      category: string;
    }>`
      select t.id, t.primary_entity_id as entity_id, coalesce(t.payee_raw, t.description) as payee, t.payee_key,
             t.spec->>'amount' as amount, t.spec->>'currency' as currency,
             a.id as category_id, a.name as category
        from app.transaction t
        join lateral (select (t.spec->'splits'->0->>'accountId')::uuid as id) s on true
        join app.ledger_account a on a.workspace_id = t.workspace_id and a.id = s.id
       where t.workspace_id = ${ctx.workspaceId}
         and t.primary_entity_id in (${personal.id}, ${b.id})
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and (t.spec->>'amount')::bigint < 0 and jsonb_array_length(t.spec->'splits') = 1
         and t.txn_date >= ${since} and a.is_category and a.system_role is null
         and ${NOT_OWNED}
         and not exists (select 1 from app.insight i where i.workspace_id = t.workspace_id
                          and i.dedupe_key = 'separation:' || t.id::text)
       order by t.txn_date desc, t.id
       limit ${SEPARATION_MAX}`.execute(trx);
    if (items.length === 0) return 0;

    const categories = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'name', 'entity_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', 'in', [personal.id, b.id])
      .where('type', '=', 'expense')
      .where('is_category', '=', true)
      .where('system_role', 'is', null)
      .where('archived_at', 'is', null)
      .execute();
    const on = (entityId: string) => categories.filter((c) => c.entity_id === entityId);
    let flagged = 0;
    const store = async (
      item: (typeof items)[number],
      target: { id: string; name: string },
      reason: string,
      confidence: number,
    ) => {
      const side = item.entity_id === b.id ? 'business' : 'personal';
      const res = await trx
        .insertInto('app.insight')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          kind: 'separation',
          entity_id: b.id,
          transaction_id: item.id,
          payee_key: item.payee_key,
          dedupe_key: `separation:${item.id}`,
          data: JSON.stringify({
            payee: item.payee,
            message: reason,
            side,
            amount: item.amount,
            currency: item.currency,
            categoryId: target.id,
            category: target.name,
            confidence,
          }),
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'dedupe_key']).doNothing())
        .executeTakeFirst();
      if (res.numInsertedOrUpdatedRows) flagged++;
    };

    // The user's own habit first: it costs nothing and works with AI off.
    const keys = [...new Set(items.map((i) => i.payee_key).filter((k): k is string => !!k))];
    const { rows: history } = keys.length
      ? await sql<{ key: string; entity_id: string; category_id: string; name: string; n: number }>`
          select t.payee_key as key, a.entity_id, a.id as category_id, a.name, count(*)::int as n
            from app.transaction t
            join lateral (select (t.spec->'splits'->0->>'accountId')::uuid as id) s on true
            join app.ledger_account a on a.workspace_id = t.workspace_id and a.id = s.id
           where t.workspace_id = ${ctx.workspaceId} and t.status = 'posted' and t.deleted_at is null
             and t.spec->>'type' = 'standard' and a.is_category and a.system_role is null
             and a.entity_id in (${personal.id}, ${b.id})
             and t.payee_key = any(${keys}::text[])
           group by t.payee_key, a.entity_id, a.id, a.name
          having count(*) >= ${SEPARATION_HISTORY}
           order by n desc`.execute(trx)
      : { rows: [] };
    const remaining: typeof items = [];
    for (const item of items) {
      const other = item.entity_id === b.id ? personal.id : b.id;
      const hit = history.find((h) => h.key === item.payee_key && h.entity_id === other);
      if (hit) {
        await store(
          item,
          { id: hit.category_id, name: hit.name },
          `You've usually filed ${item.payee} under ${hit.name}.`,
          0.95,
        );
      } else remaining.push(item);
    }

    const runtime = await this.ai.runtime(trx, ctx, { type: 'business', id: b.id });
    if (!runtime.available || remaining.length === 0) return flagged;
    const res = await this.ai.gateway.flagSeparation(
      {
        items: remaining.map((i) => ({
          id: i.id,
          payee: i.payee,
          amountMinor: BigInt(i.amount),
          currency: i.currency,
          category: i.category,
          side: i.entity_id === b.id ? ('business' as const) : ('personal' as const),
        })),
        personalCategories: on(personal.id).map((c) => c.name),
        businessCategories: on(b.id).map((c) => c.name),
      },
      { ...runtime.ctx, parkLocal: false },
    );
    if (!res.ok) return flagged;
    for (const f of res.value) {
      const item = remaining.find((i) => i.id === f.id);
      if (!item) continue;
      const other = item.entity_id === b.id ? personal.id : b.id;
      const target = on(other).find((c) => c.name === f.category);
      if (target) await store(item, target, f.reason, f.confidence);
    }
    return flagged;
  }

  // ----- Notes: tax set-aside, due dates, margin (REC-09, BIZ-09, BIZ-11) --------------------------------------

  async notes(ctx: Ctx): Promise<number> {
    return this.db.run(ctx, async (trx) => {
      let created = 0;
      for (const e of await businessEntities(trx, ctx)) {
        for (const n of await this.notesFor(trx, ctx, e)) {
          if (await this.store(trx, ctx, e, n)) created++;
        }
      }
      return created;
    });
  }

  private async notesFor(trx: Trx, ctx: Ctx, e: BusinessEntity): Promise<Note[]> {
    const notes: Note[] = [];
    const today = todayOf(e);
    const month = startOfMonth(today);
    const profile = await this.business.readProfile(trx, ctx, e.id);
    const estimate = await this.reports.taxEstimateIn(trx, ctx, e.id);
    const toSetAside = BigInt(estimate.toSetAside);

    if (profile.tax_rate_bps !== null && toSetAside > 0n) {
      const { revenue } = await profitBetween(trx, ctx, e.id, month, today);
      if (revenue > 0n) {
        const from = profile.default_deposit_account_id;
        const to = profile.tax_savings_account_id;
        notes.push({
          type: 'REC-09',
          dedupeKey: `REC-09:${e.id}:${month}`,
          periodStart: month,
          title: `Set aside for ${e.name}'s taxes`,
          figures: {
            profitSoFarThisYear: estimate.ytdProfit,
            setAsideTargetAtYourRate: estimate.target,
            alreadySetAside: estimate.saved,
            stillToSetAside: String(toSetAside),
          },
          money: ['profitSoFarThisYear', 'setAsideTargetAtYourRate', 'alreadySetAside', 'stillToSetAside'],
          actions:
            from && to && from !== to
              ? [{ kind: 'transfer', fromAccountId: from, toAccountId: to, amount: String(toSetAside) }]
              : [],
        });
      }
    }

    const next = estimate.periods.find((p) => p.status === 'next');
    if (
      next &&
      next.due >= today &&
      next.due <= addDays(today, TAX_REMINDER_DAYS) &&
      BigInt(next.profit) > 0n
    ) {
      notes.push({
        type: 'BIZ-09',
        dedupeKey: `BIZ-09:${e.id}:${next.due}`,
        periodStart: month,
        title: `Estimated tax is due ${next.due}`,
        figures: {
          profitForThisPayment: next.profit,
          ...(profile.tax_rate_bps !== null ? { setAsideTargetAtYourRate: next.target } : {}),
        },
        money: ['profitForThisPayment', 'setAsideTargetAtYourRate'],
        actions: [],
      });
    }

    // Last month's margin against the month before, once there's a month to talk about.
    const lastStart = startOfMonth(addDays(month, -1));
    const prevStart = startOfMonth(addDays(lastStart, -1));
    const last = await profitBetween(trx, ctx, e.id, lastStart, endOfMonth(lastStart));
    const prev = await profitBetween(trx, ctx, e.id, prevStart, endOfMonth(prevStart));
    const lastMargin = marginBps(last.revenue, last.expenses);
    const prevMargin = marginBps(prev.revenue, prev.expenses);
    if (lastMargin !== null) {
      const percent = (bps: number) => `${(bps / 100).toFixed(1)}%`;
      notes.push({
        type: 'BIZ-11',
        kind: 'monthly_review',
        dedupeKey: `BIZ-11:${e.id}:${lastStart}`,
        periodStart: month,
        title: `${e.name}'s margin last month`,
        figures: {
          revenueLastMonth: String(last.revenue),
          expensesLastMonth: String(last.expenses),
          marginLastMonth: percent(lastMargin),
          ...(prevMargin !== null ? { marginTheMonthBefore: percent(prevMargin) } : {}),
        },
        money: ['revenueLastMonth', 'expensesLastMonth'],
        actions: [],
      });
    }
    return notes;
  }

  private async store(trx: Trx, ctx: Ctx, e: BusinessEntity, n: Note): Promise<boolean> {
    const row = await trx
      .insertInto('app.recommendation')
      .values({
        workspace_id: ctx.workspaceId,
        entity_id: e.id,
        budget_id: null,
        type: n.type,
        period_start: n.periodStart,
        dedupe_key: n.dedupeKey,
        payload: JSON.stringify({
          currency: e.currency,
          figures: n.figures,
          subjects: [],
          actions: n.actions,
          review: null,
          title: n.title,
          money: n.money,
        }),
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'dedupe_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) return false;
    try {
      const wording = await wordSummary(this.ai, trx, ctx, e.currency, {
        kind: n.kind ?? 'recommendation',
        title: n.title,
        figures: n.figures,
        money: n.money.filter((k) => k in n.figures),
        names: [e.name],
      });
      if (wording) {
        await trx
          .updateTable('app.recommendation')
          .set({ wording })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', row.id)
          .execute();
      }
    } catch (err) {
      this.logger.warn(`Wording failed for ${n.dedupeKey}: ${(err as Error).message}`);
    }
    return true;
  }
}
