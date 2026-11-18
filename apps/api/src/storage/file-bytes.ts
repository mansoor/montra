/**
 * Reading a file's bytes, whoever holds them (ADR-0054 §5; VLT-11). Every reader of an uploaded file's bytes comes here
 * instead of calling `StoragePort.get` with the file's key: OCR and scan reading, previews, statement imports, backups
 * and archives, tax packages, payroll forms, the mirror's and the vault's own sending.
 *
 * In order, it tries:
 *
 * 1. Montra's own copy (`StoragePort`), when the file has one;
 * 2. the copy at the owner's own S3/WebDAV storage (ADR-0031), when the mirror has copied it, read back only here;
 * 3. the vault, for a document Montra sent there and the vault filed: the exact file Montra sent, counted against the
 *    vault's daily read cap. Whether it returns it is the vault's decision.
 *
 * Each caller gets the bytes, checked against the file's hash, or a typed "not available" with the reason and the words
 * to show. Showing a document to a person never asks the vault here (§5): a preview of a file only the vault holds is
 * `in_vault`, and the person opens it there through a single-use link (§9, `VaultOpener`).
 *
 * The copies belong to the owner's connections, which only owners and admins may read. The file is always read under
 * the caller's own row-level security first; only then does a definer (`app.file_copies`) say where its copies are and
 * which owner the connections act as, and the copy is read under that owner's context, as the jobs do. Nothing here logs
 * a file's name, a path or a key: only ids and codes.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { AppError, notFound } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { PermanentJobError } from '../jobs/queue.js';
import { VaultError } from './destinations/vault.js';
import { DestinationError, type StorageDestination } from './destinations/types.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from './storage.js';
import { StorageDestinationsService, type DestinationRow } from './storage-destinations.service.js';
import { configOf, scheduleVault, VaultService } from './vault/vault.service.js';

type Ctx = { workspaceId: string; userId: string };

/** What a reader needs of a file: which it is, Montra's key (null once only the vault holds it) and its hash. */
export interface HeldFile {
  id: string;
  storage_key: string | null;
  sha256: string;
}

/** Where the bytes came from. */
export type FileSource = 'montra' | 'mirror' | 'vault';

/**
 * Why a file's bytes aren't available now:
 *
 * - `in_vault`: only the vault holds it, and this caller doesn't ask the vault (a person viewing it opens it there);
 * - `vault_refused`: the vault didn't return it, or returned a different file; Montra never guesses why;
 * - `vault_read_cap`: the vault's daily reading is used up until `heldUntil`;
 * - `vault_unavailable`: the vault can't be asked now (not reached, or its connection needs a person, or is gone);
 * - `not_held`: nowhere Montra can read it.
 */
export type NotAvailableReason =
  'in_vault' | 'vault_refused' | 'vault_read_cap' | 'vault_unavailable' | 'not_held';

export type FileBytesResult =
  | { ok: true; bytes: Uint8Array; from: FileSource }
  | { ok: false; reason: NotAvailableReason; words: string; heldUntil: Date | null };

export interface ReadOptions {
  /**
   * Ask the vault when nothing else holds the file (default). False for a person viewing it (§5: they open it in the
   * vault), and for the mirror's and the vault's own sending, which only send what Montra holds.
   */
  vault?: boolean;
}

/** In Montra's words, for the caller to show (never a file's name). */
export const NOT_AVAILABLE_WORDS: Record<NotAvailableReason, string> = {
  in_vault: 'This file is kept in Family Document Vault. Open it there.',
  vault_refused: 'Family Document Vault didn’t return this file.',
  vault_read_cap:
    'Montra has read as many files from Family Document Vault as it may today. Try again later.',
  vault_unavailable: 'Montra couldn’t ask Family Document Vault for this file just now. Try again later.',
  not_held: 'Montra doesn’t hold this file any more.',
};

/** A daily read cap with no reset time said: look again in an hour. */
const CAP_FALLBACK_MS = 60 * 60_000;

@Injectable()
export class FileBytes {
  private readonly logger = new Logger('FileBytes');
  /** The most a file may be, read back from a copy: what an upload may be, and a little over. */
  private readonly maxBytes: number;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(StorageDestinationsService) private readonly destinations: StorageDestinationsService,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.maxBytes = config.MAX_UPLOAD_BYTES + 1024 * 1024;
  }

  /**
   * A file's bytes, from wherever they are held, or why not. The caller has read `file` under its own row-level
   * security, in `ctx`.
   */
  async read(ctx: Ctx, file: HeldFile, opts: ReadOptions = {}): Promise<FileBytesResult> {
    if (file.storage_key) {
      try {
        return { ok: true, bytes: await this.storage.get(file.storage_key), from: 'montra' };
      } catch (e) {
        // Montra's copy should be there: say so, then try the copies, which exist for this.
        this.logger.warn(`File ${file.id}: Montra's copy couldn't be read: ${(e as Error).name}`);
      }
    }
    const copies = await this.copiesOf(ctx, file.id);
    if (copies?.userId && copies.mirrorId && copies.mirrorPath) {
      const fromMirror = await this.fromMirror(
        { workspaceId: ctx.workspaceId, userId: copies.userId },
        copies.mirrorId,
        copies.mirrorPath,
        file,
      );
      if (fromMirror) return { ok: true, bytes: fromMirror, from: 'mirror' };
    }
    if (copies?.userId && copies.vaultId && copies.vaultRef && copies.vaultStatus === 'filed') {
      if (opts.vault === false) return notAvailable('in_vault');
      return this.fromVault(
        { workspaceId: ctx.workspaceId, userId: copies.userId },
        copies.vaultId,
        copies.vaultRef,
        file,
      );
    }
    return notAvailable('not_held');
  }

  /** As `read`, for one file by id, read under the caller's row-level security. Not found is a 404. */
  async readById(ctx: Ctx, fileId: string, opts: ReadOptions = {}): Promise<FileBytesResult> {
    const file = await this.db.run(ctx, (trx) => heldFile(trx, ctx.workspaceId, fileId));
    if (!file) throw notFound('File');
    return this.read(ctx, file, opts);
  }

  /** The bytes for a request a person is waiting on, or an answer in words: they don't wait for the vault's reset. */
  async bytes(ctx: Ctx, file: HeldFile, opts: ReadOptions = {}): Promise<Uint8Array> {
    const got = await this.read(ctx, file, opts);
    if (got.ok) return got.bytes;
    throw notAvailableError(got);
  }

  /**
   * The bytes for a job: a hold (the vault's daily cap) or a vault that can't be asked now is retried by the queue; a
   * file nothing holds, or the vault won't return, is a permanent failure in words.
   */
  async forJob(ctx: Ctx, file: HeldFile): Promise<Uint8Array> {
    const got = await this.read(ctx, file);
    if (got.ok) return got.bytes;
    if (got.reason === 'vault_read_cap' || got.reason === 'vault_unavailable')
      throw new Error(`file.${got.reason}`);
    throw new PermanentJobError(`file.${got.reason}`, got.words);
  }

  /**
   * Montra's own copy, put back, for readers that hand a key to the doc-worker (OCR, statement extraction): a file only
   * the vault (or the mirror) holds is read through `read`, stored under a new key, and its `location` goes back to
   * `montra`. For a group sent with no local copy, the vault's job removes it again once nothing is reading it (§5).
   * Answers each file's key, in order; a file that can't be read is an error in words.
   */
  async ensureHeld(ctx: Ctx, fileIds: readonly string[]): Promise<Map<string, string>> {
    const files = fileIds.length
      ? await this.db.run(ctx, (trx) =>
          trx
            .selectFrom('app.file')
            .select(['id', 'kind', 'storage_key', 'sha256', 'mime'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', 'in', [...fileIds])
            .execute(),
        )
      : [];
    const keys = new Map<string, string>();
    for (const f of files) {
      if (f.storage_key) {
        keys.set(f.id, f.storage_key);
        continue;
      }
      const got = await this.read(ctx, f);
      if (!got.ok) throw notAvailableError(got);
      keys.set(f.id, await this.holdAgain(ctx, f, got.bytes));
    }
    return keys;
  }

  /** Stores bytes read back as Montra's copy again, under a key never used before (a put never overwrites). */
  private async holdAgain(
    ctx: Ctx,
    f: { id: string; kind: string; mime: string },
    bytes: Uint8Array,
  ): Promise<string> {
    const key = `${storageKey(ctx.workspaceId, f.kind, f.id)}-${randomUUID().slice(0, 8)}`;
    await this.storage.put(key, bytes, f.mime);
    const kept = await this.db.run(ctx, async (trx) => {
      const r = await trx
        .updateTable('app.file')
        .set({ storage_key: key, location: 'montra' })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', f.id)
        .where('storage_key', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return !!r;
    });
    if (!kept) {
      // Someone else put it back first: theirs stands, and this copy goes.
      await this.storage.delete(key);
      const now = await this.db.run(ctx, (trx) => heldFile(trx, ctx.workspaceId, f.id));
      if (now?.storage_key) return now.storage_key;
      throw new AppError(409, 'file.changed', 'The file changed while Montra read it. Try again.');
    }
    this.logger.log(`File ${f.id}: Montra's copy put back`);
    return key;
  }

  // ----- Where the copies are -----------------------------------------------------------------------------------------

  private async copiesOf(ctx: Ctx, fileId: string) {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<{
        user_id: string | null;
        mirror_id: string | null;
        mirror_path: string | null;
        vault_id: string | null;
        vault_ref: string | null;
        vault_status: string | null;
      }>`select * from app.file_copies(${fileId}::uuid)`.execute(trx),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      userId: r.user_id,
      mirrorId: r.mirror_id,
      mirrorPath: r.mirror_path,
      vaultId: r.vault_id,
      vaultRef: r.vault_ref,
      vaultStatus: r.vault_status,
    };
  }

  /** The owner's own storage, read back (ADR-0031 copies are of Montra's bytes, so the hash must match). */
  private async fromMirror(
    actor: Ctx,
    destinationId: string,
    path: string,
    file: HeldFile,
  ): Promise<Uint8Array | null> {
    const row = (await this.db.run(actor, (trx) =>
      trx
        .selectFrom('app.storage_destination')
        .selectAll()
        .where('workspace_id', '=', actor.workspaceId)
        .where('id', '=', destinationId)
        .where('kind', 'in', ['s3', 'webdav'])
        .executeTakeFirst(),
    )) as DestinationRow | undefined;
    if (!row || row.status === 'paused') return null;
    let remote: StorageDestination | null = null;
    try {
      remote = await this.destinations.open(actor, row);
      const bytes = await remote.get(path, this.maxBytes);
      if (sha256(bytes) !== file.sha256) {
        this.logger.warn(`File ${file.id}: the copy in the owner's storage has a different hash`);
        return null;
      }
      return bytes;
    } catch (e) {
      const code = e instanceof DestinationError ? e.code : (e as Error)?.name;
      this.logger.warn(`File ${file.id}: the owner's storage couldn't give it back: ${code}`);
      return null;
    } finally {
      remote?.close();
    }
  }

  /**
   * §5: the exact file Montra sent, asked of the vault. Its daily read cap is a hold until its reset, kept on the
   * connection so nothing asks again before then; a connection problem wakes the connection's check (§12); anything
   * the vault won't return, or returns changed, is `vault_refused`.
   */
  private async fromVault(
    actor: Ctx,
    destinationId: string,
    ref: string,
    file: HeldFile,
  ): Promise<FileBytesResult> {
    const found = await this.db.run(actor, async (trx) => {
      const row = await this.vault.row(trx, actor);
      const state = await trx
        .selectFrom('app.vault_connection_state')
        .select(['read_held_until', 'daily_reset_at'])
        .where('workspace_id', '=', actor.workspaceId)
        .where('destination_id', '=', destinationId)
        .executeTakeFirst();
      return { row, state };
    });
    const row = found.row;
    if (!row || row.id !== destinationId) return notAvailable('vault_unavailable');
    const config = configOf(row);
    if (config.stage !== 'connected' || row.status === 'needs_vault' || row.status === 'paused') {
      return notAvailable('vault_unavailable');
    }
    const held = found.state?.read_held_until;
    if (held && held.getTime() > Date.now()) return notAvailable('vault_read_cap', held);

    let conn: Awaited<ReturnType<VaultService['openRow']>>;
    try {
      conn = await this.vault.openRow(actor, row);
    } catch (e) {
      this.logger.warn(`File ${file.id}: the vault's connection couldn't be opened: ${(e as Error).name}`);
      return notAvailable('vault_unavailable');
    }
    try {
      const got = await conn.sentFile(ref);
      if (sha256(got.bytes) !== file.sha256) {
        this.logger.warn(`File ${file.id}: the vault returned a different file`);
        return notAvailable('vault_refused');
      }
      this.logger.log(`File ${file.id}: read back from the vault`);
      return { ok: true, bytes: got.bytes, from: 'vault' };
    } catch (e) {
      const err =
        e instanceof VaultError ? e : new VaultError('failed', { detail: (e as Error)?.name ?? 'error' });
      this.logger.warn(`File ${file.id}: asking the vault for it: ${err.code} ${err.opts.detail ?? ''}`);
      if (err.code === 'unavailable') return notAvailable('vault_refused');
      if (err.code === 'read_cap') {
        const reset = found.state?.daily_reset_at;
        const until =
          err.opts.heldUntil ??
          (reset && reset.getTime() > Date.now() ? reset : new Date(Date.now() + CAP_FALLBACK_MS));
        await this.db.run(actor, (trx) =>
          trx
            .updateTable('app.vault_connection_state')
            .set({ read_held_until: until, updated_at: new Date() })
            .where('workspace_id', '=', actor.workspaceId)
            .where('destination_id', '=', destinationId)
            .execute(),
        );
        return notAvailable('vault_read_cap', until);
      }
      if (err.stopsConnection) {
        // The job's check says what is wrong, stops the connection and tells owners, once (§12).
        await this.db.run(actor, async (trx) => {
          await trx
            .updateTable('app.vault_connection_state')
            .set({ next_check_at: sql`now()`, updated_at: new Date() })
            .where('workspace_id', '=', actor.workspaceId)
            .where('destination_id', '=', destinationId)
            .execute();
          await scheduleVault(trx);
        });
      }
      return notAvailable('vault_unavailable', err.opts.retryAfter ?? null);
    } finally {
      conn.close();
    }
  }
}

/**
 * Montra's key for a file handed to the doc-worker inside a transaction, where the vault can't be asked: callers put
 * a file only the vault holds back first (`ensureHeld`), so a missing key here is a 409 to try again.
 */
export function heldKey(file: { storage_key: string | null }): string {
  if (file.storage_key) return file.storage_key;
  throw new AppError(
    409,
    'file.not_held',
    'Montra is fetching this file back from Family Document Vault. Try again.',
  );
}

/** A file as `FileBytes` reads it, under the caller's row-level security. */
export function heldFile(trx: Trx, workspaceId: string, fileId: string): Promise<HeldFile | undefined> {
  return trx
    .selectFrom('app.file')
    .select(['id', 'storage_key', 'sha256'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', fileId)
    .executeTakeFirst();
}

const notAvailable = (reason: NotAvailableReason, heldUntil: Date | null = null): FileBytesResult => ({
  ok: false,
  reason,
  words: NOT_AVAILABLE_WORDS[reason],
  heldUntil,
});

/**
 * A file that isn't available, as an answer to a person: 409 to open it in the vault, 429 or 503 to try again later
 * (with how long when known), 410 when the vault won't return it or nothing holds it.
 */
export class FileNotAvailable extends AppError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(status, code, message);
  }
}

export function notAvailableError(r: Extract<FileBytesResult, { ok: false }>): FileNotAvailable {
  const wait = r.heldUntil ? Math.max(1, Math.ceil((r.heldUntil.getTime() - Date.now()) / 1000)) : undefined;
  switch (r.reason) {
    case 'in_vault':
      return new FileNotAvailable(409, 'file.in_vault', r.words);
    case 'vault_read_cap':
      return new FileNotAvailable(429, 'file.vault_read_cap', r.words, wait);
    case 'vault_unavailable':
      return new FileNotAvailable(503, 'file.vault_unavailable', r.words, wait ?? 60);
    default:
      return new FileNotAvailable(410, `file.${r.reason}`, r.words);
  }
}
