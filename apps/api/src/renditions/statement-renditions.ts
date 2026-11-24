/**
 * Statements rendered as PDFs, stored as files of their own (VLT-13, ADR-0057 §2–§4).
 *
 * The entry point is `render(ctx, fileId, options)`: it renders an uploaded statement from its committed import's rows
 * and stores each part as a new `app.file` linked to the original (`derived_from_file_id`, `rendition`), through the
 * same storage and quota as any upload (BAK-08). `enqueue` queues the same work as the worker's `statement.render`
 * job. Sending is the vault's (ADR-0057 §1, VLT-12): a rendering is not queued for the vault by the trigger that queues
 * uploads (migration 0092), but when the vault's job asked for it (the original's outbox row is `converted`), the
 * transaction that stores it queues each part in the vault's outbox (`queueRenditions`), and the job's outcome is
 * recorded on the original's row (`recordConversion`).
 *
 * - A rendering the vault already has is kept, never redone; one not yet sent is replaced by the new one.
 * - An import that was undone drops the renderings not yet sent; one the vault has stays (documents go one way).
 * - A file the import couldn't read gives a cover-only PDF with the original attached, when attaching was asked for,
 *   and "not converted" otherwise.
 *
 * Nothing here logs a file's name, an account, an amount or a number: only ids and counts.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type ImportBatchTable, type Trx } from '@montra/db';
import type { CalendarDate } from '@montra/domain';
import type { Selectable } from 'kysely';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { JobQueue, PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { FileBytes } from '../storage/file-bytes.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import {
  statementFacts,
  statementLines,
  type CoverOptions,
  type SourceFile,
  type StatementLine,
  type StatementSummary,
} from './document-summary.js';
import { renderStatementPdf, type DrawTrace } from './statement-pdf.js';
import { queueRenditions, recordConversion } from '../storage/vault/vault.conversions.js';
import { auditReveal } from '../crypto/sealed-numbers.js';

type Ctx = { workspaceId: string; userId: string };
type Batch = Selectable<ImportBatchTable>;

/** What to render: the cover's detail and account number (ADR-0057 §3), and whether the original goes inside. */
export interface RenderOptions extends CoverOptions {
  attachOriginal: boolean;
}

export interface RenditionFile {
  fileId: string;
  part: number;
  parts: number;
  bytes: number;
  sha256: string;
}

export type RenderResult =
  /** Stored: one file per part. `coverOnly` for a file the import couldn't read. `replaced` are the unsent ones removed. */
  | { status: 'rendered'; files: RenditionFile[]; replaced: string[]; coverOnly: boolean }
  /** The vault already has a rendering of this file: it isn't redone (ADR-0057 §4). */
  | { status: 'kept'; files: RenditionFile[] }
  /** The import is still being read or waits on a person: try again once it's committed. */
  | { status: 'not_ready' }
  /** No PDF: the file couldn't be read and attaching wasn't asked for, or the workspace's storage is full. */
  | { status: 'not_converted'; reason: 'unreadable' | 'storage_full' }
  /** The import was undone: renderings not yet sent were dropped. */
  | { status: 'import_undone'; dropped: string[] }
  /** Not something to render: no such file, not a statement, itself a rendering, in the Trash, or sealed. */
  | { status: 'not_renderable'; reason: 'not_found' | 'not_statement' | 'rendition' | 'deleted' | 'sealed' };

/** Imports still being read or waiting on a person. */
const IN_PROGRESS = new Set<Batch['status']>([
  'uploaded',
  'parsing',
  'needs_mapping',
  'preview',
  'committing',
]);
/** The job's type: a file at a time, in the workspace, as the user who queued it. */
export const RENDER_JOB = 'statement.render';

/** What rendering needs, read in one transaction. */
interface Prepared {
  file: SourceFile & { storage_key: string | null };
  summary: StatementSummary;
  lines: StatementLine[] | null;
  at: Date;
}

interface Existing {
  id: string;
  storage_key: string | null;
  bytes: string | number | bigint;
  sha256: string;
  file_name: string;
  sent: boolean;
}

@Injectable()
export class StatementRenditions {
  private readonly logger = new Logger('StatementRenditions');
  /** Tests look at what the renderer drew through this. */
  trace?: DrawTrace;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(FileBytes) private readonly files: FileBytes,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  register(): void {
    this.worker.register(RENDER_JOB, async (job: Job) => {
      if (!job.workspace_id || !job.created_by)
        throw new PermanentJobError('statement.no_context', 'A rendering job needs a workspace and a user');
      const p = job.payload as { fileId?: string; options?: RenderOptions };
      if (!p.fileId || !p.options) throw new PermanentJobError('statement.bad_payload', 'Nothing to render');
      const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
      const r = await this.render(ctx, p.fileId, p.options);
      // ADR-0057 §4: what became of a conversion the vault asked for (nothing, for any other).
      await this.db.run(ctx, (trx) => recordConversion(trx, ctx, p.fileId!, p.options!, r));
      // Ids and counts only.
      return 'files' in r ? { status: r.status, files: r.files.map((f) => f.fileId) } : { ...r };
    });
  }

  /** Queues `statement.render` for a file, in the caller's transaction, to run as the caller. */
  async enqueue(trx: Trx, ctx: Ctx, fileId: string, options: RenderOptions): Promise<string> {
    return this.queue.enqueue(trx, {
      ...ctx,
      queue: 'report',
      type: RENDER_JOB,
      payload: { fileId, options: { ...options } },
    });
  }

  /**
   * Renders a statement file and stores the result (ADR-0057 §2–§4). The caller reads as itself: an owner's context
   * for the vault's job. Errors reading the original's bytes are the queue's to retry (`FileBytes.forJob`).
   */
  async render(ctx: Ctx, fileId: string, options: RenderOptions): Promise<RenderResult> {
    const first = await this.db.run(ctx, async (trx): Promise<{ done: RenderResult } | Prepared> => {
      const file = await this.original(trx, ctx, fileId);
      if ('status' in file) return { done: file };
      const existing = await this.renditionsOf(trx, ctx, fileId);
      const sent = existing.filter((e) => e.sent);
      if (sent.length) return { done: { status: 'kept', files: sent.map(toFile) } };
      const batches = await trx
        .selectFrom('app.import_batch')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('file_id', '=', fileId)
        .orderBy('created_at', 'desc')
        .execute();
      const committed = batches.find((b) => b.status === 'committed') ?? null;
      if (!committed && batches.some((b) => IN_PROGRESS.has(b.status)))
        return { done: { status: 'not_ready' } };
      if (!committed && batches.some((b) => b.status === 'undone'))
        return { done: { status: 'import_undone', dropped: [] } };
      if (!committed && !options.attachOriginal)
        return { done: { status: 'not_converted', reason: 'unreadable' } };

      const rows = committed
        ? await trx
            .selectFrom('app.import_row')
            .select(['txn_date', 'description', 'payee_raw', 'amount_minor', 'balance_minor'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('import_batch_id', '=', committed.id)
            .where('status', '<>', 'error')
            .where('txn_date', 'is not', null)
            .where('amount_minor', 'is not', null)
            .orderBy('row_no')
            .execute()
        : null;
      const drawn = rows
        ? statementLines(
            rows.map((r) => ({
              date: r.txn_date as CalendarDate,
              description: r.description ?? r.payee_raw ?? '',
              amount: BigInt(r.amount_minor!),
              balance: r.balance_minor === null ? null : BigInt(r.balance_minor),
            })),
            committed!.statement_opening_minor === null ? null : BigInt(committed!.statement_opening_minor),
            committed!.statement_closing_minor === null ? null : BigInt(committed!.statement_closing_minor),
          )
        : null;
      const summary = await statementFacts(
        trx,
        ctx.workspaceId,
        file,
        committed ?? batches[0] ?? null,
        drawn ? { moneyIn: drawn.moneyIn, moneyOut: drawn.moneyOut, count: drawn.lines.length } : null,
        options.accountNumber,
        this.crypto,
      );
      return { file, summary, lines: drawn?.lines ?? null, at: committed?.committed_at ?? file.created_at };
    });
    if ('done' in first) {
      if (first.done.status === 'import_undone')
        return { status: 'import_undone', dropped: await this.dropUnsent(ctx, fileId) };
      return first.done;
    }

    const { file, summary, lines, at } = first;
    const original = options.attachOriginal ? await this.files.forJob(ctx, file) : null;
    const parts = await renderStatementPdf(
      {
        summary,
        lines,
        detail: options.detail,
        original: original ? { bytes: original, mime: file.mime } : null,
        maxRows: this.config.STATEMENT_PDF_MAX_ROWS,
        at,
      },
      this.trace,
    );

    // Stored before the rows that point at them, as uploads are; removed again if the rows don't go in.
    const made = parts.map((p) => ({ ...p, id: newId(), sha256: sha256(p.bytes) }));
    const keys = new Map(made.map((m) => [m.id, storageKey(ctx.workspaceId, 'statement', m.id)]));
    try {
      for (const m of made) await this.storage.put(keys.get(m.id)!, m.bytes, 'application/pdf');
    } catch (e) {
      await this.remove([...keys.values()]);
      throw e;
    }
    let stored:
      | { outcome: 'gone' }
      | { outcome: 'kept'; kept: Existing[] }
      | { outcome: 'stored'; replaced: Existing[] };
    try {
      stored = await this.db.run(ctx, async (trx) => {
        // One rendering of a file at a time: whoever locks the original second sees what the first stored.
        const locked = await trx
          .selectFrom('app.file')
          .select(['id', 'retain_until'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', fileId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) return { outcome: 'gone' as const };
        const existing = await this.renditionsOf(trx, ctx, fileId);
        const kept = existing.filter((e) => e.sent);
        if (kept.length) return { outcome: 'kept' as const, kept };
        if (existing.length)
          await trx
            .deleteFrom('app.file')
            .where('workspace_id', '=', ctx.workspaceId)
            .where(
              'id',
              'in',
              existing.map((e) => e.id),
            )
            .execute();
        await trx
          .insertInto('app.file')
          .values(
            made.map((m) => ({
              workspace_id: ctx.workspaceId,
              id: m.id,
              kind: 'statement' as const,
              storage_key: keys.get(m.id)!,
              file_name: renditionName(file.file_name, m.part, m.parts),
              mime: 'application/pdf',
              bytes: m.bytes.length,
              sha256: m.sha256,
              uploaded_by: null,
              retain_until: locked.retain_until,
              page_count: m.pages,
              derived_from_file_id: fileId,
              rendition: 'statement_pdf' as const,
            })),
          )
          .execute();
        // ADR-0057 §1: each part goes to the vault in this transaction, when the vault asked for it.
        await queueRenditions(
          trx,
          ctx,
          fileId,
          options,
          made.map((m) => ({ fileId: m.id, attached: m.attached })),
        );
        // ACC-16: a cover made with the full account number is audited as a reveal is: who and which file, no number.
        if (options.detail && options.accountNumber === 'full') {
          await auditReveal(trx, ctx, 'statement.full_number_on_cover', { type: 'file', id: fileId });
        }
        return { outcome: 'stored' as const, replaced: existing };
      });
    } catch (e) {
      await this.remove([...keys.values()]);
      const pg = e as { code?: string; hint?: string };
      if (pg.code === '23514' && pg.hint === 'storage.quota')
        return { status: 'not_converted', reason: 'storage_full' };
      throw e;
    }
    if (stored.outcome !== 'stored') {
      await this.remove([...keys.values()]);
      // The original went to the Trash meanwhile, or the vault took an earlier rendering, which stands.
      return stored.outcome === 'gone'
        ? { status: 'not_renderable', reason: 'deleted' }
        : { status: 'kept', files: stored.kept.map(toFile) };
    }
    await this.remove(stored.replaced.map((r) => r.storage_key));
    this.logger.log(
      `File ${fileId}: rendered ${made.length} PDF part(s), replaced ${stored.replaced.length}`,
    );
    return {
      status: 'rendered',
      files: made.map((m) => ({
        fileId: m.id,
        part: m.part,
        parts: m.parts,
        bytes: m.bytes.length,
        sha256: m.sha256,
      })),
      replaced: stored.replaced.map((r) => r.id),
      coverOnly: lines === null,
    };
  }

  /**
   * Drops the renderings of a file not yet sent, when none of its imports is committed any more (an undone import,
   * ADR-0057 §4), or whatever its imports (`always`: its group no longer converts). One the vault already has stays,
   * and the vault's job marks it "import undone". Returns the dropped files' ids.
   */
  async dropUnsent(ctx: Ctx, fileId: string, opts: { always?: boolean } = {}): Promise<string[]> {
    const dropped = await this.db.run(ctx, async (trx) => {
      // ADR-0057 §4: the vault's job looks at the file's conversion again (an undone import).
      if (!opts.always) await sql`select app.vault_conversion_due(${fileId}::uuid)`.execute(trx);
      const committed = opts.always
        ? null
        : await trx
            .selectFrom('app.import_batch')
            .select('id')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('file_id', '=', fileId)
            .where('status', '=', 'committed')
            .executeTakeFirst();
      if (committed) return [];
      const unsent = (await this.renditionsOf(trx, ctx, fileId)).filter((e) => !e.sent);
      if (unsent.length)
        await trx
          .deleteFrom('app.file')
          .where('workspace_id', '=', ctx.workspaceId)
          .where(
            'id',
            'in',
            unsent.map((e) => e.id),
          )
          .execute();
      return unsent;
    });
    await this.remove(dropped.map((d) => d.storage_key));
    if (dropped.length) this.logger.log(`File ${fileId}: dropped ${dropped.length} unsent PDF rendering(s)`);
    return dropped.map((d) => d.id);
  }

  /**
   * A file's current renderings, each with whether the vault has had it (any state past `queued`). Renderings "Send
   * again" replaced (`superseded_at`, ADR-0057 §4) aren't current: they stay in the vault, and a new one is made.
   */
  async renditionsOf(trx: Trx, ctx: Ctx, fileId: string): Promise<Existing[]> {
    const rows = await trx
      .selectFrom('app.file')
      .select(['id', 'storage_key', 'bytes', 'sha256', 'file_name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('derived_from_file_id', '=', fileId)
      .where('rendition', '=', 'statement_pdf')
      .where('superseded_at', 'is', null)
      .execute();
    if (!rows.length) return [];
    // Parts in order: "part 2 of 12" before "part 10 of 12".
    rows.sort((a, b) => a.file_name.localeCompare(b.file_name, 'en', { numeric: true }));
    // A definer, so a caller who isn't an owner still sees what the vault has had (states only).
    const { rows: states } = await sql<{ file_id: string; status: string }>`
      select file_id, status from app.vault_file_states(${rows.map((r) => r.id)}::uuid[])`.execute(trx);
    const sent = new Set(states.filter((s) => s.status !== 'queued').map((s) => s.file_id));
    return rows.map((r) => ({ ...r, sent: sent.has(r.id) }));
  }

  private async original(trx: Trx, ctx: Ctx, fileId: string) {
    const file = await trx
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
        'sealed',
        'rendition',
      ])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', fileId)
      .executeTakeFirst();
    const no = (reason: Extract<RenderResult, { status: 'not_renderable' }>['reason']) => ({
      status: 'not_renderable' as const,
      reason,
    });
    if (!file) return no('not_found');
    if (file.rendition) return no('rendition');
    if (file.kind !== 'statement') return no('not_statement');
    if (file.deleted_at) return no('deleted');
    if (file.sealed) return no('sealed');
    return file;
  }

  /** Deletes stored objects, logging rather than failing: the rows are what count. */
  private async remove(keys: readonly (string | null)[]): Promise<void> {
    for (const k of keys) {
      if (!k) continue;
      await this.storage.delete(k).catch((e: Error) => {
        this.logger.warn(`A rendered PDF's stored copy couldn't be removed: ${e.name}`);
      });
    }
  }
}

const toFile = (e: Existing, i: number, all: readonly Existing[]): RenditionFile => ({
  fileId: e.id,
  part: i + 1,
  parts: all.length,
  bytes: Number(e.bytes),
  sha256: e.sha256,
});

/** "October.csv (PDF).pdf", or "October.csv (PDF, part 1 of 2).pdf". */
export function renditionName(original: string, part: number, parts: number): string {
  const suffix = parts > 1 ? ` (PDF, part ${part} of ${parts}).pdf` : ' (PDF).pdf';
  return `${original.slice(0, 255 - suffix.length)}${suffix}`;
}
