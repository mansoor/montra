/**
 * Copies files and backups to the owner's storage (ADR-0030 §5–§7). One system job, `storage.mirror`, works through every connection
 * with something due, each under an owner's RLS context. It claims rows with a lease, so two workers never copy the same file and a
 * crash only delays one. It then reschedules itself for whatever is due next.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { ExportJobTable, StorageMirrorItemTable } from '@montra/db';
import { Db } from '../db/database.js';
import { Worker } from '../jobs/queue.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { STORAGE_PORT, type StoragePort } from './storage.js';
import {
  asDestinationError,
  backupPath,
  filePath,
  type DestinationError,
  type StorageDestination,
} from './destinations/index.js';
import { StorageDestinationsService, type DestinationRow } from './storage-destinations.service.js';

type Ctx = { workspaceId: string; userId: string };
type Item = Selectable<StorageMirrorItemTable>;
type ExportRow = Selectable<ExportJobTable>;

/** Minutes to wait after each failed attempt; the last repeats. A row gives up after MAX_ATTEMPTS. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720, 1440];
export const MAX_ATTEMPTS = 10;
/** Failures in a row, with no success between, before the connection shows as failing and owners hear about it. */
export const FAILING_AFTER = 5;
const LEASE_MS = 10 * 60_000;
const BATCH = 20;
const RUN_BUDGET_MS = 2 * 60_000;
/** Never wake again sooner than this, so a row that can't make progress can't spin the worker. */
const MIN_GAP_MS = 30_000;

export const backoffMs = (attempts: number) =>
  BACKOFF_MIN[Math.min(Math.max(attempts, 1), BACKOFF_MIN.length) - 1]! * 60_000;

@Injectable()
export class StorageMirrorJobs {
  private readonly logger = new Logger('StorageMirror');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(StorageDestinationsService) private readonly destinations: StorageDestinationsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  register(): void {
    this.worker.register('storage.mirror', async () => this.run());
  }

  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'storage.mirror', ${at})`.execute(trx),
    );
  }

  /** One pass over every connection with work due, then the next wake-up. */
  async run(budgetMs = RUN_BUDGET_MS): Promise<Record<string, number>> {
    const started = Date.now();
    const deadline = started + budgetMs;
    const done = { copied: 0, deleted: 0, backups: 0, pruned: 0, failed: 0 };
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; destination_id: string; user_id: string | null }>`
        select * from app.storage_mirror_due()`.execute(trx),
    );
    for (const r of rows) {
      if (!r.user_id || Date.now() > deadline) continue;
      try {
        await this.runDestination(
          { workspaceId: r.workspace_id, userId: r.user_id },
          r.destination_id,
          deadline,
          done,
        );
      } catch (e) {
        this.logger.warn(`Storage ${r.destination_id} failed: ${(e as Error).message}`);
      }
    }
    const next = await this.db.run({}, (trx) =>
      sql<{ t: Date | null }>`select app.storage_mirror_next() as t`.execute(trx),
    );
    const t = next.rows[0]?.t;
    if (t) await this.schedule(new Date(Math.max(new Date(t).getTime(), Date.now() + MIN_GAP_MS)));
    return done;
  }

  private async runDestination(
    ctx: Ctx,
    destinationId: string,
    deadline: number,
    done: Record<string, number>,
  ) {
    const dest = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.storage_destination')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', destinationId)
        .executeTakeFirst(),
    );
    if (!dest || dest.status === 'paused') return;
    let remote: StorageDestination;
    try {
      remote = await this.destinations.open(ctx, dest);
    } catch (e) {
      // Not even a connection to try (an address no longer allowed, say): everything waits on the connection's backoff.
      await this.failed(ctx, dest, asDestinationError(e));
      await this.holdBack(ctx, dest.id, new Date(Date.now() + backoffMs(dest.consecutive_failures + 1)));
      return;
    }
    try {
      while (Date.now() < deadline) {
        const items = await this.claimItems(ctx, dest.id);
        if (!items.length) break;
        let until: Date | null = null;
        for (const item of items) {
          if (until) {
            await this.release(ctx, item, until);
            continue;
          }
          const err = await this.copyItem(ctx, dest, remote, item, done);
          // The connection itself is at fault: hold everything else back on the same backoff.
          if (err?.connectionLevel) until = new Date(Date.now() + backoffMs(item.attempts));
        }
        if (until) {
          await this.holdBack(ctx, dest.id, until);
          return;
        }
      }
      while (Date.now() < deadline) {
        const backups = await this.claimBackups(ctx, dest.id);
        if (!backups.length) break;
        let until: Date | null = null;
        for (const job of backups) {
          if (until) {
            await this.setBackup(ctx, job, {
              destination_attempts: Math.max(job.destination_attempts - 1, 0),
              destination_next_at: until,
            });
            continue;
          }
          const err = await this.copyBackup(ctx, dest, remote, job, done);
          if (err?.connectionLevel) until = new Date(Date.now() + backoffMs(job.destination_attempts));
        }
        if (until) {
          await this.holdBack(ctx, dest.id, until);
          return;
        }
      }
    } finally {
      remote.close();
    }
  }

  // ----- Files -----------------------------------------------------------------------------------------------------

  private async claimItems(ctx: Ctx, destinationId: string): Promise<Item[]> {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<Item>`
        update app.storage_mirror_item i
           set next_attempt_at = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = i.attempts + 1
         where (i.workspace_id, i.destination_id, i.file_id) in (
                 select workspace_id, destination_id, file_id from app.storage_mirror_item
                  where workspace_id = ${ctx.workspaceId}::uuid and destination_id = ${destinationId}::uuid
                    and status in ('pending', 'delete') and next_attempt_at <= now()
                  order by next_attempt_at
                  limit ${BATCH}
                  for update skip locked)
        returning i.*`.execute(trx),
    );
    return rows;
  }

  /** Gives back a claimed row without counting the attempt, for when the run stops early. */
  private async release(ctx: Ctx, item: Item, at: Date) {
    await this.updateItem(ctx, item, { attempts: Math.max(item.attempts - 1, 0), next_attempt_at: at });
  }

  /** Holds back everything waiting for this connection, files and backups, until `until`. */
  private async holdBack(ctx: Ctx, destinationId: string, until: Date) {
    await this.db.run(ctx, async (trx) => {
      await trx
        .updateTable('app.storage_mirror_item')
        .set({ next_attempt_at: until })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('status', 'in', ['pending', 'delete'])
        .where('next_attempt_at', '<', until)
        .execute();
      await trx
        .updateTable('app.export_job')
        .set({ destination_next_at: until })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('destination_status', '=', 'pending')
        .where((eb) => eb.or([eb('destination_next_at', 'is', null), eb('destination_next_at', '<', until)]))
        .execute();
    });
  }

  private async copyItem(
    ctx: Ctx,
    dest: DestinationRow,
    remote: StorageDestination,
    item: Item,
    done: Record<string, number>,
  ): Promise<DestinationError | null> {
    try {
      if (item.status === 'delete') {
        if (item.remote_path) await remote.delete(item.remote_path);
        await this.db.run(ctx, (trx) =>
          trx
            .deleteFrom('app.storage_mirror_item')
            .where('workspace_id', '=', item.workspace_id)
            .where('destination_id', '=', item.destination_id)
            .where('file_id', '=', item.file_id)
            .where('status', '=', 'delete')
            .execute(),
        );
        done.deleted!++;
        await this.succeeded(ctx, dest);
        return null;
      }
      const file = await this.db.run(ctx, (trx) =>
        trx
          .selectFrom('app.file')
          .select(['id', 'kind', 'file_name', 'mime', 'bytes', 'storage_key', 'created_at', 'deleted_at'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', item.file_id)
          .executeTakeFirst(),
      );
      if (!file) {
        await this.db.run(ctx, (trx) =>
          trx
            .deleteFrom('app.storage_mirror_item')
            .where('workspace_id', '=', item.workspace_id)
            .where('destination_id', '=', item.destination_id)
            .where('file_id', '=', item.file_id)
            .execute(),
        );
        return null;
      }
      if (file.deleted_at) {
        // In the trash when its turn came. Restoring it from there puts it back in line (migration 0029).
        await this.updateItem(ctx, item, { status: 'skipped', attempts: 0, last_error: null });
        return null;
      }
      const bytes = await this.storage.get(file.storage_key);
      const path = filePath(dest.folder, file);
      await remote.put(path, bytes, { contentType: file.mime, bytes: bytes.length });
      await this.updateItem(ctx, item, {
        status: 'done',
        remote_path: path,
        bytes: bytes.length,
        mirrored_at: new Date(),
        last_error: null,
      });
      done.copied!++;
      await this.succeeded(ctx, dest);
      return null;
    } catch (e) {
      const err = asDestinationError(e);
      this.logger.warn(`Copy of file ${item.file_id} failed: ${err.code} ${err.detail}`);
      const gaveUp = item.attempts >= MAX_ATTEMPTS;
      await this.updateItem(ctx, item, {
        // A copy to delete that keeps failing stays a 'delete' row: it's retried daily rather than forgotten.
        status: gaveUp && item.status !== 'delete' ? 'failed' : item.status,
        next_attempt_at: new Date(Date.now() + backoffMs(item.attempts)),
        last_error: err.message,
      });
      if (gaveUp) done.failed!++;
      await this.failed(ctx, dest, err);
      return err;
    }
  }

  private async updateItem(
    ctx: Ctx,
    item: Item,
    set: Partial<Record<keyof StorageMirrorItemTable, unknown>>,
  ) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.storage_mirror_item')
        .set(set as never)
        .where('workspace_id', '=', item.workspace_id)
        .where('destination_id', '=', item.destination_id)
        .where('file_id', '=', item.file_id)
        .execute(),
    );
  }

  // ----- Backups -----------------------------------------------------------------------------------------------------

  private async claimBackups(ctx: Ctx, destinationId: string): Promise<ExportRow[]> {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<ExportRow>`
        update app.export_job e
           set destination_next_at = now() + ${`${LEASE_MS} milliseconds`}::interval,
               destination_attempts = e.destination_attempts + 1
         where (e.workspace_id, e.id) in (
                 select workspace_id, id from app.export_job
                  where workspace_id = ${ctx.workspaceId}::uuid and destination_id = ${destinationId}::uuid
                    and destination_status = 'pending' and coalesce(destination_next_at, now()) <= now()
                  order by created_at
                  limit 5
                  for update skip locked)
        returning e.*`.execute(trx),
    );
    return rows;
  }

  private async copyBackup(
    ctx: Ctx,
    dest: DestinationRow,
    remote: StorageDestination,
    job: ExportRow,
    done: Record<string, number>,
  ): Promise<DestinationError | null> {
    const owner = { workspaceId: ctx.workspaceId, userId: job.requested_by };
    if (job.status !== 'ready' || !job.storage_key || !job.file_name || job.bytes === null) {
      await this.setBackup(ctx, job, {
        destination_status: 'failed',
        destination_error: 'The backup’s download expired before it could be saved.',
      });
      if (job.scheduled) await this.tellBackup(owner, dest, job, false);
      return null;
    }
    try {
      const path = backupPath(dest.folder, job.file_name, job.id);
      const stream = await this.storage.getStream(job.storage_key);
      await remote.put(path, stream, { contentType: 'application/octet-stream', bytes: Number(job.bytes) });
      await this.setBackup(ctx, job, {
        destination_status: 'done',
        destination_path: path,
        destination_error: null,
      });
      done.backups!++;
      await this.succeeded(ctx, dest);
      if (job.scheduled) await this.tellBackup(owner, dest, job, true);
      done.pruned! += await this.prune(ctx, dest, remote);
      return null;
    } catch (e) {
      const err = asDestinationError(e);
      this.logger.warn(`Copy of backup ${job.id} failed: ${err.code} ${err.detail}`);
      const gaveUp = job.destination_attempts >= MAX_ATTEMPTS;
      await this.setBackup(ctx, job, {
        destination_status: gaveUp ? 'failed' : 'pending',
        destination_next_at: new Date(Date.now() + backoffMs(job.destination_attempts)),
        destination_error: err.message,
      });
      if (gaveUp && job.scheduled) await this.tellBackup(owner, dest, job, false);
      await this.failed(ctx, dest, err);
      return err;
    }
  }

  private async setBackup(ctx: Ctx, job: ExportRow, set: Partial<Record<keyof ExportJobTable, unknown>>) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.export_job')
        .set(set as never)
        .where('workspace_id', '=', job.workspace_id)
        .where('id', '=', job.id)
        .execute(),
    );
  }

  /** Keeps the newest `keep_backups` archives Montra wrote there, and deletes older ones (ADR-0030 §6). */
  private async prune(ctx: Ctx, dest: DestinationRow, remote: StorageDestination): Promise<number> {
    if (dest.keep_backups === 0 || !dest.can_delete) return 0;
    const old = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.export_job')
        .select(['workspace_id', 'id', 'destination_path'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', dest.id)
        .where('destination_status', '=', 'done')
        .orderBy('created_at', 'desc')
        .offset(dest.keep_backups)
        .limit(100)
        .execute(),
    );
    let n = 0;
    for (const o of old) {
      try {
        if (o.destination_path) await remote.delete(o.destination_path);
        await this.db.run(ctx, (trx) =>
          trx
            .updateTable('app.export_job')
            .set({ destination_status: 'pruned' })
            .where('workspace_id', '=', o.workspace_id)
            .where('id', '=', o.id)
            .execute(),
        );
        n++;
      } catch (e) {
        // Tried again after the next backup.
        this.logger.warn(`Pruning backup ${o.id} failed: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** The schedule's owner hears how it went (BAK-05). No amounts or file contents, as for any notification. */
  private async tellBackup(owner: Ctx, dest: DestinationRow, job: ExportRow, saved: boolean) {
    try {
      await this.db.run(owner, async (trx) => {
        const prefs = await this.notifications.prefsIn(trx, owner.userId);
        await this.notifications.create(
          trx,
          owner,
          {
            type: 'backup_ready',
            dedupeKey: `backup_ready:${job.id}`,
            title: saved
              ? `Your scheduled backup is saved to ${dest.label}`
              : `Your scheduled backup couldn’t be saved to ${dest.label}`,
            body: saved
              ? 'It’s also ready to download from Montra for 7 days.'
              : 'It’s ready to download from Montra for 7 days. See your storage settings for what went wrong.',
            link: `/w/${owner.workspaceId}/settings?tab=storage`,
          },
          prefs,
        );
      });
    } catch (e) {
      this.logger.warn(`Couldn't tell ${owner.userId} about backup ${job.id}: ${(e as Error).message}`);
    }
  }

  // ----- The connection's state --------------------------------------------------------------------------------------

  private async succeeded(ctx: Ctx, dest: DestinationRow) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.storage_destination')
        .set({
          last_success_at: new Date(),
          consecutive_failures: 0,
          status: sql`case when status = 'failing' then 'active' else status end`,
        } as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', dest.id)
        .execute(),
    );
  }

  private async failed(ctx: Ctx, dest: DestinationRow, err: DestinationError) {
    const turned = await this.db.run(ctx, async (trx) => {
      const row = await trx
        .updateTable('app.storage_destination')
        .set({
          consecutive_failures: sql`consecutive_failures + 1`,
          last_error: err.message,
          last_error_at: new Date(),
          status: sql`case when status = 'active' and consecutive_failures + 1 >= ${FAILING_AFTER} then 'failing' else status end`,
        } as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', dest.id)
        .returning(['status', 'consecutive_failures'])
        .executeTakeFirst();
      return row?.status === 'failing' && row.consecutive_failures === FAILING_AFTER;
    });
    if (turned) await this.tellOwners(ctx, dest);
  }

  /** Once, as the connection turns to failing. Each owner, under their own RLS. */
  private async tellOwners(ctx: Ctx, dest: DestinationRow) {
    const owners = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.workspace_member')
        .select('user_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('role', '=', 'owner')
        .where('status', '=', 'active')
        .execute(),
    );
    const day = new Date().toISOString().slice(0, 10);
    for (const o of owners) {
      if (!o.user_id) continue;
      const owner = { workspaceId: ctx.workspaceId, userId: o.user_id };
      try {
        await this.db.run(owner, async (trx) => {
          const prefs = await this.notifications.prefsIn(trx, owner.userId);
          await this.notifications.create(
            trx,
            owner,
            {
              type: 'storage_failing',
              dedupeKey: `storage_failing:${dest.id}:${day}`,
              title: `Montra can’t save copies to ${dest.label}`,
              body: 'Your files are safe in Montra, and copying picks up again once the storage works. See your storage settings.',
              link: `/w/${owner.workspaceId}/settings?tab=storage`,
            },
            prefs,
          );
        });
      } catch (e) {
        this.logger.warn(`Couldn't tell ${owner.userId} about storage ${dest.id}: ${(e as Error).message}`);
      }
    }
  }
}
