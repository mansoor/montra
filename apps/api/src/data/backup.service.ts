/**
 * Backups, full export and tax packages (BAK-04, NFR-06, RPT-04; ADR-0019 §7, §8). Archives are read under the requester's RLS at one
 * point in time, so they hold what that person can read, as it stood. They expire after 7 days. Jobs do the work; a password never
 * reaches the queue, only a key derived from it and wrapped by the KMS port.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import yazl from 'yazl';
import { newId, setContext, type ExportJobTable, type Trx } from '@montra/db';
import { addDays, calendarDate, todayIn, type CalendarDate } from '@montra/domain';
import type {
  BackupScheduleDto,
  CreateBackupRequest,
  CreateTaxPackageRequest,
  ExportJobDto,
  ReportType,
  SaveBackupScheduleRequest,
} from '@montra/schemas';
import { AppError, notFound } from '../common/errors.js';
import { KMS_PORT, FieldCrypto, type KmsPort } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { JobQueue, PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { renderReport } from '../reports/report-render.js';
import { ReportsService } from '../reports/reports.service.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { deriveKey, encryptFile, newKdfParams, type KdfParams } from './archive-crypto.js';
import {
  ENCRYPTED,
  exportedTables,
  insertOrder,
  plainName,
  readCatalog,
  withParents,
  type TableInfo,
} from './catalog.js';

type Ctx = { workspaceId: string; userId: string };

export const ARCHIVE_FORMAT = 1;
const EXPIRY_DAYS = 7;
const PAGE = 2000;
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const safe = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const safeFileName = (s: string) => s.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80);

export interface ArchiveManifest {
  format: number;
  createdAt: string;
  workspace: {
    id: string;
    name: string;
    baseCurrency: string;
    timeZone: string;
    priorities: unknown;
    interEntityMode: string;
    aiMode: string;
    aiSettings: unknown;
  };
  requestedBy: string;
  /** Other people's ids that rows may mention. */
  users: string[];
  entityScoped: boolean;
  /** The requester wasn't an owner, so RLS may have left things out. */
  partial: boolean;
  entities: { id: string; name: string; type: string }[];
  tables: Record<string, { rows: number; sha256: string }>;
  files: {
    id: string;
    kind: string;
    name: string;
    mime: string;
    bytes: string;
    sha256: string;
    path: string;
  }[];
  /** Sum of postings per account: what a restore must come back to. */
  balances: Record<string, string>;
  firstDate: string | null;
  lastDate: string | null;
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger('Backup');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(KMS_PORT) private readonly kms: KmsPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  register(): void {
    const run = (fn: (ctx: Ctx, job: Job, exportId: string) => Promise<void>) => async (job: Job) => {
      const payload = job.payload as { exportId: string };
      if (!job.workspace_id || !job.created_by)
        throw new PermanentJobError('job.context', 'Job without workspace or user');
      const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
      await this.mark(ctx, payload.exportId, { status: 'running' });
      try {
        await fn(ctx, job, payload.exportId);
      } catch (e) {
        this.logger.warn(`Export ${payload.exportId} failed: ${(e as Error).message}`);
        await this.mark(ctx, payload.exportId, {
          status: 'failed',
          error: 'This could not be finished. Try again, and tell us if it keeps failing.',
          finished_at: new Date(),
        });
        throw new PermanentJobError('export.failed', (e as Error).message);
      }
      return { exportId: payload.exportId };
    };
    this.worker.register(
      'data.backup',
      run((ctx, job, id) => this.runBackup(ctx, job, id)),
    );
    this.worker.register(
      'data.tax_package',
      run((ctx, _job, id) => this.runTaxPackage(ctx, id)),
    );
  }

  private async mark(
    ctx: Ctx,
    id: string,
    set: Partial<Record<keyof ExportJobTable, unknown>>,
  ): Promise<void> {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.export_job')
        .set(set as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute(),
    );
  }

  // ----- Asking for one -----------------------------------------------------------------------------------------

  async createBackup(ctx: Ctx, role: string, req: CreateBackupRequest): Promise<ExportJobDto> {
    // An owner's archive is the workspace. Others may take books they can read; RLS decides which rows that is.
    if (role !== 'owner' && role !== 'partner') {
      throw new AppError(403, 'export.not_allowed', 'Only owners and partners can take a backup');
    }
    if (role !== 'owner' && !req.entityId) {
      throw new AppError(403, 'export.not_allowed', 'Only an owner can take a backup of the whole workspace');
    }
    // Derived here, so what's queued can't reveal the password.
    const kdf: KdfParams | null = req.password ? newKdfParams() : null;
    const wrapped = req.password && kdf ? await this.kms.wrap(await deriveKey(req.password, kdf)) : null;
    return this.db.run(ctx, async (trx) => {
      if (req.entityId) await this.requireEntity(trx, ctx, req.entityId);
      const id = newId();
      await trx
        .insertInto('app.export_job')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          requested_by: ctx.userId,
          kind: 'backup',
          entity_id: req.entityId ?? null,
          tax_year: null,
          encrypted: Boolean(req.password),
          storage_key: null,
          file_name: null,
          bytes: null,
          error: null,
          finished_at: null,
          expires_at: null,
        })
        .execute();
      await this.queue.enqueue(trx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        queue: 'report',
        type: 'data.backup',
        payload: {
          exportId: id,
          ...(wrapped && kdf ? { wrappedKey: wrapped.toString('base64'), kdf } : {}),
        },
      });
      await this.security(trx, ctx, 'export_requested', {
        kind: 'backup',
        entityScoped: Boolean(req.entityId),
      });
      return this.jobDto(await this.jobRow(trx, ctx, id));
    });
  }

  async createTaxPackage(ctx: Ctx, req: CreateTaxPackageRequest): Promise<ExportJobDto> {
    return this.db.run(ctx, async (trx) => {
      await this.requireEntity(trx, ctx, req.entityId);
      const id = newId();
      await trx
        .insertInto('app.export_job')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          requested_by: ctx.userId,
          kind: 'tax_package',
          entity_id: req.entityId,
          tax_year: req.year,
          encrypted: false,
          storage_key: null,
          file_name: null,
          bytes: null,
          error: null,
          finished_at: null,
          expires_at: null,
        })
        .execute();
      await this.queue.enqueue(trx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        queue: 'report',
        type: 'data.tax_package',
        payload: { exportId: id },
      });
      await this.security(trx, ctx, 'export_requested', { kind: 'tax_package', year: req.year });
      return this.jobDto(await this.jobRow(trx, ctx, id));
    });
  }

  private async requireEntity(trx: Trx, ctx: Ctx, entityId: string) {
    const e = await trx
      .selectFrom('app.entity')
      .select(['id', 'name', 'type', 'functional_currency'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', entityId)
      .executeTakeFirst();
    if (!e) throw notFound('Entity');
    return e;
  }

  private async jobRow(trx: Trx, ctx: Ctx, id: string) {
    const r = await trx
      .selectFrom('app.export_job')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Export');
    return r;
  }

  private jobDto(r: Awaited<ReturnType<BackupService['jobRow']>>): ExportJobDto {
    return {
      id: r.id,
      kind: r.kind,
      entityId: r.entity_id,
      taxYear: r.tax_year,
      status: r.status,
      encrypted: r.encrypted,
      fileName: r.file_name,
      bytes: r.bytes !== null ? String(r.bytes) : null,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at?.toISOString() ?? null,
    };
  }

  async list(ctx: Ctx): Promise<ExportJobDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.export_job')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('requested_by', '=', ctx.userId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute();
      return rows.map((r) => this.jobDto(r));
    });
  }

  async get(ctx: Ctx, id: string): Promise<ExportJobDto> {
    return this.db.run(ctx, async (trx) => this.jobDto(await this.jobRow(trx, ctx, id)));
  }

  /** Each download is on the record: a backup holds everything (AUTH-12). */
  async open(ctx: Ctx, id: string) {
    const row = await this.db.run(ctx, async (trx) => {
      const r = await this.jobRow(trx, ctx, id);
      if (r.status !== 'ready' || !r.storage_key) {
        throw new AppError(409, 'export.not_ready', 'This file is not ready, or has expired');
      }
      await this.security(trx, ctx, 'export_downloaded', { kind: r.kind, file: r.file_name });
      return r;
    });
    return {
      stream: await this.storage.getStream(row.storage_key!),
      fileName: row.file_name!,
      bytes: row.bytes !== null ? String(row.bytes) : null,
      encrypted: row.encrypted,
    };
  }

  private async security(trx: Trx, ctx: Ctx, kind: string, detail: Record<string, unknown>): Promise<void> {
    await trx
      .insertInto('app.security_event')
      .values({ user_id: ctx.userId, workspace_id: ctx.workspaceId, kind, detail: JSON.stringify(detail) })
      .execute();
  }

  // ----- Schedules (BAK-05) --------------------------------------------------------------------------------------

  async getSchedule(ctx: Ctx): Promise<BackupScheduleDto | null> {
    return this.db.run(ctx, async (trx) => {
      const r = await trx
        .selectFrom('app.backup_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('user_id', '=', ctx.userId)
        .executeTakeFirst();
      return r ? this.scheduleDto(r) : null;
    });
  }

  private scheduleDto(r: {
    cadence: 'weekly' | 'monthly';
    destination: 'email_link';
    next_run_on: unknown;
    last_run_at: Date | null;
    version: bigint | string | number;
  }): BackupScheduleDto {
    return {
      cadence: r.cadence,
      destination: r.destination,
      nextRunOn: calendarDate(String(r.next_run_on).slice(0, 10)),
      lastRunAt: r.last_run_at?.toISOString() ?? null,
      version: Number(r.version),
    };
  }

  async saveSchedule(ctx: Ctx, role: string, req: SaveBackupScheduleRequest): Promise<BackupScheduleDto> {
    if (role !== 'owner') throw new AppError(403, 'export.not_allowed', 'Only an owner can schedule backups');
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const next = nextRun(todayIn(ws.time_zone), req.cadence);
      const r = await trx
        .insertInto('app.backup_schedule')
        .values({
          workspace_id: ctx.workspaceId,
          user_id: ctx.userId,
          cadence: req.cadence,
          next_run_on: next,
          last_run_at: null,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'user_id']).doUpdateSet({ cadence: req.cadence, next_run_on: next }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.security(trx, ctx, 'backup_scheduled', { cadence: req.cadence });
      return this.scheduleDto(r);
    });
  }

  async removeSchedule(ctx: Ctx): Promise<void> {
    await this.db.run(ctx, (trx) =>
      trx
        .deleteFrom('app.backup_schedule')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('user_id', '=', ctx.userId)
        .execute(),
    );
  }

  /** Queues what's due. Each schedule owner's backup runs under their own RLS. */
  async runSchedules(): Promise<number> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; user_id: string }>`select * from app.backup_schedules_due()`.execute(trx),
    );
    let queued = 0;
    for (const r of rows) {
      const ctx = { workspaceId: r.workspace_id, userId: r.user_id };
      try {
        await this.db.run(ctx, async (trx) => {
          const s = await trx
            .selectFrom('app.backup_schedule')
            .selectAll()
            .where('workspace_id', '=', ctx.workspaceId)
            .where('user_id', '=', ctx.userId)
            .executeTakeFirstOrThrow();
          const ws = await trx
            .selectFrom('app.workspace')
            .select('time_zone')
            .where('id', '=', ctx.workspaceId)
            .executeTakeFirstOrThrow();
          const id = newId();
          await trx
            .insertInto('app.export_job')
            .values({
              workspace_id: ctx.workspaceId,
              id,
              requested_by: ctx.userId,
              kind: 'backup',
              entity_id: null,
              tax_year: null,
              storage_key: null,
              file_name: null,
              bytes: null,
              error: null,
              finished_at: null,
              expires_at: null,
            })
            .execute();
          await this.queue.enqueue(trx, {
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            queue: 'report',
            type: 'data.backup',
            payload: { exportId: id, scheduled: true },
          });
          await trx
            .updateTable('app.backup_schedule')
            .set({ next_run_on: nextRun(todayIn(ws.time_zone), s.cadence), last_run_at: new Date() })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('user_id', '=', ctx.userId)
            .execute();
        });
        queued++;
      } catch (e) {
        this.logger.warn(`Could not queue a scheduled backup: ${(e as Error).message}`);
      }
    }
    return queued;
  }

  // ----- Building one ------------------------------------------------------------------------------------------------

  private async runBackup(ctx: Ctx, job: Job, exportId: string): Promise<void> {
    const payload = job.payload as { wrappedKey?: string; kdf?: KdfParams; scheduled?: boolean };
    const dir = await mkdtemp(join(tmpdir(), 'montra-backup-'));
    try {
      const { entityId } = await this.db.run(ctx, async (trx) => ({
        entityId: (await this.jobRow(trx, ctx, exportId)).entity_id,
      }));
      const zipPath = join(dir, 'archive.zip');
      const name = await this.writeArchive(ctx, entityId, dir, zipPath);
      let path = zipPath;
      if (payload.wrappedKey && payload.kdf) {
        path = join(dir, 'archive.bin');
        await encryptFile(
          zipPath,
          path,
          await this.kms.unwrap(Buffer.from(payload.wrappedKey, 'base64')),
          payload.kdf,
        );
      }
      const date = new Date().toISOString().slice(0, 10);
      const fileName = `${safeFileName(name)}-backup-${date}${payload.wrappedKey ? '.montra' : '.zip'}`;
      await this.finish(ctx, exportId, path, fileName, payload.scheduled ?? false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async finish(ctx: Ctx, id: string, path: string, fileName: string, notify: boolean): Promise<void> {
    const key = `${ctx.workspaceId}/exports/${id}`;
    await this.storage.putFile(key, path, 'application/octet-stream');
    const { size } = await stat(path);
    await this.db.run(ctx, async (trx) => {
      await trx
        .updateTable('app.export_job')
        .set({
          status: 'ready',
          storage_key: key,
          file_name: fileName,
          bytes: size,
          finished_at: new Date(),
          expires_at: new Date(Date.now() + EXPIRY_DAYS * 86_400_000),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      // BAK-05: the emailed link for a scheduled backup. It leads to the app and asks for a sign-in; it isn't itself a key.
      if (notify) {
        const prefs = await this.notifications.prefsIn(trx, ctx.userId);
        await this.notifications.create(
          trx,
          ctx,
          {
            type: 'backup_ready',
            dedupeKey: `backup_ready:${id}`,
            title: 'Your scheduled backup is ready',
            body: `It's ready to download for ${EXPIRY_DAYS} days.`,
            link: `/w/${ctx.workspaceId}/settings?tab=data`,
          },
          prefs,
        );
      }
    });
  }

  /** Writes the ZIP; returns the name to file it under. */
  private async writeArchive(
    ctx: Ctx,
    entityId: string | null,
    dir: string,
    zipPath: string,
  ): Promise<string> {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(zipPath);
    const done = pipeline(zip.outputStream, output);
    const manifest = await this.dumpTables(ctx, entityId, dir, zip);
    const scope = entityId ? manifest.entities.find((e) => e.id === entityId)?.name : manifest.workspace.name;
    await this.writeSummaryWorkbook(ctx, entityId, join(dir, 'summary.xlsx'));
    zip.addFile(join(dir, 'summary.xlsx'), 'summary.xlsx');
    for (const f of manifest.files) {
      try {
        const bytes = await this.storage.get(f.path);
        // The path in the manifest is where it sits in the archive, set once it's in there.
        const path = `attachments/${f.id}-${safeFileName(f.name)}`;
        zip.addBuffer(Buffer.from(bytes), path);
        f.path = path;
      } catch (e) {
        this.logger.warn(`A file could not be read for a backup: ${(e as Error).message}`);
        f.path = '';
      }
    }
    manifest.files = manifest.files.filter((f) => f.path);
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
    zip.addBuffer(Buffer.from(README), 'README.txt');
    zip.end();
    await done;
    return scope ?? 'montra';
  }

  /** Every table at one point in time, as JSON lines and CSV. */
  private async dumpTables(
    ctx: Ctx,
    entityId: string | null,
    dir: string,
    zip: yazl.ZipFile,
  ): Promise<ArchiveManifest> {
    return this.db.kysely
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await setContext(trx, ctx);
        const ws = await trx
          .selectFrom('app.workspace')
          .selectAll()
          .where('id', '=', ctx.workspaceId)
          .executeTakeFirstOrThrow();
        const member = await trx
          .selectFrom('app.workspace_member')
          .select('role')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', ctx.userId)
          .executeTakeFirst();
        const { rows: users } = await sql<{ id: string }>`
          select user_id as id from app.workspace_active_members(${ctx.workspaceId}::uuid)`.execute(trx);
        const catalog = await readCatalog(trx);
        const tables = exportedTables(catalog);
        const { order } = insertOrder(catalog, tables);
        const partial = member?.role !== 'owner';
        // Rows are checked against their parents only when something was left out, since that's the only way one can be missing.
        const filtering = partial || Boolean(entityId);
        const needed = new Set(
          tables.flatMap((t) =>
            catalog
              .get(t)!
              .fks.filter((f) => f.refColumns.includes('id'))
              .map((f) => f.refTable),
          ),
        );
        const kept = new Map<string, Set<string>>();
        const manifest: ArchiveManifest = {
          format: ARCHIVE_FORMAT,
          createdAt: new Date().toISOString(),
          workspace: {
            id: ws.id,
            name: ws.name,
            baseCurrency: ws.base_currency,
            timeZone: ws.time_zone,
            priorities: ws.priorities,
            interEntityMode: ws.inter_entity_mode,
            aiMode: ws.ai_mode,
            aiSettings: ws.ai_settings,
          },
          requestedBy: ctx.userId,
          users: users.map((u) => u.id),
          entityScoped: Boolean(entityId),
          partial,
          entities: [],
          tables: {},
          files: [],
          balances: {},
          firstDate: null,
          lastDate: null,
        };
        const balances = new Map<string, bigint>();
        for (const table of order) {
          const info = catalog.get(table)!;
          const hash = createHash('sha256');
          const jsonlPath = join(dir, `${table}.jsonl`);
          const csvPath = join(dir, `${table}.csv`);
          const jsonl = createWriteStream(jsonlPath);
          const csv = createWriteStream(csvPath);
          const columns = [...info.columns.keys()].map((c) => (ENCRYPTED[table]?.[c] ? plainName(c) : c));
          await write(csv, columns.map(csvCell).join(',') + '\r\n');
          const ids = needed.has(table) ? new Set<string>() : null;
          let rows = 0;
          const scope = entityId ? scopeOf(info, entityId) : sql`true`;
          for (let offset = 0; ; offset += PAGE) {
            const { rows: page } = await sql<{ row: Record<string, unknown> }>`
              select to_jsonb(t) as row from ${sql.table(`app.${table}`)} t
               where t.workspace_id = ${ctx.workspaceId} and ${scope}
               order by t.ctid limit ${PAGE} offset ${offset}`.execute(trx);
            for (const raw of page) {
              let row: Record<string, unknown> | null = raw.row;
              if (filtering) row = withParents(info, row, kept);
              if (!row) continue;
              row = await this.decrypted(trx, ctx, table, row);
              const line = JSON.stringify(row) + '\n';
              hash.update(line);
              await write(jsonl, line);
              await write(csv, columns.map((c) => csvCell(row![c])).join(',') + '\r\n');
              rows++;
              if (ids && row.id) ids.add(String(row.id));
              if (table === 'entity') {
                manifest.entities.push({
                  id: String(row.id),
                  name: String(row.name),
                  type: String(row.type),
                });
              }
              if (table === 'posting') {
                const a = String(row.ledger_account_id);
                balances.set(a, (balances.get(a) ?? 0n) + BigInt(String(row.amount_minor)));
              }
              if (table === 'transaction' && row.txn_date) {
                const d = String(row.txn_date).slice(0, 10);
                if (!manifest.firstDate || d < manifest.firstDate) manifest.firstDate = d;
                if (!manifest.lastDate || d > manifest.lastDate) manifest.lastDate = d;
              }
              if (table === 'file' && !row.deleted_at) {
                manifest.files.push({
                  id: String(row.id),
                  kind: String(row.kind),
                  name: String(row.file_name),
                  mime: String(row.mime),
                  bytes: String(row.bytes),
                  sha256: String(row.sha256),
                  // Where it's stored, until it's been copied in.
                  path: String(row.storage_key),
                });
              }
            }
            if (page.length < PAGE) break;
          }
          await close(jsonl);
          await close(csv);
          if (ids) kept.set(table, ids);
          manifest.tables[table] = { rows, sha256: hash.digest('hex') };
          zip.addFile(jsonlPath, `data/${table}.jsonl`);
          zip.addFile(csvPath, `csv/${table}.csv`);
        }
        manifest.balances = Object.fromEntries([...balances].map(([k, v]) => [k, String(v)]));
        return manifest;
      });
  }

  /** Replaces an encrypted column with its text, so the archive is readable and can be re-encrypted on restore. */
  private async decrypted(
    trx: Trx,
    ctx: Ctx,
    table: string,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const columns = ENCRYPTED[table];
    if (!columns) return row;
    const out = { ...row };
    for (const [column, label] of Object.entries(columns)) {
      const value = out[column];
      delete out[column];
      if (typeof value === 'string' && value.startsWith('\\x')) {
        out[plainName(column)] = await this.crypto.decrypt(
          trx,
          ctx.workspaceId,
          label,
          Buffer.from(value.slice(2), 'hex'),
        );
      } else {
        out[plainName(column)] = null;
      }
    }
    return out;
  }

  /** NFR-06: the part most people will open: transactions, accounts and categories in one workbook. */
  private async writeSummaryWorkbook(ctx: Ctx, entityId: string | null, path: string): Promise<void> {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useStyles: false,
      useSharedStrings: false,
    });
    await this.db.run(ctx, async (trx) => {
      const transactions = wb.addWorksheet('Transactions');
      transactions.addRow(['Date', 'Payee', 'Description', 'Amount', 'Currency', 'Status', 'Note']).commit();
      for (let offset = 0; ; offset += PAGE) {
        const { rows } = await sql<{
          d: string;
          payee: string | null;
          description: string;
          amount: string | null;
          currency: string | null;
          status: string;
          memo_enc: Buffer | null;
        }>`
          select t.txn_date::text as d, t.payee_raw as payee, t.description, t.spec->>'amount' as amount,
                 t.spec->>'currency' as currency, t.status, t.memo_enc
            from app.transaction t
           where t.workspace_id = ${ctx.workspaceId}
             ${entityId ? sql`and t.primary_entity_id = ${entityId}` : sql``}
           order by t.txn_date, t.id limit ${PAGE} offset ${offset}`.execute(trx);
        for (const r of rows) {
          const memo = await this.crypto.decrypt(trx, ctx.workspaceId, 'transaction.memo', r.memo_enc);
          transactions
            .addRow([
              r.d,
              safe(r.payee),
              safe(r.description),
              r.amount ? BigInt(r.amount).toString() : null,
              r.currency,
              r.status,
              safe(memo),
            ])
            .commit();
        }
        if (rows.length < PAGE) break;
      }
      transactions.commit();
      const accounts = wb.addWorksheet('Accounts');
      accounts.addRow(['Name', 'Type', 'Currency', 'Tax line']).commit();
      const list = await trx
        .selectFrom('app.ledger_account')
        .select(['name', 'type', 'currency', 'tax_line_code'])
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!entityId, (q) => q.where('entity_id', '=', entityId!))
        .orderBy('type')
        .orderBy('name')
        .execute();
      for (const a of list) accounts.addRow([safe(a.name), a.type, a.currency, a.tax_line_code]).commit();
      accounts.commit();
    });
    await wb.commit();
  }

  // ----- Tax package (RPT-04, UP-10) --------------------------------------------------------------------------------------

  private async runTaxPackage(ctx: Ctx, exportId: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'montra-tax-'));
    try {
      const { job, entity } = await this.db.run(ctx, async (trx) => {
        const j = await this.jobRow(trx, ctx, exportId);
        return { job: j, entity: await this.requireEntity(trx, ctx, j.entity_id!) };
      });
      const year = job.tax_year!;
      const entityId = entity.id;
      const from = `${year}-01-01` as CalendarDate;
      const to = `${year}-12-31` as CalendarDate;
      const types: ReportType[] = [
        'pnl',
        'general-ledger',
        'trial-balance',
        'balance-sheet',
        'spending',
        ...(entity.type === 'business' ? (['schedule-c'] as const) : []),
        ...(entity.type === 'rental' ? (['schedule-e'] as const) : []),
      ];
      const zip = new yazl.ZipFile();
      const zipPath = join(dir, 'package.zip');
      const done = pipeline(zip.outputStream, createWriteStream(zipPath));
      for (const type of types) {
        const report = await this.reports.run(ctx, type, { entityId, from, to });
        for (const format of ['pdf', 'csv'] as const) {
          const file = await renderReport(report, format, entity.name);
          zip.addBuffer(Buffer.from(file.bytes), `reports/${type}.${format}`);
        }
      }
      // Receipts for the year, with an index an accountant can sort.
      const documents = await this.db.run(ctx, async (trx) => {
        const { rows } = await sql<{
          id: string;
          merchant: string | null;
          d: string;
          total: string | null;
          currency: string | null;
          attachment_ids: string[];
        }>`
          select r.id, r.merchant, r.receipt_date::text as d, r.total_minor::text as total, r.currency, r.attachment_ids
            from app.receipt r
           where r.workspace_id = ${ctx.workspaceId} and r.entity_id = ${entityId} and r.deleted_at is null
             and r.receipt_date between ${from} and ${to}
           order by r.receipt_date, r.id`.execute(trx);
        const ids = rows.flatMap((r) => r.attachment_ids);
        const files = ids.length
          ? await trx
              .selectFrom('app.file')
              .select(['id', 'storage_key', 'file_name'])
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', 'in', ids)
              .execute()
          : [];
        return { rows, files: new Map(files.map((f) => [f.id, f])) };
      });
      const index = ['Date,Merchant,Total,Currency,File'];
      for (const r of documents.rows) {
        const names: string[] = [];
        for (const id of r.attachment_ids) {
          const f = documents.files.get(id);
          if (!f) continue;
          try {
            const path = `receipts/${r.d}-${safeFileName(r.merchant ?? 'receipt')}-${id.slice(0, 8)}-${safeFileName(f.file_name)}`;
            zip.addBuffer(Buffer.from(await this.storage.get(f.storage_key)), path);
            names.push(path);
          } catch (e) {
            this.logger.warn(`A receipt could not be read: ${(e as Error).message}`);
          }
        }
        index.push(
          [r.d, csvCell(r.merchant), r.total ?? '', r.currency ?? '', csvCell(names.join('; '))].join(','),
        );
      }
      zip.addBuffer(Buffer.from(index.join('\r\n') + '\r\n'), 'receipts.csv');
      zip.addBuffer(
        Buffer.from(
          `Tax package for ${entity.name}, ${year}.\r\n\r\nreports/ holds each report as PDF and CSV. receipts/ holds the receipts for the year, listed in receipts.csv.\r\n\r\nPrepared by Montra for your records and your tax professional. It isn't tax advice, and the figures are on a cash basis.\r\n`,
        ),
        'README.txt',
      );
      zip.end();
      await done;
      await this.finish(
        ctx,
        exportId,
        zipPath,
        `${safeFileName(entity.name)}-tax-package-${year}.zip`,
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

const README = `This is a backup of your Montra data.

manifest.json  what's in here, with a checksum for each table and file
data/          every table as JSON lines, which is what Montra restores from
csv/           the same tables as CSV
summary.xlsx   transactions and accounts, for reading
attachments/   your receipts, statements and other documents

Sensitive fields such as notes are decrypted in this file, so keep it somewhere safe. If you protected it with a password,
the file you downloaded is encrypted with AES-256-GCM and Montra can restore it with that password.
`;

/** Text a spreadsheet would run as a formula is neutralized, as in other exports. */
const safe = (s: string | null) => (s && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function nextRun(today: CalendarDate, cadence: 'weekly' | 'monthly'): CalendarDate {
  return addDays(today, cadence === 'weekly' ? 7 : 30);
}

function scopeOf(info: TableInfo, entityId: string) {
  if (info.columns.has('entity_id')) return sql`(t.entity_id = ${entityId} or t.entity_id is null)`;
  if (info.columns.has('primary_entity_id')) return sql`t.primary_entity_id = ${entityId}`;
  if (info.name === 'entity') return sql`t.id = ${entityId}`;
  return sql`true`;
}

function write(stream: WriteStream, text: string): Promise<void> | void {
  if (!stream.write(text)) return new Promise((resolve) => stream.once('drain', () => resolve()));
}

const close = (stream: WriteStream) =>
  new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });
