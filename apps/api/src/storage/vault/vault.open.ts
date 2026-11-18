/**
 * Opening a document in the household's Family Document Vault (ADR-0054 §9; VLT-06). A person clicks "Open in the
 * vault"; Montra makes a single-use link then, and the API answers with a redirect to it at once. The link is never
 * stored, logged, cached, emailed, put in a notification or prefetched: it lives in this request and its answer's
 * `Location`, nowhere else. The audit row says who opened which file, never the link.
 *
 * Who may open a document is who may see its file in Montra (row-level security on `app.file`, with the restricted
 * rules for payslips and tax forms); the vault then applies its own rules to the link. The connection and its sealed key
 * are for owners and admins, so the link is made under the context of the owner the connection acts as, as the job
 * does, and only after the person's own context has shown they can see the file.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError } from '../../common/errors.js';
import { Db } from '../../db/database.js';
import { VaultError } from '../destinations/vault.js';
import { configOf, scheduleVault, VaultService } from './vault.service.js';
import { FEED_FRESH_MS, VaultFeed } from './vault.feed.js';

type Ctx = { workspaceId: string; userId: string };

/** How long catching up the feed may take before a document is opened (§9); past that, it opens anyway. */
const CATCH_UP_MS = 5_000;
const CATCH_UP_PAGES = 5;

/** A refusal to open, in words, with how long to wait when the vault's hourly limit on links is reached. */
export class VaultOpenRefused extends AppError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(status, code, message);
  }
}

const OUT_OF_REACH = 'No longer available in Family Document Vault.';

@Injectable()
export class VaultOpener {
  private readonly logger = new Logger('FamilyVault');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(VaultFeed) private readonly feed: VaultFeed,
  ) {}

  /**
   * A single-use link for one file, made now. `view` falls back to a download link when the vault can't show the type
   * as pages and lets Montra download. The caller redirects to it at once and keeps it nowhere.
   */
  async open(ctx: Ctx, fileId: string, mode: 'view' | 'download'): Promise<URL> {
    const target = await this.target(ctx, fileId);
    if (target.status === 'out_of_reach') throw new VaultOpenRefused(410, 'vault.out_of_reach', OUT_OF_REACH);
    if (target.status !== 'filed' || !target.userId) {
      throw new VaultOpenRefused(409, 'vault.not_filed', 'This document isn’t filed in the vault yet.');
    }
    const actor = { workspaceId: ctx.workspaceId, userId: target.userId };
    const row = await this.db.run(actor, (trx) => this.vault.row(trx, actor));
    if (!row || row.id !== target.destinationId) throw notInVault();
    // §10: disconnected, Montra has no key to ask the vault with.
    if (row.status === 'disconnected') {
      throw new VaultOpenRefused(409, 'vault.disconnected', 'Montra is disconnected from the vault.');
    }
    const config = configOf(row);
    if (config.stage !== 'connected' || row.status === 'needs_vault') {
      throw new VaultOpenRefused(
        409,
        'vault.needs_vault',
        row.last_error ?? 'The vault needs someone to look at Montra’s connection there.',
      );
    }
    if (!config.mayOpen) throw refused(new VaultError('cannot_open'));

    const conn = await this.vault.openRow(actor, row);
    let url: URL;
    let made: 'view' | 'download' = mode;
    try {
      // §9: the feed is read before a vault-held document is shown, so a document the vault no longer shows Montra
      // isn't opened as if it were there.
      const state = await this.feed.state(actor, row.id);
      if (
        config.mayRead &&
        row.status !== 'paused' &&
        (!state?.feed_read_at || state.feed_read_at.getTime() < Date.now() - FEED_FRESH_MS)
      ) {
        try {
          await this.feed.read(actor, row.id, conn, Date.now() + CATCH_UP_MS, CATCH_UP_PAGES);
        } catch (e) {
          if (e instanceof VaultError && e.stopsConnection) {
            await this.wakeCheck(actor, row.id);
            throw refused(e);
          }
          // The job reads it again soon; opening goes on with what Montra knows.
        }
      }
      const now = await this.target(ctx, fileId);
      if (now.status === 'out_of_reach') throw new VaultOpenRefused(410, 'vault.out_of_reach', OUT_OF_REACH);
      if (now.status !== 'filed' || !now.documentId) {
        throw new VaultOpenRefused(409, 'vault.not_filed', 'This document isn’t filed in the vault yet.');
      }
      try {
        url = await conn.link(now.documentId, mode);
      } catch (e) {
        // §9: a type the vault can't draw opens as a download instead, when the vault lets Montra download.
        if (!(e instanceof VaultError && e.code === 'cannot_view' && mode === 'view' && config.mayReadBack))
          throw e;
        url = await conn.link(now.documentId, 'download');
        made = 'download';
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      const err =
        e instanceof VaultError ? e : new VaultError('failed', { detail: (e as Error)?.name ?? 'error' });
      this.logger.warn(`Opening file ${fileId} in vault ${row.id}: ${err.code} ${err.opts.detail ?? ''}`);
      if (err.stopsConnection) await this.wakeCheck(actor, row.id);
      // The vault won't open it: the feed, not this answer, is the record, so the job reads it again now.
      if (err.code === 'unavailable') {
        await this.wakeFeed(actor, row.id);
        throw new VaultOpenRefused(410, 'vault.out_of_reach', OUT_OF_REACH);
      }
      throw refused(err);
    } finally {
      conn.close();
    }

    await this.db.run(ctx, (trx) =>
      trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: ctx.userId,
          action: 'file.vault_link_made',
          subject_type: 'file',
          subject_id: fileId,
          diff: JSON.stringify({ mode: made }),
        })
        .execute(),
    );
    return url;
  }

  /** The file as the person sees it (RLS on `app.file`), then its row in the vault's outbox, through a definer. */
  private async target(ctx: Ctx, fileId: string) {
    return this.db.run(ctx, async (trx) => {
      const file = await trx
        .selectFrom('app.file')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirst();
      if (!file) throw new AppError(404, 'not_found', 'File not found');
      const { rows } = await sql<{
        destination_id: string;
        document_id: string | null;
        status: string;
        user_id: string | null;
      }>`select * from app.vault_file_open(${fileId}::uuid)`.execute(trx);
      const r = rows[0];
      if (!r) throw notInVault();
      return {
        destinationId: r.destination_id,
        documentId: r.document_id,
        status: r.status,
        userId: r.user_id,
      };
    });
  }

  private async wakeFeed(actor: Ctx, destinationId: string) {
    await this.feed.next(actor, destinationId, new Date());
    await this.db.run(actor, (trx) => scheduleVault(trx));
  }

  private async wakeCheck(actor: Ctx, destinationId: string) {
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
}

const notInVault = () => new AppError(404, 'vault.not_in_vault', 'This file isn’t in the vault.');

/** A `VaultError` as an answer to the person who clicked: its words, never its detail. */
function refused(e: VaultError): VaultOpenRefused {
  switch (e.code) {
    case 'links_full': {
      const s = e.opts.retryAfter
        ? Math.max(1, Math.ceil((e.opts.retryAfter.getTime() - Date.now()) / 1000))
        : 60;
      return new VaultOpenRefused(429, 'vault.links_full', e.shown, s);
    }
    case 'cannot_view':
    case 'cannot_open':
      return new VaultOpenRefused(422, `vault.${e.code}`, e.shown);
    case 'connection':
    case 'identity_changed':
      return new VaultOpenRefused(409, 'vault.needs_vault', e.shown);
    case 'retry_later': {
      const s = e.opts.retryAfter
        ? Math.max(1, Math.ceil((e.opts.retryAfter.getTime() - Date.now()) / 1000))
        : 30;
      return new VaultOpenRefused(503, 'vault.retry_later', e.shown, s);
    }
    default:
      return new VaultOpenRefused(502, `vault.${e.code}`, e.shown);
  }
}
