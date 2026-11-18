/**
 * Sending to the household's Family Document Vault (ADR-0054 §3, §4, §10, §12; VLT-03, VLT-04, VLT-09). One system job,
 * `storage.vault`, separate from `storage.mirror` because its pacing, states and failures differ. It has the mirror's
 * shape: due connections through a definer function, each under an owner's RLS context, rows claimed with
 * `for update skip locked` and a lease, a run budget, then a reschedule for whatever is due next. Per connection, a run:
 *
 * 1. checks the connection when it last failed, is waiting, or hasn't been checked today (§12.1);
 * 2. moves files Montra has finished with from `queued` to `pending` (§3), and keeps the rest in Montra only;
 * 3. sends pending rows one at a time, with a pause between sends (§4): the id is saved before the first send, and a
 *    row whose last attempt got no answer is asked about before it is sent again;
 * 4. asks about rows in someone's Inbox, a hundred at a time, and marks them filed or not kept;
 * 5. reads the vault's changes feed a few times an hour, when the vault lets Montra read it (§9, `VaultFeed`);
 * 6. brings files held only in the vault back into Montra's storage, one at a time, when the owner asked (§10);
 * 7. removes Montra's copy of a filed file whose group is sent with no local copy, once all of §5 holds (`moveOne`),
 *    including the files a "Move existing documents" confirmed;
 * 8. withdraws Inbox items and deletes documents for files deleted for good (§10).
 *
 * The daily caps hold sending without counting as failures; a problem with the connection itself stops it and tells
 * owners once; five failures in a row turn it `failing`, as for a mirror. Nothing here logs a key, a signature, a
 * code, a file's name or its contents: only ids and codes.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import type { StorageDestinationTable, Trx, VaultConnectionStateTable, VaultItemTable } from '@montra/db';
import { asCurrencyCode, toDecimalString } from '@montra/domain';
import {
  isSentMode,
  VAULT_GROUP_KINDS,
  VAULT_GROUPS,
  vaultEffectiveModes,
  vaultGroupOf,
  vaultTypeKept,
  type FileKind,
  type StorageFileKind,
  type VaultGroup,
} from '@montra/schemas';
import { Db } from '../../db/database.js';
import { Worker } from '../../jobs/queue.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { FileBytes, type FileSource } from '../file-bytes.js';
import { MISSING_WORDS, MissingFiles } from '../missing-files.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../storage.js';
import { backoffMs, MAX_ATTEMPTS } from '../backoff.js';
import { VaultError, type VaultDocument, type VaultItemState } from '../destinations/vault.js';
import type { VaultConnection } from './connection.js';
import { FEED_MS, VaultFeed } from './vault.feed.js';
import {
  configOf,
  VAULT_FAILING_AFTER,
  VAULT_LABEL,
  VaultService,
  type VaultConfig,
} from './vault.service.js';

type Ctx = { workspaceId: string; userId: string };
type Row = Selectable<StorageDestinationTable>;
type Item = Selectable<VaultItemTable>;
type State = Selectable<VaultConnectionStateTable>;

const MINUTE = 60_000;
const LEASE_MS = 10 * MINUTE;
const RUN_BUDGET_MS = 2 * MINUTE;
/** Never wake again sooner than this, so a row that can't make progress can't spin the worker. */
const MIN_GAP_MS = 30_000;
/** §3: a file Montra is still reading is looked at again after this. */
const NOT_READY_MS = 5 * MINUTE;
/** A file in the trash waits there; restoring it puts it back in line within a day. */
const TRASHED_MS = 24 * 60 * MINUTE;
/** A group whose vault kind the vault no longer lets Montra send waits for the owner, or the vault, to change it. */
const KIND_GONE_MS = 6 * 60 * MINUTE;
/** §12.3: rows in someone's Inbox are asked about this often. */
export const POLL_MS = 30 * MINUTE;
/** §4: the pause between two sends to one vault. */
export const SEND_GAP_MS = 500;
/** §3: a new file waits this long, so the record it belongs to (a receipt, a payslip, an import) exists first. */
export const SETTLE_MS = 2 * MINUTE;
/** The longest jitter added to a wait the vault asked for (§12). */
const JITTER_MS = 15_000;
/** A daily cap with no reset time said: look again in an hour. */
const CAP_FALLBACK_MS = 60 * MINUTE;
/** §5: a filed file whose copy can't go yet (the mirror, a reading, the vault's say-so) is looked at again after this. */
export const REMOVE_WAIT_MS = 30 * MINUTE;
/** §10: bringing files back when the vault can't be asked just now: looked at again after this. */
const BRING_BACK_WAIT_MS = 15 * MINUTE;

/** In Montra's words, for Settings and the badges (§4.5, D8). Never a file name, never the vault's own words. */
export const NOT_KEPT_WORDS = {
  type: 'Not a type the vault keeps. It stays in Montra.',
  size: 'Too large for the vault. It stays in Montra.',
  kind: 'The vault doesn’t let Montra send this kind of document. It stays in Montra.',
  refused: 'The vault turned it down. It stays in Montra.',
  removed: 'The family removed it from the vault’s Inbox. Montra keeps its copy.',
  lapsed:
    'It waited in the vault’s Inbox until it lapsed, twice. Montra keeps its copy; you can send it again.',
  withdrawn: 'It was taken back from the vault’s Inbox. Montra keeps its copy.',
} as const;
const KIND_GONE_WORDS = 'The vault no longer lets Montra send this group’s kind. Choose another in Settings.';
const HASH_WORDS = 'The vault received a different file from the one Montra sent. It wasn’t sent again.';

/**
 * §4.1: a row's id in the vault, chosen once and saved before the first send: opaque, derived from the workspace, the
 * file and the row (so a file sent again after the vault didn't keep it goes as a new send), never a name or an amount.
 */
export function vaultRef(workspaceId: string, fileId: string, rowCreatedAt: Date): string {
  const digest = createHash('sha256')
    .update(`montra-vault:${workspaceId}:${fileId}:${rowCreatedAt.toISOString()}`)
    .digest('base64url');
  return `m1-${digest.slice(0, 40)}`;
}

export interface VaultRunOptions {
  budgetMs?: number;
  /** The pause between sends; tests pass 0. */
  sendGapMs?: number;
  /** How long a new file waits before it can go; tests pass 0. */
  settleMs?: number;
}

type Done = Record<
  'sent' | 'filed' | 'notKept' | 'failed' | 'withdrawn' | 'deleted' | 'moved' | 'broughtBack',
  number
>;
type Outcome = 'ok' | 'stop' | 'hold';

@Injectable()
export class VaultJobs {
  private readonly logger = new Logger('FamilyVault');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(FileBytes) private readonly files: FileBytes,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(VaultFeed) private readonly feed: VaultFeed,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(MissingFiles) private readonly missing: MissingFiles,
  ) {}

  register(): void {
    this.worker.register('storage.vault', async () => this.run());
  }

  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'storage.vault', ${at})`.execute(trx),
    );
  }

  /** One pass over every vault connection with work due, then the next wake-up. */
  async run(opts: VaultRunOptions = {}): Promise<Done> {
    const deadline = Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS);
    const done: Done = {
      sent: 0,
      filed: 0,
      notKept: 0,
      failed: 0,
      withdrawn: 0,
      deleted: 0,
      moved: 0,
      broughtBack: 0,
    };
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ workspace_id: string; destination_id: string; user_id: string | null }>`
        select * from app.vault_due()`.execute(trx),
    );
    for (const r of rows) {
      if (!r.user_id || Date.now() > deadline) continue;
      try {
        await this.runConnection(
          { workspaceId: r.workspace_id, userId: r.user_id },
          r.destination_id,
          deadline,
          done,
          opts,
        );
      } catch (e) {
        this.logger.warn(`Vault ${r.destination_id} failed: ${(e as Error).name}`);
      }
    }
    const next = await this.db.run({}, (trx) =>
      sql<{ t: Date | null }>`select app.vault_next() as t`.execute(trx),
    );
    const t = next.rows[0]?.t;
    const at = t ? new Date(t).getTime() : NaN;
    if (Number.isFinite(at)) await this.schedule(new Date(Math.max(at, Date.now() + MIN_GAP_MS)));
    return done;
  }

  private async runConnection(
    ctx: Ctx,
    destinationId: string,
    deadline: number,
    done: Done,
    opts: VaultRunOptions,
  ) {
    let row = await this.loadRow(ctx, destinationId);
    if (!row || row.status === 'paused' || row.status === 'disconnected') return;
    let config = configOf(row);
    if (config.stage === 'register') return;
    const state = await this.loadState(ctx, destinationId);

    // 1. The connection itself (§12.1).
    const mustCheck =
      row.status !== 'active' ||
      config.stage !== 'connected' ||
      config.hints === null ||
      !state?.checked_at ||
      state.next_check_at.getTime() <= Date.now();
    if (mustCheck) {
      const checked = await this.vault.checkRow(ctx, row);
      row = checked.row;
      config = configOf(row);
      if (checked.stopped && checked.check instanceof VaultError)
        await this.tellAttention(ctx, row, checked.check);
      if (checked.turnedFailing) await this.tellFailing(ctx, row);
      if (checked.check instanceof VaultError) {
        // Not stopped, just failed: what's waiting waits as long as the next check does.
        if (!checked.check.stopsConnection) {
          await this.holdBack(ctx, row.id, new Date(Date.now() + backoffMs(row.consecutive_failures)));
        }
        return;
      }
      if (!checked.check.approved || row.status === 'paused') return;
    }
    if (config.stage !== 'connected') return;

    let conn: VaultConnection;
    try {
      conn = await this.vault.openRow(ctx, row);
    } catch (e) {
      this.logger.warn(`Vault ${row.id} couldn't open: ${(e as Error).name}`);
      return;
    }
    try {
      await this.promote(ctx, row, config, opts);
      const held = state?.send_held_until && state.send_held_until.getTime() > Date.now();
      if (!held) {
        const out = await this.sendDue(ctx, row, config, conn, deadline, done, opts);
        if (out === 'stop') return;
      }
      if ((await this.poll(ctx, row, conn, deadline, done)) === 'stop') return;
      // What asking turned back into a send (a lapsed item's one resend, an id the vault doesn't know) goes now.
      if (!held && (await this.sendDue(ctx, row, config, conn, deadline, done, opts)) === 'stop') return;
      if (config.mayRead && (await this.readFeed(ctx, row, conn, deadline)) === 'stop') return;
      await this.bringBack(ctx, row.id, deadline, done);
      if ((await this.removeSources(ctx, row, config, conn, deadline, done)) === 'stop') return;
      await this.deletes(ctx, row, conn, deadline, done);
    } finally {
      conn.close();
    }
  }

  // ----- 2. Ready to go (§3) ---------------------------------------------------------------------------------------

  private async promote(ctx: Ctx, row: Row, config: VaultConfig, opts: VaultRunOptions): Promise<void> {
    const settle = opts.settleMs ?? SETTLE_MS;
    const modes = vaultEffectiveModes(config.groups);
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<{
        file_id: string;
        created_at: Date;
        kind: FileKind | null;
        sealed: boolean | null;
        mime: string | null;
        file_name: string | null;
        bytes: string | null;
        deleted_at: Date | null;
        file_created_at: Date | null;
        busy: boolean | null;
      }>`
        select i.file_id, i.created_at, f.kind, f.sealed, f.mime, f.file_name, f.bytes::text as bytes, f.deleted_at,
               f.created_at as file_created_at, app.vault_file_busy(i.file_id) as busy
          from app.vault_item i
          left join app.file f on f.workspace_id = i.workspace_id and f.id = i.file_id
         where i.workspace_id = ${ctx.workspaceId}::uuid and i.destination_id = ${row.id}::uuid
           and i.status = 'queued' and i.next_attempt_at <= now()
         order by i.created_at, i.file_id
         limit 500`.execute(trx),
    );
    const now = Date.now();
    for (const r of rows) {
      const key = { workspace_id: ctx.workspaceId, destination_id: row.id, file_id: r.file_id };
      if (!r.kind) {
        await this.dropItem(ctx, key);
        continue;
      }
      const group = vaultGroupOf({ kind: r.kind, sealed: r.sealed ?? false });
      if (group === 'never' || !isSentMode(modes[group])) {
        // Its group isn't sent any more (or never was): it stays in Montra only.
        await this.dropItem(ctx, key);
        continue;
      }
      if (r.deleted_at) {
        await this.setItem(ctx, key, { next_attempt_at: new Date(now + TRASHED_MS) });
        continue;
      }
      if (!vaultTypeKept({ mime: r.mime ?? '', fileName: r.file_name ?? '' }, config.mediaTypes)) {
        await this.notKeptHere(ctx, key, r.created_at, NOT_KEPT_WORDS.type);
        continue;
      }
      if (config.limits && Number(r.bytes ?? 0) > config.limits.maxUploadBytes) {
        await this.notKeptHere(ctx, key, r.created_at, NOT_KEPT_WORDS.size);
        continue;
      }
      const kind = config.groups.find((g) => g.group === group)?.vaultKind ?? null;
      if (!kind || !config.sendKinds.some((k) => k.key === kind)) {
        await this.setItem(ctx, key, {
          next_attempt_at: new Date(now + KIND_GONE_MS),
          last_error: KIND_GONE_WORDS,
        });
        continue;
      }
      if (r.busy || (r.file_created_at && r.file_created_at.getTime() > now - settle)) {
        await this.setItem(ctx, key, { next_attempt_at: new Date(now + NOT_READY_MS) });
        continue;
      }
      await this.setItem(ctx, key, { status: 'pending', next_attempt_at: sql`now()`, last_error: null });
    }
  }

  /** A file Montra keeps to itself (a type or size the vault doesn't keep), shown with the words why. */
  private async notKeptHere(ctx: Ctx, key: ItemKey, createdAt: Date, words: string) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.vault_item')
        .set({
          status: 'not_kept',
          vault_ref: sql`coalesce(vault_ref, ${vaultRef(key.workspace_id, key.file_id, createdAt)})`,
          not_kept_reason: words,
          resend_allowed: false,
          last_error: null,
          updated_at: new Date(),
        } as never)
        .where('workspace_id', '=', key.workspace_id)
        .where('destination_id', '=', key.destination_id)
        .where('file_id', '=', key.file_id)
        .execute(),
    );
  }

  // ----- 3. Sending, one at a time (§4) ------------------------------------------------------------------------------

  private async sendDue(
    ctx: Ctx,
    row: Row,
    config: VaultConfig,
    conn: VaultConnection,
    deadline: number,
    done: Done,
    opts: VaultRunOptions,
  ): Promise<Outcome> {
    let first = true;
    while (Date.now() < deadline) {
      const item = await this.claimOne(ctx, row.id);
      if (!item) return 'ok';
      if (!first && (opts.sendGapMs ?? SEND_GAP_MS) > 0) await pause(opts.sendGapMs ?? SEND_GAP_MS);
      first = false;
      const out = await this.sendOne(ctx, row, config, conn, item, done);
      if (out !== 'ok') return out;
    }
    return 'ok';
  }

  /** One pending row, oldest first, leased: only one is in flight for a connection at a time. */
  private async claimOne(ctx: Ctx, destinationId: string): Promise<Item | null> {
    const { rows } = await this.db.run(ctx, (trx) =>
      sql<Item>`
        -- Claimed in a CTE, so the limit holds: an IN (... limit) can be run again per row.
        with c as (
          select workspace_id, destination_id, file_id from app.vault_item
          where workspace_id = ${ctx.workspaceId}::uuid and destination_id = ${destinationId}::uuid
          and status = 'pending' and next_attempt_at <= now()
          order by created_at, file_id
          limit 1
          for update skip locked)
        update app.vault_item i
           set next_attempt_at = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = i.attempts + 1,
               updated_at = now()
          from c
         where i.workspace_id = c.workspace_id and i.destination_id = c.destination_id and i.file_id = c.file_id
        returning i.*`.execute(trx),
    );
    return rows[0] ?? null;
  }

  private async sendOne(
    ctx: Ctx,
    row: Row,
    config: VaultConfig,
    conn: VaultConnection,
    item: Item,
    done: Done,
  ): Promise<Outcome> {
    const key = {
      workspace_id: item.workspace_id,
      destination_id: item.destination_id,
      file_id: item.file_id,
    };
    const file = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.file')
        .select(['id', 'kind', 'file_name', 'mime', 'bytes', 'sha256', 'storage_key', 'deleted_at', 'sealed'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', item.file_id)
        .executeTakeFirst(),
    );
    if (!file || file.sealed) {
      await this.dropItem(ctx, key);
      return 'ok';
    }
    const group = vaultGroupOf({ kind: file.kind, sealed: file.sealed });
    const modes = vaultEffectiveModes(config.groups);
    if (group === 'never' || !isSentMode(modes[group])) {
      await this.dropItem(ctx, key);
      return 'ok';
    }
    if (file.deleted_at) {
      await this.setItem(ctx, key, {
        status: 'queued',
        attempts: Math.max(item.attempts - 1, 0),
        next_attempt_at: new Date(Date.now() + TRASHED_MS),
      });
      return 'ok';
    }

    try {
      // §4.4: a row whose last attempt got no answer is asked about before it is sent again. (A row sent again on
      // purpose, after a lapse or an id the vault didn't know, starts with no attempts, so it is simply sent.)
      let ref = item.vault_ref;
      if (ref && item.attempts > 1) {
        const known = (await conn.status([ref])).get(ref);
        if (known) {
          await this.apply(ctx, row, item, file.sha256, known, done);
          await this.succeeded(ctx, row);
          return 'ok';
        }
      } else if (!ref) {
        // §4.1: chosen once and saved, in its own transaction, before the first send.
        ref = vaultRef(item.workspace_id, item.file_id, item.created_at);
        await this.setItem(ctx, key, { vault_ref: ref });
      }
      // Montra's copy (or the mirror's), never the vault's own: only what Montra holds is sent (ADR-0054 §5).
      const got = await this.files.read(ctx, file, { vault: false });
      if (!got.ok) throw new VaultError('failed', { detail: `file ${got.reason}` });
      const bytes = got.bytes;
      const doc = await this.describe(ctx, config, group, {
        ref,
        fileId: file.id,
        fileName: file.file_name,
        mime: file.mime,
        bytes: bytes.length,
        sha256: file.sha256,
      });
      const answer = await conn.send(doc, bytes);
      done.sent++;
      await this.apply(ctx, row, { ...item, vault_ref: ref }, file.sha256, answer, done);
      await this.succeeded(ctx, row);
      return 'ok';
    } catch (e) {
      return this.sendFailed(ctx, row, item, e, done);
    }
  }

  /** What a failed attempt does to the row and the connection (§12). */
  private async sendFailed(ctx: Ctx, row: Row, item: Item, e: unknown, done: Done): Promise<Outcome> {
    const key = {
      workspace_id: item.workspace_id,
      destination_id: item.destination_id,
      file_id: item.file_id,
    };
    const err =
      e instanceof VaultError ? e : new VaultError('failed', { detail: (e as Error)?.name ?? 'error' });
    this.logger.warn(`Sending file ${item.file_id} to vault ${row.id}: ${err.code} ${err.opts.detail ?? ''}`);
    const release = Math.max(item.attempts - 1, 0);
    if (err.stopsConnection) {
      await this.setItem(ctx, key, { attempts: release, next_attempt_at: sql`now()` });
      await this.stop(ctx, row, err);
      return 'stop';
    }
    if (err.code === 'send_cap') {
      // §12: not a failure. Sending waits for the vault's next daily reset; the row keeps its place.
      const until =
        err.opts.heldUntil ?? (await this.resetAt(ctx, row.id)) ?? new Date(Date.now() + CAP_FALLBACK_MS);
      await this.setItem(ctx, key, { attempts: release, next_attempt_at: until });
      await this.holdSending(ctx, row.id, until);
      return 'hold';
    }
    if (err.code === 'retry_later') {
      // The vault asked Montra to wait (busy, or too many requests): at least that long, plus jitter, and with
      // Montra's own backoff. Not a failure of the connection, and the row doesn't give up over it.
      const wait = Math.max(
        err.opts.retryAfter ? err.opts.retryAfter.getTime() - Date.now() : 0,
        backoffMs(item.attempts),
      );
      await this.setItem(ctx, key, {
        next_attempt_at: new Date(Date.now() + wait + randomInt(JITTER_MS)),
        last_error: err.message,
      });
      return 'ok';
    }
    const final = err.code === 'hash_mismatch' || err.code === 'refused' || item.attempts >= MAX_ATTEMPTS;
    await this.setItem(ctx, key, {
      status: final ? 'failed' : 'pending',
      next_attempt_at: new Date(Date.now() + backoffMs(item.attempts)),
      last_error: err.code === 'hash_mismatch' ? HASH_WORDS : err.message,
    });
    if (final) done.failed++;
    await this.failed(ctx, row, err);
    // Can't reach the vault at all: everything else waits on the same backoff.
    if (err.code === 'unreachable' || err.code === 'not_allowed_host') {
      await this.holdBack(ctx, row.id, new Date(Date.now() + backoffMs(item.attempts)));
      return 'hold';
    }
    return 'ok';
  }

  /**
   * What the vault said about a row (§4.3–§4.5): in someone's Inbox, filed, or not kept. Its hash must be the file's;
   * a document that lapsed undecided is sent again once on its own, under the same id.
   */
  private async apply(
    ctx: Ctx,
    row: Row,
    item: Item,
    sha256: string,
    s: VaultItemState,
    done: Done,
  ): Promise<void> {
    const key = {
      workspace_id: item.workspace_id,
      destination_id: item.destination_id,
      file_id: item.file_id,
    };
    const now = new Date();
    if (s.state !== 'not_kept' && s.sha256 && s.sha256 !== sha256) {
      await this.setItem(ctx, key, { status: 'failed', last_error: HASH_WORDS });
      done.failed++;
      await this.failed(ctx, row, new VaultError('hash_mismatch'));
      return;
    }
    if (s.state === 'received') {
      await this.setItem(ctx, key, {
        status: 'received',
        received_at: item.received_at ?? now,
        vault_sha256: s.sha256,
        content_available: s.contentAvailable,
        attempts: 0,
        next_attempt_at: new Date(now.getTime() + POLL_MS),
        last_error: null,
      });
      return;
    }
    if (s.state === 'filed') {
      await this.setItem(ctx, key, {
        status: 'filed',
        received_at: item.received_at ?? now,
        filed_at: s.filedAt ?? item.filed_at ?? now,
        vault_document_id: s.documentId ?? item.vault_document_id,
        vault_version: s.version ?? item.vault_version,
        vault_sha256: s.sha256 ?? item.vault_sha256,
        content_available: s.contentAvailable,
        // §5: filed now, so whether Montra's copy goes is looked at (only for a group sent with no local copy).
        remove_at: item.status === 'filed' ? item.remove_at : sql`now()`,
        attempts: 0,
        last_error: null,
      });
      done.filed++;
      return;
    }
    if (s.why === 'lapsed' && item.auto_resends < 1) {
      await this.setItem(ctx, key, {
        status: 'pending',
        auto_resends: item.auto_resends + 1,
        attempts: 0,
        next_attempt_at: sql`now()`,
        last_error: null,
      });
      return;
    }
    const words =
      s.why === 'refused'
        ? NOT_KEPT_WORDS[s.refusal ?? 'refused']
        : s.why === 'lapsed'
          ? NOT_KEPT_WORDS.lapsed
          : s.why === 'withdrawn'
            ? NOT_KEPT_WORDS.withdrawn
            : NOT_KEPT_WORDS.removed;
    await this.setItem(ctx, key, {
      status: 'not_kept',
      not_kept_reason: words,
      // §4.5: the family decided, or the vault refused the kind: a person may send it again. A type or size the vault
      // doesn't keep won't change by sending again.
      resend_allowed: !(s.why === 'refused' && (s.refusal === 'type' || s.refusal === 'size')),
      attempts: 0,
      last_error: null,
    });
    done.notKept++;
    if (s.why === 'removed') await this.tellNotKept(ctx, row);
  }

  /**
   * §3, D5: what Montra says about a document. Its group's vault kind, a title from its name (and a business's or
   * rental's name), its date, and whom it belongs to when Montra knows (the person hint, by name, as the household
   * knows them; the vault decides whose Inbox). Amounts and an account's last four only with "Describe documents in
   * more detail". Only the hints the vault takes.
   */
  private async describe(
    ctx: Ctx,
    config: VaultConfig,
    group: VaultGroup,
    f: { ref: string; fileId: string; fileName: string; mime: string; bytes: number; sha256: string },
  ): Promise<VaultDocument> {
    const about = await this.db.run(ctx, (trx) => aboutFile(trx, ctx.workspaceId, f.fileId, group));
    const takes = new Set(config.hints ?? []);
    const base = f.fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || f.fileName;
    const title = about.entity ? `${base} · ${about.entity}` : base;
    const doc: VaultDocument = {
      ref: f.ref,
      vaultKind: config.groups.find((g) => g.group === group)!.vaultKind!,
      title: takes.has('title') ? title.slice(0, 200) : '',
      fileName: f.fileName,
      mediaType: f.mime,
      bytes: f.bytes,
      sha256: f.sha256,
      date: takes.has('issued') ? about.date : null,
      person: takes.has('person') ? about.person : null,
      taxYear: takes.has('tax_year') ? about.taxYear : null,
    };
    if (config.describeMore) {
      const detail: NonNullable<VaultDocument['detail']> = {};
      if (takes.has('amount') && about.amount) detail.amounts = [about.amount];
      if (takes.has('account_last4') && about.accountLast4) detail.accountLast4 = about.accountLast4;
      if (detail.amounts || detail.accountLast4) doc.detail = detail;
    }
    return doc;
  }

  // ----- 4. What became of them (§12.3) ------------------------------------------------------------------------------

  private async poll(
    ctx: Ctx,
    row: Row,
    conn: VaultConnection,
    deadline: number,
    done: Done,
  ): Promise<Outcome> {
    while (Date.now() < deadline) {
      const { rows: items } = await this.db.run(ctx, (trx) =>
        sql<Item>`
          -- Claimed in a CTE, so the limit holds: an IN (... limit) can be run again per row.
          with c as (
            select workspace_id, destination_id, file_id from app.vault_item
            where workspace_id = ${ctx.workspaceId}::uuid and destination_id = ${row.id}::uuid
            and status = 'received' and next_attempt_at <= now()
            order by next_attempt_at
            limit 100
            for update skip locked)
          update app.vault_item i
             set next_attempt_at = now() + ${`${POLL_MS} milliseconds`}::interval
            from c
           where i.workspace_id = c.workspace_id and i.destination_id = c.destination_id and i.file_id = c.file_id
          returning i.*`.execute(trx),
      );
      if (!items.length) return 'ok';
      let states: Map<string, VaultItemState>;
      try {
        states = await conn.status(items.map((i) => i.vault_ref!));
      } catch (e) {
        const err = e instanceof VaultError ? e : new VaultError('failed');
        if (err.stopsConnection) {
          await this.stop(ctx, row, err);
          return 'stop';
        }
        if (err.countsAsFailure && err.code !== 'retry_later') await this.failed(ctx, row, err);
        return 'hold';
      }
      const shas = await this.db.run(ctx, (trx) =>
        trx
          .selectFrom('app.file')
          .select(['id', 'sha256'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where(
            'id',
            'in',
            items.map((i) => i.file_id),
          )
          .execute(),
      );
      for (const item of items) {
        const s = states.get(item.vault_ref!);
        const sha = shas.find((x) => x.id === item.file_id)?.sha256;
        if (!sha) continue;
        if (!s) {
          // The vault doesn't know it: it never arrived after all. Sent again under the same id.
          await this.setItem(
            ctx,
            { workspace_id: item.workspace_id, destination_id: item.destination_id, file_id: item.file_id },
            { status: 'pending', attempts: 0, next_attempt_at: sql`now()` },
          );
          continue;
        }
        await this.apply(ctx, row, item, sha, s, done);
      }
      await this.succeeded(ctx, row);
    }
    return 'ok';
  }

  // ----- 5. Keeping in step (§9) -------------------------------------------------------------------------------------

  /**
   * The changes feed, when it is due: to the end, or as far as the run's budget goes, then again soon. A wait the vault
   * asks for is waited; not reaching it counts as a failure, as for sending; a connection problem stops the connection.
   */
  private async readFeed(ctx: Ctx, row: Row, conn: VaultConnection, deadline: number): Promise<Outcome> {
    const state = await this.feed.state(ctx, row.id);
    if (!state?.feed_next_at || state.feed_next_at.getTime() > Date.now()) return 'ok';
    try {
      const read = await this.feed.read(ctx, row.id, conn, deadline);
      await this.feed.next(ctx, row.id, new Date(Date.now() + (read.caughtUp ? FEED_MS : MIN_GAP_MS)));
      if (read.pages) await this.succeeded(ctx, row);
      return 'ok';
    } catch (e) {
      const err =
        e instanceof VaultError ? e : new VaultError('failed', { detail: (e as Error)?.name ?? 'error' });
      this.logger.warn(`Reading the feed of vault ${row.id}: ${err.code} ${err.opts.detail ?? ''}`);
      if (err.stopsConnection) {
        await this.stop(ctx, row, err);
        return 'stop';
      }
      const wait = Math.max(
        err.opts.retryAfter ? err.opts.retryAfter.getTime() - Date.now() : 0,
        backoffMs(row.consecutive_failures + 1),
      );
      await this.feed.next(ctx, row.id, new Date(Date.now() + wait + randomInt(JITTER_MS)));
      if (err.code !== 'retry_later') await this.failed(ctx, row, err);
      return 'hold';
    }
  }

  // ----- 6. Bringing files back (§10) -------------------------------------------------------------------------------

  /**
   * §10 "Bring the files back": each file held only in the vault, oldest first and one at a time, read back (from the
   * owner's own storage when it has a copy, else the vault, counted against its daily read cap) and stored as Montra's
   * copy again. The cap holds the rest until the vault's reset; a file the vault doesn't give back is missing (§5a) and
   * the next one is asked for. When none is left to fetch, the vault service ends it (and disconnects, when asked).
   */
  private async bringBack(ctx: Ctx, destinationId: string, deadline: number, done: Done): Promise<void> {
    const state = await this.loadState(ctx, destinationId);
    if (!state?.bring_back_at || state.bring_back_at.getTime() > Date.now()) return;
    const tried: string[] = [];
    while (Date.now() < deadline) {
      const f = await this.db.run(ctx, (trx) => {
        let q = trx
          .selectFrom('app.file')
          .select(['id', 'kind', 'mime', 'sha256', 'storage_key'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('location', '=', 'vault')
          .where('missing_since', 'is', null);
        if (tried.length) q = q.where('id', 'not in', tried);
        return q.orderBy('created_at').orderBy('id').limit(1).executeTakeFirst();
      });
      if (!f) {
        await this.vault.finishBringBack(ctx, destinationId);
        return;
      }
      tried.push(f.id);
      const got = await this.files.read(ctx, f);
      if (got.ok) {
        try {
          if (await this.keepAgain(ctx, f, got.bytes, got.from)) done.broughtBack++;
        } catch (e) {
          this.logger.warn(`File ${f.id} couldn't be brought back yet: ${(e as Error).name}`);
          await this.bringBackAt(ctx, destinationId, new Date(Date.now() + REMOVE_WAIT_MS));
          return;
        }
        continue;
      }
      if (got.reason === 'vault_read_cap') {
        // §12: not a failure. The rest wait for the vault's next daily reset.
        await this.bringBackAt(ctx, destinationId, got.heldUntil ?? new Date(Date.now() + CAP_FALLBACK_MS));
        return;
      }
      if (got.reason === 'vault_unavailable') {
        await this.bringBackAt(ctx, destinationId, new Date(Date.now() + BRING_BACK_WAIT_MS));
        return;
      }
      // `vault_refused` is marked missing by `FileBytes`; anything else nothing holds, so it is missing too (§5a).
      if (got.reason !== 'vault_refused') await this.missing.mark(ctx, [f.id], MISSING_WORDS.refused);
    }
  }

  /**
   * One file brought back: stored under a key never used before, and Montra's again. It is no longer a file that moved:
   * only a "Move existing documents" (with its confirmation) takes its copy away again. Audited, never with its name.
   */
  private async keepAgain(
    ctx: Ctx,
    f: { id: string; kind: string; mime: string },
    bytes: Uint8Array,
    from: FileSource,
  ): Promise<boolean> {
    const key = `${storageKey(ctx.workspaceId, f.kind, f.id)}-${randomUUID().slice(0, 8)}`;
    await this.storage.put(key, bytes, f.mime);
    const kept = await this.db.run(ctx, async (trx) => {
      const r = await trx
        .updateTable('app.file')
        .set({ storage_key: key, location: 'montra' })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', f.id)
        .where('location', '=', 'vault')
        .where('storage_key', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!r) return false;
      await trx
        .updateTable('app.vault_item')
        .set({ source_key: null, source_removed_at: null, updated_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('file_id', '=', f.id)
        .where('source_removed_at', 'is not', null)
        .execute();
      await trx
        .updateTable('app.vault_item')
        .set({ remove_at: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('file_id', '=', f.id)
        .execute();
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: null,
          actor_type: 'system',
          action: 'file.brought_back',
          subject_type: 'file',
          subject_id: f.id,
          diff: JSON.stringify({ from }),
        })
        .execute();
      return true;
    });
    // Someone provided it again meanwhile: theirs stands, and this copy goes.
    if (!kept) await this.storage.delete(key).catch(() => undefined);
    return kept;
  }

  private async bringBackAt(ctx: Ctx, destinationId: string, at: Date): Promise<void> {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.vault_connection_state')
        .set({ bring_back_at: at, updated_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('bring_back_at', 'is not', null)
        .execute(),
    );
  }

  // ----- 6. Removing Montra's copy (§5) -------------------------------------------------------------------------------

  /**
   * §5: for a group sent with no local copy, Montra's copy of a file goes only when all of these hold:
   *
   * 1. the vault reports the item filed (never while it is only in someone's Inbox);
   * 2. the vault says it could give back the exact file Montra sent (`content_available`), asked again when it hasn't
   *    said so since the item was filed;
   * 3. when the owner's own S3/WebDAV storage is set to copy that kind, it has copied this file (`done`): it copies from
   *    Montra's copy, so that stays until then;
   * 4. nothing in Montra is reading the file or waiting on a person for it (`app.vault_file_busy`);
   *
   * and the connection is active. Then, in one transaction, the file's `location` becomes `vault`, its key moves to the
   * outbox row as the object still to remove, and an audit row says it moved. The object is deleted after the commit,
   * and only then is `source_removed_at` set, so a crash in between leaves a row whose object the next run deletes.
   */
  private async removeSources(
    ctx: Ctx,
    row: Row,
    config: VaultConfig,
    conn: VaultConnection,
    deadline: number,
    done: Done,
  ): Promise<Outcome> {
    await this.finishRemovals(ctx, row.id);
    const modes = vaultEffectiveModes(config.groups);
    const kinds: StorageFileKind[] = VAULT_GROUPS.filter((g) => modes[g] === 'sent_no_copy').flatMap((g) => [
      ...VAULT_GROUP_KINDS[g],
    ]);
    if (!kinds.length) {
      // No group goes without a copy (any more): nothing is to be looked at.
      await this.db.run(ctx, (trx) =>
        trx
          .updateTable('app.vault_item')
          .set({ remove_at: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', row.id)
          .where('remove_at', 'is not', null)
          .execute(),
      );
      return 'ok';
    }
    // Files that moved before and that Montra put back to read them again (`FileBytes.ensureHeld`): theirs goes again
    // once nothing reads them. Files filed while their group kept a copy move only with the move backfill.
    await this.db.run(ctx, (trx) =>
      sql`
        update app.vault_item i set remove_at = now()
          from app.file f
         where i.workspace_id = ${ctx.workspaceId}::uuid and i.destination_id = ${row.id}::uuid
           and i.status = 'filed' and i.remove_at is null and i.source_removed_at is not null
           and f.workspace_id = i.workspace_id and f.id = i.file_id and f.location = 'montra'
           and f.deleted_at is null and not f.sealed and f.kind = any (${kinds}::text[])`.execute(trx),
    );
    if (row.status !== 'active') {
      // §5: only while the connection is active. Looked at again later, without spinning the worker meanwhile.
      await this.waitRemoval(ctx, row.id, null);
      return 'ok';
    }
    while (Date.now() < deadline) {
      const { rows: items } = await this.db.run(ctx, (trx) =>
        sql<Item>`
          -- Claimed in a CTE, so the limit holds: an IN (... limit) can be run again per row.
          with c as (
            select workspace_id, destination_id, file_id from app.vault_item
            where workspace_id = ${ctx.workspaceId}::uuid and destination_id = ${row.id}::uuid
            and remove_at <= now()
            order by remove_at, file_id
            limit 20
            for update skip locked)
          update app.vault_item i set remove_at = now() + ${`${LEASE_MS} milliseconds`}::interval
            from c
           where i.workspace_id = c.workspace_id and i.destination_id = c.destination_id and i.file_id = c.file_id
          returning i.*`.execute(trx),
      );
      if (!items.length) return 'ok';
      // §5.2: what the vault last said may be from before it filed the item: ask again where it hasn't said yes.
      const ask = items.filter((i) => i.status === 'filed' && i.content_available !== true && i.vault_ref);
      if (ask.length) {
        try {
          const states = await conn.status(ask.map((i) => i.vault_ref!));
          for (const i of ask) {
            const s = states.get(i.vault_ref!);
            if (s?.state !== 'filed') continue;
            i.content_available = s.contentAvailable;
            await this.setItem(
              ctx,
              { workspace_id: ctx.workspaceId, destination_id: row.id, file_id: i.file_id },
              { content_available: s.contentAvailable },
            );
          }
        } catch (e) {
          const err = e instanceof VaultError ? e : new VaultError('failed');
          await this.waitRemoval(
            ctx,
            row.id,
            items.map((i) => i.file_id),
          );
          if (err.stopsConnection) {
            await this.stop(ctx, row, err);
            return 'stop';
          }
          if (err.countsAsFailure && err.code !== 'retry_later') await this.failed(ctx, row, err);
          return 'hold';
        }
      }
      for (const item of items) await this.moveOne(ctx, row.id, kinds, item, done);
    }
    return 'ok';
  }

  /** One file, if §5 holds for it now: moved in one transaction, then its object removed. */
  private async moveOne(
    ctx: Ctx,
    destinationId: string,
    kinds: readonly StorageFileKind[],
    item: Item,
    done: Done,
  ): Promise<void> {
    const key = { workspace_id: ctx.workspaceId, destination_id: destinationId, file_id: item.file_id };
    const moved = await this.db.run(ctx, async (trx) => {
      const f = await trx
        .selectFrom('app.file')
        .select(['id', 'kind', 'storage_key', 'location', 'sha256', 'deleted_at', 'sealed'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', item.file_id)
        .forUpdate()
        .executeTakeFirst();
      const i = await trx
        .selectFrom('app.vault_item')
        .selectAll()
        .where('workspace_id', '=', key.workspace_id)
        .where('destination_id', '=', key.destination_id)
        .where('file_id', '=', key.file_id)
        .forUpdate()
        .executeTakeFirst();
      if (!i) return null;
      const not = async (at: Date | null) => {
        await trx
          .updateTable('app.vault_item')
          .set({ remove_at: at })
          .where('workspace_id', '=', key.workspace_id)
          .where('destination_id', '=', key.destination_id)
          .where('file_id', '=', key.file_id)
          .execute();
        return null;
      };
      const later = () => not(new Date(Date.now() + REMOVE_WAIT_MS));
      // Not a file whose copy goes: held only by the vault already, in the trash, sealed, or no longer in such a group.
      if (
        !f ||
        f.location !== 'montra' ||
        !f.storage_key ||
        f.deleted_at ||
        f.sealed ||
        !(kinds as readonly string[]).includes(f.kind)
      )
        return not(null);
      // 1. Filed, and what the vault holds is the file Montra holds.
      if (i.status !== 'filed' || !i.filed_at) return not(null);
      if (i.vault_sha256 && i.vault_sha256 !== f.sha256) return not(null);
      // 2. The vault could give it back.
      if (i.content_available !== true) return later();
      // 3. The owner's own storage, when it copies this kind, has it.
      const mirror = await sql<{ done: boolean }>`
        select exists (select 1 from app.storage_mirror_item mi
                        where mi.workspace_id = d.workspace_id and mi.destination_id = d.id
                          and mi.file_id = ${f.id}::uuid and mi.status = 'done') as done
          from app.storage_destination d
         where d.workspace_id = ${ctx.workspaceId}::uuid and d.kind in ('s3', 'webdav') and d.mirror_files
           and ${f.kind}::text = any (d.file_kinds)`.execute(trx);
      if (mirror.rows.some((m) => !m.done)) return later();
      // 4. Nothing in Montra is reading it or waiting on a person for it.
      const busy = await sql<{ busy: boolean }>`select app.vault_file_busy(${f.id}::uuid) as busy`.execute(
        trx,
      );
      if (busy.rows[0]?.busy) return later();

      await trx
        .updateTable('app.file')
        .set({ location: 'vault', storage_key: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', f.id)
        .execute();
      await trx
        .updateTable('app.vault_item')
        .set({ source_key: f.storage_key, source_removed_at: null, remove_at: null, updated_at: new Date() })
        .where('workspace_id', '=', key.workspace_id)
        .where('destination_id', '=', key.destination_id)
        .where('file_id', '=', key.file_id)
        .execute();
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: null,
          actor_type: 'system',
          action: 'file.moved_to_vault',
          subject_type: 'file',
          subject_id: f.id,
          diff: JSON.stringify({ destinationId, vaultDocumentId: i.vault_document_id }),
        })
        .execute();
      return f.storage_key;
    });
    if (!moved) return;
    done.moved++;
    await this.dropSource(ctx, key, moved);
  }

  /**
   * §5: deletes an object whose file moved to the vault, then says so. Safe to run again: a missing object is no error,
   * and an object that is some file's copy again is never deleted, only let go of.
   */
  private async dropSource(ctx: Ctx, key: ItemKey, source: string): Promise<void> {
    const inUse = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.file')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('storage_key', '=', source)
        .executeTakeFirst(),
    );
    if (!inUse) {
      try {
        await this.storage.delete(source);
      } catch (e) {
        // Left for the next run (`finishRemovals`); the vault holds the file meanwhile.
        this.logger.warn(
          `File ${key.file_id}: Montra's old copy couldn't be removed yet: ${(e as Error).name}`,
        );
        return;
      }
    }
    const now = new Date();
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.vault_item')
        .set(inUse ? { source_key: null, updated_at: now } : { source_removed_at: now, updated_at: now })
        .where('workspace_id', '=', key.workspace_id)
        .where('destination_id', '=', key.destination_id)
        .where('file_id', '=', key.file_id)
        .where('source_key', '=', source)
        .where('source_removed_at', 'is', null)
        .execute(),
    );
  }

  /** §5: objects a crash left behind between moving their files and deleting them. */
  private async finishRemovals(ctx: Ctx, destinationId: string): Promise<void> {
    const left = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.vault_item')
        .select(['file_id', 'source_key'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('source_key', 'is not', null)
        .where('source_removed_at', 'is', null)
        .limit(100)
        .execute(),
    );
    for (const l of left) {
      await this.dropSource(
        ctx,
        { workspace_id: ctx.workspaceId, destination_id: destinationId, file_id: l.file_id },
        l.source_key!,
      );
    }
  }

  /** Looks at these rows (or every due one) again later, without spinning the worker meanwhile. */
  private async waitRemoval(ctx: Ctx, destinationId: string, fileIds: readonly string[] | null) {
    await this.db.run(ctx, (trx) => {
      let q = trx
        .updateTable('app.vault_item')
        .set({ remove_at: new Date(Date.now() + REMOVE_WAIT_MS) })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('remove_at', 'is not', null);
      q = fileIds ? q.where('file_id', 'in', [...fileIds]) : q.where('remove_at', '<=', new Date());
      return q.execute();
    });
  }

  // ----- 7. Withdrawals and deletes (§10) ----------------------------------------------------------------------------

  private async deletes(
    ctx: Ctx,
    row: Row,
    conn: VaultConnection,
    deadline: number,
    done: Done,
  ): Promise<void> {
    while (Date.now() < deadline) {
      const { rows: items } = await this.db.run(ctx, (trx) =>
        sql<Item>`
          -- Claimed in a CTE, so the limit holds: an IN (... limit) can be run again per row.
          with c as (
            select workspace_id, destination_id, file_id from app.vault_item
            where workspace_id = ${ctx.workspaceId}::uuid and destination_id = ${row.id}::uuid
            and status = 'delete' and next_attempt_at <= now()
            order by next_attempt_at
            limit 20
            for update skip locked)
          update app.vault_item i
             set next_attempt_at = now() + ${`${LEASE_MS} milliseconds`}::interval, attempts = i.attempts + 1
            from c
           where i.workspace_id = c.workspace_id and i.destination_id = c.destination_id and i.file_id = c.file_id
          returning i.*`.execute(trx),
      );
      if (!items.length) return;
      for (const item of items) {
        const key = {
          workspace_id: item.workspace_id,
          destination_id: item.destination_id,
          file_id: item.file_id,
        };
        try {
          let documentId = item.filed_at ? item.vault_document_id : null;
          if (!item.filed_at && item.vault_ref) {
            // An Inbox item for a file Montra deleted for good: take it back. Filed meanwhile: delete it only when the
            // owner asked for that and the vault allows it.
            const now = await conn.withdraw(item.vault_ref);
            done.withdrawn++;
            documentId =
              now?.state === 'filed' && row.delete_with_montra && row.can_delete ? now.documentId : null;
          }
          if (documentId) {
            await conn.remove(documentId);
            done.deleted++;
          }
          await this.dropItem(ctx, key);
        } catch (e) {
          const err = e instanceof VaultError ? e : new VaultError('failed');
          if (err.stopsConnection) {
            await this.setItem(ctx, key, {
              attempts: Math.max(item.attempts - 1, 0),
              next_attempt_at: sql`now()`,
            });
            await this.stop(ctx, row, err);
            return;
          }
          // Kept as a row to delete, tried again on Montra's backoff; daily at most once it has tried enough.
          await this.setItem(ctx, key, {
            next_attempt_at: new Date(Date.now() + backoffMs(item.attempts)),
            last_error: err.message,
          });
          if (err.countsAsFailure) await this.failed(ctx, row, err);
        }
      }
    }
  }

  // ----- Rows ----------------------------------------------------------------------------------------------------

  private async setItem(ctx: Ctx, key: ItemKey, set: Partial<Record<keyof VaultItemTable, unknown>>) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.vault_item')
        .set({ ...set, updated_at: new Date() } as never)
        .where('workspace_id', '=', key.workspace_id)
        .where('destination_id', '=', key.destination_id)
        .where('file_id', '=', key.file_id)
        .execute(),
    );
  }

  private async dropItem(ctx: Ctx, key: ItemKey) {
    await this.db.run(ctx, (trx) =>
      trx
        .deleteFrom('app.vault_item')
        .where('workspace_id', '=', key.workspace_id)
        .where('destination_id', '=', key.destination_id)
        .where('file_id', '=', key.file_id)
        .execute(),
    );
  }

  /** Holds back everything waiting to be sent or asked about, until `until`. */
  private async holdBack(ctx: Ctx, destinationId: string, until: Date) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.vault_item')
        .set({ next_attempt_at: until })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('status', 'in', ['pending', 'received', 'delete'])
        .where('next_attempt_at', '<', until)
        .execute(),
    );
  }

  /** §12: the day's sending is used up. Pending rows wait for the reset, and Settings says so; not a failure. */
  private async holdSending(ctx: Ctx, destinationId: string, until: Date) {
    await this.db.run(ctx, async (trx) => {
      await trx
        .updateTable('app.vault_connection_state')
        .set({ send_held_until: until, updated_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .execute();
      await trx
        .updateTable('app.vault_item')
        .set({ next_attempt_at: until })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('status', '=', 'pending')
        .where('next_attempt_at', '<', until)
        .execute();
    });
  }

  private async resetAt(ctx: Ctx, destinationId: string): Promise<Date | null> {
    const s = await this.loadState(ctx, destinationId);
    return s?.daily_reset_at && s.daily_reset_at.getTime() > Date.now() ? s.daily_reset_at : null;
  }

  private loadRow(ctx: Ctx, destinationId: string): Promise<Row | undefined> {
    return this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.storage_destination')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', destinationId)
        .where('kind', '=', 'fdv')
        .executeTakeFirst(),
    );
  }

  private loadState(ctx: Ctx, destinationId: string): Promise<State | undefined> {
    return this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.vault_connection_state')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .executeTakeFirst(),
    );
  }

  // ----- The connection's state ------------------------------------------------------------------------------------

  private async succeeded(ctx: Ctx, row: Row) {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.storage_destination')
        .set({
          last_success_at: new Date(),
          consecutive_failures: 0,
          last_error: null,
          last_error_at: null,
          status: sql`case when status = 'failing' then 'active' else status end`,
        } as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .execute(),
    );
  }

  private async failed(ctx: Ctx, row: Row, err: VaultError) {
    if (!err.countsAsFailure) return;
    const turned = await this.db.run(ctx, async (trx) => {
      const r = await trx
        .updateTable('app.storage_destination')
        .set({
          consecutive_failures: sql`consecutive_failures + 1`,
          last_error: err.shown,
          last_error_at: new Date(),
          status: sql`case when status = 'active' and consecutive_failures + 1 >= ${VAULT_FAILING_AFTER} then 'failing' else status end`,
        } as never)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .returning(['status', 'consecutive_failures'])
        .executeTakeFirst();
      return r?.status === 'failing' && r.consecutive_failures === VAULT_FAILING_AFTER;
    });
    if (turned) await this.tellFailing(ctx, row);
  }

  /**
   * §12: a problem with the connection itself stops it at once (`needs_vault`), with the vault's own words for owners,
   * and nothing is retried until a check passes. Owners hear about it once, as it stops.
   */
  private async stop(ctx: Ctx, row: Row, err: VaultError) {
    const now = new Date();
    const turned = await this.db.run(ctx, async (trx) => {
      const before = await trx
        .selectFrom('app.storage_destination')
        .select('status')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .forUpdate()
        .executeTakeFirst();
      if (!before || before.status === 'paused') return false;
      await trx
        .updateTable('app.storage_destination')
        .set({ status: 'needs_vault', last_error: err.shown, last_error_at: now, updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .execute();
      await trx
        .updateTable('app.vault_connection_state')
        .set({ next_check_at: new Date(now.getTime() + 15 * MINUTE), updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', row.id)
        .execute();
      return before.status !== 'needs_vault';
    });
    if (turned) await this.tellAttention(ctx, row, err);
  }

  // ----- Telling people (no file names, ever) -------------------------------------------------------------------------

  private async tellAttention(ctx: Ctx, row: Row, err: VaultError) {
    await this.tell(ctx, row, {
      type: 'vault_attention',
      dedupeKey: `vault_attention:${row.id}:${today()}`,
      title: `${VAULT_LABEL} needs someone to look at Montra’s connection`,
      body: `${err.shown} Montra stopped sending until it’s sorted out. Your files are safe in Montra.`,
    });
  }

  private async tellNotKept(ctx: Ctx, row: Row) {
    await this.tell(ctx, row, {
      type: 'vault_attention',
      dedupeKey: `vault_attention:not_kept:${row.id}:${today()}`,
      title: `Some documents weren’t kept in ${VAULT_LABEL}`,
      body: 'Montra keeps its copies. See your storage settings for which ones, and to send them again.',
    });
  }

  private async tellFailing(ctx: Ctx, row: Row) {
    await this.tell(ctx, row, {
      type: 'storage_failing',
      dedupeKey: `storage_failing:${row.id}:${today()}`,
      title: `Montra can’t send documents to ${VAULT_LABEL}`,
      body: 'Your files are safe in Montra, and sending picks up again once the vault answers. See your storage settings.',
    });
  }

  /** Each owner and admin, under their own RLS, as the mirror tells them. */
  private async tell(
    ctx: Ctx,
    row: Row,
    n: { type: 'vault_attention' | 'storage_failing'; dedupeKey: string; title: string; body: string },
  ) {
    const people = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.workspace_member')
        .select('user_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('role', 'in', ['owner', 'admin'])
        .where('status', '=', 'active')
        .execute(),
    );
    for (const p of people) {
      if (!p.user_id) continue;
      const who = { workspaceId: ctx.workspaceId, userId: p.user_id };
      try {
        await this.db.run(who, async (trx) => {
          const prefs = await this.notifications.prefsIn(trx, who.userId);
          await this.notifications.create(
            trx,
            who,
            { ...n, link: `/w/${who.workspaceId}/settings?tab=storage` },
            prefs,
          );
        });
      } catch (e) {
        this.logger.warn(`Couldn't tell ${who.userId} about vault ${row.id}: ${(e as Error).name}`);
      }
    }
  }
}

type ItemKey = { workspace_id: string; destination_id: string; file_id: string };

const today = () => new Date().toISOString().slice(0, 10);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What Montra knows about a file from the record it belongs to (§3): its date, person, entity and, for D5, amounts. */
interface About {
  date: string | null;
  person: string | null;
  entity: string | null;
  taxYear: number | null;
  amount: { amount: string; currency: string } | null;
  accountLast4: string | null;
}

async function aboutFile(trx: Trx, workspaceId: string, fileId: string, group: VaultGroup): Promise<About> {
  const none: About = {
    date: null,
    person: null,
    entity: null,
    taxYear: null,
    amount: null,
    accountLast4: null,
  };
  type R = {
    date: string | null;
    person: string | null;
    entity: string | null;
    entity_type: string | null;
    tax_year: number | null;
    amount: string | null;
    currency: string | null;
    last4: string | null;
  };
  let q;
  switch (group) {
    case 'receipts':
      q = sql<R>`
        select r.receipt_date::text as date, null::text as person, e.name as entity, e.type as entity_type,
               null::int as tax_year, r.total_minor::text as amount, r.currency, r.card_last4 as last4
          from app.receipt r join app.entity e on e.workspace_id = r.workspace_id and e.id = r.entity_id
         where r.workspace_id = ${workspaceId}::uuid and ${fileId}::uuid = any (r.attachment_ids)
           and r.deleted_at is null
         order by r.created_at desc limit 1`;
      break;
    case 'payslips':
      q = sql<R>`
        select p.pay_date::text as date, m.name as person, e.name as entity, e.type as entity_type,
               null::int as tax_year, p.net_minor::text as amount, p.currency, null::text as last4
          from app.payslip p
          join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
          left join app.family_member m on m.workspace_id = p.workspace_id and m.id = p.member_id
         where p.workspace_id = ${workspaceId}::uuid and ${fileId}::uuid = any (p.attachment_ids)
         order by p.created_at desc limit 1`;
      break;
    case 'tax_documents':
      q = sql<R>`
        select null::text as date, m.name as person, null::text as entity, null::text as entity_type,
               t.tax_year, null::text as amount, null::text as currency, t.account_last4 as last4
          from app.tax_form t
          left join app.family_member m on m.workspace_id = t.workspace_id and m.id = t.person_member_id
         where t.workspace_id = ${workspaceId}::uuid and ${fileId}::uuid = any (t.file_ids) and t.deleted_at is null
         order by t.created_at desc limit 1`;
      break;
    case 'statements':
      q = sql<R>`
        select b.max_date::text as date, null::text as person, e.name as entity, e.type as entity_type,
               null::int as tax_year, null::text as amount, null::text as currency, null::text as last4
          from app.import_batch b join app.entity e on e.workspace_id = b.workspace_id and e.id = b.entity_id
         where b.workspace_id = ${workspaceId}::uuid and b.file_id = ${fileId}::uuid
         order by b.created_at desc limit 1`;
      break;
    case 'bills':
      q = sql<R>`
        select coalesce(h.bill_date, h.due_date)::text as date, m.name as person, e.name as entity,
               e.type as entity_type, null::int as tax_year, h.amount_minor::text as amount, h.currency,
               null::text as last4
          from app.household_bill h
          join app.entity e on e.workspace_id = h.workspace_id and e.id = h.entity_id
          left join app.family_member m on m.workspace_id = h.workspace_id and m.id = h.member_id
         where h.workspace_id = ${workspaceId}::uuid and ${fileId}::uuid = any (h.attachment_ids)
        union all
        select b.bill_date::text, null, e.name, e.type, null, b.amount_minor::text, b.currency, null
          from app.bill b join app.entity e on e.workspace_id = b.workspace_id and e.id = b.entity_id
         where b.workspace_id = ${workspaceId}::uuid and ${fileId}::uuid = any (b.attachment_ids)
         limit 1`;
      break;
    default:
      return none;
  }
  const r = (await q.execute(trx)).rows[0];
  if (!r) return none;
  let amount: About['amount'] = null;
  if (r.amount !== null && r.currency) {
    try {
      amount = {
        amount: toDecimalString({ amount: BigInt(r.amount), currency: asCurrencyCode(r.currency) }),
        currency: r.currency,
      };
    } catch {
      amount = null;
    }
  }
  return {
    date: r.date,
    person: r.person,
    // A business's or rental's name helps a household tell papers apart; their own books' name doesn't.
    entity: r.entity && r.entity_type && r.entity_type !== 'personal' ? r.entity : null,
    taxYear: r.tax_year,
    amount,
    accountLast4: r.last4 && /^\d{4}$/.test(r.last4) ? r.last4 : null,
  };
}
