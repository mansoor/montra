import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { newId, type ImportBatchTable, type ImportRowTable, type Trx } from '@montra/db';
import { asCurrencyCode, isBalanceSheet } from '@montra/domain';
import type {
  BulkImportRowsRequest,
  ColumnMappingDto,
  CreateImportRequest,
  ImportBatchDto,
  ImportRowDto,
  UpdateImportRowRequest,
  UpdateMappingRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { JobQueue } from '../jobs/queue.js';
import { LedgerService } from '../ledger/ledger.service.js';

type Ctx = { workspaceId: string; userId: string };
type Batch = Selectable<ImportBatchTable>;
type Row = Selectable<ImportRowTable>;

/** What commit does with a row: the user's decision wins, otherwise the classification decides (04 §3.5). */
export function effectiveDecision(
  row: Pick<Row, 'status' | 'decision'>,
): 'import' | 'skip' | 'match' | 'fail' {
  if (row.status === 'error') return 'fail';
  if (row.decision) return row.decision === 'match' && row.status !== 'match' ? 'import' : row.decision;
  switch (row.status) {
    case 'duplicate':
      return 'skip';
    case 'match':
      return 'match';
    default:
      return 'import'; // new and probable duplicates are imported unless the user skips them
  }
}

const money = (amount: bigint | null, currency: string) =>
  amount === null ? null : { amount: amount.toString(), currency: asCurrencyCode(currency) };

@Injectable()
export class ImportsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /** Starts an import of an uploaded file into an account (IMP-01). Parsing runs in the worker. */
  async create(ctx: Ctx, req: CreateImportRequest): Promise<ImportBatchDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const file = await trx
        .selectFrom('app.file')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.fileId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!file) throw notFound('Uploaded file');
      const fileType = fileTypeOf(file.mime, file.file_name);
      if (!fileType)
        throw unprocessable('import.unsupported_file', 'Upload a CSV, XLS, XLSX or PDF statement');
      const account = await this.ledger.accountRef(trx, ctx.workspaceId, req.accountId);
      if (!isBalanceSheet(account.type) || account.type === 'equity') {
        throw unprocessable(
          'account.not_a_bank_account',
          'Statements are imported into a bank, card, loan or cash account',
        );
      }
      await trx
        .insertInto('app.import_batch')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: account.entityId,
          ledger_account_id: account.id,
          file_id: file.id,
          file_name: file.file_name,
          file_type: fileType,
          currency: account.currency,
          status: 'parsing',
          warnings: '[]',
          created_by: ctx.userId,
        })
        .execute();
      const parse = { workspaceId: ctx.workspaceId, batchId: id, accountFilter: req.accountFilter ?? null };
      const jobId =
        fileType === 'xls' || fileType === 'pdf'
          ? await this.queue.enqueue(trx, {
              ...ctx,
              queue: 'doc',
              type: 'doc.extract',
              payload: {
                workspaceId: ctx.workspaceId,
                fileId: file.id,
                storageKey: file.storage_key,
                fileName: file.file_name,
                mime: file.mime,
                fileType,
              },
              then: { queue: 'import', type: 'import.parse', payload: parse },
            })
          : await this.queue.enqueue(trx, { ...ctx, queue: 'import', type: 'import.parse', payload: parse });
      await trx
        .updateTable('app.import_batch')
        .set({ job_id: jobId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.get(ctx, id);
  }

  async get(ctx: Ctx, id: string): Promise<ImportBatchDto> {
    return this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id);
      const counts = await trx
        .selectFrom('app.import_row')
        .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', id)
        .groupBy('status')
        .execute();
      // A failed extraction or parse job is reported on the batch (the doc worker can't update it itself).
      let { status, error } = batch;
      const job = batch.job_id
        ? await trx
            .selectFrom('app.job')
            .select(['id', 'type', 'status', 'progress', 'result', 'error'])
            .where('id', '=', batch.job_id)
            .executeTakeFirst()
        : undefined;
      if (job?.status === 'failed' && (status === 'parsing' || status === 'committing')) {
        status = 'failed';
        error = job.error;
      }
      return toBatchDto(
        { ...batch, status, error },
        Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
        job ? { ...job, result: (job.result as Record<string, unknown> | null) ?? null } : null,
      );
    });
  }

  async list(ctx: Ctx, accountId?: string): Promise<ImportBatchDto[]> {
    const ids = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.import_batch')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(Boolean(accountId), (q) => q.where('ledger_account_id', '=', accountId!))
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
    );
    return Promise.all(ids.map((r) => this.get(ctx, r.id)));
  }

  async rows(
    ctx: Ctx,
    id: string,
    opts: { status?: Row['status']; afterRowNo?: number; limit: number },
  ): Promise<{ data: ImportRowDto[]; nextCursor: string | null }> {
    return this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id);
      const rows = await trx
        .selectFrom('app.import_row')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', id)
        .$if(Boolean(opts.status), (q) => q.where('status', '=', opts.status!))
        .$if(opts.afterRowNo !== undefined, (q) => q.where('row_no', '>', opts.afterRowNo!))
        .orderBy('row_no')
        .limit(opts.limit + 1)
        .execute();
      const page = rows.slice(0, opts.limit);
      return {
        data: page.map((r) => toRowDto(r, batch.currency)),
        nextCursor: rows.length > opts.limit ? String(page.at(-1)!.row_no) : null,
      };
    });
  }

  /** Confirm or correct the column mapping (IMP-03/04); the file is parsed again with it. */
  async setMapping(ctx: Ctx, id: string, req: UpdateMappingRequest): Promise<ImportBatchDto> {
    await this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id, true);
      if (!['needs_mapping', 'preview', 'failed'].includes(batch.status)) {
        throw unprocessable('import.not_editable', `The import is ${batch.status}`);
      }
      const payload = {
        workspaceId: ctx.workspaceId,
        batchId: id,
        override: req.mapping as ColumnMappingDto,
        saveProfile: req.saveProfile,
        accountFilter: (batch.analysis as { accountFilter?: string } | null)?.accountFilter ?? null,
      };
      // Spreadsheets and PDFs re-use the grid the doc worker extracted the first time.
      const grid = (batch.analysis as { sheets?: unknown } | null)?.sheets;
      const jobId = await this.queue.enqueue(trx, {
        ...ctx,
        queue: 'import',
        type: 'import.parse',
        payload: grid
          ? {
              ...payload,
              previousResult: {
                kind: 'grid',
                sheets: grid,
                statement: (batch.analysis as { statement?: unknown }).statement ?? null,
              },
            }
          : payload,
      });
      await trx
        .updateTable('app.import_batch')
        .set({ status: 'parsing', job_id: jobId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.get(ctx, id);
  }

  /** Skip, import or (re)categorize one preview row (IMP-06). */
  async updateRow(ctx: Ctx, id: string, rowId: string, req: UpdateImportRowRequest): Promise<ImportRowDto> {
    return this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id);
      if (batch.status !== 'preview' && batch.status !== 'needs_mapping')
        throw unprocessable('import.not_editable', `The import is ${batch.status}`);
      if (req.categoryId) {
        const cat = await this.ledger.accountRef(trx, ctx.workspaceId, req.categoryId);
        if (
          cat.type !== 'income' &&
          cat.type !== 'expense' &&
          cat.type !== 'asset' &&
          cat.type !== 'liability'
        ) {
          throw unprocessable('category.invalid', 'Choose a category');
        }
      }
      const row = await trx
        .updateTable('app.import_row')
        .set({
          ...(req.decision !== undefined ? { decision: req.decision } : {}),
          ...(req.categoryId !== undefined ? { category_id: req.categoryId } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', id)
        .where('id', '=', rowId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw notFound('Import row');
      return toRowDto(row, batch.currency);
    });
  }

  /** Bulk decision for preview rows (IMP-06), e.g. skip every probable duplicate. */
  async bulkRows(ctx: Ctx, id: string, req: BulkImportRowsRequest): Promise<{ updated: number }> {
    return this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id);
      if (batch.status !== 'preview' && batch.status !== 'needs_mapping') {
        throw unprocessable('import.not_editable', `The import is ${batch.status}`);
      }
      const res = await trx
        .updateTable('app.import_row')
        .set({ decision: req.decision })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', id)
        .$if(Boolean(req.rowIds?.length), (q) => q.where('id', 'in', req.rowIds!))
        .$if(Boolean(req.status), (q) => q.where('status', '=', req.status!))
        .executeTakeFirst();
      return { updated: Number(res.numUpdatedRows) };
    });
  }

  /** Posts the preview (IMP-08). Runs in the worker as one atomic job; progress is visible on the job. */
  async commit(ctx: Ctx, id: string): Promise<ImportBatchDto> {
    await this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id, true);
      if (batch.status !== 'preview') {
        throw new AppError(
          409,
          'import.not_ready',
          batch.status === 'needs_mapping'
            ? 'Confirm the column mapping first'
            : `The import is ${batch.status}`,
        );
      }
      const jobId = await this.queue.enqueue(trx, {
        ...ctx,
        queue: 'import',
        type: 'import.commit',
        payload: { workspaceId: ctx.workspaceId, batchId: id },
        maxAttempts: 1,
      });
      await trx
        .updateTable('app.import_batch')
        .set({ status: 'committing', job_id: jobId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.get(ctx, id);
  }

  /** Undo a committed import within 30 days (IMP-09). */
  async undo(ctx: Ctx, id: string): Promise<ImportBatchDto> {
    await this.db.run(ctx, async (trx) => {
      const batch = await this.load(trx, ctx, id, true);
      if (batch.status !== 'committed')
        throw new AppError(409, 'import.not_committed', 'Only committed imports can be undone');
      if (batch.undo_until && batch.undo_until.getTime() < Date.now()) {
        throw new AppError(409, 'import.undo_expired', 'Imports can be undone for 30 days');
      }
      const jobId = await this.queue.enqueue(trx, {
        ...ctx,
        queue: 'import',
        type: 'import.undo',
        payload: { workspaceId: ctx.workspaceId, batchId: id },
        maxAttempts: 1,
      });
      await trx
        .updateTable('app.import_batch')
        .set({ status: 'committing', job_id: jobId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.get(ctx, id);
  }

  async job(ctx: Ctx, jobId: string) {
    const job = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.job')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', jobId)
        .executeTakeFirst(),
    );
    if (!job) throw notFound('Job');
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      error: job.error,
      result: job.result as Record<string, unknown> | null,
      createdAt: job.created_at.toISOString(),
      finishedAt: job.finished_at?.toISOString() ?? null,
    };
  }

  private async load(trx: Trx, ctx: Ctx, id: string, forUpdate = false): Promise<Batch> {
    let q = trx
      .selectFrom('app.import_batch')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    const batch = await q.executeTakeFirst();
    if (!batch) throw notFound('Import');
    return batch;
  }
}

export function fileTypeOf(mime: string, fileName: string): ImportBatchTable['file_type'] | null {
  if (/pdf/.test(mime) || /\.pdf$/i.test(fileName)) return 'pdf';
  if (/spreadsheetml|\.sheet/.test(mime) || /\.xlsx$/i.test(fileName)) return 'xlsx';
  if (/ms-excel$/.test(mime) || /\.xls$/i.test(fileName)) return 'xls';
  if (/csv|text\/plain|tab-separated/.test(mime) || /\.(csv|tsv|txt)$/i.test(fileName)) return 'csv';
  return null;
}

function toBatchDto(b: Batch, counts: Record<string, number>, job: ImportBatchDto['job']): ImportBatchDto {
  const analysis = b.analysis as {
    accountColumn?: number | null;
    header?: string[] | null;
    sample?: string[][];
    accounts?: string[];
    templateId?: string | null;
  } | null;
  return {
    id: b.id,
    accountId: b.ledger_account_id,
    fileId: b.file_id,
    fileName: b.file_name,
    fileType: b.file_type,
    status: b.status,
    currency: b.currency,
    mapping: (b.mapping as ColumnMappingDto | null) ?? null,
    mappingSource: b.mapping_source,
    mappingConfidence: b.mapping_confidence === null ? null : Number(b.mapping_confidence),
    analysis: analysis
      ? {
          header: analysis.header ?? null,
          sample: analysis.sample ?? [],
          accounts: analysis.accounts ?? [],
          accountColumn: analysis.accountColumn ?? null,
          templateId: analysis.templateId ?? null,
        }
      : null,
    counts: {
      read: b.rows_read,
      new: counts.new ?? 0,
      duplicate: counts.duplicate ?? 0,
      probableDuplicate: counts.probable_duplicate ?? 0,
      match: counts.match ?? 0,
      error: counts.error ?? 0,
      skipped: b.rows_skipped,
      added: b.rows_added,
      matched: b.rows_matched,
      failed: b.rows_failed,
    },
    minDate: b.min_date,
    maxDate: b.max_date,
    statement: {
      opening: money(b.statement_opening_minor, b.currency),
      closing: money(b.statement_closing_minor, b.currency),
    },
    balanceCheck: b.balance_check,
    balanceGap: money(b.balance_gap_minor, b.currency),
    warnings: (b.warnings as string[]) ?? [],
    error: b.error,
    committedAt: b.committed_at?.toISOString() ?? null,
    undoUntil: b.undo_until?.toISOString() ?? null,
    undoneAt: b.undone_at?.toISOString() ?? null,
    jobId: b.job_id,
    job,
    createdAt: b.created_at.toISOString(),
  };
}

function toRowDto(r: Row, currency: string): ImportRowDto {
  const s = r.suggestion as { categoryId?: string | null; confidence?: number; explanation?: string } | null;
  return {
    id: r.id,
    rowNo: r.row_no,
    date: r.txn_date,
    amount: money(r.amount_minor, currency),
    description: r.description,
    payee: r.payee_raw,
    balance: money(r.balance_minor, currency),
    status: r.status,
    decision: r.decision,
    effective: effectiveDecision(r),
    transactionId: r.transaction_id,
    matchTransactionId: r.match_transaction_id,
    duplicateOfTransactionId: r.duplicate_of_transaction_id,
    score: r.score === null ? null : Number(r.score),
    categoryId: r.category_id,
    suggestion: s
      ? { categoryId: s.categoryId ?? null, confidence: s.confidence ?? 0, explanation: s.explanation ?? '' }
      : null,
    error: r.error,
    outcome: r.outcome,
    raw: (r.raw as string[]) ?? [],
  };
}
