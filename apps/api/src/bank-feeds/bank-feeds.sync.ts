/**
 * Syncing a bank feed (ADR-0055 §5; FEED-03, FEED-04, FEED-05, FEED-06's "posted only"). The `bankfeed.sync` job finds
 * feeds that are due (`app.bank_feed_due()`, acting as the owner who connected them), asks SimpleFIN once for every
 * linked account, and stages each account's new rows as an import batch that waits in Review. Clean batches commit
 * themselves in PR 3b; here every batch waits.
 *
 * - One request per sync, from the earliest any linked account needs (its cursor less SIMPLEFIN_OVERLAP_DAYS, never
 *   before its start date) to tomorrow, never longer than SIMPLEFIN_MAX_WINDOW_DAYS.
 * - Never more than SIMPLEFIN_REQUESTS_PER_DAY a UTC day: a feed at its limit waits for the next UTC day.
 * - Rows dated before the account's start date never import; pending rows never get this far (the parser drops them).
 * - The provider's id is each row's identity: ids already brought into the account (waiting, committed or discarded)
 *   are skipped, so the overlap never adds a row twice; an undone batch's come back.
 * - A failed sync waits as the outbox jobs do (1 minute up to a day) and turns the feed `failing` after five in a row;
 *   a revoked access or a payment problem stops it until a person acts.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { CalendarDate } from '@montra/domain';
import { newId, type Trx } from '@montra/db';
import { CONFIG, type AppConfig } from '../config.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { ImportJobs } from '../imports/import-jobs.js';
import { ImportsService } from '../imports/imports.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Worker } from '../jobs/queue.js';
import { backoffMs } from '../storage/backoff.js';
import { BANK_FEED_PROVIDER, BankFeedsService, FEED_SECRET_COLUMN, feedError } from './bank-feeds.service.js';
import {
  lastSyncDay,
  nextSyncAt,
  nextUtcDay,
  requestsLeft,
  simpleFinLimits,
  syncWindow,
  utcDay,
  type SimpleFinLimits,
} from './limits.js';
import { BankFeedError, type BankFeedProvider, type FeedSnapshot } from './provider.js';

type Ctx = { workspaceId: string; userId: string };

/** §5: a feed turns `failing` after this many failed syncs in a row (as the vault's connection, ADR-0054 §12). */
export const FEED_FAILING_AFTER = 5;
/** Runs are kept this long (§2). */
const RUN_DAYS = 90;
const RUN_BUDGET_MS = 2 * 60_000;
const MIN_GAP_MS = 30_000;

export interface SyncResult {
  outcome: 'ok' | 'partial' | 'held' | 'failed' | 'idle';
  batches: number;
  rows: number;
  /** Batches clean enough to import themselves (§5). */
  committed?: number;
}

/** §7: why a feed needs a person, in words for its owners, or null when it doesn't. Never amounts or transactions. */
export function attentionWords(status: string, reauth: readonly string[]): string | null {
  if (status === 'revoked')
    return 'SimpleFIN no longer accepts Montra’s access. Connect again with a new setup token in Settings → Bank feeds.';
  if (status === 'payment_required')
    return 'Your SimpleFIN Bridge subscription needs attention. Montra stopped syncing until it’s sorted out.';
  if (status === 'failing')
    return 'Montra hasn’t been able to sync your bank feed for a while. See Settings → Bank feeds for what went wrong.';
  const banks = [...new Set(reauth)];
  if (banks.length)
    return `${banks.join(', ')} ${banks.length === 1 ? 'needs' : 'need'} you to sign in again at SimpleFIN Bridge. Other banks keep syncing.`;
  return null;
}

/** "SimpleFIN · Checking …1234 · 2026-11-01 to 2026-11-20": a feed batch's name where a file's would be. */
export function feedBatchName(accountName: string, from: CalendarDate, to: CalendarDate): string {
  return `SimpleFIN · ${accountName.slice(0, 120)} · ${from === to ? from : `${from} to ${to}`}`;
}

@Injectable()
export class BankFeedSync {
  private readonly logger = new Logger('BankFeeds');
  private readonly limits: SimpleFinLimits;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(BANK_FEED_PROVIDER) private readonly provider: BankFeedProvider,
    @Inject(BankFeedsService) private readonly feeds: BankFeedsService,
    @Inject(ImportJobs) private readonly imports: ImportJobs,
    @Inject(ImportsService) private readonly importsService: ImportsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.limits = simpleFinLimits(config);
  }

  register(): void {
    this.worker.register('bankfeed.sync', async () => this.run());
  }

  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'bankfeed.sync', ${at})`.execute(trx),
    );
  }

  /** One pass over every feed that is due, then the next wake-up. */
  async run(budgetMs = RUN_BUDGET_MS): Promise<Record<string, unknown>> {
    const deadline = Date.now() + budgetMs;
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; bank_feed_id: string; user_id: string | null }>`
        select * from app.bank_feed_due()`.execute(trx),
    );
    let synced = 0;
    for (const r of rows) {
      if (!r.user_id || Date.now() > deadline) continue;
      const ctx = { workspaceId: r.workspace_id, userId: r.user_id };
      try {
        await this.sync(ctx, r.bank_feed_id);
        synced++;
      } catch (e) {
        // Never a code path that leaves the feed due at once: it would be picked up again in 30 seconds.
        this.logger.warn(`Bank feed ${r.bank_feed_id} failed: ${(e as Error).name}`);
        await this.failed(ctx, r.bank_feed_id, null, new BankFeedError('bad_response', 'sync'));
      }
    }
    const next = await this.db.run({}, (trx) =>
      sql<{ t: Date | null }>`select app.bank_feed_next() as t`.execute(trx),
    );
    const t = next.rows[0]?.t;
    const at = t ? new Date(t).getTime() : NaN;
    if (Number.isFinite(at)) await this.schedule(new Date(Math.max(at, Date.now() + MIN_GAP_MS)));
    return { synced };
  }

  /** §5: one feed's sync, acting as `ctx`'s owner; then owners are told if it now needs a person (§7). */
  async sync(ctx: Ctx, feedId: string, now: Date = new Date()): Promise<SyncResult> {
    try {
      return await this.syncOnce(ctx, feedId, now);
    } finally {
      await this.attention(ctx, feedId);
    }
  }

  private async syncOnce(ctx: Ctx, feedId: string, now: Date): Promise<SyncResult> {
    const worker = { ...ctx, actorType: 'worker' as const };
    const prep = await this.db.run(worker, async (trx) => {
      const feed = await trx
        .selectFrom('app.bank_feed')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .where('status', 'in', ['active', 'failing'])
        .forUpdate()
        .executeTakeFirst();
      if (!feed?.secret_enc) return null;
      const tz = (
        await trx
          .selectFrom('app.workspace')
          .select('time_zone')
          .where('id', '=', ctx.workspaceId)
          .executeTakeFirstOrThrow()
      ).time_zone;
      // The later of the workspace's day and UTC's: SimpleFIN dates rows in UTC (live run, 2026-11-20).
      const today = lastSyncDay(now, tz);
      const manual =
        feed.last_manual_sync_at !== null &&
        (feed.last_sync_at === null || feed.last_manual_sync_at > feed.last_sync_at);
      // Connecting lists the accounts (and sets last_success_at), but only a sync sets last_sync_at.
      const trigger = manual ? 'manual' : feed.last_sync_at === null ? 'first' : 'schedule';
      const accounts = await this.linked(trx, ctx, feedId);
      const window = syncWindow(
        accounts.map((a) => ({ startDate: a.start_date, syncedThrough: a.synced_through })),
        today,
        this.limits,
      );
      const scheduled = nextSyncAt(now, tz, feed.sync_minute, this.limits);
      if (!window) {
        await this.setFeed(trx, ctx, feedId, { last_sync_at: now, next_sync_at: scheduled });
        return { idle: true as const };
      }
      const counter = {
        requestsDay: feed.requests_day as CalendarDate | null,
        requestsToday: feed.requests_today,
      };
      if (requestsLeft(counter, now, this.limits) <= 0) {
        // §5: the day's requests are used; ask again once the UTC day turns, without counting it as a failure.
        await this.setFeed(trx, ctx, feedId, { last_sync_at: now, next_sync_at: nextUtcDay(now) });
        await this.run_(trx, ctx, feedId, trigger, now, { outcome: 'held', error: null });
        return { held: true as const };
      }
      const day = utcDay(now);
      await this.setFeed(trx, ctx, feedId, {
        last_sync_at: now,
        requests_day: day,
        requests_today: (feed.requests_day === day ? feed.requests_today : 0) + 1,
      });
      const runId = await this.run_(trx, ctx, feedId, trigger, now, {
        outcome: 'running',
        error: null,
        requests: 1,
      });
      const secret = await this.crypto.decrypt(trx, ctx.workspaceId, FEED_SECRET_COLUMN, feed.secret_enc);
      return { feed, tz, today, accounts, window, secret: secret ?? '', runId, scheduled };
    });
    if (!prep) return { outcome: 'idle', batches: 0, rows: 0 };
    if ('idle' in prep) return { outcome: 'idle', batches: 0, rows: 0 };
    if ('held' in prep) return { outcome: 'held', batches: 0, rows: 0 };

    let snap: FeedSnapshot;
    try {
      snap = await this.provider.fetchTransactions(prep.secret, {
        from: prep.window.from,
        to: prep.window.to,
      });
    } catch (e) {
      if (!(e instanceof BankFeedError)) throw e;
      await this.failed(ctx, feedId, prep.runId, e, now);
      return { outcome: 'failed', batches: 0, rows: 0 };
    }

    return this.db.run(worker, async (trx) => {
      await this.feeds.store(trx, ctx, feedId, snap);
      let batches = 0;
      let rows = 0;
      let committed = 0;
      for (const a of prep.accounts) {
        const reported = snap.accounts.find((x) => x.id === a.provider_account_id);
        if (!reported) continue;
        // Nothing before the start date, nothing after today (§5).
        const inRange = reported.transactions.filter((t) => t.date >= a.start_date && t.date <= prep.today);
        if (!inRange.length) continue;
        const known = await this.knownIds(
          trx,
          ctx,
          a.id,
          inRange.map((t) => t.id),
        );
        const fresh = inRange.filter((t) => !known.has(t.id));
        if (fresh.length) {
          const dates = fresh.map((t) => t.date).sort();
          const batchId = newId();
          await trx
            .insertInto('app.import_batch')
            .values({
              workspace_id: ctx.workspaceId,
              id: batchId,
              entity_id: a.entity_id,
              ledger_account_id: a.ledger_account_id,
              file_id: null,
              file_name: feedBatchName(a.name, dates[0]!, dates[dates.length - 1]!),
              file_type: 'feed',
              source: 'feed',
              bank_feed_account_id: a.id,
              currency: a.currency,
              status: 'parsing',
              warnings: JSON.stringify([]),
              created_by: ctx.userId,
            })
            .execute();
          await this.imports.stageFeedRows(
            trx,
            ctx,
            batchId,
            a.ledger_account_id,
            fresh.map((t) => ({
              id: t.id,
              date: t.date,
              amount: t.amount,
              description: [t.description, t.memo].filter(Boolean).join(' · '),
              payee: t.payee,
            })),
          );
          batches++;
          rows += fresh.length;
          // §5, owner's answer 4: a clean batch imports itself, with Undo; anything else waits in Review.
          if (await this.clean(trx, ctx, batchId, a.id)) {
            await trx
              .updateTable('app.import_batch')
              .set({ warnings: JSON.stringify(['auto_commit']) })
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', '=', batchId)
              .execute();
            await this.importsService.enqueueCommit(trx, ctx, batchId);
            committed++;
          }
        }
        // The cursor: imported or waiting through the latest date seen (§5), never past today.
        const latest = inRange.map((t) => t.date).sort()[inRange.length - 1]!;
        if (!a.synced_through || latest > a.synced_through)
          await trx
            .updateTable('app.bank_feed_account')
            .set({ synced_through: latest, updated_at: now })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', a.id)
            .execute();
      }
      // §7: a quota warning holds further requests until the UTC day turns; it isn't a failure.
      const quota = snap.problems.some((p) => p.code === 'quota_warning');
      const accountProblems = snap.problems.some((p) => p.code !== 'quota_warning');
      await this.setFeed(trx, ctx, feedId, {
        status: 'active',
        attempts: 0,
        last_error: null,
        last_success_at: now,
        next_sync_at: quota ? nextUtcDay(now) : prep.scheduled,
      });
      const outcome = accountProblems ? 'partial' : 'ok';
      await trx
        .updateTable('app.bank_feed_run')
        .set({
          outcome,
          finished_at: new Date(),
          accounts: prep.accounts.length,
          batches,
          rows_read: rows,
          error: quota ? 'Waiting for SimpleFIN’s daily limit.' : null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', prep.runId)
        .execute();
      await trx
        .deleteFrom('app.bank_feed_run')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('bank_feed_id', '=', feedId)
        .where('started_at', '<', new Date(now.getTime() - RUN_DAYS * 86_400_000))
        .execute();
      return { outcome, batches, rows, committed };
    });
  }

  /**
   * §5: a batch with nothing to decide: no probable duplicates and no rows that couldn't be read, on an account whose
   * last checked feed batch that imported itself didn't miss the institution's balance (a mismatch holds the next
   * automatic import until someone imports one by hand).
   */
  private async clean(trx: Trx, ctx: Ctx, batchId: string, feedAccountId: string): Promise<boolean> {
    const doubtful = await trx
      .selectFrom('app.import_row')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('import_batch_id', '=', batchId)
      .where('status', 'in', ['probable_duplicate', 'error'])
      .limit(1)
      .executeTakeFirst();
    if (doubtful) return false;
    const last = await trx
      .selectFrom('app.import_batch')
      .select(['balance_check', 'warnings'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('bank_feed_account_id', '=', feedAccountId)
      .where('status', '=', 'committed')
      .where('balance_check', '<>', 'n_a')
      .orderBy('committed_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const held = last?.balance_check === 'mismatch' && (last.warnings as string[]).includes('auto_commit');
    return !held;
  }

  /**
   * §7: a feed whose access was revoked, whose subscription needs attention, that keeps failing, or with a bank to sign
   * in to again needs a person. Each owner is told once (no amounts, no transaction text), then nothing more until it's
   * fixed and breaks again.
   */
  private async attention(ctx: Ctx, feedId: string): Promise<void> {
    const worker = { ...ctx, actorType: 'worker' as const };
    const found = await this.db.run(worker, async (trx) => {
      const feed = await trx
        .selectFrom('app.bank_feed')
        .select(['status', 'attention_notified_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .executeTakeFirst();
      if (!feed) return null;
      const reauth = await trx
        .selectFrom('app.bank_feed_account')
        .select(['institution_name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('bank_feed_id', '=', feedId)
        .where('state', '=', 'linked')
        .where('problem', '=', 'reauth_needed')
        .execute();
      const why = attentionWords(
        feed.status,
        reauth.map((r) => r.institution_name ?? 'A bank'),
      );
      if (!why && feed.attention_notified_at)
        await trx
          .updateTable('app.bank_feed')
          .set({ attention_notified_at: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', feedId)
          .execute();
      if (!why || feed.attention_notified_at) return null;
      await trx
        .updateTable('app.bank_feed')
        .set({ attention_notified_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .execute();
      const owners = await trx
        .selectFrom('app.workspace_member')
        .select('user_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('role', '=', 'owner')
        .where('status', '=', 'active')
        .execute();
      // One notification per problem: a different problem the same day is told of too.
      const reason = ['revoked', 'payment_required', 'failing'].includes(feed.status)
        ? feed.status
        : 'reauth';
      return { why, reason, owners: owners.map((o) => o.user_id).filter((u): u is string => Boolean(u)) };
    });
    if (!found) return;
    for (const userId of found.owners) {
      const who = { workspaceId: ctx.workspaceId, userId };
      try {
        await this.db.run(who, async (trx) => {
          const prefs = await this.notifications.prefsIn(trx, userId);
          await this.notifications.create(
            trx,
            who,
            {
              type: 'bank_feed_attention',
              dedupeKey: `bank_feed_attention:${feedId}:${found.reason}:${new Date().toISOString().slice(0, 10)}`,
              title: 'Your bank feed needs someone to look at it',
              body: found.why,
              link: `/w/${ctx.workspaceId}/settings?tab=bank-feeds`,
            },
            prefs,
          );
        });
      } catch (e) {
        this.logger.warn(`Couldn't tell ${userId} about bank feed ${feedId}: ${(e as Error).name}`);
      }
    }
  }

  /** §5, §7: a sync that didn't get its answer. */
  private async failed(
    ctx: Ctx,
    feedId: string,
    runId: string | null,
    e: BankFeedError,
    now: Date = new Date(),
  ): Promise<void> {
    const words = feedError(e).message;
    await this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const feed = await trx
        .selectFrom('app.bank_feed')
        .select(['attempts', 'status'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .forUpdate()
        .executeTakeFirst();
      if (!feed || feed.status === 'disconnected') return;
      const attempts = feed.attempts + 1;
      // A revoked access or a payment problem needs a person: no retries until they act.
      const stopped = e.code === 'revoked' || e.code === 'payment_required' ? e.code : null;
      await this.setFeed(trx, ctx, feedId, {
        attempts,
        last_error: words,
        status:
          stopped ?? (attempts >= FEED_FAILING_AFTER || feed.status === 'failing' ? 'failing' : 'active'),
        next_sync_at: stopped ? null : new Date(now.getTime() + backoffMs(attempts)),
      });
      if (runId)
        await trx
          .updateTable('app.bank_feed_run')
          .set({ outcome: 'failed', finished_at: new Date(), error: words })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', runId)
          .execute();
    });
  }

  /** The accounts a sync fetches: linked, to an open Montra account, and still in the Bridge. */
  private async linked(trx: Trx, ctx: Ctx, feedId: string) {
    const rows = await trx
      .selectFrom('app.bank_feed_account as a')
      .innerJoin('app.ledger_account as l', (j) =>
        j.onRef('l.workspace_id', '=', 'a.workspace_id').onRef('l.id', '=', 'a.ledger_account_id'),
      )
      .select([
        'a.id',
        'a.name',
        'a.provider_account_id',
        'a.start_date',
        'a.synced_through',
        'l.id as ledger_account_id',
        'l.entity_id',
        'l.currency',
      ])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.bank_feed_id', '=', feedId)
      .where('a.state', '=', 'linked')
      .where('a.missing_since', 'is', null)
      .where('l.archived_at', 'is', null)
      .execute();
    return rows
      .filter((r) => r.start_date !== null)
      .map((r) => ({
        ...r,
        start_date: r.start_date as CalendarDate,
        synced_through: r.synced_through as CalendarDate | null,
      }));
  }

  /**
   * §5: ids this feed account has already brought: in a batch waiting, committed or discarded. An undone batch's are
   * not, so they come back.
   */
  private async knownIds(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await trx
      .selectFrom('app.import_row as r')
      .innerJoin('app.import_batch as b', (j) =>
        j.onRef('b.workspace_id', '=', 'r.workspace_id').onRef('b.id', '=', 'r.import_batch_id'),
      )
      .select('r.external_id')
      .where('r.workspace_id', '=', ctx.workspaceId)
      .where('b.bank_feed_account_id', '=', accountId)
      .where('b.status', 'not in', ['undone', 'failed'])
      .where('r.external_id', 'in', [...ids])
      .execute();
    return new Set(rows.map((r) => r.external_id!).filter(Boolean));
  }

  private async setFeed(
    trx: Trx,
    ctx: Ctx,
    feedId: string,
    set: Partial<{
      status: 'active' | 'failing' | 'revoked' | 'payment_required';
      attempts: number;
      last_error: string | null;
      last_sync_at: Date;
      last_success_at: Date;
      next_sync_at: Date | null;
      requests_day: string;
      requests_today: number;
    }>,
  ): Promise<void> {
    await trx
      .updateTable('app.bank_feed')
      .set({ ...set, updated_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', feedId)
      .execute();
  }

  private async run_(
    trx: Trx,
    ctx: Ctx,
    feedId: string,
    trigger: 'first' | 'schedule' | 'manual',
    now: Date,
    r: { outcome: 'running' | 'held'; error: string | null; requests?: number },
  ): Promise<string> {
    const row = await trx
      .insertInto('app.bank_feed_run')
      .values({
        workspace_id: ctx.workspaceId,
        bank_feed_id: feedId,
        trigger,
        started_at: now,
        outcome: r.outcome,
        requests: r.requests ?? 0,
        ...(r.outcome === 'held' ? { finished_at: now } : {}),
        error: r.error,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
