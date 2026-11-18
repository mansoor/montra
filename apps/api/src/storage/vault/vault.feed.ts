/**
 * Keeping in step with the household's Family Document Vault (ADR-0054 §9; VLT-05). The vault's changes feed says what
 * became of the documents Montra sent: what the vault calls them now (its kind, title and date), whether the family put
 * a newer version in, and whether Montra may still see them. Montra stores that on the outbox row (`vault_meta`) and
 * shows it. It never changes Montra's books: transactions, receipts, payslips, tax form boxes and matches stay as Montra
 * has them, and nothing here writes anywhere but the vault's own tables.
 *
 * - **Only Montra's own documents** (§1, one direction). The feed may name documents Montra didn't send (whatever the
 *   vault's owner let it read); those are skipped, never stored, never imported.
 * - **The position** is saved only after a page is processed, in the same transaction, and only if nobody else moved it
 *   meanwhile (the job and a person opening a document may both catch up), so a page is never applied twice out of
 *   order.
 * - **Out of reach**: the vault says Montra may no longer see a document. The row becomes `out_of_reach`, with no guess
 *   at why; a later line showing it again makes it `filed` again.
 * - **Starting over**: when the vault says the position is no longer valid (too old, or after the vault was restored
 *   from a backup), the adapter starts from the beginning and says so. The first read is a full read too. A full read
 *   that reaches the end marks out of reach any filed document of Montra's it didn't show.
 *
 * Nothing here logs a document's title or kind: only ids and counts.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import type { Trx, VaultConnectionStateTable } from '@montra/db';
import { Db } from '../../db/database.js';
import type { VaultChange, VaultDestination } from '../destinations/vault.js';
import { clearShownAgain, markOutOfReach, MissingFiles } from '../missing-files.js';

type Ctx = { workspaceId: string; userId: string };
type State = Selectable<VaultConnectionStateTable>;

const MINUTE = 60_000;
/** §9: "a few times an hour". */
export const FEED_MS = 20 * MINUTE;
/** §9: before a vault-held document is opened, the feed is caught up when it was last read longer ago than this. */
export const FEED_FRESH_MS = MINUTE;

export interface FeedRead {
  /** Read to the end of the feed. */
  caughtUp: boolean;
  pages: number;
  /** The vault refused Montra's position, so this read started over. */
  restarted: boolean;
  /** Rows the vault no longer shows Montra, from `out_of_reach` lines and a full read's end. */
  outOfReach: number;
  /** Rows the feed described (Montra's own documents). */
  updated: number;
  /** §5a: files only the vault held that are now missing, because the vault no longer shows them to Montra. */
  missing: number;
}

/** What Montra keeps of a feed line (§9): what the vault calls the document. Never amounts, issuers or digits. */
export function vaultMetaOf(
  c: Extract<VaultChange, { change: 'updated' }>,
  at: Date,
): Record<string, unknown> {
  return {
    documentId: c.documentId,
    kind: c.kind?.name ?? null,
    kindKey: c.kind?.key ?? null,
    title: c.title,
    date: c.date,
    version: c.version,
    // The vault's current version isn't the one Montra sent: the family put a newer one in. Montra doesn't re-read it.
    newerVersion: !c.own,
    readAt: at.toISOString(),
  };
}

@Injectable()
export class VaultFeed {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(MissingFiles) private readonly missingFiles: MissingFiles,
  ) {}

  /**
   * Reads the feed from the saved position, a page at a time, until it is caught up, `deadline` passes or `maxPages`
   * are read. A `VaultError` from the vault is the caller's to handle; whatever pages were processed stay processed.
   */
  async read(
    ctx: Ctx,
    destinationId: string,
    conn: Pick<VaultDestination, 'changes'>,
    deadline: number,
    maxPages = Number.POSITIVE_INFINITY,
  ): Promise<FeedRead> {
    const out: FeedRead = {
      caughtUp: false,
      pages: 0,
      restarted: false,
      outOfReach: 0,
      updated: 0,
      missing: 0,
    };
    let state = await this.state(ctx, destinationId);
    if (!state) return out;
    if (state.feed_cursor === null && state.full_read_started_at === null) {
      // The first read is a full one: what Montra may see now, then the changes since.
      await this.db.run(ctx, (trx) =>
        trx
          .updateTable('app.vault_connection_state')
          .set({ full_read_started_at: new Date(), updated_at: new Date() })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', destinationId)
          .where('feed_cursor', 'is', null)
          .where('full_read_started_at', 'is', null)
          .execute(),
      );
      state = await this.state(ctx, destinationId);
      if (!state) return out;
    }
    let cursor = state.feed_cursor;
    while (out.pages < maxPages && Date.now() < deadline) {
      const page = await conn.changes(cursor);
      out.pages++;
      const applied = await this.db.run(ctx, async (trx) => {
        const cur = await trx
          .selectFrom('app.vault_connection_state')
          .select(['feed_cursor', 'full_read_started_at', 'full_read_at'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', destinationId)
          .forUpdate()
          .executeTakeFirst();
        // Someone else read on from here meanwhile: this page is theirs, already applied.
        if (!cur || cur.feed_cursor !== cursor) return null;
        const now = new Date();
        const fullStart = page.restart ? now : cur.full_read_started_at;
        const counted = await applyChanges(trx, ctx.workspaceId, destinationId, page.changes, now);
        const finishing = !page.more && fullStart !== null;
        const unseen = finishing ? await markUnseen(trx, ctx.workspaceId, destinationId, fullStart) : 0;
        // §5a, §9: a file only the vault held that the vault no longer shows is missing; one shown again isn't.
        const missing = await markOutOfReach(trx, ctx, destinationId);
        await clearShownAgain(trx, ctx, destinationId);
        await trx
          .updateTable('app.vault_connection_state')
          .set({
            feed_cursor: page.cursor,
            feed_read_at: now,
            full_read_started_at: finishing ? null : fullStart,
            full_read_at: finishing ? now : cur.full_read_at,
            updated_at: now,
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('destination_id', '=', destinationId)
          .execute();
        return { ...counted, unseen, missing };
      });
      if (!applied) return out;
      if (applied.missing.length) {
        out.missing += applied.missing.length;
        await this.missingFiles.tell(ctx, applied.missing);
      }
      if (page.restart) out.restarted = true;
      out.updated += applied.updated;
      out.outOfReach += applied.outOfReach + applied.unseen;
      cursor = page.cursor;
      if (!page.more) {
        out.caughtUp = true;
        return out;
      }
    }
    return out;
  }

  /** When the job next reads the feed: soon when it stopped part-way, a few times an hour once caught up. */
  async next(ctx: Ctx, destinationId: string, at: Date): Promise<void> {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.vault_connection_state')
        .set({ feed_next_at: at, updated_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('feed_next_at', 'is not', null)
        .execute(),
    );
  }

  state(ctx: Ctx, destinationId: string): Promise<State | undefined> {
    return this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.vault_connection_state')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('destination_id', '=', destinationId)
        .executeTakeFirst(),
    );
  }
}

/**
 * One page's lines, in order, on Montra's own rows. A line about a document Montra didn't send matches no row and is
 * skipped. Only `app.vault_item` is written.
 */
async function applyChanges(
  trx: Trx,
  workspaceId: string,
  destinationId: string,
  changes: readonly VaultChange[],
  now: Date,
): Promise<{ updated: number; outOfReach: number }> {
  let updated = 0;
  let outOfReach = 0;
  for (const c of changes) {
    if (c.change === 'out_of_reach') {
      const r = await trx
        .updateTable('app.vault_item')
        .set({ status: 'out_of_reach', last_error: null, updated_at: now })
        .where('workspace_id', '=', workspaceId)
        .where('destination_id', '=', destinationId)
        .where('vault_document_id', '=', c.documentId)
        .where('status', '=', 'filed')
        .executeTakeFirst();
      outOfReach += Number(r.numUpdatedRows);
      continue;
    }
    // Montra's own: by the document it became, or, for a filed item whose document Montra wasn't told, by Montra's id.
    const r = await trx
      .updateTable('app.vault_item')
      .set({
        status: 'filed',
        vault_document_id: sql`coalesce(vault_document_id, ${c.documentId})`,
        received_at: sql`coalesce(received_at, ${now})`,
        filed_at: sql`coalesce(filed_at, ${now})`,
        // §5: newly filed, so whether Montra's copy goes is looked at (only for a group sent with no local copy).
        remove_at: sql`case when status = 'filed' then remove_at else ${now}::timestamptz end`,
        // The version Montra's send became; a newer one from the family doesn't replace it.
        vault_version: c.own && c.version ? c.version : sql`vault_version`,
        vault_meta: JSON.stringify(vaultMetaOf(c, now)),
        feed_seen_at: now,
        last_error: null,
        updated_at: now,
      } as never)
      .where('workspace_id', '=', workspaceId)
      .where('destination_id', '=', destinationId)
      .where('status', 'in', ['received', 'filed', 'out_of_reach'])
      .where((eb) =>
        c.ref
          ? eb.or([
              eb('vault_document_id', '=', c.documentId),
              eb.and([eb('vault_document_id', 'is', null), eb('vault_ref', '=', c.ref)]),
            ])
          : eb('vault_document_id', '=', c.documentId),
      )
      .executeTakeFirst();
    updated += Number(r.numUpdatedRows);
  }
  return { updated, outOfReach };
}

/**
 * §9 "Starting over": at the end of a full read, a document Montra holds as filed that the read didn't show is out of
 * reach. Only rows filed before the read started: one filed since may simply not be in the read's snapshot, and the
 * feed's own lines say what becomes of it.
 */
async function markUnseen(
  trx: Trx,
  workspaceId: string,
  destinationId: string,
  since: Date,
): Promise<number> {
  const r = await trx
    .updateTable('app.vault_item')
    .set({ status: 'out_of_reach', last_error: null, updated_at: new Date() })
    .where('workspace_id', '=', workspaceId)
    .where('destination_id', '=', destinationId)
    .where('status', '=', 'filed')
    .where('vault_document_id', 'is not', null)
    .where('filed_at', '<', since)
    .where((eb) => eb.or([eb('feed_seen_at', 'is', null), eb('feed_seen_at', '<', since)]))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}
