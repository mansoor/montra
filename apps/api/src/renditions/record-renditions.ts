/**
 * A receipt's or bill's pages as one PDF, stored as a file of its own (VLT-14, ADR-0059 §1–§3).
 *
 * The entry point is `render(ctx, fileId)`: it finds the record `fileId` is a page of (`app.vault_file_record`: a
 * receipt, a household or business bill, a reimbursement, or a bill scan or intake not filed yet), draws its pages in
 * order (`renderRecordPdf`), and stores the PDF as a new `app.file` (`rendition = 'record_pdf'`, its pages in
 * `source_file_ids`), through the same storage and quota as any upload. Only the vault asks for one: the vault's job
 * queues `record.render` as an owner when a record's pages are complete, or were moved or removed, and the transaction
 * that stores the PDF puts it in the vault's outbox (`queueRecordPdf`). The pages themselves are never sent.
 *
 * - A record whose current PDF already has its pages, in its order, keeps it: the same pages are never made twice.
 * - A PDF made from other pages (they were moved or removed since) is replaced when the vault hasn't had it, and set
 *   aside (`superseded_at`) when it has: it stays in the vault, and the new PDF goes as a new document (the vault's
 *   client adds no version to a document).
 * - A page Montra can't put in a PDF (a damaged PDF or photo) means no PDF: the pages stay in Montra, and say why.
 *
 * Nothing here logs a file's name, an amount or a merchant: only ids and counts.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { Db } from '../db/database.js';
import { JobQueue, PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { FileBytes } from '../storage/file-bytes.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import { queueRecordPdf, recordRecordConversion } from '../storage/vault/vault.conversions.js';
import { RecordPdfError, renderRecordPdf } from './record-pdf.js';
import { renditionName } from './statement-renditions.js';

type Ctx = { workspaceId: string; userId: string };

/** The job's type: a record at a time (named by one of its pages), in the workspace, as the owner who queued it. */
export const RECORD_RENDER_JOB = 'record.render';

/** Where a file is a page, as `app.vault_file_record` says. `other`: a record that holds it alone, sent as it is. */
export interface FileRecord {
  holder:
    'receipt' | 'household_bill' | 'bill' | 'reimbursement' | 'document_intake' | 'document_scan' | 'other';
  recordId: string | null;
  fileIds: string[];
  trashed: boolean;
}

export type RecordRenderResult =
  /** Stored. `replaced`: earlier PDFs the vault hadn't had, removed; `supersededIds`: ones it had, set aside. */
  | { status: 'rendered'; fileId: string; sources: string[]; replaced: string[]; superseded: string[] }
  /** The record's current PDF has these pages already. */
  | { status: 'kept'; fileId: string; sources: string[] }
  /** A page is still being read, or the pages changed while this one was drawn: tried again soon. */
  | { status: 'not_ready'; sources: string[] }
  /** No PDF: a page couldn't go in one, or the workspace's storage is full. */
  | {
      status: 'not_converted';
      reason: 'unreadable_page' | 'unsupported_page' | 'storage_full';
      sources: string[];
    }
  /** Not something to render: no record holds the file (any more), or the record is in the Trash. */
  | { status: 'not_renderable'; reason: 'no_record' | 'deleted'; sources: string[] };

interface Page {
  id: string;
  kind: 'receipt' | 'invoice';
  file_name: string;
  mime: string;
  sha256: string;
  storage_key: string | null;
  created_at: Date;
  deleted_at: Date | null;
  retain_until: string | Date | null;
}

interface Existing {
  id: string;
  storage_key: string | null;
  source_file_ids: string[];
  sent: boolean;
}

/** The record `fileId` is a page of, read as the caller (an owner or admin: the function answers no one else). */
export async function fileRecord(trx: Trx, fileId: string): Promise<FileRecord | null> {
  const { rows } = await sql<{
    holder: FileRecord['holder'];
    record_id: string | null;
    file_ids: string[] | null;
    trashed: boolean;
  }>`select * from app.vault_file_record(${fileId}::uuid)`.execute(trx);
  const r = rows[0];
  if (!r) return null;
  return { holder: r.holder, recordId: r.record_id, fileIds: r.file_ids ?? [], trashed: r.trashed };
}

/** The current (not set aside) record PDFs made from any of `pages`, each with whether the vault has had it. */
export async function recordPdfsOf(trx: Trx, ctx: Ctx, pages: readonly string[]): Promise<Existing[]> {
  if (!pages.length) return [];
  const rows = await trx
    .selectFrom('app.file')
    .select(['id', 'storage_key', 'source_file_ids'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('rendition', '=', 'record_pdf')
    .where('superseded_at', 'is', null)
    .where(sql<boolean>`source_file_ids && ${[...pages]}::uuid[]`)
    .orderBy('created_at')
    .execute();
  if (!rows.length) return [];
  // A definer, so whoever reads sees what the vault has had (states only).
  const { rows: states } = await sql<{ file_id: string; status: string }>`
    select file_id, status from app.vault_file_states(${rows.map((r) => r.id)}::uuid[])`.execute(trx);
  const sent = new Set(states.filter((s) => s.status !== 'queued').map((s) => s.file_id));
  return rows.map((r) => ({
    id: r.id,
    storage_key: r.storage_key,
    source_file_ids: r.source_file_ids ?? [],
    sent: sent.has(r.id),
  }));
}

const samePages = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

@Injectable()
export class RecordRenditions {
  private readonly logger = new Logger('RecordRenditions');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(FileBytes) private readonly files: FileBytes,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  register(): void {
    this.worker.register(RECORD_RENDER_JOB, async (job: Job) => {
      if (!job.workspace_id || !job.created_by)
        throw new PermanentJobError('record.no_context', 'A rendering job needs a workspace and a user');
      const p = job.payload as { fileId?: string };
      if (!p.fileId) throw new PermanentJobError('record.bad_payload', 'Nothing to render');
      const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
      const r = await this.render(ctx, p.fileId);
      // ADR-0059 §3: what became of it, on the pages' outbox rows.
      await this.db.run(ctx, (trx) => recordRecordConversion(trx, ctx, [p.fileId!, ...r.sources], r));
      // Ids and counts only.
      return 'fileId' in r ? { status: r.status, fileId: r.fileId } : { status: r.status };
    });
  }

  /** Queues `record.render` for the record `fileId` is a page of, in the caller's transaction, to run as the caller. */
  async enqueue(trx: Trx, ctx: Ctx, fileId: string): Promise<string> {
    return this.queue.enqueue(trx, {
      ...ctx,
      queue: 'report',
      type: RECORD_RENDER_JOB,
      payload: { fileId },
    });
  }

  /**
   * Draws the record's pages as one PDF and stores it (ADR-0059 §1–§3). The caller reads as an owner or admin (the
   * vault's job). Errors reading a page's bytes are the queue's to retry (`FileBytes.forJob`).
   */
  async render(ctx: Ctx, fileId: string): Promise<RecordRenderResult> {
    const first = await this.db.run(
      ctx,
      async (trx): Promise<{ done: RecordRenderResult } | { pages: Page[]; at: Date }> => {
        const record = await fileRecord(trx, fileId);
        if (!record || record.holder === 'other' || !record.fileIds.length)
          return { done: { status: 'not_renderable', reason: 'no_record', sources: [] } };
        const pages = await this.pagesOf(trx, ctx, record.fileIds);
        const sources = pages.map((p) => p.id);
        if (record.trashed || !pages.length)
          return { done: { status: 'not_renderable', reason: 'deleted', sources } };
        const busy = await sql<{ busy: boolean }>`
          select bool_or(app.vault_file_busy(f)) as busy from unnest(${sources}::uuid[]) as f`.execute(trx);
        if (busy.rows[0]?.busy) return { done: { status: 'not_ready', sources } };
        const same = (await recordPdfsOf(trx, ctx, sources)).find((e) =>
          samePages(e.source_file_ids, sources),
        );
        if (same) return { done: { status: 'kept', fileId: same.id, sources } };
        // The same pages give the same bytes: dated by the newest page, not by when it was drawn.
        const at = new Date(Math.max(...pages.map((p) => p.created_at.getTime())));
        return { pages, at };
      },
    );
    if ('done' in first) return first.done;

    const { pages, at } = first;
    const sources = pages.map((p) => p.id);
    let drawn: { bytes: Uint8Array; pages: number };
    try {
      const read: { bytes: Uint8Array; mime: string }[] = [];
      for (const p of pages) read.push({ bytes: await this.files.forJob(ctx, p), mime: p.mime });
      drawn = await renderRecordPdf({ pages: read, title: titleOf(pages[0]!.file_name), at });
    } catch (e) {
      if (e instanceof RecordPdfError)
        return {
          status: 'not_converted',
          reason: e.reason === 'unsupported' ? 'unsupported_page' : 'unreadable_page',
          sources,
        };
      throw e;
    }

    // Stored before the row that points at it, as uploads are; removed again if the row doesn't go in.
    const id = newId();
    const digest = sha256(drawn.bytes);
    const key = storageKey(ctx.workspaceId, pages[0]!.kind, id);
    await this.storage.put(key, drawn.bytes, 'application/pdf');
    let stored:
      | { outcome: 'changed' }
      | { outcome: 'kept'; id: string }
      | { outcome: 'stored'; replaced: Existing[]; superseded: Existing[] };
    try {
      stored = await this.db.run(ctx, async (trx) => {
        // One rendering of a record at a time: whoever locks its pages second sees what the first stored.
        await trx
          .selectFrom('app.file')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', sources)
          .orderBy('id')
          .forUpdate()
          .execute();
        // The pages may have been moved or removed while this was drawn: the next rendering has them.
        const now = await fileRecord(trx, fileId);
        const live = now ? (await this.pagesOf(trx, ctx, now.fileIds)).map((p) => p.id) : [];
        if (!now || now.trashed || !samePages(live, sources)) return { outcome: 'changed' as const };
        const existing = await recordPdfsOf(trx, ctx, sources);
        const same = existing.find((e) => samePages(e.source_file_ids, sources));
        if (same) return { outcome: 'kept' as const, id: same.id };
        const replaced = existing.filter((e) => !e.sent);
        const superseded = existing.filter((e) => e.sent);
        if (replaced.length)
          await trx
            .deleteFrom('app.file')
            .where('workspace_id', '=', ctx.workspaceId)
            .where(
              'id',
              'in',
              replaced.map((e) => e.id),
            )
            .execute();
        if (superseded.length)
          await trx
            .updateTable('app.file')
            .set({ superseded_at: new Date() })
            .where('workspace_id', '=', ctx.workspaceId)
            .where(
              'id',
              'in',
              superseded.map((e) => e.id),
            )
            .execute();
        await trx
          .insertInto('app.file')
          .values({
            workspace_id: ctx.workspaceId,
            id,
            kind: pages[0]!.kind,
            storage_key: key,
            file_name: renditionName(pages[0]!.file_name, 1, 1),
            mime: 'application/pdf',
            bytes: drawn.bytes.length,
            sha256: digest,
            uploaded_by: null,
            retain_until: retainedUntil(pages),
            page_count: drawn.pages,
            rendition: 'record_pdf' as const,
            source_file_ids: sources,
          })
          .execute();
        // ADR-0059 §3: it goes to the vault in this transaction, where the vault asked for the record.
        await queueRecordPdf(trx, ctx, id, pages[0]!.kind, sources);
        return { outcome: 'stored' as const, replaced, superseded };
      });
    } catch (e) {
      await this.remove([key]);
      const pg = e as { code?: string; hint?: string };
      if (pg.code === '23514' && pg.hint === 'storage.quota')
        return { status: 'not_converted', reason: 'storage_full', sources };
      throw e;
    }
    if (stored.outcome !== 'stored') {
      await this.remove([key]);
      return stored.outcome === 'kept'
        ? { status: 'kept', fileId: stored.id, sources }
        : { status: 'not_ready', sources };
    }
    await this.remove(stored.replaced.map((r) => r.storage_key));
    this.logger.log(
      `File ${fileId}: made a ${drawn.pages}-page PDF of ${sources.length} page file(s), replaced ${stored.replaced.length}, set aside ${stored.superseded.length}`,
    );
    return {
      status: 'rendered',
      fileId: id,
      sources,
      replaced: stored.replaced.map((r) => r.id),
      superseded: stored.superseded.map((r) => r.id),
    };
  }

  /** The record's pages that are files of the kinds a receipt or bill holds, in its order, without the trashed ones. */
  private async pagesOf(trx: Trx, ctx: Ctx, ids: readonly string[]): Promise<Page[]> {
    if (!ids.length) return [];
    const rows = await trx
      .selectFrom('app.file')
      .select([
        'id',
        'kind',
        'file_name',
        'mime',
        'sha256',
        'storage_key',
        'created_at',
        'deleted_at',
        'retain_until',
        'rendition',
        'sealed',
      ])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', [...ids])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: Page[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || r.deleted_at || r.sealed || r.rendition) continue;
      if (r.kind !== 'receipt' && r.kind !== 'invoice') continue;
      out.push({ ...r, kind: r.kind });
    }
    return out;
  }

  /** Deletes stored objects, logging rather than failing: the rows are what count. */
  private async remove(keys: readonly (string | null)[]): Promise<void> {
    for (const k of keys) {
      if (!k) continue;
      await this.storage.delete(k).catch((e: Error) => {
        this.logger.warn(`A record PDF's stored copy couldn't be removed: ${e.name}`);
      });
    }
  }
}

/** The PDF's own title: its first page's name, without the extension. */
function titleOf(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || fileName;
}

/**
 * Kept as long as its pages are (RCP-10): until the latest of their dates, or with no date while any page has none
 * (kept while it isn't deleted).
 */
function retainedUntil(pages: readonly Page[]): string | null {
  let latest: string | null = null;
  for (const p of pages) {
    if (p.retain_until === null) return null;
    const d =
      typeof p.retain_until === 'string'
        ? p.retain_until.slice(0, 10)
        : p.retain_until.toISOString().slice(0, 10);
    if (latest === null || d > latest) latest = d;
  }
  return latest;
}
