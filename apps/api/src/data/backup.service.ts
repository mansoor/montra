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
import {
  addDays,
  asCurrencyCode,
  calendarDate,
  money,
  toDecimalString,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import {
  MIRROR_DESTINATION_KINDS,
  type BackupScheduleDto,
  type CreateBackupRequest,
  type CreateTaxPackageRequest,
  type ExportJobDto,
  type ReportType,
  type SaveBackupScheduleRequest,
} from '@montra/schemas';
import { AppError, notFound } from '../common/errors.js';
import { KMS_PORT, FieldCrypto, type KmsPort } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { JobQueue, PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { renderReport } from '../reports/report-render.js';
import { ReportsService } from '../reports/reports.service.js';
import { FileBytes, type HeldFile } from '../storage/file-bytes.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import {
  leftOutLine,
  packageFileName,
  README_LINE,
  taxFormsCheckPdf,
  taxFormsCsv,
} from '../tax-forms/tax-form-package.js';
import { TaxFormsService } from '../tax-forms/tax-forms.service.js';
import { deriveKey, encryptFile, newKdfParams, type KdfParams } from './archive-crypto.js';
import {
  ENCRYPTED,
  exportedTables,
  FILE_HOLDERS,
  insertOrder,
  plainName,
  readCatalog,
  withParents,
  type TableInfo,
} from './catalog.js';
import { isAdmin } from '../common/roles.js';

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
    /** ADR-0034: sealed in storage; the archive holds it decrypted, and a restore seals it again. */
    sealed?: boolean;
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
    @Inject(TaxFormsService) private readonly taxForms: TaxFormsService,
    @Inject(FileBytes) private readonly files: FileBytes,
  ) {}

  register(): void {
    const run = (fn: (ctx: Ctx, job: Job, exportId: string) => Promise<void>) => async (job: Job) => {
      const payload = job.payload as { exportId: string };
      if (!job.workspace_id || !job.created_by)
        throw new PermanentJobError('job.context', 'Job without workspace or user');
      const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
      await this.mark(ctx, payload.exportId, { status: 'running', waiting_until: null });
      try {
        await fn(ctx, job, payload.exportId);
      } catch (e) {
        if (e instanceof WaitForVault) {
          // ADR-0054 §5a: once, until the vault's daily reset; then it is made with whatever it can get.
          await this.waitForVault(ctx, job, payload.exportId, e.until);
          return { exportId: payload.exportId, waitingUntil: e.until.toISOString() };
        }
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
      run((ctx, job, id) => this.runTaxPackage(ctx, job, id)),
    );
  }

  /**
   * ADR-0054 §5a: a background archive met the vault's daily read cap. It waits once: the archive is queued again for
   * just after the vault's reset (saying so on its screen), and that run lists anything still unavailable rather than
   * waiting again.
   */
  private async waitForVault(ctx: Ctx, job: Job, exportId: string, until: Date): Promise<void> {
    const at = new Date(Math.max(until.getTime(), Date.now()) + VAULT_RESET_MARGIN_MS);
    await this.db.run(ctx, async (trx) => {
      await trx
        .updateTable('app.export_job')
        .set({ status: 'queued', waiting_until: at })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', exportId)
        .execute();
      await this.queue.enqueue(trx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        queue: 'report',
        type: job.type,
        payload: { ...(job.payload as Record<string, unknown>), vaultWaited: true },
        runAfter: at,
      });
    });
    this.logger.log(`Export ${exportId} waits for the vault's daily reset`);
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
    if (!isAdmin(role) && role !== 'partner') {
      throw new AppError(403, 'export.not_allowed', 'Only owners, admins and partners can take a backup');
    }
    if (!isAdmin(role) && !req.entityId) {
      throw new AppError(
        403,
        'export.not_allowed',
        'Only an owner or admin can take a backup of the whole workspace',
      );
    }
    // Derived here, so what's queued can't reveal the password.
    if (req.saveToStorage && !isAdmin(role)) {
      throw new AppError(
        403,
        'storage.not_allowed',
        'Only an owner or admin can save backups to the workspace’s storage',
      );
    }
    const kdf: KdfParams | null = req.password ? newKdfParams() : null;
    const wrapped = req.password && kdf ? await this.kms.wrap(await deriveKey(req.password, kdf)) : null;
    return this.db.run(ctx, async (trx) => {
      if (req.entityId) await this.requireEntity(trx, ctx, req.entityId);
      // ADR-0031 §7: a copy goes to the owner's storage too, unless they said not to.
      const destination =
        isAdmin(role) && req.saveToStorage !== false ? await this.destinationIn(trx, ctx) : undefined;
      if (req.saveToStorage && !destination) {
        throw new AppError(409, 'storage.not_connected', 'Connect your own storage first');
      }
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
          destination_id: destination?.id ?? null,
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

  /**
   * The workspace's own storage, if it has one and the caller can see it (owners only, by RLS). Backups go to the mirror,
   * never to the household's vault (ADR-0054; BAK-05 unchanged).
   */
  private async destinationIn(trx: Trx, ctx: Ctx) {
    return trx
      .selectFrom('app.storage_destination')
      .select(['id', 'status'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kind', 'in', MIRROR_DESTINATION_KINDS)
      .executeTakeFirst();
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
      missingFiles: r.missing_files,
      waitingUntil: r.waiting_until?.toISOString() ?? null,
      storageCopy: r.destination_status
        ? { status: r.destination_status, path: r.destination_path, error: r.destination_error }
        : r.destination_id
          ? { status: 'pending', path: null, error: null }
          : null,
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
    destination: 'email_link' | 'storage';
    wrapped_key: Buffer | null;
    next_run_on: unknown;
    last_run_at: Date | null;
    version: bigint | string | number;
  }): BackupScheduleDto {
    return {
      cadence: r.cadence,
      destination: r.destination,
      encrypted: r.wrapped_key !== null,
      nextRunOn: calendarDate(String(r.next_run_on).slice(0, 10)),
      lastRunAt: r.last_run_at?.toISOString() ?? null,
      version: Number(r.version),
    };
  }

  async saveSchedule(ctx: Ctx, role: string, req: SaveBackupScheduleRequest): Promise<BackupScheduleDto> {
    if (!isAdmin(role))
      throw new AppError(403, 'export.not_allowed', 'Only an owner or admin can schedule backups');
    // ADR-0031 §7: the key derived here is kept, wrapped by the KMS port. The password isn't.
    let key: { wrapped_key: Buffer | null; kdf: string | null } | undefined;
    if (req.password === null) key = { wrapped_key: null, kdf: null };
    else if (req.password) {
      const kdf = newKdfParams();
      key = {
        wrapped_key: await this.kms.wrap(await deriveKey(req.password, kdf)),
        kdf: JSON.stringify(kdf),
      };
    }
    return this.db.run(ctx, async (trx) => {
      if (req.destination === 'storage' && !(await this.destinationIn(trx, ctx))) {
        throw new AppError(409, 'storage.not_connected', 'Connect your own storage first');
      }
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
          destination: req.destination,
          next_run_on: next,
          last_run_at: null,
          ...(key ?? {}),
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'user_id']).doUpdateSet({
            cadence: req.cadence,
            destination: req.destination,
            next_run_on: next,
            version: sql`app.backup_schedule.version + 1`,
            ...(key ?? {}),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.security(trx, ctx, 'backup_scheduled', {
        cadence: req.cadence,
        destination: req.destination,
        encrypted: r.wrapped_key !== null,
      });
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
          // Disconnected since it was scheduled: the emailed link, as before.
          const destination = s.destination === 'storage' ? await this.destinationIn(trx, ctx) : undefined;
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
              encrypted: s.wrapped_key !== null,
              destination_id: destination?.id ?? null,
              scheduled: true,
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
              scheduled: true,
              ...(s.wrapped_key && s.kdf ? { wrappedKey: s.wrapped_key.toString('base64'), kdf: s.kdf } : {}),
            },
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
    const payload = job.payload as {
      wrappedKey?: string;
      kdf?: KdfParams;
      scheduled?: boolean;
      vaultWaited?: boolean;
    };
    const dir = await mkdtemp(join(tmpdir(), 'montra-backup-'));
    try {
      const { entityId } = await this.db.run(ctx, async (trx) => ({
        entityId: (await this.jobRow(trx, ctx, exportId)).entity_id,
      }));
      const zipPath = join(dir, 'archive.zip');
      const { name, missing } = await this.writeArchive(ctx, entityId, dir, zipPath, !payload.vaultWaited);
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
      await this.finish(ctx, exportId, path, fileName, payload.scheduled ?? false, missing);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async finish(
    ctx: Ctx,
    id: string,
    path: string,
    fileName: string,
    notify: boolean,
    missing: number,
  ): Promise<void> {
    const key = `${ctx.workspaceId}/exports/${id}`;
    await this.storage.putFile(key, path, 'application/octet-stream');
    const { size } = await stat(path);
    await this.db.run(ctx, async (trx) => {
      const job = await trx
        .updateTable('app.export_job')
        .set({
          status: 'ready',
          storage_key: key,
          file_name: fileName,
          bytes: size,
          finished_at: new Date(),
          expires_at: new Date(Date.now() + EXPIRY_DAYS * 86_400_000),
          missing_files: missing,
          waiting_until: null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returning(['destination_id'])
        .executeTakeFirstOrThrow();
      // ADR-0031 §7: the mirror job saves it to the owner's storage, and tells a schedule's owner how that went.
      if (job.destination_id) {
        await trx
          .updateTable('app.export_job')
          .set({ destination_status: 'pending', destination_next_at: new Date(), destination_attempts: 0 })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .execute();
        await sql`select app.schedule_system_job('schedule', 'storage.mirror', now())`.execute(trx);
      }
      // BAK-05: the emailed link for a scheduled backup. It leads to the app and asks for a sign-in; it isn't itself a key.
      if (notify && !job.destination_id) {
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

  /**
   * Writes the ZIP; returns the name to file it under and how many files it couldn't include. `mayWait`: the vault's
   * daily read cap stops it to wait for the reset (`WaitForVault`) rather than leaving files out.
   */
  private async writeArchive(
    ctx: Ctx,
    entityId: string | null,
    dir: string,
    zipPath: string,
    mayWait: boolean,
  ): Promise<{ name: string; missing: number }> {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(zipPath);
    const done = pipeline(zip.outputStream, output);
    const manifest = await this.dumpTables(ctx, entityId, dir, zip);
    const scope = entityId ? manifest.entities.find((e) => e.id === entityId)?.name : manifest.workspace.name;
    await this.writeSummaryWorkbook(ctx, entityId, join(dir, 'summary.xlsx'));
    zip.addFile(join(dir, 'summary.xlsx'), 'summary.xlsx');
    // ADR-0054 §5a: every file Montra can get, from wherever it is held (the vault included); any it can't is listed in
    // the README, and the backup goes on without it.
    const missing: MissingInArchive[] = [];
    for (const f of manifest.files) {
      const got = await this.readForArchive(
        ctx,
        { id: f.id, storage_key: f.path || null, sha256: f.sha256 },
        mayWait,
      ).catch(abandon(zip, done));
      if (!got.ok) {
        missing.push({ id: f.id, name: f.name, words: got.words });
        f.path = '';
        continue;
      }
      try {
        const bytes = f.sealed
          ? await this.db.run(ctx, (trx) => this.crypto.openBytes(trx, ctx.workspaceId, f.id, got.bytes))
          : got.bytes;
        // The path in the manifest is where it sits in the archive, set once it's in there.
        const path = `attachments/${f.id}-${safeFileName(f.name)}`;
        zip.addBuffer(Buffer.from(bytes), path);
        f.path = path;
      } catch (e) {
        this.logger.warn(`File ${f.id} could not be opened for a backup: ${(e as Error).name}`);
        missing.push({ id: f.id, name: f.name, words: UNREADABLE });
        f.path = '';
      }
    }
    manifest.files = manifest.files.filter((f) => f.path);
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
    zip.addBuffer(Buffer.from(README + missingSection(missing, '\n')), 'README.txt');
    zip.end();
    await done;
    return { name: scope ?? 'montra', missing: missing.length };
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
        const partial = !isAdmin(member?.role);
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
        // Files carry no books or person, so RLS lets every member read their rows. A file goes only with a row the
        // archive holds that holds it: a partner's archive leaves out the payslips' files of other members (PAY-09), the
        // tax forms' (ADR-0052 §8.4), others' scans and the files of books they can't read; one set of books' leaves out
        // the other books' files. An owner's or admin's archive of the workspace takes every file, as before.
        const heldFiles = filtering ? await this.filesHeld(trx, ctx, catalog, tables, entityId) : null;
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
          // A sealed column goes by its plain name; once, where the plain column is still there too (BIZ-26).
          const columns = [
            ...new Set([...info.columns.keys()].map((c) => (ENCRYPTED[table]?.[c] ? plainName(c) : c))),
          ];
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
              if (table === 'file' && heldFiles && !heldFiles.has(String(row.id))) continue;
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
                  // Where it's stored, until it's been copied in: empty for a file only the vault holds (ADR-0054).
                  path: row.storage_key ? String(row.storage_key) : '',
                  ...(row.sealed ? { sealed: true } : {}),
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

  /**
   * The files that rows going into this archive hold: those the maker's RLS shows, in the archive's books. Read in the
   * archive's snapshot, before the `file` table, which comes ahead of most of the rows that hold files.
   */
  private async filesHeld(
    trx: Trx,
    ctx: Ctx,
    catalog: Map<string, TableInfo>,
    tables: readonly string[],
    entityId: string | null,
  ): Promise<Set<string>> {
    const held = new Set<string>();
    for (const [table, columns] of Object.entries(FILE_HOLDERS)) {
      const info = catalog.get(table);
      if (!info || !tables.includes(table)) continue;
      const scope = entityId ? scopeOf(info, entityId) : sql`true`;
      for (const column of columns) {
        const ref = sql.ref(`t.${column}`);
        const { rows } = await sql<{ id: string | null }>`
          select distinct ${column.endsWith('_ids') ? sql`unnest(${ref})` : ref}::text as id
            from ${sql.table(`app.${table}`)} t
           where t.workspace_id = ${ctx.workspaceId} and ${scope}`.execute(trx);
        for (const r of rows) if (r.id) held.add(r.id);
      }
    }
    return held;
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
      // A plain value not sealed yet (a business's tax numbers before the job reaches them, BIZ-26) is the current one.
      if (typeof out[plainName(column)] === 'string') continue;
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
      // UP-05: the account and category each one is in, and the amount in the currency's units (12.34, not 1234), so
      // the sheet can be summed and pivoted as it is.
      transactions
        .addRow([
          'Date',
          'Account',
          'Payee',
          'Description',
          'Category',
          'Amount',
          'Currency',
          'Status',
          'Note',
        ])
        .commit();
      for (let offset = 0; ; offset += PAGE) {
        const { rows } = await sql<{
          d: string;
          account: string | null;
          payee: string | null;
          description: string;
          category: string | null;
          splits: number;
          amount: string | null;
          currency: string | null;
          status: string;
          memo_enc: Buffer | null;
        }>`
          select t.txn_date::text as d, acc.name as account, t.payee_raw as payee, t.description,
                 cat.name as category, coalesce(jsonb_array_length(t.spec->'splits'), 0)::int as splits,
                 t.spec->>'amount' as amount, t.spec->>'currency' as currency, t.status, t.memo_enc
            from app.transaction t
            left join app.ledger_account acc
              on acc.workspace_id = t.workspace_id and acc.id = (t.spec->>'accountId')::uuid
            left join app.ledger_account cat
              on cat.workspace_id = t.workspace_id and cat.id = (t.spec->'splits'->0->>'accountId')::uuid
           where t.workspace_id = ${ctx.workspaceId}
             ${entityId ? sql`and t.primary_entity_id = ${entityId}` : sql``}
           order by t.txn_date, t.id limit ${PAGE} offset ${offset}`.execute(trx);
        for (const r of rows) {
          const memo = await this.crypto.decrypt(trx, ctx.workspaceId, 'transaction.memo', r.memo_enc);
          transactions
            .addRow([
              r.d,
              safe(r.account),
              safe(r.payee),
              safe(r.description),
              r.splits > 1 ? 'Split' : safe(r.category),
              r.amount && r.currency
                ? Number(toDecimalString(money(BigInt(r.amount), asCurrencyCode(r.currency))))
                : null,
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
      // ACC-15: an account's holders, in order. Its full number is in bank_account's own file, not here.
      accounts.addRow(['Name', 'Type', 'Currency', 'Tax line', 'Holders']).commit();
      const list = await trx
        .selectFrom('app.ledger_account as a')
        .select([
          'a.name',
          'a.type',
          'a.currency',
          'a.tax_line_code',
          (eb) =>
            eb
              .selectFrom('app.account_holder as h')
              .select(sql<string>`string_agg(h.name, ', ' order by h.position)`.as('n'))
              .whereRef('h.workspace_id', '=', 'a.workspace_id')
              .whereRef('h.ledger_account_id', '=', 'a.id')
              .as('holders'),
        ])
        .where('a.workspace_id', '=', ctx.workspaceId)
        .$if(!!entityId, (q) => q.where('a.entity_id', '=', entityId!))
        .orderBy('a.type')
        .orderBy('a.name')
        .execute();
      for (const a of list) {
        accounts.addRow([safe(a.name), a.type, a.currency, a.tax_line_code, safe(a.holders)]).commit();
      }
      accounts.commit();
    });
    await wb.commit();
  }

  // ----- Tax package (RPT-04, UP-10) --------------------------------------------------------------------------------------

  private async runTaxPackage(ctx: Ctx, job: Job, exportId: string): Promise<void> {
    const mayWait = !(job.payload as { vaultWaited?: boolean }).vaultWaited;
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
              .select(['id', 'storage_key', 'sha256', 'file_name'])
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', 'in', ids)
              .execute()
          : [];
        return { rows, files: new Map(files.map((f) => [f.id, f])) };
      });
      // ADR-0054 §5a: each file from wherever it is held; any Montra can't get is listed, and the package goes on.
      const missing: MissingInArchive[] = [];
      const index = ['Date,Merchant,Total,Currency,File'];
      for (const r of documents.rows) {
        const names: string[] = [];
        for (const id of r.attachment_ids) {
          const f = documents.files.get(id);
          if (!f) continue;
          const path = `receipts/${r.d}-${safeFileName(r.merchant ?? 'receipt')}-${id.slice(0, 8)}-${safeFileName(f.file_name)}`;
          const got = await this.readForArchive(ctx, f, mayWait).catch(abandon(zip, done));
          if (!got.ok) {
            if (!missing.some((m) => m.id === id)) missing.push({ id, name: f.file_name, words: got.words });
            continue;
          }
          zip.addBuffer(Buffer.from(got.bytes), path);
          names.push(path);
        }
        index.push(
          [r.d, csvCell(r.merchant), r.total ?? '', r.currency ?? '', csvCell(names.join('; '))].join(','),
        );
      }
      zip.addBuffer(Buffer.from(index.join('\r\n') + '\r\n'), 'receipts.csv');
      const forms = await this.taxFormsInPackage(
        ctx,
        zip,
        entityId,
        entity.name,
        year,
        missing,
        mayWait,
      ).catch(abandon(zip, done));
      const formLines = forms
        ? `${README_LINE}${forms.leftOut ? ` ${leftOutLine(forms.leftOut)}` : ''}\r\n\r\n`
        : '';
      zip.addBuffer(
        Buffer.from(
          `Tax package for ${entity.name}, ${year}.\r\n\r\nreports/ holds each report as PDF and CSV. receipts/ holds the receipts for the year, listed in receipts.csv.\r\n\r\n${formLines}Prepared by Montra for your records and your tax professional. It isn't tax advice, and the figures are on a cash basis.\r\n${missingSection(missing, '\r\n')}`,
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
        missing.length,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * A file for an archive: from wherever it is held, or why not; never an error that stops the archive, but for the
   * vault's daily read cap while the archive may still wait for its reset (ADR-0054 §5a, once).
   */
  private async readForArchive(
    ctx: Ctx,
    f: HeldFile,
    mayWait: boolean,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; words: string }> {
    let got: Awaited<ReturnType<FileBytes['read']>>;
    try {
      got = await this.files.read(ctx, f);
    } catch (e) {
      this.logger.warn(`File ${f.id} could not be read for an archive: ${(e as Error).name}`);
      return { ok: false, words: UNREADABLE };
    }
    if (!got.ok && got.reason === 'vault_read_cap' && mayWait) {
      throw new WaitForVault(got.heldUntil ?? new Date(Date.now() + VAULT_CAP_FALLBACK_MS));
    }
    return got;
  }

  /**
   * ADR-0052 §7.3 (TAX-07): the year's tax forms in these books, as the maker's row-level security shows them (§8.4): a
   * member's forms are in an owner's or admin's package and the person's own, and in an accountant's only while the
   * owner's setting is on; always bounded by the books. Those left out are counted, never named. Null when the books have
   * no forms, none expected and none left out (and in workspaces not kept in US dollars): the package is as before.
   */
  private async taxFormsInPackage(
    ctx: Ctx,
    zip: yazl.ZipFile,
    entityId: string,
    booksName: string,
    year: number,
    missing: MissingInArchive[],
    mayWait: boolean,
  ): Promise<{ forms: number; leftOut: number } | null> {
    const base = await this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      if (ws.base_currency !== 'USD') return null;
      const { rows } = await sql<{ n: number }>`
        select app.tax_forms_in_books(${entityId}::uuid, ${year}::integer) as n`.execute(trx);
      const people = await trx
        .selectFrom('app.family_member')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .execute();
      return { total: Number(rows[0]?.n ?? 0), people: new Map(people.map((p) => [p.id, p.name])) };
    });
    if (!base) return null;
    const all = await this.taxForms.year(ctx, year);
    const forms = all.forms.filter(
      (f) => f.entityId === entityId && f.status !== 'dismissed' && f.status !== 'superseded',
    );
    const expected = all.expected.filter((e) => e.entityId === entityId && e.state !== 'received');
    const leftOut = Math.max(0, base.total - forms.length);
    if (forms.length === 0 && expected.length === 0 && leftOut === 0) return null;

    // Each file once, named for the first form on it (a consolidated 1099 holds several).
    const fileIds = [...new Set(forms.flatMap((f) => f.fileIds))];
    const files = fileIds.length
      ? await this.db.run(ctx, (trx) =>
          trx
            .selectFrom('app.file')
            .select(['id', 'storage_key', 'sha256', 'mime', 'file_name'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', 'in', fileIds)
            .where('deleted_at', 'is', null)
            .execute(),
        )
      : [];
    const byId = new Map(files.map((f) => [f.id, f]));
    const pathOf = new Map<string, string>();
    const taken = new Set<string>();
    const paths = new Map<string, string[]>();
    for (const f of forms) {
      const mine: string[] = [];
      for (const id of f.fileIds) {
        const file = byId.get(id);
        if (!file) continue;
        let path = pathOf.get(id);
        if (!path) {
          if (missing.some((m) => m.id === id)) continue;
          const got = await this.readForArchive(ctx, file, mayWait);
          if (!got.ok) {
            missing.push({ id, name: file.file_name, words: got.words });
            continue;
          }
          const person = f.personMemberId ? (base.people.get(f.personMemberId) ?? null) : null;
          path = `tax-forms/${packageFileName(f, person, file.mime, taken)}`;
          zip.addBuffer(Buffer.from(got.bytes), path);
          pathOf.set(id, path);
        }
        mine.push(path);
      }
      paths.set(f.id, mine);
    }
    const input = { forms, expected, waivers: all.waivers, people: base.people, paths };
    zip.addBuffer(Buffer.from(taxFormsCsv(input)), 'tax-forms.csv');
    zip.addBuffer(
      Buffer.from(await taxFormsCheckPdf({ ...input, year, booksName, leftOut })),
      'tax-forms-check.pdf',
    );
    return { forms: forms.length, leftOut };
  }
}

const UNREADABLE = 'Montra couldn’t read this file.';
/** A daily read cap with no reset time said: wait an hour. */
const VAULT_CAP_FALLBACK_MS = 60 * 60_000;
/** Run a little after the vault's reset, not on it. */
const VAULT_RESET_MARGIN_MS = 60_000;

/**
 * An archive given up part-way (to wait for the vault's reset): its ZIP is finished and written before the error goes
 * on, so nothing reads the job's temporary files after they are removed.
 */
function abandon(zip: yazl.ZipFile, done: Promise<void>) {
  return async (e: unknown): Promise<never> => {
    zip.end();
    await done.catch(() => undefined);
    throw e;
  };
}

/** ADR-0054 §5a: the vault's daily read cap met while the archive may still wait once for its reset. */
class WaitForVault extends Error {
  constructor(readonly until: Date) {
    super('vault_read_cap');
    this.name = 'WaitForVault';
  }
}

/** A file an archive couldn't include (ADR-0054 §5a), named in its README. */
interface MissingInArchive {
  id: string;
  name: string;
  words: string;
}

/** The README's list of files Montra couldn't get, or nothing when it got them all. */
export function missingSection(missing: readonly MissingInArchive[], nl: string): string {
  if (!missing.length) return '';
  const lines = missing.map((m) => `- ${m.name.replace(/[\r\n]+/g, ' ')} (file ${m.id}): ${m.words}`);
  return [
    '',
    `Montra couldn't include ${missing.length === 1 ? 'one file' : `${missing.length} files`} it no longer holds:`,
    ...lines,
    '',
    'Upload them again in Montra to keep them with your records.',
    '',
  ].join(nl);
}

const README = `This is a backup of your Montra data.

manifest.json  what's in here, with a checksum for each table and file
data/          every table as JSON lines, which is what Montra restores from
csv/           the same tables as CSV
summary.xlsx   transactions and accounts, for reading
attachments/   your receipts, statements and other documents

Amounts in data/ and csv/ are whole minor units, such as cents: 1234 is 12.34. summary.xlsx shows them as 12.34.

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
  // ACC-15: holders are people's names; one book's archive has only its own accounts'.
  if (info.name === 'account_holder') {
    return sql`exists (select 1 from app.ledger_account la where la.workspace_id = t.workspace_id
                        and la.id = t.ledger_account_id and la.entity_id = ${entityId})`;
  }
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
