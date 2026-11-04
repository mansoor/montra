/**
 * The rest of owning your data: the security log (AUTH-12), trash (BAK-06), the storage meter (BAK-08), leaving (NFR-06, BAK-09) and the
 * job that keeps retention promises. Deletion can be undone for 30 days; purging then removes everything but a row with no identity in it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { asCurrencyCode, addDays, type CalendarDate } from '@montra/domain';
import type { DeletionStatusDto, SecurityEventDto, StorageUsageDto, TrashItemDto } from '@montra/schemas';
import { notFound } from '../common/errors.js';
import { Db } from '../db/database.js';
import { Worker } from '../jobs/queue.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { BackupService } from './backup.service.js';

type Ctx = { workspaceId: string; userId: string };

const TRASH_DAYS = 30;
const DELETION_DAYS = 30;
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

  async trash(ctx: Ctx): Promise<TrashItemDto[]> {
    return this.db.run(ctx, async (trx) => {
      const { rows } = await sql<{
        kind: 'transaction' | 'receipt';
        id: string;
        title: string;
        deleted_at: Date;
        amount: string | null;
        currency: string | null;
      }>`
        select 'transaction' as kind, t.id, coalesce(t.payee_raw, nullif(t.description, ''), 'Transaction') as title,
               t.deleted_at, t.spec->>'amount' as amount, t.spec->>'currency' as currency
          from app.transaction t
         where t.workspace_id = ${ctx.workspaceId} and t.deleted_at is not null
           and not exists (select 1 from app.journal_entry e where e.workspace_id = t.workspace_id and e.transaction_id = t.id)
        union all
        select 'receipt', r.id, coalesce(r.merchant, r.merchant_raw, 'Receipt'), r.deleted_at, r.total_minor::text, r.currency
          from app.receipt r
         where r.workspace_id = ${ctx.workspaceId} and r.deleted_at is not null
         order by deleted_at desc
         limit 500`.execute(trx);
      return rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        title: r.title,
        deletedAt: r.deleted_at.toISOString(),
        purgeOn: addDays(r.deleted_at.toISOString().slice(0, 10) as CalendarDate, TRASH_DAYS),
        amount: r.amount,
        currency: r.currency ? asCurrencyCode(r.currency) : null,
      }));
    });
  }

  async restoreFromTrash(ctx: Ctx, kind: 'transaction' | 'receipt', id: string): Promise<void> {
    if (kind === 'transaction') {
      await this.transactions.restore(ctx, id);
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

  async requestDeletion(userId: string): Promise<DeletionStatusDto> {
    const purgeAfter = new Date(Date.now() + DELETION_DAYS * 86_400_000);
    await this.db.run({ userId }, async (trx) => {
      await sql`select app.flag_account_deletion(${userId}::uuid, ${purgeAfter})`.execute(trx);
      await trx
        .insertInto('app.security_event')
        .values({
          user_id: userId,
          workspace_id: null,
          kind: 'deletion_requested',
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
    const done = { exports: 0, restores: 0, files: 0, workspaces: 0, users: 0, trash: 0, backups: 0 };
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ kind: string; workspace_id: string | null; id: string; storage_key: string | null }>`
        select * from app.retention_due()`.execute(trx),
    );
    const order: Record<string, number> = { export: 0, restore: 1, file: 2, workspace: 3, user: 4 };
    rows.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    for (const r of rows) {
      try {
        await this.retainOne(r, done);
      } catch (e) {
        this.logger.warn(`Retention failed for a ${r.kind}: ${(e as Error).message}`);
      }
    }
    const trash = await this.db.run({}, (trx) =>
      sql<{ n: number }>`select app.purge_trash() as n`.execute(trx),
    );
    done.trash = Number(trash.rows[0]?.n ?? 0);
    done.backups = await this.backups.runSchedules();
    return done;
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
    } else if (r.kind === 'file') {
      const { rows } = await this.db.run({}, (trx) =>
        sql<{ gone: boolean }>`select app.purge_file(${r.workspace_id}::uuid, ${r.id}::uuid) as gone`.execute(
          trx,
        ),
      );
      // The row first: a row with no file is a visible gap, but a file with no row could never be found again.
      if (rows[0]?.gone && r.storage_key) await this.storage.delete(r.storage_key);
      done.files!++;
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
