import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { addDays, calendarDate, formatMoney, money, type CalendarDate } from '@montra/domain';
import { detectAnomalies, detectRecurring, type HistoryTxn, type PayeeSeries } from '@montra/categorize';
import type { AcceptInsightRequest, InsightDto } from '@montra/schemas';
import { Db } from '../db/database.js';
import { notFound, unprocessable } from '../common/errors.js';
import { Worker, type Job } from '../jobs/queue.js';
import { RecurringService } from '../recurring/recurring.service.js';

type Ctx = { workspaceId: string; userId: string };

const LOOKBACK_DAYS = 400;
const RECENT_DAYS = 45;

/** Recurring proposals (AI-08) and anomaly flags (AI-09). All numbers are computed in code (AIA-05). */
@Injectable()
export class InsightsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(RecurringService) private readonly recurring: RecurringService,
  ) {}

  register(): void {
    this.worker.register('insights.detect', async (job: Job) => {
      if (!job.workspace_id || !job.created_by) throw new Error('Job without workspace or user');
      const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
      const today = calendarDate(new Date().toISOString().slice(0, 10));
      return this.db.run({ ...ctx, actorType: 'worker' }, (trx) => this.detect(trx, ctx, today));
    });
  }

  async detect(trx: Trx, ctx: Ctx, today: CalendarDate): Promise<{ created: number }> {
    const from = addDays(today, -LOOKBACK_DAYS);
    const rows = await sql<{
      id: string;
      txn_date: string;
      payee_key: string;
      payee: string | null;
      account_id: string;
      entity_id: string;
      amount: string;
      currency: string;
      category_id: string | null;
      created_at: Date;
    }>`
      select t.id, t.txn_date::text, t.payee_key, coalesce(t.payee_raw, t.description) as payee,
             t.spec->>'accountId' as account_id, t.primary_entity_id as entity_id,
             t.spec->>'amount' as amount, t.spec->>'currency' as currency,
             case when jsonb_array_length(t.spec->'splits') = 1 and not (t.spec->>'uncategorized')::boolean
                  then t.spec->'splits'->0->>'accountId' end as category_id,
             t.created_at
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId} and t.status = 'posted' and t.deleted_at is null
         and t.spec->>'type' = 'standard' and t.payee_key is not null
         and t.txn_date >= ${from}
       order by t.txn_date`.execute(trx);
    const series = new Map<string, PayeeSeries & { txns: HistoryTxn[] }>();
    for (const r of rows.rows) {
      const k = `${r.account_id}|${r.payee_key}`;
      const s = series.get(k) ?? {
        payeeKey: r.payee_key,
        payee: r.payee ?? r.payee_key,
        accountId: r.account_id,
        entityId: r.entity_id,
        categoryId: r.category_id,
        txns: [],
      };
      s.txns.push({ id: r.id, date: calendarDate(r.txn_date), amountMinor: BigInt(r.amount), accountId: r.account_id });
      if (r.category_id) s.categoryId = r.category_id;
      series.set(k, s);
    }
    const proposals = detectRecurring([...series.values()], today);

    // Payees already covered by a recurring template on the same account are not proposed again.
    const templates = await trx
      .selectFrom('app.recurring_item')
      .select(['name', 'spec'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '<>', 'ended')
      .execute();
    const covered = new Set(
      templates.flatMap((t) => {
        const spec = t.spec as { payee?: string | null; accountId?: string };
        return [t.name, spec.payee ?? ''].filter(Boolean).map((n) => `${spec.accountId}|${n.toUpperCase()}`);
      }),
    );

    const currencyOf = new Map(rows.rows.map((r) => [r.id, r.currency]));
    const entityOf = new Map(rows.rows.map((r) => [r.id, r.entity_id]));
    const recentFrom = addDays(today, -RECENT_DAYS);
    const recent = rows.rows.filter((r) => r.txn_date >= recentFrom);
    const anomalies = detectAnomalies({
      txns: recent.map((r) => ({
        id: r.id,
        date: calendarDate(r.txn_date),
        amountMinor: BigInt(r.amount),
        accountId: r.account_id,
        payeeKey: r.payee_key,
        payee: r.payee ?? r.payee_key,
        currency: r.currency,
      })),
      history: (key) =>
        rows.rows
          .filter((r) => r.payee_key === key)
          .map((r) => ({
            id: r.id,
            date: calendarDate(r.txn_date),
            amountMinor: BigInt(r.amount),
            accountId: r.account_id,
          })),
      recurring: proposals,
      today,
    });

    const values: Array<{
      kind: InsightDto['kind'];
      entity_id: string;
      transaction_id: string | null;
      payee_key: string;
      dedupe_key: string;
      data: string;
    }> = [];
    for (const p of proposals) {
      if (covered.has(`${p.accountId}|${p.payee.toUpperCase()}`)) continue;
      const currency = currencyOf.get(series.get(`${p.accountId}|${p.payeeKey}`)!.txns.at(-1)!.id) ?? 'USD';
      values.push({
        kind: 'recurring',
        entity_id: p.entityId,
        transaction_id: null,
        payee_key: p.payeeKey,
        dedupe_key: `recurring:${p.accountId}:${p.payeeKey}`,
        data: JSON.stringify({
          payee: p.payee,
          accountId: p.accountId,
          categoryId: p.categoryId,
          cadence: p.cadence,
          amountKind: p.amountKind,
          amount: p.amountMinor.toString(),
          currency,
          nextDate: p.nextDate,
          lastDate: p.lastDate,
          occurrences: p.occurrences,
          message: `${p.payee} looks like a ${p.cadence} ${p.amountKind === 'fixed' ? 'payment' : 'bill'} of about ${formatMoney(money(p.amountMinor < 0n ? -p.amountMinor : p.amountMinor, currency))} (${p.occurrences} times). Next around ${p.nextDate}.`,
        }),
      });
    }
    for (const a of anomalies) {
      const entityId = entityOf.get(a.transactionId);
      if (!entityId) continue;
      values.push({
        kind: a.kind,
        entity_id: entityId,
        transaction_id: a.transactionId,
        payee_key: a.payeeKey,
        dedupe_key: a.dedupeKey,
        data: JSON.stringify({ ...a.data, message: a.message }),
      });
    }
    let created = 0;
    for (let i = 0; i < values.length; i += 500) {
      const res = await trx
        .insertInto('app.insight')
        .values(values.slice(i, i + 500).map((v) => ({ workspace_id: ctx.workspaceId, ...v })))
        .onConflict((oc) => oc.columns(['workspace_id', 'dedupe_key']).doNothing())
        .executeTakeFirst();
      created += Number(res.numInsertedOrUpdatedRows ?? 0n);
    }
    return { created };
  }

  async list(trx: Trx, ctx: Ctx, status: 'open' | 'dismissed' | 'accepted' = 'open'): Promise<InsightDto[]> {
    const rows = await trx
      .selectFrom('app.insight')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', status)
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map(toDto);
  }

  async dismiss(trx: Trx, ctx: Ctx, id: string): Promise<InsightDto> {
    const r = await trx
      .updateTable('app.insight')
      .set({ status: 'dismissed' })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!r) throw notFound('Insight');
    return toDto(r);
  }

  /** Accepting a recurring proposal creates the template (UP-14); other kinds are simply acknowledged. */
  async accept(ctx: Ctx, id: string, req: AcceptInsightRequest): Promise<InsightDto> {
    const insight = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.insight')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!insight) throw notFound('Insight');
    if (insight.status !== 'open') throw unprocessable('insight.closed', `The insight is ${insight.status}`);
    if (insight.kind === 'recurring') {
      const d = insight.data as {
        payee: string;
        accountId: string;
        categoryId: string | null;
        cadence: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly';
        amount: string;
        currency: string;
        nextDate: string;
      };
      const categoryId = req.categoryId ?? d.categoryId;
      if (!categoryId)
        throw unprocessable('insight.category_required', 'Choose a category for the recurring template');
      await this.recurring.create(ctx, {
        name: req.name ?? d.payee,
        accountId: d.accountId,
        amount: { amount: d.amount, currency: d.currency as never },
        payee: d.payee,
        categoryId,
        cadence: d.cadence,
        startDate: calendarDate(d.nextDate),
        autoCreate: 'scheduled',
      });
    }
    return this.db.run(ctx, async (trx) =>
      toDto(
        await trx
          .updateTable('app.insight')
          .set({ status: 'accepted' })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow(),
      ),
    );
  }
}

function toDto(r: {
  id: string;
  kind: InsightDto['kind'];
  entity_id: string;
  transaction_id: string | null;
  data: unknown;
  status: InsightDto['status'];
  created_at: Date;
}): InsightDto {
  const data = (r.data ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    kind: r.kind,
    entityId: r.entity_id,
    transactionId: r.transaction_id,
    payee: typeof data.payee === 'string' ? data.payee : null,
    message: typeof data.message === 'string' ? data.message : '',
    data,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}
