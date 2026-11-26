/**
 * Statements the vault doesn't keep, sent as PDFs (ADR-0057 §1, §4, §7; VLT-12): the vault's side of a conversion.
 *
 * A CSV, XLS or OFX statement whose group says "Convert to PDF" has its outbox row marked `converted` by the vault's job
 * (`VaultJobs.promote`), which queues the worker's `statement.render` as an owner. The rendering (`StatementRenditions`)
 * then calls in here:
 *
 * - `queueRenditions`, in the transaction that stores the PDFs: each PDF gets an outbox row of its own, the one with the
 *   original attached marked `carries_original` (§7), and the original's row says what they were made with;
 * - `recordConversion`, after the rendering: what became of it when nothing was stored (kept, not converted, not ready,
 *   import undone).
 *
 * Both do nothing for a file whose outbox row isn't `converted`: only a conversion the vault asked for is sent. Nothing
 * here logs or stores a file's name, an account, an amount or a number.
 */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import type { VaultUnkeptChoice, VaultCoverNumber } from '@montra/schemas';
import type { RecordRenderResult } from '../../renditions/record-renditions.js';

type Ctx = { workspaceId: string; userId: string };

/** What a PDF is made with (as `RenderOptions` in `statement-renditions.ts`), from the vault's settings. */
export interface ConversionOptions {
  detail: boolean;
  accountNumber: VaultCoverNumber;
  attachOriginal: boolean;
}

/** ADR-0054 D8: a file the vault doesn't keep, left in Montra ("Don't send"), in the words the badges show. */
export const TYPE_NOT_KEPT_WORDS = 'Not a type the vault keeps. It stays in Montra.';

/** In Montra's words, for the badges: why a file wasn't converted (ADR-0057 §2). Never a file's name. */
export const NOT_CONVERTED_WORDS = {
  unreadable:
    'Montra couldn’t read this file into rows, so it couldn’t be converted to PDF. It stays in Montra. Choose “Convert to PDF, attach the original” to send it with a cover page.',
  storage_full: 'Montra’s storage is full, so the PDF couldn’t be made. It stays in Montra for now.',
} as const;

/**
 * ADR-0059 §1: why a receipt's or bill's pages weren't made into a PDF, in Montra's words for the badges. The pages
 * stay in Montra; none is ever sent on its own.
 */
export const RECORD_NOT_CONVERTED_WORDS = {
  unreadable_page:
    'A page couldn’t be read (a damaged or password-protected PDF, say), so the PDF for the vault wasn’t made. The pages stay in Montra.',
  unsupported_page:
    'A page is a kind of image Montra can’t put in a PDF, so the PDF for the vault wasn’t made. The pages stay in Montra.',
  storage_full: NOT_CONVERTED_WORDS.storage_full,
} as const;

/** ADR-0059: what a page's outbox row says it waits for (`render_options`), beside a statement's options. */
export const RECORD_OPTIONS = { record: true } as const;

/** §12: a rendering not heard of in this long is asked for again (the job's run, or the worker, may have stopped). */
export const RENDER_WAIT_MS = 30 * 60_000;
/** A rendering that waits for its import (still being read or reviewed) is looked at again after this. */
export const RENDER_NOT_READY_MS = 5 * 60_000;
/** Storage full: tried again a day later. */
export const RENDER_FULL_MS = 24 * 60 * 60_000;

/**
 * ADR-0057 §1, §3: what the PDFs are made with. The cover's account number matters only with the detail switch on, so
 * with it off the number is `none`, and switching the number then makes nothing again.
 */
export function conversionOptions(
  choice: Exclude<VaultUnkeptChoice, 'dont_send'>,
  describeMore: boolean,
  coverNumber: VaultCoverNumber,
): ConversionOptions {
  return {
    detail: describeMore,
    accountNumber: describeMore ? coverNumber : 'none',
    attachOriginal: choice === 'convert_attach',
  };
}

/** Whether PDFs made with `a` are the ones `b` asks for. */
export function sameOptions(a: unknown, b: ConversionOptions): boolean {
  const o = (a ?? {}) as Partial<ConversionOptions>;
  return (
    o.detail === b.detail && o.accountNumber === b.accountNumber && o.attachOriginal === b.attachOriginal
  );
}

/**
 * §1, §4, §7: PDFs just stored for `originalId`, in the same transaction. For each vault connection that asked for
 * them (the original's row is `converted`), each PDF gets a queued outbox row, the first with the original inside it
 * marked `carries_original`, and the original's row says they were made with `options`. Wakes the job once they have
 * settled. Answers whether the vault asked.
 */
export async function queueRenditions(
  trx: Trx,
  ctx: Ctx,
  originalId: string,
  options: ConversionOptions,
  files: readonly { fileId: string; attached: boolean }[],
): Promise<boolean> {
  const asked = await trx
    .updateTable('app.vault_item')
    .set({
      render_state: 'rendered',
      render_options: JSON.stringify(options),
      not_kept_reason: null,
      last_error: null,
      next_attempt_at: sql<Date>`'infinity'::timestamptz`,
      updated_at: new Date(),
    })
    .where('workspace_id', '=', ctx.workspaceId)
    .where('file_id', '=', originalId)
    .where('status', '=', 'converted')
    .returning('destination_id')
    .execute();
  if (!asked.length || !files.length) return asked.length > 0;
  for (const a of asked) {
    await trx
      .insertInto('app.vault_item')
      .values(
        files.map((f) => ({
          workspace_id: ctx.workspaceId,
          destination_id: a.destination_id,
          file_id: f.fileId,
          carries_original: f.attached,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  // §3: a new file waits a little (the job's settle time), as the trigger on `app.file` schedules it.
  await sql`select app.schedule_system_job('schedule', 'storage.vault', now() + interval '2 minutes')`.execute(
    trx,
  );
  return true;
}

/** What a rendering answered, as `statement-renditions.ts` says it, without the files' details. */
export type ConversionResult =
  | { status: 'rendered' }
  | { status: 'kept' }
  | { status: 'not_ready' }
  | { status: 'not_converted'; reason: 'unreadable' | 'storage_full' }
  | { status: 'import_undone' }
  | { status: 'not_renderable'; reason: string };

/**
 * §4: what became of a conversion the vault asked for, when the rendering stored nothing new. `rendered` was recorded
 * with the PDFs (`queueRenditions`). A rendering the vault already has is kept: the original's row says so and isn't
 * looked at again until something changes (its settings, its import, "Send again").
 */
export async function recordConversion(
  trx: Trx,
  ctx: Ctx,
  originalId: string,
  options: ConversionOptions,
  result: ConversionResult,
): Promise<void> {
  if (result.status === 'rendered') return;
  const row = () =>
    trx
      .updateTable('app.vault_item')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('file_id', '=', originalId)
      .where('status', '=', 'converted');
  const now = new Date();
  const never = sql<Date>`'infinity'::timestamptz`;
  switch (result.status) {
    case 'kept':
      await row()
        .set({ render_state: 'rendered', not_kept_reason: null, next_attempt_at: never, updated_at: now })
        .execute();
      return;
    case 'not_ready':
      await row()
        .set({ next_attempt_at: new Date(now.getTime() + RENDER_NOT_READY_MS), updated_at: now })
        .execute();
      return;
    case 'not_converted':
      await row()
        .set({
          render_state: 'not_converted',
          render_options: JSON.stringify(options),
          not_kept_reason: NOT_CONVERTED_WORDS[result.reason],
          next_attempt_at:
            result.reason === 'storage_full' ? new Date(now.getTime() + RENDER_FULL_MS) : never,
          updated_at: now,
        })
        .execute();
      return;
    case 'import_undone':
      await row()
        .set({
          render_state: 'import_undone',
          render_options: JSON.stringify(options),
          not_kept_reason: null,
          next_attempt_at: never,
          updated_at: now,
        })
        .execute();
      return;
    case 'not_renderable':
      // In the Trash: looked at again once it's back. Anything else isn't a statement to send: the vault's job drops it.
      await row()
        .set({
          next_attempt_at: new Date(now.getTime() + (result.reason === 'deleted' ? 24 * 60 : 5) * 60_000),
          updated_at: now,
        })
        .execute();
      return;
  }
}

/**
 * ADR-0059 §3: a record's PDF just stored, in the same transaction. Each vault connection that has any of the record's
 * pages in its outbox (they wait for the PDF, `converted`, or the vault had them and their pages changed) gets a queued
 * row for the PDF, when it still sends the PDF's kind. Wakes the job once it has settled. Answers how many it queued.
 */
export async function queueRecordPdf(
  trx: Trx,
  ctx: Ctx,
  pdfId: string,
  kind: string,
  pages: readonly string[],
): Promise<number> {
  if (!pages.length) return 0;
  const { rows } = await sql<{ destination_id: string }>`
    insert into app.vault_item (workspace_id, destination_id, file_id)
    select distinct d.workspace_id, d.id, ${pdfId}::uuid
      from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.workspace_id = ${ctx.workspaceId}::uuid and i.file_id = any (${[...pages]}::uuid[])
       and d.kind = 'fdv' and d.mirror_files and d.status not in ('paused', 'disconnected')
       and ${kind}::text = any (d.file_kinds)
    on conflict do nothing
    returning destination_id`.execute(trx);
  if (rows.length) {
    // §3: a new file waits a little (the job's settle time), as the trigger on `app.file` schedules it.
    await sql`select app.schedule_system_job('schedule', 'storage.vault', now() + interval '2 minutes')`.execute(
      trx,
    );
  }
  return rows.length;
}

/**
 * ADR-0059 §3: what became of a record's PDF, on its pages' outbox rows: the rows waiting for it (`converted`) and the
 * rows whose pages changed (`pages_changed_at`). Made or kept: nothing more to do until the pages change again.
 */
export async function recordRecordConversion(
  trx: Trx,
  ctx: Ctx,
  pages: readonly string[],
  result: RecordRenderResult,
): Promise<void> {
  const ids = [...new Set(pages)];
  if (!ids.length) return;
  const rows = () =>
    trx.updateTable('app.vault_item').where('workspace_id', '=', ctx.workspaceId).where('file_id', 'in', ids);
  const now = new Date();
  const never = sql<Date>`'infinity'::timestamptz`;
  const later = (ms: number) => new Date(now.getTime() + ms);
  switch (result.status) {
    case 'rendered':
    case 'kept':
      await rows()
        .where('status', '=', 'converted')
        .set({
          render_state: 'rendered',
          render_options: JSON.stringify(RECORD_OPTIONS),
          not_kept_reason: null,
          last_error: null,
          next_attempt_at: never,
          updated_at: now,
        })
        .execute();
      await rows().where('pages_changed_at', 'is not', null).set({ pages_changed_at: null }).execute();
      return;
    case 'not_ready':
      await rows()
        .where('status', '=', 'converted')
        .set({ next_attempt_at: later(RENDER_NOT_READY_MS), updated_at: now })
        .execute();
      await rows()
        .where('pages_changed_at', 'is not', null)
        .set({ pages_changed_at: later(RENDER_NOT_READY_MS) })
        .execute();
      return;
    case 'not_converted': {
      const full = result.reason === 'storage_full';
      await rows()
        .where('status', '=', 'converted')
        .set({
          render_state: 'not_converted',
          render_options: JSON.stringify(RECORD_OPTIONS),
          not_kept_reason: RECORD_NOT_CONVERTED_WORDS[result.reason],
          next_attempt_at: full ? later(RENDER_FULL_MS) : never,
          updated_at: now,
        })
        .execute();
      await rows()
        .where('pages_changed_at', 'is not', null)
        .set({ pages_changed_at: full ? later(RENDER_FULL_MS) : null })
        .execute();
      return;
    }
    case 'not_renderable':
      // In the Trash, or no longer a page of a record: looked at again in a day (it may be restored, or filed).
      await rows()
        .where('status', '=', 'converted')
        .set({ next_attempt_at: later(24 * 60 * 60_000), updated_at: now })
        .execute();
      await rows().where('pages_changed_at', 'is not', null).set({ pages_changed_at: null }).execute();
      return;
  }
}
