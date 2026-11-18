/**
 * Files to provide again (ADR-0054 §5a; VLT-11). A file whose copy Montra removed because the vault is its record is
 * read back from the vault when Montra needs it. When the vault doesn't give it back (it never says why, and Montra
 * doesn't guess), or the changes feed says Montra may no longer see it, the file is **missing**: it gets `missing_since`
 * and a reason in words, an audit row, a place in Review ("Files to provide again", with an Upload action), a count in
 * the Review badge, and one `files_missing` notification a day at most, with no file names.
 *
 * Providing it again stores the upload under the same file id (its `location` goes back to `montra`), clears the mark
 * and records the new hash: a hash different from the original is accepted and noted (`replaced_sha256`), because a
 * fresh scan of the same paper won't match byte for byte. Montra doesn't read it again unless someone asks. Its group
 * still sent, it goes through the vault's outbox again as a new send.
 *
 * A missing file never changes the books: the transactions, payslips and tax forms read from it stay as they are.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  vaultGroupOf,
  type FileKind,
  type FileProvidedAgainDto,
  type MissingFileDto,
  type MissingFilesResponse,
} from '@montra/schemas';
import { AppError, notFound } from '../common/errors.js';
import { isAdmin } from '../common/roles.js';
import { Db } from '../db/database.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from './storage.js';
import { scheduleVault } from './vault/vault.service.js';

type Ctx = { workspaceId: string; userId: string };

/** Why a file is missing, in Montra's words (§5a). Never a guess at the vault's reasons, never a file's name. */
export const MISSING_WORDS = {
  refused: 'Family Document Vault didn’t give this file back to Montra.',
  outOfReach: 'No longer available in Family Document Vault.',
} as const;

/**
 * What a paper provided again is: the types an upload of a receipt, a payslip, a bill or a tax form may be, which are
 * the types the vault keeps. As `detectReceiptMedia`, here so that storage doesn't depend on receipts.
 */
export function paperType(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null {
  const b = Buffer.from(bytes.subarray(0, 1024));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.includes(Buffer.from('%PDF-'))) return 'application/pdf';
  return null;
}

/** At most this many files in Review's list at once. */
const LIST_LIMIT = 500;

@Injectable()
export class MissingFiles {
  private readonly logger = new Logger('MissingFiles');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /**
   * Marks files missing that only the vault holds and that aren't marked yet, then tells people. `actor` is the owner
   * the vault's connection acts as (the copies are theirs), as `FileBytes` and the job read them. Answers how many.
   */
  async mark(actor: Ctx, fileIds: readonly string[], reason: string): Promise<number> {
    if (!fileIds.length) return 0;
    const marked = await this.db.run(actor, (trx) => markMissing(trx, actor, fileIds, reason));
    if (marked.length) {
      this.logger.log(`Workspace ${actor.workspaceId}: ${marked.length} file(s) to provide again`);
      await this.tell(actor, marked);
    }
    return marked.length;
  }

  /**
   * §5a: one `files_missing` notification a day at most, to owners and admins and to whoever uploaded the files, each
   * under their own preferences. No file names: the list is in Review.
   */
  async tell(actor: Ctx, fileIds: readonly string[]): Promise<void> {
    if (!fileIds.length) return;
    const people = await this.db.run(actor, (trx) =>
      trx
        .selectFrom('app.workspace_member as m')
        .select('m.user_id')
        .where('m.workspace_id', '=', actor.workspaceId)
        .where('m.status', '=', 'active')
        .where('m.user_id', 'is not', null)
        .where((eb) =>
          eb.or([
            eb('m.role', 'in', ['owner', 'admin']),
            eb.and([
              eb('m.role', '<>', 'viewer'),
              eb(
                'm.user_id',
                'in',
                eb
                  .selectFrom('app.file')
                  .select('uploaded_by')
                  .where('workspace_id', '=', actor.workspaceId)
                  .where('id', 'in', [...fileIds]),
              ),
            ]),
          ]),
        )
        .execute(),
    );
    const day = new Date().toISOString().slice(0, 10);
    for (const p of people) {
      if (!p.user_id) continue;
      const who = { workspaceId: actor.workspaceId, userId: p.user_id };
      try {
        await this.db.run(who, async (trx) => {
          const prefs = await this.notifications.prefsIn(trx, who.userId);
          await this.notifications.create(
            trx,
            who,
            {
              type: 'files_missing',
              dedupeKey: `files_missing:${day}`,
              title: 'Some files need uploading again',
              body: 'Family Document Vault didn’t give Montra back some files it no longer keeps a copy of. Review lists them, with a way to upload each one again.',
              link: `/w/${who.workspaceId}/review#files-to-provide`,
            },
            prefs,
          );
        });
      } catch (e) {
        this.logger.warn(`Couldn't tell ${who.userId} about missing files: ${(e as Error).name}`);
      }
    }
  }

  /**
   * Review → "Files to provide again": owners and admins see every missing file of the workspace, anyone else (but a
   * viewer) the ones they uploaded, as row-level security on the file and on what uses it allows.
   */
  async list(ctx: Ctx, role: string): Promise<MissingFilesResponse> {
    if (role === 'viewer') return { data: [] };
    return this.db.run(ctx, async (trx) => {
      let q = trx
        .selectFrom('app.file')
        .select(['id', 'file_name', 'kind', 'sealed', 'created_at', 'missing_since', 'missing_reason'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('missing_since', 'is not', null)
        .where('deleted_at', 'is', null);
      if (!isAdmin(role)) q = q.where('uploaded_by', '=', ctx.userId);
      const files = await q.orderBy('missing_since').orderBy('id').limit(LIST_LIMIT).execute();
      if (!files.length) return { data: [] };
      const uses = await usedBy(
        trx,
        ctx.workspaceId,
        files.map((f) => f.id),
      );
      return {
        data: files.map((f): MissingFileDto => {
          const group = vaultGroupOf({ kind: f.kind as FileKind, sealed: f.sealed });
          return {
            fileId: f.id,
            fileName: f.file_name,
            group: group === 'never' ? null : group,
            uploadedAt: f.created_at.toISOString(),
            missingSince: f.missing_since!.toISOString(),
            reason: f.missing_reason ?? MISSING_WORDS.refused,
            usedBy: uses
              .filter((u) => u.file_id === f.id)
              .map((u) => ({ kind: u.kind, id: u.id, label: u.label })),
          };
        }),
      };
    });
  }

  /**
   * §5a "Providing it again": the upload is stored under the same file id, the mark is cleared and the new hash
   * recorded; a different one is accepted and noted. Owners and admins, or whoever uploaded it. Then, as the owner the
   * vault's connection acts as, it goes through the outbox again as a new send when its group is still sent, and the
   * owner's own storage copies it again when its copy there is no longer this file.
   */
  async provideAgain(
    ctx: Ctx,
    role: string,
    fileId: string,
    bytes: Uint8Array,
  ): Promise<FileProvidedAgainDto> {
    const file = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.file')
        .select(['id', 'kind', 'sha256', 'uploaded_by', 'missing_since', 'deleted_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirst(),
    );
    if (!file || file.deleted_at) throw notFound('File');
    if (!isAdmin(role) && file.uploaded_by !== ctx.userId) {
      throw new AppError(
        403,
        'file.not_yours',
        'Only an owner or admin, or whoever uploaded it, can provide this file again',
      );
    }
    if (!file.missing_since) {
      throw new AppError(409, 'file.not_missing', 'Montra isn’t missing this file');
    }
    const mime = paperType(bytes);
    if (!mime) {
      throw new AppError(
        415,
        'file.unsupported_type',
        'Upload a PDF, or a JPEG, PNG or WebP photo of the paper',
      );
    }
    const digest = sha256(bytes);
    const hashChanged = digest !== file.sha256;
    // A key never used before: a put never overwrites, and an old object still to remove (§5) is never this one.
    const key = `${storageKey(ctx.workspaceId, file.kind, file.id)}-${randomUUID().slice(0, 8)}`;
    await this.storage.put(key, bytes, mime);

    const done = await this.db.run(ctx, async (trx) => {
      const r = await trx
        .updateTable('app.file')
        .set({
          storage_key: key,
          location: 'montra',
          missing_since: null,
          missing_reason: null,
          sha256: digest,
          bytes: bytes.length,
          mime,
          // The hash Montra first read, kept when the paper comes back different.
          replaced_sha256: hashChanged
            ? sql<string>`coalesce(replaced_sha256, sha256)`
            : sql<string>`replaced_sha256`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .where('missing_since', 'is not', null)
        .where('sha256', '=', file.sha256)
        .returning('id')
        .executeTakeFirst();
      if (!r) return false;
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: ctx.userId,
          action: 'file.provided_again',
          subject_type: 'file',
          subject_id: fileId,
          diff: JSON.stringify({ hashChanged }),
        })
        .execute();
      return true;
    });
    if (!done) {
      // Someone else provided it first: theirs stands.
      await this.storage.delete(key);
      throw new AppError(409, 'file.not_missing', 'Montra isn’t missing this file any more');
    }

    const queuedForVault = await this.sendAgain(ctx, fileId, hashChanged);
    return { fileId, location: 'montra', hashChanged, queuedForVault };
  }

  /** The outboxes, as the owner the connections act as: a new send to the vault, and a new copy for the mirror. */
  private async sendAgain(ctx: Ctx, fileId: string, hashChanged: boolean): Promise<boolean> {
    const owner = await this.db.run(ctx, (trx) =>
      sql<{ user_id: string | null }>`select user_id from app.file_copies(${fileId}::uuid)`.execute(trx),
    );
    const userId = owner.rows[0]?.user_id;
    if (!userId) return false;
    const actor = { workspaceId: ctx.workspaceId, userId };
    const { queued, stale } = await this.db.run(actor, async (trx) => {
      // An object of an earlier copy still to remove after a crash (§5) goes with its row.
      const stale = await trx
        .selectFrom('app.vault_item')
        .select('source_key')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('file_id', '=', fileId)
        .where('source_key', 'is not', null)
        .where('source_removed_at', 'is', null)
        .execute();
      await trx
        .deleteFrom('app.vault_item')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('file_id', '=', fileId)
        .where('status', '<>', 'delete')
        .execute();
      const added = await sql<{ file_id: string }>`
        insert into app.vault_item (workspace_id, destination_id, file_id)
        select d.workspace_id, d.id, f.id
          from app.storage_destination d
          join app.file f on f.workspace_id = d.workspace_id and f.id = ${fileId}::uuid
         where d.workspace_id = ${ctx.workspaceId}::uuid and d.kind = 'fdv' and d.mirror_files
           and d.status <> 'paused' and f.kind = any (d.file_kinds) and not f.sealed
        on conflict do nothing
        returning file_id`.execute(trx);
      if (added.rows.length) await scheduleVault(trx);
      // The owner's own storage: a copy it skipped (only the vault held the file), or one of other bytes, is made again.
      const mirrored = await trx
        .updateTable('app.storage_mirror_item')
        .set({ status: 'pending', attempts: 0, next_attempt_at: new Date(), last_error: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('file_id', '=', fileId)
        .where('status', 'in', hashChanged ? ['skipped', 'failed', 'done'] : ['skipped', 'failed'])
        .executeTakeFirst();
      if (Number(mirrored.numUpdatedRows)) {
        await sql`select app.schedule_system_job('schedule', 'storage.mirror', now())`.execute(trx);
      }
      return { queued: added.rows.length > 0, stale: stale.map((s) => s.source_key!) };
    });
    for (const k of stale) await this.storage.delete(k).catch(() => undefined);
    return queued;
  }
}

/**
 * Marks files missing, inside a transaction (the feed applies a page in one), with an audit row each. Only a file held
 * only in the vault, not in the trash, and not already marked. Answers the ids it marked.
 */
export async function markMissing(
  trx: Trx,
  actor: Ctx,
  fileIds: readonly string[],
  reason: string,
): Promise<string[]> {
  if (!fileIds.length) return [];
  const rows = await trx
    .updateTable('app.file')
    .set({ missing_since: new Date(), missing_reason: reason })
    .where('workspace_id', '=', actor.workspaceId)
    .where('id', 'in', [...fileIds])
    .where('location', '=', 'vault')
    .where('missing_since', 'is', null)
    .where('deleted_at', 'is', null)
    .returning('id')
    .execute();
  if (rows.length) {
    await trx
      .insertInto('app.audit_log')
      .values(
        rows.map((r) => ({
          workspace_id: actor.workspaceId,
          actor_user_id: null,
          actor_type: 'system' as const,
          action: 'file.marked_missing',
          subject_type: 'file',
          subject_id: r.id,
          diff: JSON.stringify({ reason }),
        })),
      )
      .execute();
  }
  return rows.map((r) => r.id);
}

/**
 * §9: the feed showed Montra again a document it had said was out of reach. A file marked missing for that, and not
 * yet provided again, is no longer missing.
 */
export async function clearShownAgain(trx: Trx, actor: Ctx, destinationId: string): Promise<string[]> {
  const rows = await trx
    .updateTable('app.file')
    .set({ missing_since: null, missing_reason: null })
    .where('workspace_id', '=', actor.workspaceId)
    .where('missing_reason', '=', MISSING_WORDS.outOfReach)
    .where('location', '=', 'vault')
    .where('id', 'in', (eb) =>
      eb
        .selectFrom('app.vault_item')
        .select('file_id')
        .where('workspace_id', '=', actor.workspaceId)
        .where('destination_id', '=', destinationId)
        .where('status', '=', 'filed'),
    )
    .returning('id')
    .execute();
  if (rows.length) {
    await trx
      .insertInto('app.audit_log')
      .values(
        rows.map((r) => ({
          workspace_id: actor.workspaceId,
          actor_user_id: null,
          actor_type: 'system' as const,
          action: 'file.found_again',
          subject_type: 'file',
          subject_id: r.id,
          diff: JSON.stringify({ shownAgain: true }),
        })),
      )
      .execute();
  }
  return rows.map((r) => r.id);
}

/** §9: files only the vault held whose documents the feed says are out of reach: missing (§5a). */
export async function markOutOfReach(trx: Trx, actor: Ctx, destinationId: string): Promise<string[]> {
  const ids = await trx
    .selectFrom('app.vault_item as i')
    .innerJoin('app.file as f', (j) =>
      j.onRef('f.workspace_id', '=', 'i.workspace_id').onRef('f.id', '=', 'i.file_id'),
    )
    .select('f.id')
    .where('i.workspace_id', '=', actor.workspaceId)
    .where('i.destination_id', '=', destinationId)
    .where('i.status', '=', 'out_of_reach')
    .where('f.location', '=', 'vault')
    .where('f.missing_since', 'is', null)
    .where('f.deleted_at', 'is', null)
    .execute();
  return markMissing(
    trx,
    actor,
    ids.map((r) => r.id),
    MISSING_WORDS.outOfReach,
  );
}

/** What in Montra uses each file, so the person knows which paper to look for (§5a). Under the caller's RLS. */
async function usedBy(
  trx: Trx,
  workspaceId: string,
  fileIds: readonly string[],
): Promise<{ file_id: string; kind: MissingFileDto['usedBy'][number]['kind']; id: string; label: string }[]> {
  const ids = sql`${[...fileIds]}::uuid[]`;
  const { rows } = await sql<{
    file_id: string;
    kind: MissingFileDto['usedBy'][number]['kind'];
    id: string;
    label: string;
  }>`
    select f as file_id, 'receipt' as kind, r.id, concat_ws(' · ', r.merchant, r.receipt_date::text) as label
      from app.receipt r cross join unnest(r.attachment_ids) f
     where r.workspace_id = ${workspaceId}::uuid and r.deleted_at is null and f = any (${ids})
    union all
    select f, 'payslip', p.id, concat_ws(' · ', e.name, p.pay_date::text)
      from app.payslip p cross join unnest(p.attachment_ids) f
      left join app.employer e on e.workspace_id = p.workspace_id and e.id = p.employer_id
     where p.workspace_id = ${workspaceId}::uuid and f = any (${ids})
    union all
    select f, 'tax_form', t.id, concat_ws(' · ', t.issuer_name, t.tax_year::text)
      from app.tax_form t cross join unnest(t.file_ids) f
     where t.workspace_id = ${workspaceId}::uuid and t.deleted_at is null and f = any (${ids})
    union all
    select b.file_id, 'statement', b.id,
           concat_ws(' · ', b.file_name, nullif(concat_ws(' – ', b.min_date::text, b.max_date::text), ''))
      from app.import_batch b
     where b.workspace_id = ${workspaceId}::uuid and b.file_id = any (${ids})
    union all
    select f, 'bill', h.id, concat_ws(' · ', bl.name, coalesce(h.bill_date, h.due_date)::text)
      from app.household_bill h cross join unnest(h.attachment_ids) f
      left join app.biller bl on bl.workspace_id = h.workspace_id and bl.id = h.biller_id
     where h.workspace_id = ${workspaceId}::uuid and f = any (${ids})
    union all
    select f, 'bill', b.id, concat_ws(' · ', b.reference, b.bill_date::text)
      from app.bill b cross join unnest(b.attachment_ids) f
     where b.workspace_id = ${workspaceId}::uuid and f = any (${ids})
    union all
    select f, 'lease', l.id, concat_ws(' · ', p.name, l.start_date::text)
      from app.lease l cross join unnest(l.attachment_ids) f
      left join app.property p on p.workspace_id = l.workspace_id and p.id = l.property_id
     where l.workspace_id = ${workspaceId}::uuid and f = any (${ids})`.execute(trx);
  return rows;
}
