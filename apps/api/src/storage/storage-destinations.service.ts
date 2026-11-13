/**
 * The owner's own storage (BAK-03, BAK-05; ADR-0031): connecting, testing, changing, disconnecting, and what it's done so far.
 * Only owners, and RLS says so too. A secret goes in sealed and never comes back out.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { StorageDestinationTable, Trx } from '@montra/db';
import {
  STORAGE_FILE_KINDS,
  type ConnectStorageRequest,
  type StorageConnection,
  type StorageDestinationDto,
  type StorageItemDto,
  type StorageItemsQuery,
  type StorageTestResultDto,
  type UpdateStorageRequest,
} from '@montra/schemas';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import {
  asDestinationError,
  checkDestination,
  defaultFolder,
  openDestination,
  type HostPolicy,
  type StorageDestination,
} from './destinations/index.js';
import { isAdmin } from '../common/roles.js';

type Ctx = { workspaceId: string; userId: string };
export type DestinationRow = Selectable<StorageDestinationTable>;

/** The AES-GCM associated data for the sealed secret. */
export const SECRET_COLUMN = 'storage_destination.secret';

const ownersOnly = () =>
  new AppError(403, 'storage.not_allowed', 'Only an owner or admin can manage the workspace’s storage');
const conflict = () =>
  new AppError(
    409,
    'version.conflict',
    'The storage settings were changed by someone else; reload and try again',
  );

/** What isn't secret, as stored in `config`. */
function settingsOf(c: StorageConnection): Record<string, unknown> {
  return c.kind === 's3' ? { ...c.s3 } : { ...c.webdav };
}

function hintOf(c: StorageConnection): string | null {
  return c.kind === 's3' && c.secret ? c.secret.accessKeyId.slice(-4) : null;
}

@Injectable()
export class StorageDestinationsService {
  readonly policy: HostPolicy;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.policy = { allowPrivate: config.STORAGE_DESTINATIONS_PRIVATE ?? config.NODE_ENV !== 'production' };
  }

  // ----- Reading ---------------------------------------------------------------------------------------------------

  async get(ctx: Ctx, role: string): Promise<StorageDestinationDto | null> {
    if (!isAdmin(role)) throw ownersOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      return row ? this.dto(trx, row) : null;
    });
  }

  async row(trx: Trx, ctx: Ctx): Promise<DestinationRow | undefined> {
    return trx
      .selectFrom('app.storage_destination')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .executeTakeFirst();
  }

  private async dto(trx: Trx, r: DestinationRow): Promise<StorageDestinationDto> {
    const counts = await trx
      .selectFrom('app.storage_mirror_item')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('workspace_id', '=', r.workspace_id)
      .where('destination_id', '=', r.id)
      .groupBy('status')
      .execute();
    const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const last = await trx
      .selectFrom('app.export_job')
      .select(['id', 'created_at', 'destination_status', 'destination_path', 'destination_error'])
      .where('workspace_id', '=', r.workspace_id)
      .where('destination_id', '=', r.id)
      .where('destination_status', 'is not', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const c = r.config as Record<string, unknown>;
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      s3:
        r.kind === 's3'
          ? {
              endpoint: (c.endpoint as string | undefined) ?? null,
              region: String(c.region ?? ''),
              bucket: String(c.bucket ?? ''),
              pathStyle: Boolean(c.pathStyle),
              accessKeyHint: r.secret_hint,
            }
          : null,
      webdav: r.kind === 'webdav' ? { url: String(c.url ?? ''), username: String(c.username ?? '') } : null,
      folder: r.folder,
      mirrorFiles: r.mirror_files,
      fileKinds: r.file_kinds,
      deleteWithMontra: r.delete_with_montra,
      keepBackups: r.keep_backups,
      canDelete: r.can_delete,
      status: r.status,
      lastSuccessAt: r.last_success_at?.toISOString() ?? null,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at?.toISOString() ?? null,
      // 'delete' rows are copies on their way out, still counted as copied until they're gone.
      files: {
        pending: n('pending'),
        done: n('done') + n('delete'),
        failed: n('failed'),
        skipped: n('skipped'),
      },
      lastBackup: last
        ? {
            exportId: last.id,
            at: last.created_at.toISOString(),
            status: last.destination_status!,
            path: last.destination_path,
            error: last.destination_error,
          }
        : null,
      createdAt: r.created_at.toISOString(),
      version: Number(r.version),
    };
  }

  async items(ctx: Ctx, role: string, q: StorageItemsQuery): Promise<StorageItemDto[]> {
    if (!isAdmin(role)) throw ownersOnly();
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.storage_mirror_item as i')
        .leftJoin('app.file as f', (j) =>
          j.onRef('f.workspace_id', '=', 'i.workspace_id').onRef('f.id', '=', 'i.file_id'),
        )
        .select([
          'i.file_id',
          'i.status',
          'i.attempts',
          'i.last_error',
          'i.remote_path',
          'i.mirrored_at',
          'i.next_attempt_at',
          'f.file_name',
          'f.kind',
        ])
        .where('i.workspace_id', '=', ctx.workspaceId)
        .where('i.status', '=', q.status)
        .orderBy(q.status === 'done' ? 'i.mirrored_at' : 'i.next_attempt_at', 'desc')
        .limit(q.limit)
        .execute();
      return rows.map((r) => ({
        fileId: r.file_id,
        fileName: r.file_name ?? null,
        kind: r.kind ?? null,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        path: r.remote_path,
        copiedAt: r.mirrored_at?.toISOString() ?? null,
        nextAttemptAt: r.next_attempt_at.toISOString(),
      }));
    });
  }

  // ----- Testing ---------------------------------------------------------------------------------------------------

  /** Tries a connection without saving it. Leaving the secret out uses the saved one, when the kind is the same. */
  async test(
    ctx: Ctx,
    role: string,
    connection: StorageConnection,
    folder?: string,
  ): Promise<StorageTestResultDto> {
    if (!isAdmin(role)) throw ownersOnly();
    const { row, name } = await this.db.run(ctx, async (trx) => ({
      row: await this.row(trx, ctx),
      name: await this.workspaceName(trx, ctx),
    }));
    const secret =
      connection.secret ?? (row && row.kind === connection.kind ? await this.secretOf(ctx, row) : null);
    if (!secret) {
      return { ok: false, canDelete: false, error: 'Enter the password or secret key.', code: 'invalid' };
    }
    return this.check(
      connection.kind,
      settingsOf(connection),
      secret,
      folder ?? row?.folder ?? defaultFolder(name),
    );
  }

  private async check(
    kind: StorageConnection['kind'],
    settings: unknown,
    secret: unknown,
    folder: string,
  ): Promise<StorageTestResultDto> {
    let dest: StorageDestination | undefined;
    try {
      dest = openDestination(kind, settings, secret, this.policy);
      const { canDelete } = await checkDestination(dest, folder);
      return { ok: true, canDelete, error: null, code: null };
    } catch (e) {
      const err = asDestinationError(e);
      return { ok: false, canDelete: false, error: err.message, code: err.code };
    } finally {
      dest?.close();
    }
  }

  // ----- Changing ----------------------------------------------------------------------------------------------------

  async connect(ctx: Ctx, role: string, req: ConnectStorageRequest): Promise<StorageDestinationDto> {
    if (!isAdmin(role)) throw ownersOnly();
    if (!req.connection.secret)
      throw new AppError(400, 'storage.secret_required', 'Enter the password or secret key');
    const name = await this.db.run(ctx, (trx) => this.workspaceName(trx, ctx));
    const folder = req.folder ?? defaultFolder(name);
    const settings = settingsOf(req.connection);
    const test = await this.check(req.connection.kind, settings, req.connection.secret, folder);
    if (!test.ok) throw new AppError(422, `storage.${test.code}`, test.error!);
    return this.db.run(ctx, async (trx) => {
      if (await this.row(trx, ctx)) {
        throw new AppError(409, 'storage.exists', 'This workspace already has its own storage connected');
      }
      const row = await trx
        .insertInto('app.storage_destination')
        .values({
          workspace_id: ctx.workspaceId,
          kind: req.connection.kind,
          label: req.label,
          config: JSON.stringify(settings),
          secret_enc: (await this.crypto.encrypt(
            trx,
            ctx.workspaceId,
            SECRET_COLUMN,
            JSON.stringify(req.connection.secret),
          ))!,
          secret_hint: hintOf(req.connection),
          folder,
          mirror_files: req.mirrorFiles ?? true,
          file_kinds: req.fileKinds ?? [...STORAGE_FILE_KINDS],
          delete_with_montra: req.deleteWithMontra ?? false,
          keep_backups: req.keepBackups ?? 12,
          can_delete: test.canDelete,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (req.copyExisting && row.mirror_files) await this.queueExisting(trx, row);
      await this.security(trx, ctx, 'storage_connected', { kind: row.kind, label: row.label });
      return this.dto(trx, row);
    });
  }

  async update(ctx: Ctx, role: string, req: UpdateStorageRequest): Promise<StorageDestinationDto> {
    if (!isAdmin(role)) throw ownersOnly();
    const current = await this.db.run(ctx, (trx) => this.row(trx, ctx));
    if (!current) throw new AppError(404, 'not_found', 'No storage is connected');
    if (BigInt(current.version) !== BigInt(req.version)) throw conflict();
    let sealed: { settings: Record<string, unknown>; secret: unknown; canDelete: boolean } | null = null;
    const folder = req.folder ?? current.folder;
    if (req.connection || req.folder) {
      const connection = req.connection;
      if (connection && !connection.secret && connection.kind !== current.kind) {
        throw new AppError(400, 'storage.secret_required', 'Enter the password or secret key');
      }
      const settings = connection ? settingsOf(connection) : (current.config as Record<string, unknown>);
      const secret = connection?.secret ?? (await this.secretOf(ctx, current));
      const test = await this.check(connection?.kind ?? current.kind, settings, secret, folder);
      if (!test.ok) throw new AppError(422, `storage.${test.code}`, test.error!);
      sealed = { settings, secret, canDelete: test.canDelete };
    }
    return this.db.run(ctx, async (trx) => {
      const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
      if (req.label !== undefined) set.label = req.label;
      if (req.folder !== undefined) set.folder = req.folder;
      if (req.mirrorFiles !== undefined) set.mirror_files = req.mirrorFiles;
      if (req.fileKinds !== undefined) set.file_kinds = req.fileKinds;
      if (req.deleteWithMontra !== undefined) set.delete_with_montra = req.deleteWithMontra;
      if (req.keepBackups !== undefined) set.keep_backups = req.keepBackups;
      if (req.paused !== undefined) {
        set.status = req.paused ? 'paused' : 'active';
        if (!req.paused) set.consecutive_failures = 0;
      }
      if (sealed) {
        set.can_delete = sealed.canDelete;
        if (req.connection) {
          set.kind = req.connection.kind;
          set.config = JSON.stringify(sealed.settings);
          if (req.connection.secret) {
            set.secret_enc = await this.crypto.encrypt(
              trx,
              ctx.workspaceId,
              SECRET_COLUMN,
              JSON.stringify(req.connection.secret),
            );
            set.secret_hint = hintOf(req.connection);
          }
        }
        // It worked just now: whatever was failing gets another go.
        if (current.status === 'failing' && req.paused === undefined) {
          set.status = 'active';
          set.consecutive_failures = 0;
        }
      }
      const row = await trx
        .updateTable('app.storage_destination')
        .set(set as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', current.id)
        .where('version', '=', current.version)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw conflict();
      if (sealed || req.paused === false) await this.wake(trx, ctx.workspaceId, row.id, true);
      await this.security(trx, ctx, 'storage_changed', {
        kind: row.kind,
        label: row.label,
        connection: Boolean(req.connection),
        ...(req.paused !== undefined ? { paused: req.paused } : {}),
      });
      return this.dto(trx, row);
    });
  }

  /** Copies stay where they are. Montra forgets the connection, its secret and what it copied. */
  async disconnect(ctx: Ctx, role: string): Promise<void> {
    if (!isAdmin(role)) throw ownersOnly();
    await this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) return;
      await trx
        .updateTable('app.export_job')
        .set({
          destination_status: 'failed',
          destination_error: 'The storage was disconnected before this was saved.',
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .where('destination_status', '=', 'pending')
        .execute();
      await trx
        .deleteFrom('app.storage_destination')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .execute();
      await this.security(trx, ctx, 'storage_disconnected', { kind: row.kind, label: row.label });
    });
  }

  /** Copies the files already in Montra that aren't there yet. */
  async backfill(ctx: Ctx, role: string): Promise<{ queued: number }> {
    if (!isAdmin(role)) throw ownersOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw new AppError(404, 'not_found', 'No storage is connected');
      if (!row.mirror_files) {
        throw new AppError(409, 'storage.not_copying', 'Turn on copying files first');
      }
      return { queued: await this.queueExisting(trx, row) };
    });
  }

  /** Everything that gave up gets another go now: files, and backups whose download hasn't expired. */
  async retry(ctx: Ctx, role: string): Promise<{ queued: number }> {
    if (!isAdmin(role)) throw ownersOnly();
    return this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx);
      if (!row) throw new AppError(404, 'not_found', 'No storage is connected');
      const files = await trx
        .updateTable('app.storage_mirror_item')
        .set({ status: 'pending', attempts: 0, next_attempt_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .where('status', '=', 'failed')
        .executeTakeFirst();
      const backups = await trx
        .updateTable('app.export_job')
        .set({ destination_status: 'pending', destination_attempts: 0, destination_next_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .where('destination_status', '=', 'failed')
        .where('status', '=', 'ready')
        .executeTakeFirst();
      const queued = Number(files.numUpdatedRows) + Number(backups.numUpdatedRows);
      await this.wake(trx, ctx.workspaceId, row.id, true);
      return { queued };
    });
  }

  // ----- For the jobs ----------------------------------------------------------------------------------------------

  async secretOf(ctx: Ctx, row: DestinationRow): Promise<unknown> {
    const plain = await this.db.run(ctx, (trx) =>
      this.crypto.decrypt(trx, ctx.workspaceId, SECRET_COLUMN, row.secret_enc),
    );
    return JSON.parse(plain!);
  }

  async open(ctx: Ctx, row: DestinationRow): Promise<StorageDestination> {
    return openDestination(row.kind, row.config, await this.secretOf(ctx, row), this.policy);
  }

  private async queueExisting(trx: Trx, row: DestinationRow): Promise<number> {
    const res = await sql`
      insert into app.storage_mirror_item (workspace_id, destination_id, file_id)
      select f.workspace_id, ${row.id}::uuid, f.id from app.file f
       where f.workspace_id = ${row.workspace_id}::uuid and f.deleted_at is null and not f.sealed
         and f.kind = any (${row.file_kinds}::text[])
      on conflict do nothing`.execute(trx);
    const queued = Number(res.numAffectedRows ?? 0);
    if (queued > 0) await this.wake(trx, row.workspace_id, row.id, false);
    return queued;
  }

  /** Asks the mirror job to look now; `retryNow` also brings forward what's waiting on a backoff. */
  private async wake(trx: Trx, workspaceId: string, destinationId: string, retryNow: boolean): Promise<void> {
    if (retryNow) {
      await trx
        .updateTable('app.storage_mirror_item')
        .set({ next_attempt_at: new Date() })
        .where('workspace_id', '=', workspaceId)
        .where('destination_id', '=', destinationId)
        .where('status', 'in', ['pending', 'delete'])
        .execute();
      await trx
        .updateTable('app.export_job')
        .set({ destination_next_at: new Date() })
        .where('workspace_id', '=', workspaceId)
        .where('destination_id', '=', destinationId)
        .where('destination_status', '=', 'pending')
        .execute();
    }
    await sql`select app.schedule_system_job('schedule', 'storage.mirror', now())`.execute(trx);
  }

  private async workspaceName(trx: Trx, ctx: Ctx): Promise<string> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('name')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return ws.name;
  }

  private async security(trx: Trx, ctx: Ctx, kind: string, detail: Record<string, unknown>): Promise<void> {
    await trx
      .insertInto('app.security_event')
      .values({ user_id: ctx.userId, workspace_id: ctx.workspaceId, kind, detail: JSON.stringify(detail) })
      .execute();
  }
}
