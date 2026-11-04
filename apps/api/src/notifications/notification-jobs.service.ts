/**
 * What gets a notification (NOT-01, NOT-02). Runs after a workspace's nightly planning, once for each member and under their RLS, so
 * nobody hears about books they can't see. Each part is its own transaction, and one failing doesn't stop the rest.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import {
  addDays,
  asCurrencyCode,
  daysBetween,
  formatMoney,
  localClock,
  money,
  type CalendarDate,
} from '@montra/domain';
import { Db } from '../db/database.js';
import { Worker, type Job } from '../jobs/queue.js';
import { FlowService } from '../planning/flow.service.js';
import { RentService } from '../rentals/rent.service.js';
import { RentalOpsService } from '../rentals/rental-ops.service.js';
import { rentalEntities } from '../rentals/shared.js';
import { NotificationsService, type NewNotification } from './notifications.service.js';

type Ctx = { workspaceId: string; userId: string };

const BILL_DAYS = 3;
const LARGE_LOOKBACK_DAYS = 2;
const RECENT_RECOMMENDATION_DAYS = 2;
const DELIVER_EVERY_MS = 5 * 60_000;

@Injectable()
export class NotificationJobs {
  private readonly logger = new Logger('NotificationJobs');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(RentService) private readonly rent: RentService,
    @Inject(RentalOpsService) private readonly ops: RentalOpsService,
  ) {}

  register(): void {
    this.worker.register('notifications.deliver', async (_job: Job) => {
      await this.schedule(new Date(Date.now() + DELIVER_EVERY_MS));
      return { sent: await this.notifications.deliverWaiting() };
    });
  }

  /** Keeps one delivery run queued. */
  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'notifications.deliver', ${at})`.execute(trx),
    );
  }

  /** Writes what's new for every member of a workspace. Delivery follows on its own schedule. */
  async nightly(workspaceId: string, now = new Date()): Promise<{ created: number }> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{
        user_id: string;
      }>`select user_id from app.workspace_active_members(${workspaceId}::uuid)`.execute(trx),
    );
    let created = 0;
    for (const m of rows) created += await this.forMember({ workspaceId, userId: m.user_id }, now);
    return { created };
  }

  async forMember(ctx: Ctx, now = new Date()): Promise<number> {
    const base = `/w/${ctx.workspaceId}`;
    const { prefs, today, weekday } = await this.db.run(ctx, async (trx) => {
      const p = await this.notifications.prefsIn(trx, ctx.userId);
      const clock = localClock(now, p.timeZone);
      return { prefs: p, today: clock.date as CalendarDate, weekday: clock.weekday };
    });
    const parts: (() => Promise<NewNotification[]>)[] = [
      () => this.bills(ctx, base, today),
      () => this.lowBalance(ctx, base, prefs.lowBalanceDays),
      () => this.overspending(ctx, base, today),
      () => this.large(ctx, base, today, prefs.largeTransaction),
      () => this.rentals(ctx, base, today),
      () => this.importReminder(ctx, base, today, prefs.importReminderDays),
      () => this.recommendations(ctx, base, today),
      ...(weekday === prefs.digestWeekday ? [() => this.digest(ctx, base, today)] : []),
    ];
    let created = 0;
    for (const part of parts) {
      try {
        const list = await part();
        if (list.length === 0) continue;
        created += await this.db.run(ctx, async (trx) => {
          let n = 0;
          for (const item of list) if (await this.notifications.create(trx, ctx, item, prefs, now)) n++;
          return n;
        });
      } catch (e) {
        this.logger.warn(`A notification check failed for ${ctx.workspaceId}: ${(e as Error).message}`);
      }
    }
    return created;
  }

  private async bills(ctx: Ctx, base: string, today: CalendarDate): Promise<NewNotification[]> {
    const { items } = await this.flow.calendar(ctx, today, addDays(today, BILL_DAYS));
    return items
      .filter((i) => ['bill', 'card_due', 'mortgage'].includes(i.kind) && BigInt(i.amount) < 0n)
      .map((i) => ({
        type: 'bill_due' as const,
        dedupeKey: `bill_due:${i.sourceId}:${i.date}`,
        title: `${i.name} is due ${i.date === today ? 'today' : `on ${i.date}`}`,
        link: `${base}/calendar`,
      }));
  }

  private async lowBalance(ctx: Ctx, base: string, days: number): Promise<NewNotification[]> {
    const { accounts } = await this.flow.forecast(ctx, days);
    return accounts.flatMap((a) =>
      a.kind === 'cash' && a.lowBalance
        ? [
            {
              type: 'low_balance' as const,
              dedupeKey: `low_balance:${a.accountId}:${a.lowBalance.date}`,
              title: `${a.name} is forecast to run low by ${a.lowBalance.date}`,
              link: `${base}/cash-flow`,
            },
          ]
        : [],
    );
  }

  private async overspending(ctx: Ctx, base: string, today: CalendarDate): Promise<NewNotification[]> {
    const entities = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.budget as b')
        .select('b.entity_id')
        .distinct()
        .where('b.workspace_id', '=', ctx.workspaceId)
        .where('b.member_id', 'is', null)
        .execute(),
    );
    const out: NewNotification[] = [];
    for (const e of entities) {
      const d = await this.flow.dashboard(ctx, { entityId: e.entity_id });
      for (const p of d.pace) {
        if (p.pace.status !== 'over') continue;
        out.push({
          type: 'overspend_pace',
          dedupeKey: `overspend_pace:${p.categoryId}:${today.slice(0, 7)}`,
          title: `${p.name} is running over budget this month`,
          link: `${base}/budget`,
        });
      }
    }
    return out;
  }

  private async large(
    ctx: Ctx,
    base: string,
    today: CalendarDate,
    threshold: bigint,
  ): Promise<NewNotification[]> {
    if (threshold <= 0n) return [];
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<{ id: string; payee: string | null; description: string }>`
        select t.id, t.payee_raw as payee, t.description
          from app.transaction t
         where t.workspace_id = ${ctx.workspaceId} and t.deleted_at is null and t.status = 'posted'
           and t.spec->>'type' = 'standard' and t.txn_date >= ${addDays(today, -LARGE_LOOKBACK_DAYS)}
           and abs((t.spec->>'amount')::bigint) >= ${String(threshold)}::bigint
         order by t.txn_date desc limit 20`.execute(trx),
    );
    return rows.map((t) => ({
      type: 'large_transaction' as const,
      dedupeKey: `large_transaction:${t.id}`,
      title: `Large transaction: ${t.payee || t.description || 'no payee'}`,
      link: `${base}/transactions/${t.id}`,
    }));
  }

  private async rentals(ctx: Ctx, base: string, today: CalendarDate): Promise<NewNotification[]> {
    const portfolios = await this.db.run(ctx, (trx) => rentalEntities(trx, ctx));
    const out: NewNotification[] = [];
    for (const e of portfolios) {
      const here = `${base}/rentals/${e.id}`;
      const arrears = await this.rent.arrears(ctx, e.id);
      for (const r of arrears.rows) {
        out.push({
          type: 'rent_overdue',
          dedupeKey: `rent_overdue:${r.leaseId}:${r.oldestDue}`,
          title: `Rent is overdue: ${r.propertyName} · ${r.unitLabel}`,
          link: `${here}/arrears`,
        });
      }
      for (const r of await this.ops.reminders(ctx, e.id)) {
        if (!r.active) continue;
        if (r.kind === 'lease_end') {
          // Twice: at 60 days and again at 30 (RNT-12).
          const window = daysBetween(today, r.dueDate) <= 30 ? 30 : 60;
          out.push({
            type: 'lease_expiring',
            dedupeKey: `lease_expiring:${r.leaseId}:${r.dueDate}:${window}`,
            title: `Lease ends ${r.dueDate}: ${r.title}`,
            link: `${here}/leases/${r.leaseId}`,
          });
        } else {
          out.push({
            type: 'reminder',
            dedupeKey: `reminder:${r.id}:${r.dueDate}`,
            title: `${r.title} is due ${r.dueDate}`,
            link: `${here}/reminders`,
          });
        }
      }
    }
    return out;
  }

  private async importReminder(
    ctx: Ctx,
    base: string,
    today: CalendarDate,
    days: number,
  ): Promise<NewNotification[]> {
    const last = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.import_batch')
        .select((eb) => eb.fn.max('committed_at').as('at'))
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst(),
    );
    if (!last?.at) return [];
    const lastDate = last.at.toISOString().slice(0, 10) as CalendarDate;
    const since = daysBetween(lastDate, today);
    if (since < days) return [];
    return [
      {
        type: 'import_reminder',
        // Once for each import that's gone quiet, not nightly.
        dedupeKey: `import_reminder:${lastDate}`,
        title: `Your last import was ${since} days ago`,
        link: `${base}/imports`,
      },
    ];
  }

  private async recommendations(ctx: Ctx, base: string, today: CalendarDate): Promise<NewNotification[]> {
    const rows = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.recommendation')
        .select(['id', 'type', 'payload', 'period_start'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'open')
        .where(
          'created_at',
          '>=',
          new Date(Date.parse(`${addDays(today, -RECENT_RECOMMENDATION_DAYS)}T00:00:00Z`)),
        )
        .execute(),
    );
    const out: NewNotification[] = [];
    let other = false;
    for (const r of rows) {
      const payload = r.payload as { title?: string; kind?: string };
      if (r.type === 'BIZ-09' || r.type === 'REC-09') {
        out.push({
          type: 'tax_due',
          dedupeKey: `tax_due:${r.id}`,
          title: payload.title ?? 'A tax date is coming up',
          link: `${base}/suggestions`,
        });
      } else if (r.type === 'REC-07' || r.type === 'BIZ-11') {
        out.push({
          type: 'monthly_review',
          dedupeKey: `monthly_review:${r.id}`,
          title: payload.title ?? 'Your monthly review is ready',
          link: `${base}/suggestions`,
        });
      } else {
        other = true;
      }
    }
    // At most one a day for the rest, however many there are (04 §12).
    if (other) {
      out.push({
        type: 'suggestion',
        dedupeKey: `suggestion:${today}`,
        title: 'You have new suggestions',
        link: `${base}/suggestions`,
      });
    }
    return out;
  }

  /** NOT-02: last week's spending, how the budget stands, and what's waiting for review. */
  private async digest(ctx: Ctx, base: string, today: CalendarDate): Promise<NewNotification[]> {
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const from = addDays(today, -7);
      const to = addDays(today, -1);
      const { rows } = await sql<{ amount: string }>`
        select coalesce(sum(p.functional_amount_minor), 0)::text as amount
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
         where p.workspace_id = ${ctx.workspaceId} and a.type = 'expense'
           and e.functional_currency = ${ws.base_currency}
           and p.entry_date between ${from} and ${to}`.execute(trx);
      const review = await trx
        .selectFrom('app.transaction')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('review_state', '=', 'needs_review')
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      const currency = asCurrencyCode(ws.base_currency);
      const spent = formatMoney(money(BigInt(rows[0]?.amount ?? '0'), currency), { locale: 'en-US' });
      const waiting = Number(review.n);
      return [
        {
          type: 'weekly_digest' as const,
          dedupeKey: `weekly_digest:${today}`,
          title: 'Your week in Montra',
          // The one place figures go in an email, and this type can be turned off (ADR-0019 §5).
          body: [
            `You spent ${spent} from ${from} to ${to}.`,
            waiting
              ? `${waiting} ${waiting === 1 ? 'transaction is' : 'transactions are'} waiting for review.`
              : 'Nothing is waiting for review.',
            'See how your budget stands in the app.',
          ].join('\n'),
          link: base,
        },
      ];
    });
  }
}
