/**
 * Restore (BAK-06; ADR-0019 §9, §10). An upload is checked and previewed first, and nothing changes until it's confirmed. Then every row
 * goes in, in one transaction, with every id replaced, so it works fully or leaves nothing. An archive is treated as untrusted input:
 * rows only go into the target workspace, storage keys are always made here, and it must come back to the balances it says it holds.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import yauzl from 'yauzl';
import { z } from 'zod';
import { newId, setContext, type Trx } from '@montra/db';
import type { ConfirmRestoreRequest, RestoreJobDto, RestorePreviewDto } from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { KMS_PORT, FieldCrypto, type KmsPort } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { STORAGE_PORT, storageKey, type StoragePort, sha256 } from '../storage/storage.js';
import { BadPasswordError, decryptFile, encryptFile, inspectArchive } from './archive-crypto.js';
import { ARCHIVE_FORMAT, type ArchiveManifest } from './backup.service.js';
import {
  ENCRYPTED,
  EXPORT_ONLY,
  exportedTables,
  insertOrder,
  plainName,
  readCatalog,
  remapIds,
  withParents,
  type TableInfo,
} from './catalog.js';

const BATCH = 500;
/** Far larger than any real table's file, and small enough to refuse a ZIP bomb. */
const MAX_ENTRY_BYTES = 10 * 1024 ** 3;

const ManifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  createdAt: z.string(),
  workspace: z.object({
    id: z.uuid(),
    name: z.string().min(1).max(200),
    baseCurrency: z.string().regex(/^[A-Z]{3}$/),
    timeZone: z.string().max(100),
    priorities: z.unknown(),
    interEntityMode: z.string().max(40),
    aiMode: z.string().max(40),
    aiSettings: z.unknown(),
  }),
  requestedBy: z.uuid(),
  users: z.array(z.uuid()),
  entityScoped: z.boolean(),
  partial: z.boolean(),
  entities: z.array(z.object({ id: z.uuid(), name: z.string(), type: z.string() })),
  tables: z.record(z.string(), z.object({ rows: z.number().int().min(0), sha256: z.string() })),
  files: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      name: z.string(),
      mime: z.string(),
      bytes: z.string(),
      sha256: z.string(),
      path: z.string(),
    }),
  ),
  balances: z.record(z.string(), z.string()),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
});

/** A shared list maps onto what's already in the workspace rather than clashing with it (ADR-0019 §10). */
const NATURAL_KEYS: Readonly<Record<string, { column: string; lower: boolean }>> = {
  tag: { column: 'name', lower: true },
  payee: { column: 'normalized_key', lower: false },
  family_member: { column: 'name', lower: true },
};

class ZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: Map<string, yauzl.Entry>,
  ) {}

  static open(path: string): Promise<ZipReader> {
    return new Promise((resolve, reject) => {
      yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('Not a ZIP'));
        const entries = new Map<string, yauzl.Entry>();
        zip.on('entry', (entry: yauzl.Entry) => {
          entries.set(entry.fileName, entry);
          zip.readEntry();
        });
        zip.on('end', () => resolve(new ZipReader(zip, entries)));
        zip.on('error', reject);
        zip.readEntry();
      });
    });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  stream(name: string): Promise<Readable> {
    const entry = this.entries.get(name);
    if (!entry) return Promise.reject(new Error(`Missing ${name}`));
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) return Promise.reject(new Error(`Too large: ${name}`));
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) =>
        err || !stream ? reject(err ?? new Error('No stream')) : resolve(stream),
      );
    });
  }

  async bytes(name: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of await this.stream(name)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async *lines(name: string): AsyncGenerator<string> {
    if (!this.has(name)) return;
    const rl = createInterface({ input: await this.stream(name), crlfDelay: Infinity });
    for await (const line of rl) if (line) yield line;
  }

  close(): void {
    this.zip.close();
  }
}

const invalid = (why: string) =>
  unprocessable('restore.invalid', `This doesn't look like a Montra backup: ${why}`);

@Injectable()
export class RestoreService {
  private readonly logger = new Logger('Restore');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(KMS_PORT) private readonly kms: KmsPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  register(): void {
    this.worker.register('data.restore', async (job: Job) => {
      const { restoreId } = job.payload as { restoreId: string };
      if (!job.created_by) throw new PermanentJobError('job.context', 'Job without a user');
      return this.run(job.created_by, restoreId);
    });
  }

  // ----- Upload and preview ---------------------------------------------------------------------------------------

  /** Checks the upload and keeps it, under a key of its own, until it's confirmed or expires. */
  async upload(userId: string, path: string, password: string | undefined): Promise<RestoreJobDto> {
    const dir = await mkdtemp(join(tmpdir(), 'montra-restore-'));
    try {
      const kind = await inspectArchive(path);
      let zipPath = path;
      if (kind === 'keyed') throw invalid('it is not an archive you can restore');
      if (kind === 'password') {
        if (!password)
          throw unprocessable('restore.password_required', 'This backup is protected. Enter its password.');
        zipPath = join(dir, 'plain.zip');
        try {
          await decryptFile(path, zipPath, { password });
        } catch (e) {
          if (e instanceof BadPasswordError) {
            throw unprocessable('restore.bad_password', 'The password is wrong, or the file is damaged.');
          }
          throw e;
        }
      }
      const preview = await this.inspect(zipPath);
      const id = newId();
      const key = randomBytes(32);
      const encrypted = join(dir, 'kept.bin');
      await encryptFile(zipPath, encrypted, key, null);
      const storageKeyName = `restores/${userId}/${id}`;
      await this.storage.putFile(storageKeyName, encrypted, 'application/octet-stream');
      const wrapped = await this.kms.wrap(key);
      return this.db.run({ userId }, async (trx) => {
        const row = await trx
          .insertInto('app.restore_job')
          .values({
            id,
            user_id: userId,
            status: 'ready',
            storage_key: storageKeyName,
            wrapped_key: wrapped,
            preview: JSON.stringify(preview),
            mode: null,
            target_workspace_id: null,
            result: null,
            error: null,
            finished_at: null,
            expires_at: new Date(Date.now() + 7 * 86_400_000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('app.security_event')
          .values({
            user_id: userId,
            workspace_id: null,
            kind: 'restore_started',
            detail: JSON.stringify({ workspace: preview.workspaceName }),
          })
          .execute();
        return dto(row);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Validates what's inside: the manifest's shape and every checksum. */
  private async inspect(zipPath: string): Promise<RestorePreviewDto> {
    let zip: ZipReader;
    try {
      zip = await ZipReader.open(zipPath);
    } catch {
      throw invalid('it is not a readable ZIP file');
    }
    try {
      const manifest = await this.manifestOf(zip);
      for (const [table, t] of Object.entries(manifest.tables)) {
        const hash = createHash('sha256');
        let rows = 0;
        for await (const line of zip.lines(`data/${table}.jsonl`)) {
          hash.update(line + '\n');
          rows++;
        }
        if (rows !== t.rows || hash.digest('hex') !== t.sha256)
          throw invalid(`${table} doesn't match its checksum`);
      }
      for (const f of manifest.files) {
        if (!zip.has(f.path)) throw invalid(`a file is missing`);
        if (sha256(await zip.bytes(f.path)) !== f.sha256) throw invalid(`a file doesn't match its checksum`);
      }
      return {
        workspaceName: manifest.workspace.name,
        createdAt: manifest.createdAt,
        entityScoped: manifest.entityScoped,
        partial: manifest.partial,
        entities: manifest.entities.map((e) => ({ name: e.name, type: e.type })),
        counts: Object.fromEntries(
          Object.entries(manifest.tables)
            .filter(([, t]) => t.rows > 0)
            .map(([k, t]) => [k, t.rows]),
        ),
        firstDate: manifest.firstDate as RestorePreviewDto['firstDate'],
        lastDate: manifest.lastDate as RestorePreviewDto['lastDate'],
        files: manifest.files.length,
        possibleDuplicates: null,
      };
    } finally {
      zip.close();
    }
  }

  private async manifestOf(zip: ZipReader): Promise<ArchiveManifest> {
    if (!zip.has('manifest.json')) throw invalid('it has no manifest');
    let raw: unknown;
    try {
      raw = JSON.parse((await zip.bytes('manifest.json')).toString('utf8'));
    } catch {
      throw invalid('its manifest is not readable');
    }
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) throw invalid('its manifest is not one this version understands');
    return parsed.data as ArchiveManifest;
  }

  async list(userId: string): Promise<RestoreJobDto[]> {
    return this.db.run({ userId }, async (trx) => {
      const rows = await trx
        .selectFrom('app.restore_job')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      return rows.map(dto);
    });
  }

  private async row(trx: Trx, userId: string, id: string) {
    const r = await trx
      .selectFrom('app.restore_job')
      .selectAll()
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Restore');
    return r;
  }

  /** With a target, the preview also counts what may already be there. */
  async get(userId: string, id: string, workspaceId?: string): Promise<RestoreJobDto> {
    const r = await this.db.run({ userId }, (trx) => this.row(trx, userId, id));
    const out = dto(r);
    if (workspaceId && out.preview && r.status === 'ready') {
      await this.requireOwner(userId, workspaceId);
      out.preview = { ...out.preview, possibleDuplicates: await this.duplicates(r, userId, workspaceId) };
    }
    return out;
  }

  private async requireOwner(userId: string, workspaceId: string): Promise<void> {
    const m = await this.db.run({ userId }, (trx) =>
      trx
        .selectFrom('app.workspace_member')
        .select('role')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (m?.role !== 'owner')
      throw new AppError(403, 'restore.not_owner', 'Only an owner can restore into a workspace');
  }

  private async withPlainFile<T>(
    r: { storage_key: string; wrapped_key: Buffer },
    fn: (zip: ZipReader, manifest: ArchiveManifest) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'montra-restore-'));
    try {
      const kept = join(dir, 'kept.bin');
      const plain = join(dir, 'plain.zip');
      await pipeline(await this.storage.getStream(r.storage_key), createWriteStream(kept));
      await decryptFile(kept, plain, await this.kms.unwrap(r.wrapped_key));
      const zip = await ZipReader.open(plain);
      try {
        return await fn(zip, await this.manifestOf(zip));
      } finally {
        zip.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async duplicates(
    r: { storage_key: string; wrapped_key: Buffer },
    userId: string,
    workspaceId: string,
  ): Promise<number> {
    return this.withPlainFile(r, async (zip) => {
      const keys: string[] = [];
      for await (const line of zip.lines('data/transaction.jsonl')) {
        const key = (JSON.parse(line) as { dedupe_key?: string | null }).dedupe_key;
        if (key) keys.push(key);
      }
      if (keys.length === 0) return 0;
      const { n } = await this.db.run({ workspaceId, userId }, (trx) =>
        trx
          .selectFrom('app.transaction')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('workspace_id', '=', workspaceId)
          .where('dedupe_key', 'in', keys.slice(0, 20000))
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow(),
      );
      return Number(n);
    });
  }

  // ----- Confirming ---------------------------------------------------------------------------------------------------

  async confirm(userId: string, id: string, req: ConfirmRestoreRequest): Promise<RestoreJobDto> {
    if (req.mode === 'existing') await this.requireOwner(userId, req.workspaceId);
    return this.db.run({ userId }, async (trx) => {
      const r = await this.row(trx, userId, id);
      if (r.status !== 'ready')
        throw new AppError(409, 'restore.not_ready', 'This restore has already been started');
      const preview = r.preview as RestorePreviewDto;
      if (req.mode === 'existing' && preview.entities.every((e) => e.type === 'personal')) {
        throw unprocessable(
          'restore.personal_existing',
          'A workspace has one set of personal books, so these can only be restored into a new workspace.',
        );
      }
      const updated = await trx
        .updateTable('app.restore_job')
        .set({
          status: 'restoring',
          mode: req.mode,
          target_workspace_id: req.mode === 'existing' ? req.workspaceId : null,
          result: req.mode === 'new' && req.name ? JSON.stringify({ name: req.name }) : null,
        })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await sql`select app.enqueue_restore(${id}::uuid)`.execute(trx);
      return dto(updated);
    });
  }

  // ----- Running ----------------------------------------------------------------------------------------------------------

  async run(userId: string, id: string): Promise<Record<string, unknown>> {
    const r = await this.db.run({ userId }, (trx) => this.row(trx, userId, id));
    if (r.status !== 'restoring') return { skipped: true };
    const written: string[] = [];
    try {
      const result = await this.withPlainFile(r, (zip, manifest) =>
        this.restoreInto(userId, r, zip, manifest, written),
      );
      await this.db.run({ userId }, async (trx) => {
        await trx
          .updateTable('app.restore_job')
          .set({
            status: 'done',
            target_workspace_id: result.workspaceId,
            result: JSON.stringify(result),
            finished_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
        await trx
          .insertInto('app.security_event')
          .values({
            user_id: userId,
            workspace_id: result.workspaceId,
            kind: 'restore_finished',
            detail: JSON.stringify({ mode: r.mode }),
          })
          .execute();
      });
      return result;
    } catch (e) {
      this.logger.warn(`Restore ${id} failed: ${(e as Error).message}`);
      // Nothing in the database survived the rollback; the files copied so far go too.
      for (const key of written) await this.storage.delete(key).catch(() => undefined);
      await this.db.run({ userId }, (trx) =>
        trx
          .updateTable('app.restore_job')
          .set({
            status: 'failed',
            error: 'The restore could not be finished, and nothing was changed.',
            finished_at: new Date(),
          })
          .where('id', '=', id)
          .execute(),
      );
      throw new PermanentJobError('restore.failed', (e as Error).message);
    }
  }

  private restoreInto(
    userId: string,
    job: { mode: 'new' | 'existing' | null; target_workspace_id: string | null; result: unknown },
    zip: ZipReader,
    manifest: ArchiveManifest,
    written: string[],
  ) {
    const existing = job.mode === 'existing';
    const workspaceId = existing ? job.target_workspace_id! : newId();
    const ctx = { workspaceId, userId, allowLockedEdit: true };
    return this.db.kysely.transaction().execute(async (trx) => {
      await setContext(trx, ctx);
      if (!existing)
        await this.makeWorkspace(
          trx,
          workspaceId,
          userId,
          manifest,
          (job.result as { name?: string } | null)?.name,
        );
      const catalog = await readCatalog(trx);
      const inArchive = exportedTables(catalog).filter((t) => !EXPORT_ONLY.has(t) && manifest.tables[t]);
      const { order, deferred } = insertOrder(catalog, inArchive);

      const ids = new Map<string, string>();
      for (const u of manifest.users) ids.set(u.toLowerCase(), userId);
      ids.set(manifest.requestedBy.toLowerCase(), userId);
      const manifestWorkspace = manifest.workspace.id.toLowerCase();
      ids.set(manifestWorkspace, workspaceId);
      const filesById = new Map(manifest.files.map((f) => [f.id, f]));
      const kept = new Map<string, Set<string>>();
      const needed = new Set(
        inArchive.flatMap((t) =>
          catalog
            .get(t)!
            .fks.filter((f) => f.refColumns.includes('id'))
            .map((f) => f.refTable),
        ),
      );
      const counts: Record<string, number> = {};
      const later: { table: string; id: string; set: Record<string, unknown> }[] = [];

      // Every id gets its replacement first, so a row can point forward.
      for (const table of order) {
        if (!catalog.get(table)!.hasId) continue;
        for await (const line of zip.lines(`data/${table}.jsonl`)) {
          const id = (JSON.parse(line) as { id?: string }).id;
          if (id) ids.set(id.toLowerCase(), newId());
        }
      }

      for (const table of order) {
        const info = catalog.get(table)!;
        const keptIds = needed.has(table) ? new Set<string>() : null;
        const batch: Record<string, unknown>[] = [];
        const flush = async () => {
          if (batch.length) await this.insert(trx, info, batch);
          counts[table] = (counts[table] ?? 0) + batch.length;
          batch.length = 0;
        };
        const deferredColumns = deferred.get(table) ?? [];
        for await (const line of zip.lines(`data/${table}.jsonl`)) {
          let row: Record<string, unknown> | null = JSON.parse(line) as Record<string, unknown>;
          const oldId = typeof row.id === 'string' ? row.id : null;
          // A workspace has one set of personal books, and these don't merge with them (ADR-0019 §10).
          if (existing && table === 'entity' && row.type === 'personal') continue;
          row = withParents(info, row, kept);
          if (!row) continue;
          if (existing && oldId) {
            const match = await this.naturalMatch(trx, workspaceId, table, row);
            if (match) {
              ids.set(oldId.toLowerCase(), match);
              keptIds?.add(oldId);
              continue;
            }
          }
          if (oldId) keptIds?.add(oldId);
          if (
            table === 'family_member' &&
            row.linked_user_id &&
            row.linked_user_id !== manifest.requestedBy
          ) {
            row = { ...row, linked_user_id: null };
          }
          const prepared = await this.prepare(trx, table, workspaceId, row, ids);
          if (table === 'file')
            await this.copyFile(trx, zip, filesById.get(oldId ?? ''), prepared, workspaceId, written);
          if (table === 'entity' && existing)
            prepared.name = `${String(prepared.name)} (restored)`.slice(0, 200);
          const set: Record<string, unknown> = {};
          for (const c of deferredColumns) {
            if (prepared[c] !== null && prepared[c] !== undefined) set[c] = prepared[c];
            prepared[c] = null;
          }
          if (Object.keys(set).length) {
            if (!info.hasId) throw new Error(`Cannot defer columns of ${table}`);
            later.push({ table, id: String(prepared.id), set });
          }
          batch.push(prepared);
          if (batch.length >= BATCH) await flush();
        }
        await flush();
        if (keptIds) kept.set(table, keptIds);
      }

      for (const l of later) {
        const assignments = Object.entries(l.set).map(([c, v]) => sql`${sql.ref(c)} = ${v}`);
        await sql`update ${sql.table(`app.${l.table}`)} set ${sql.join(assignments, sql`, `)}
                   where workspace_id = ${workspaceId} and id = ${l.id}`.execute(trx);
      }

      await this.check(trx, workspaceId, manifest, ids, kept);
      return { workspaceId, counts };
    });
  }

  /** Workspace settings come from the file, but not AI ones: a key doesn't travel, and a file shouldn't choose where data is sent. */
  private async makeWorkspace(
    trx: Trx,
    workspaceId: string,
    userId: string,
    manifest: ArchiveManifest,
    name: string | undefined,
  ): Promise<void> {
    const { workspace: w } = manifest;
    let timeZone = 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: w.timeZone });
      timeZone = w.timeZone;
    } catch {
      // A time zone this system doesn't know falls back to UTC, which the owner can change.
    }
    await trx
      .insertInto('app.workspace')
      .values({
        id: workspaceId,
        name: name ?? `${w.name} (restored)`.slice(0, 200),
        base_currency: w.baseCurrency,
        time_zone: timeZone,
        ai_mode: w.aiMode === 'builtin' ? 'builtin' : 'off',
      })
      .execute();
    await trx
      .insertInto('app.workspace_member')
      .values({ workspace_id: workspaceId, user_id: userId, role: 'owner' })
      .execute();
  }

  private async naturalMatch(
    trx: Trx,
    workspaceId: string,
    table: string,
    row: Record<string, unknown>,
  ): Promise<string | null> {
    const key = NATURAL_KEYS[table];
    if (!key) return null;
    const value = row[key.column];
    if (typeof value !== 'string') return null;
    const { rows } = await sql<{ id: string }>`
      select id from ${sql.table(`app.${table}`)}
       where workspace_id = ${workspaceId}
         and ${key.lower ? sql`lower(${sql.ref(key.column)}) = lower(${value})` : sql`${sql.ref(key.column)} = ${value}`}
       limit 1`.execute(trx);
    return rows[0]?.id ?? null;
  }

  private async prepare(
    trx: Trx,
    table: string,
    workspaceId: string,
    row: Record<string, unknown>,
    ids: ReadonlyMap<string, string>,
  ): Promise<Record<string, unknown>> {
    const out = remapIds(row, ids) as Record<string, unknown>;
    out.workspace_id = workspaceId;
    for (const [column, label] of Object.entries(ENCRYPTED[table] ?? {})) {
      const plain = out[plainName(column)];
      delete out[plainName(column)];
      const sealed =
        typeof plain === 'string' ? await this.crypto.encrypt(trx, workspaceId, label, plain) : null;
      out[column] = sealed ? `\\x${sealed.toString('hex')}` : null;
    }
    return out;
  }

  /** Always a key made here: a storage key from a file could otherwise point at someone else's document. */
  private async copyFile(
    trx: Trx,
    zip: ZipReader,
    file: ArchiveManifest['files'][number] | undefined,
    row: Record<string, unknown>,
    workspaceId: string,
    written: string[],
  ): Promise<void> {
    const key = storageKey(workspaceId, String(row.kind), String(row.id));
    row.storage_key = key;
    if (!file || !zip.has(file.path)) return;
    const bytes = await zip.bytes(file.path);
    if (sha256(bytes) !== file.sha256) throw new Error('A file does not match its checksum');
    written.push(key);
    // ADR-0034: a sealed file is sealed again under this workspace's key and its new id.
    const stored = row.sealed ? await this.crypto.sealBytes(trx, workspaceId, String(row.id), bytes) : bytes;
    await this.storage.put(key, stored, row.sealed ? 'application/octet-stream' : String(row.mime));
  }

  private async insert(trx: Trx, info: TableInfo, rows: Record<string, unknown>[]): Promise<void> {
    const columns = [...info.columns.entries()].filter(([, c]) => c.writable).map(([name]) => name);
    const list = sql.join(columns.map((c) => sql.ref(c)));
    await sql`insert into ${sql.table(`app.${info.name}`)} (${list})
              select ${list} from jsonb_populate_recordset(null::${sql.table(`app.${info.name}`)}, ${JSON.stringify(rows)}::jsonb)`.execute(
      trx,
    );
  }

  /** It must come back to what it says it held, or nothing's kept (ADR-0019 §9). Unbalanced entries fail on commit by themselves. */
  private async check(
    trx: Trx,
    workspaceId: string,
    manifest: ArchiveManifest,
    ids: ReadonlyMap<string, string>,
    kept: ReadonlyMap<string, ReadonlySet<string>>,
  ): Promise<void> {
    const { rows } = await sql<{ id: string; amount: string }>`
      select ledger_account_id as id, sum(amount_minor)::text as amount from app.posting
       where workspace_id = ${workspaceId} group by 1`.execute(trx);
    const actual = new Map(rows.map((r) => [r.id, r.amount]));
    const accounts = kept.get('ledger_account');
    for (const [account, amount] of Object.entries(manifest.balances)) {
      if (accounts && !accounts.has(account)) continue;
      const id = ids.get(account.toLowerCase());
      if (!id) throw new Error(`An account in the archive has no replacement`);
      if ((actual.get(id) ?? '0') !== amount) {
        throw new Error(`An account came back to ${actual.get(id) ?? '0'} and not ${amount}`);
      }
    }
  }
}

function dto(r: {
  id: string;
  status: RestoreJobDto['status'];
  preview: unknown;
  mode: 'new' | 'existing' | null;
  target_workspace_id: string | null;
  error: string | null;
  created_at: Date;
}): RestoreJobDto {
  return {
    id: r.id,
    status: r.status,
    preview: (r.preview as RestorePreviewDto | null) ?? null,
    mode: r.mode,
    targetWorkspaceId: r.target_workspace_id,
    error: r.error,
    createdAt: r.created_at.toISOString(),
  };
}
