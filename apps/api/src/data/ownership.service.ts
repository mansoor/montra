/**
 * The rest of owning your data: the security log (AUTH-12), trash (BAK-06), the storage meter (BAK-08), leaving (NFR-06, BAK-09) and the
 * job that keeps retention promises. Deletion can be undone for 30 days; purging then removes everything but a row with no identity in it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { asCurrencyCode, addDays, type CalendarDate } from '@montra/domain';
import type {
  DeletionStatusDto,
  RetentionItemRef,
  RetentionResultDto,
  RetentionReviewDto,
  SecurityEventDto,
  StorageUsageDto,
  TrashItemDto,
} from '@montra/schemas';
import { notFound } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { Worker } from '../jobs/queue.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { BackupService } from './backup.service.js';

type Ctx = { workspaceId: string; userId: string };

const TRASH_DAYS = 30;
/** A transaction still in the Trash this long past its 30 days was tried by the hourly job: something still uses it. */
const IN_USE_AFTER_HOURS = 2;
/** NFR-06 promises the data is gone within 30 days, so it falls due early enough for the hourly job to get there in time. */
const DELETION_WINDOW_MS = 30 * 86_400_000 - 2 * 3_600_000;
const RETENTION_EVERY_MS = 60 * 60_000;

@Injectable()
export class OwnershipService {
  private readonly logger = new Logger('Retention');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  register(): void {
    this.worker.register('data.retention', async () => {
      await this.schedule(new Date(Date.now() + RETENTION_EVERY_MS));
      return this.retention();
    });
  }

  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'data.retention', ${at})`.execute(trx),
    );
  }

  // ----- Security log (AUTH-12) -------------------------------------------------------------------------------------

  async securityActivity(userId: string): Promise<SecurityEventDto[]> {
    return this.db.run({ userId }, async (trx) => {
      const rows = await trx
        .selectFrom('app.security_event')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('at', 'desc')
        .limit(200)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as SecurityEventDto['kind'],
        at: r.at.toISOString(),
        workspaceId: r.workspace_id,
        detail: r.detail,
      }));
    });
  }

  // ----- Trash (BAK-06) ---------------------------------------------------------------------------------------------

  /**
   * What is in the Trash, and how and when each leaves it. Transactions and tax forms go 30 days after they were
   * deleted. A receipt is a tax record: it stays until its retention date, then waits for an owner's approval like any
   * other receipt (RCP-10). Each can be restored meanwhile.
   */
  async trash(ctx: Ctx): Promise<TrashItemDto[]> {
    return this.db.run(ctx, async (trx) => {
      const { rows } = await sql<{
        kind: TrashItemDto['kind'];
        id: string;
        title: string;
        deleted_at: Date;
        retain_until: CalendarDate | null;
        past_retention: boolean;
        in_use: boolean;
        amount: string | null;
        currency: string | null;
      }>`
        select 'transaction' as kind, t.id, coalesce(t.payee_raw, nullif(t.description, ''), 'Transaction') as title,
               t.deleted_at, null::date as retain_until, false as past_retention,
               -- Still here after its 30 days and the hourly job's next run: another record refers to it.
               t.deleted_at < now() - ${`${TRASH_DAYS} days ${IN_USE_AFTER_HOURS} hours`}::interval as in_use,
               t.spec->>'amount' as amount, t.spec->>'currency' as currency
          from app.transaction t
         where t.workspace_id = ${ctx.workspaceId} and t.deleted_at is not null
           and not exists (select 1 from app.journal_entry e where e.workspace_id = t.workspace_id and e.transaction_id = t.id)
        union all
        select 'receipt', r.id, coalesce(r.merchant, r.merchant_raw, 'Receipt'), r.deleted_at, r.retain_until,
               r.retain_until < current_date, false, r.total_minor::text, r.currency
          from app.receipt r
         where r.workspace_id = ${ctx.workspaceId} and r.deleted_at is not null
        union all
        select 'tax_form', f.id, coalesce(f.issuer_name, 'Tax form'), f.deleted_at, null, false, false, null, null
          from app.tax_form f
         where f.workspace_id = ${ctx.workspaceId} and f.deleted_at is not null
         order by deleted_at desc
         limit 500`.execute(trx);
      return rows.map((r) => {
        const trashEnds = addDays(r.deleted_at.toISOString().slice(0, 10) as CalendarDate, TRASH_DAYS);
        const [removal, until]: [TrashItemDto['removal'], CalendarDate] = r.retain_until
          ? [r.past_retention ? 'owner_approval' : 'retention', r.retain_until]
          : [r.in_use ? 'in_use' : 'trash', trashEnds];
        return {
          kind: r.kind,
          id: r.id,
          title: r.title,
          deletedAt: r.deleted_at.toISOString(),
          removal,
          until,
          amount: r.amount,
          currency: r.currency ? asCurrencyCode(r.currency) : null,
        };
      });
    });
  }

  async restoreFromTrash(ctx: Ctx, kind: TrashItemDto['kind'], id: string): Promise<void> {
    if (kind === 'transaction') {
      await this.transactions.restore(ctx, id);
      return;
    }
    if (kind === 'tax_form') {
      await this.db.run(ctx, async (trx) => {
        const res = await trx
          .updateTable('app.tax_form')
          .set({ deleted_at: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .where('deleted_at', 'is not', null)
          .executeTakeFirst();
        if (!res.numUpdatedRows) throw notFound('Tax form');
      });
      return;
    }
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .updateTable('app.receipt')
        .set({ deleted_at: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('deleted_at', 'is not', null)
        .executeTakeFirst();
      if (!res.numUpdatedRows) throw notFound('Receipt');
    });
  }

  // ----- Storage (BAK-08) -------------------------------------------------------------------------------------------

  async storageUsage(ctx: Ctx): Promise<StorageUsageDto> {
    return this.db.run(ctx, async (trx) => {
      const { rows } = await sql<{
        kind: string;
        bytes: string;
        quota: string;
      }>`select * from app.workspace_storage(${ctx.workspaceId}::uuid)`.execute(trx);
      const byKind: Record<string, string> = {};
      let used = 0n;
      for (const r of rows) {
        if (r.kind === '') continue;
        byKind[r.kind] = r.bytes;
        used += BigInt(r.bytes);
      }
      return { usedBytes: String(used), quotaBytes: rows[0]?.quota ?? '0', byKind };
    });
  }

  // ----- Leaving (NFR-06, BAK-09) ---------------------------------------------------------------------------------------

  /** Workspaces that go with this account, because it's their only owner. */
  private async soleOwned(userId: string) {
    const { rows } = await this.db.run({ userId }, (trx) =>
      sql<{
        id: string;
        name: string;
        others: string;
      }>`select * from app.sole_owned_workspaces(${userId}::uuid)`.execute(trx),
    );
    return rows;
  }

  async deletionStatus(userId: string): Promise<DeletionStatusDto> {
    const user = await this.db.run({ userId }, (trx) =>
      trx
        .selectFrom('app.app_user')
        .select(['deleted_at', 'purge_after'])
        .where('id', '=', userId)
        .executeTakeFirst(),
    );
    const owned = await this.soleOwned(userId);
    return {
      requested: Boolean(user?.deleted_at),
      purgeAfter: user?.purge_after?.toISOString() ?? null,
      workspaces: owned.map((w) => ({ id: w.id, name: w.name, otherMembers: Number(w.others) })),
    };
  }

  /** `support`: staff started it because the person asked them to (ADR-0049 §4). It's the same deletion. */
  async requestDeletion(userId: string, by: 'self' | 'support' = 'self'): Promise<DeletionStatusDto> {
    const purgeAfter = new Date(Date.now() + DELETION_WINDOW_MS);
    await this.db.run({ userId }, async (trx) => {
      await sql`select app.flag_account_deletion(${userId}::uuid, ${purgeAfter})`.execute(trx);
      await trx
        .insertInto('app.security_event')
        .values({
          user_id: userId,
          workspace_id: null,
          kind: by === 'support' ? 'deletion_requested_by_support' : 'deletion_requested',
          detail: JSON.stringify({ purgeAfter: purgeAfter.toISOString() }),
        })
        .execute();
    });
    return this.deletionStatus(userId);
  }

  async cancelDeletion(userId: string): Promise<DeletionStatusDto> {
    await this.db.run({ userId }, async (trx) => {
      await sql`select app.unflag_account_deletion(${userId}::uuid)`.execute(trx);
      await trx
        .insertInto('app.security_event')
        .values({
          user_id: userId,
          workspace_id: null,
          kind: 'deletion_cancelled',
          detail: JSON.stringify({}),
        })
        .execute();
    });
    return this.deletionStatus(userId);
  }

  // ----- Retention -------------------------------------------------------------------------------------------------------

  /** One failure doesn't stop the rest, and it's picked up again next hour. */
  async retention(): Promise<Record<string, number>> {
    const done = {
      exports: 0,
      restores: 0,
      found: 0,
      receipts: 0,
      files: 0,
      workspaces: 0,
      users: 0,
      held: 0,
      trash: 0,
      backups: 0,
    };
    // The Trash first: a tax form purged there marks its files deleted, and they go below in the same run (§8.5).
    const trash = await this.db.run({}, (trx) =>
      sql<{ n: number }>`select app.purge_trash() as n`.execute(trx),
    );
    done.trash = Number(trash.rows[0]?.n ?? 0);
    done.held = await this.holdPurges();
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ kind: string; workspace_id: string | null; id: string; storage_key: string | null }>`
        select * from app.retention_due()`.execute(trx),
    );
    const order: Record<string, number> = { export: 0, restore: 1, workspace: 2, user: 3 };
    rows.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    const archives = rows.filter((r) => r.kind === 'export' || r.kind === 'restore');
    for (const r of archives) await this.tryRetainOne(r, done);
    // RCP-10: what is past its date is listed for the owners; only what an owner approved goes. Receipts first: a
    // receipt's files take its approval, so they go in the same run.
    done.found = await this.findDue();
    done.receipts = await this.purgeReceipts();

    done.files = await this.purgeFiles();
    for (const r of rows.filter((x) => !archives.includes(x))) await this.tryRetainOne(r, done);
    done.backups = await this.backups.runSchedules();
    if (done.found || done.receipts || done.files) {
      this.logger.log(
        `Retention: ${done.found} newly past their date for owners to review; removed ${done.receipts} receipts and ${done.files} files`,
      );
    }
    return done;
  }

  /**
   * ADR-0049 §4: a closing account under a legal hold, or a closing workspace with an active member under one, stays
   * as it is: `retention_due()` leaves it out, and the purge functions refuse it. Each is logged once when first held
   * back, and again when the hold goes; the next run then purges it. The staff console shows since when.
   */
  private async holdPurges(): Promise<number> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ kind: 'workspace' | 'user'; id: string; change: 'held' | 'released' }>`
        select * from app.retention_hold_purges()`.execute(trx),
    );
    for (const r of rows) {
      if (r.change === 'held') {
        this.logger.warn(
          `Held back by a legal hold: the closing ${r.kind} ${r.id} stays until the hold is lifted`,
        );
      } else {
        this.logger.log(`No longer held back: the closing ${r.kind} ${r.id} goes when its date has passed`);
      }
    }
    return rows.filter((r) => r.change === 'held').length;
  }

  private async tryRetainOne(
    r: { kind: string; workspace_id: string | null; id: string; storage_key: string | null },
    done: Record<string, number>,
  ): Promise<void> {
    try {
      await this.retainOne(r, done);
    } catch (e) {
      this.logger.warn(`Retention failed for a ${r.kind}: ${(e as Error).message}`);
    }
  }

  /**
   * RCP-10: records what is newly past its date as waiting for an owner, at most RETENTION_BATCH a run, and tells each
   * owner of a workspace with new items, once a day at most. Nothing is deleted here (owner's decision, 2026-11-22).
   */
  private async findDue(): Promise<number> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; user_id: string; new_items: number; waiting: number }>`
        select * from app.retention_find(${this.config.RETENTION_BATCH}::integer)`.execute(trx),
    );
    const found = new Map<string, number>();
    for (const r of rows) {
      found.set(r.workspace_id, r.new_items);
      const who = { workspaceId: r.workspace_id, userId: r.user_id };
      try {
        await this.db.run(who, async (trx) => {
          const prefs = await this.notifications.prefsIn(trx, who.userId);
          await this.notifications.create(
            trx,
            who,
            {
              type: 'retention_due',
              dedupeKey: `retention_due:${new Date().toISOString().slice(0, 10)}`,
              title: 'Receipts and files are past their retention date',
              body:
                `${r.waiting} ${r.waiting === 1 ? 'is' : 'are'} waiting for an owner. Nothing is deleted until you ` +
                'approve it. Review them on the web, in Settings, Data.',
              link: `/w/${who.workspaceId}/settings?tab=data#retention`,
            },
            prefs,
          );
        });
      } catch (e) {
        this.logger.warn(`Couldn't tell an owner of ${r.workspace_id} about retention: ${(e as Error).name}`);
      }
    }
    return [...found.values()].reduce((a, b) => a + b, 0);
  }

  /** RCP-10: what is waiting in this workspace, for its owners (the database refuses anyone else). */
  async retentionReview(ctx: Ctx): Promise<RetentionReviewDto> {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<{
        kind: 'receipt' | 'file';
        subject_id: string;
        retain_until: CalendarDate;
        title: string;
        file_kind: string | null;
        receipt_date: CalendarDate | null;
        total_minor: bigint | null;
        currency: string | null;
        transaction_id: string | null;
        transaction_date: CalendarDate | null;
        transaction_payee: string | null;
        approved_at: Date | null;
      }>`select * from app.retention_review()`.execute(trx),
    );
    return {
      items: rows.map((r) => ({
        kind: r.kind,
        id: r.subject_id,
        retainUntil: r.retain_until,
        title: r.title,
        fileKind: r.file_kind,
        date: r.receipt_date,
        amount: r.total_minor === null ? null : String(r.total_minor),
        currency: r.currency,
        transaction:
          r.transaction_id && r.transaction_date
            ? { id: r.transaction_id, date: r.transaction_date, payee: r.transaction_payee }
            : null,
        approvedAt: r.approved_at?.toISOString() ?? null,
      })),
      extendYears: this.config.RETENTION_EXTEND_YEARS,
    };
  }

  /**
   * "Delete these": approves exactly these items, if still waiting and past their date, and runs the job now. The
   * purge still checks for a legal hold. Logged with who approved.
   */
  async approveRetention(ctx: Ctx, items: readonly RetentionItemRef[]): Promise<RetentionResultDto> {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<{ n: number }>`select app.retention_approve(
        ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.id)}::uuid[]) as n`.execute(trx),
    );
    const count = Number(rows[0]?.n ?? 0);
    if (count > 0) await this.schedule(new Date());
    return { count };
  }

  /** "Keep for longer": these items' dates move RETENTION_EXTEND_YEARS from today. Logged with who did it. */
  async extendRetention(ctx: Ctx, items: readonly RetentionItemRef[]): Promise<RetentionResultDto> {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<{ n: number }>`select app.retention_extend(
        ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.id)}::uuid[],
        ${this.config.RETENTION_EXTEND_YEARS}::integer) as n`.execute(trx),
    );
    return { count: Number(rows[0]?.n ?? 0) };
  }

  /**
   * RCP-10: approved receipts still past their date, at most RETENTION_BATCH a run. Each goes with its lines, OCR text
   * and extraction; the transaction it was matched to stays. A legal hold keeps them, approved or not (migration 0079).
   */
  private async purgeReceipts(): Promise<number> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; id: string }>`
        select * from app.retention_receipts_approved(${this.config.RETENTION_BATCH}::integer)`.execute(trx),
    );
    let n = 0;
    for (const r of rows) {
      try {
        const res = await this.db.run({}, (trx) =>
          sql<{ gone: boolean }>`
            select app.purge_receipt(${r.workspace_id}::uuid, ${r.id}::uuid) as gone`.execute(trx),
        );
        if (res.rows[0]?.gone) n++;
      } catch (e) {
        this.logger.warn(`Retention failed for a receipt: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /**
   * Files an owner approved, or 30 days in the trash, at most RETENTION_BATCH a run. The row first: a row with no file is
   * a visible gap, but a file with no row could never be found again. The database says which objects in Montra's
   * storage then go: none for a file held only in the vault, whose document the vault keeps (ADR-0054 §10), and never
   * one another file still names.
   */
  private async purgeFiles(): Promise<number> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; id: string }>`
        select * from app.retention_files_due(${this.config.RETENTION_BATCH}::integer)`.execute(trx),
    );
    let n = 0;
    for (const r of rows) {
      try {
        const res = await this.db.run({}, (trx) =>
          sql<{ keys: string[] | null }>`
            select app.purge_expired_file(${r.workspace_id}::uuid, ${r.id}::uuid) as keys`.execute(trx),
        );
        const keys = res.rows[0]?.keys;
        if (!keys) continue;
        n++;
        for (const k of keys) {
          await this.storage.delete(k).catch((e: Error) => {
            this.logger.warn(`File ${r.id}: its stored copy couldn't be removed: ${e.message}`);
          });
        }
      } catch (e) {
        this.logger.warn(`Retention failed for a file: ${(e as Error).message}`);
      }
    }
    return n;
  }

  private async retainOne(
    r: { kind: string; workspace_id: string | null; id: string; storage_key: string | null },
    done: Record<string, number>,
  ): Promise<void> {
    if (r.kind === 'export') {
      if (r.storage_key) await this.storage.delete(r.storage_key);
      await this.db.run({}, (trx) =>
        sql`select app.expire_export(${r.workspace_id}::uuid, ${r.id}::uuid)`.execute(trx),
      );
      done.exports!++;
    } else if (r.kind === 'restore') {
      if (r.storage_key) await this.storage.delete(r.storage_key);
      await this.db.run({}, (trx) => sql`select app.delete_expired_restore(${r.id}::uuid)`.execute(trx));
      done.restores!++;
    } else if (r.kind === 'workspace') {
      const { rows } = await this.db.run({}, (trx) =>
        sql<{ key: string }>`select k as key from app.workspace_storage_keys(${r.id}::uuid) k`.execute(trx),
      );
      await this.db.run({}, (trx) => sql`select app.purge_workspace(${r.id}::uuid)`.execute(trx));
      for (const k of rows) await this.storage.delete(k.key).catch(() => undefined);
      done.workspaces!++;
    } else if (r.kind === 'user') {
      await this.db.run({}, (trx) => sql`select app.purge_user(${r.id}::uuid)`.execute(trx));
      done.users!++;
    }
  }
}
