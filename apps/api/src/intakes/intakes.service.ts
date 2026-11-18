/**
 * Intakes (ADR-0051): a statement uploaded without an account, or a bill scanned to be filed automatically. Each is
 * read once (`intake.read`, after the doc-worker for PDFs, XLS files and photos) and matched to an account or biller.
 * A learned match imports the statement when the import is clean (`intake.settle`) or files the bill; anything else
 * waits in Review, where a person picks and the match memory learns.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type DocumentIntakeRow, type Trx } from '@montra/db';
import { calendarDate, isBalanceSheet } from '@montra/domain';
import { detectFileType, LEARN_AFTER } from '@montra/importers';
import type {
  CreateIntakeRequest,
  IntakeBillDto,
  IntakeCandidateDto,
  IntakeDetectedDto,
  IntakeDto,
  IntakeReason,
  IntakeStatus,
  ListIntakesQuery,
  ResolveIntakeRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, forbidden, notFound, unprocessable } from '../common/errors.js';
import { JobQueue } from '../jobs/queue.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ImportsService, fileTypeOf } from '../imports/imports.service.js';
import { HouseholdBillsService } from '../planning/household-bills.service.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { FileBytes } from '../storage/file-bytes.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import { confirmMatch, readMemory } from './match-memory.js';

type Ctx = { workspaceId: string; userId: string };

const MIME_BY_TYPE = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  qif: 'application/qif',
  ofx: 'application/x-ofx',
} as const;

/** Roles that import statements; bills are also filed by members (AUTH-18). */
export const STATEMENT_ROLES = ['owner', 'admin', 'partner', 'accountant'] as const;
export const BILL_ROLES = ['owner', 'admin', 'partner', 'accountant', 'member'] as const;

/** What `detected` holds on an intake: the DTO's details plus the candidates and, for a bill, its reading. */
export interface StoredDetected extends IntakeDetectedDto {
  candidates: IntakeCandidateDto[];
  bill?: IntakeBillDto | null;
  duplicateOf?: IntakeDto['duplicateOf'];
}

/** The institutions on the workspace's accounts: the doc-worker says which one a statement names (ADR-0051 §2). */
export async function workspaceIssuers(trx: Trx, workspaceId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('app.bank_account')
    .select('institution')
    .distinct()
    .where('workspace_id', '=', workspaceId)
    .where('institution', 'is not', null)
    .execute();
  return rows.map((r) => r.institution!.trim()).filter((n) => n.length >= 3);
}

/** The import job that follows `doc.extract` or reads the file itself. */
export const READ_JOB = 'intake.read';
/** Runs after an intake's import is parsed: commits it when clean. */
export const SETTLE_JOB = 'intake.settle';

@Injectable()
export class IntakesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(FileBytes) private readonly files: FileBytes,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(ImportsService) private readonly imports: ImportsService,
    @Inject(HouseholdBillsService) private readonly bills: HouseholdBillsService,
  ) {}

  /** A statement file of any kind, photos included, uploaded with no account: stored, then read and matched. */
  async upload(ctx: Ctx, bytes: Uint8Array, rawName: string): Promise<IntakeDto> {
    const fileName = rawName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'statement';
    const type = detectFileType(bytes, fileName);
    const media = type ? null : detectReceiptMedia(bytes);
    const mime = type ? MIME_BY_TYPE[type] : media?.startsWith('image/') ? media : null;
    if (!mime)
      throw new AppError(
        415,
        'upload.unsupported_type',
        'Upload a CSV, XLS, XLSX, PDF, QIF or OFX statement, or a photo of one',
      );
    const id = await this.db.run(ctx, async (trx) => {
      const fileId = newId();
      const key = storageKey(ctx.workspaceId, 'statement', fileId);
      await this.storage.put(key, bytes, mime);
      const digest = sha256(bytes);
      const earlier = await trx
        .selectFrom('app.file as f')
        .leftJoin('app.import_batch as b', (j) =>
          j.onRef('b.workspace_id', '=', 'f.workspace_id').onRef('b.file_id', '=', 'f.id'),
        )
        .select(['f.id', 'f.created_at', 'b.id as batch_id'])
        .where('f.workspace_id', '=', ctx.workspaceId)
        .where('f.sha256', '=', digest)
        .where('f.deleted_at', 'is', null)
        .orderBy('f.created_at')
        .executeTakeFirst();
      await trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id: fileId,
          kind: 'statement',
          storage_key: key,
          file_name: fileName,
          mime,
          bytes: bytes.length,
          sha256: digest,
          uploaded_by: ctx.userId,
        })
        .execute();
      return this.start(
        trx,
        ctx,
        { id: fileId, storage_key: key, file_name: fileName, mime },
        earlier
          ? {
              fileId: earlier.id,
              importBatchId: earlier.batch_id,
              uploadedAt: earlier.created_at.toISOString(),
            }
          : null,
      );
    });
    return this.get(ctx, id);
  }

  /** A statement uploaded already (`POST uploads`), to find its account. */
  async create(ctx: Ctx, req: CreateIntakeRequest): Promise<IntakeDto> {
    // The doc-worker reads files by Montra's key: one only the vault holds is asked of it and kept here again first
    // (ADR-0054 §5).
    const keys = await this.files.ensureHeld(ctx, [req.fileId]);
    const id = await this.db.run(ctx, async (trx) => {
      const file = await trx
        .selectFrom('app.file')
        .select(['id', 'storage_key', 'file_name', 'mime'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.fileId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      const key = file?.storage_key ?? keys.get(req.fileId);
      if (!file || !key) throw notFound('Uploaded file');
      return this.start(trx, ctx, { ...file, storage_key: key }, null);
    });
    return this.get(ctx, id);
  }

  private async start(
    trx: Trx,
    ctx: Ctx,
    file: { id: string; storage_key: string; file_name: string; mime: string },
    duplicateOf: IntakeDto['duplicateOf'],
  ): Promise<string> {
    const fileType = /^image\//.test(file.mime) ? 'image' : fileTypeOf(file.mime, file.file_name);
    if (!fileType)
      throw unprocessable('import.unsupported_file', 'Upload a CSV, XLS, XLSX, PDF, QIF or OFX statement');
    const detected: StoredDetected = {
      last4: null,
      issuer: null,
      fileNamePattern: null,
      billerName: null,
      candidates: [],
      duplicateOf,
    };
    const intake = await trx
      .insertInto('app.document_intake')
      .values({
        workspace_id: ctx.workspaceId,
        kind: 'statement',
        file_ids: [file.id],
        file_name: file.file_name,
        file_type: fileType,
        detected: JSON.stringify(detected),
        created_by: ctx.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const read = { queue: 'import' as const, type: READ_JOB, payload: { intakeId: intake.id } };
    // One reading (ADR-0048 §3): PDFs, XLS files and photos are read by the doc-worker once, and the intake keeps it.
    const jobId =
      fileType === 'pdf' || fileType === 'xls' || fileType === 'image'
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
              issuers: await workspaceIssuers(trx, ctx.workspaceId),
            },
            then: read,
          })
        : await this.queue.enqueue(trx, { ...ctx, ...read });
    await trx
      .updateTable('app.document_intake')
      .set({ job_id: jobId })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', intake.id)
      .execute();
    return intake.id;
  }

  async list(ctx: Ctx, q: ListIntakesQuery): Promise<IntakeDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.document_intake')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(Boolean(q.kind), (b) => b.where('kind', '=', q.kind!))
        .$if(q.status === 'open', (b) =>
          b.where('status', 'in', ['reading', 'suggested', 'review', 'importing']),
        )
        .$if(q.status === 'recent', (b) => b.where('created_at', '>', sql<Date>`now() - interval '30 days'`))
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute();
      const out: IntakeDto[] = [];
      for (const r of rows) out.push(await this.dto(trx, ctx, r));
      return q.status === 'open' ? out.filter((d) => d.status === 'suggested' || d.status === 'review') : out;
    });
  }

  async get(ctx: Ctx, id: string): Promise<IntakeDto> {
    return this.db.run(ctx, async (trx) => this.dto(trx, ctx, await this.row(trx, ctx, id)));
  }

  async dismiss(ctx: Ctx, role: string, id: string): Promise<IntakeDto> {
    await this.db.run(ctx, async (trx) => {
      const row = await this.row(trx, ctx, id, true);
      this.requireKindRole(row.kind, role);
      const { status } = await this.effective(trx, ctx, row);
      if (status !== 'suggested' && status !== 'review')
        throw new AppError(409, 'intake.not_open', 'This statement or bill is already filed');
      await trx
        .updateTable('app.document_intake')
        .set({
          status: 'dismissed',
          resolved_by: ctx.userId,
          resolved_at: new Date(),
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.get(ctx, id);
  }

  /** Picks the account or biller and finishes: a confirmation the memory learns from, or a correction. */
  async resolve(ctx: Ctx, role: string, id: string, req: ResolveIntakeRequest): Promise<IntakeDto> {
    const kind = await this.db.run(ctx, async (trx) => (await this.row(trx, ctx, id)).kind);
    this.requireKindRole(kind, role);
    if (kind === 'bill') await this.resolveBill(ctx, id, req);
    else await this.db.run(ctx, (trx) => this.resolveStatement(trx, ctx, id, req));
    return this.get(ctx, id);
  }

  /** Statements are finished by the roles that import files; bills also by members (AUTH-18). */
  private requireKindRole(kind: 'statement' | 'bill', role: string): void {
    const allowed: readonly string[] = kind === 'statement' ? STATEMENT_ROLES : BILL_ROLES;
    if (!allowed.includes(role)) throw forbidden();
  }

  private async resolveStatement(trx: Trx, ctx: Ctx, id: string, req: ResolveIntakeRequest): Promise<void> {
    const row = await this.row(trx, ctx, id, true);
    const { status } = await this.effective(trx, ctx, row);
    if (status !== 'suggested' && status !== 'review')
      throw new AppError(409, 'intake.not_open', 'This statement is already imported, or still being read');
    const account = await this.ledger.accountRef(trx, ctx.workspaceId, req.targetId);
    if (!isBalanceSheet(account.type) || account.type === 'equity')
      throw unprocessable(
        'account.not_a_bank_account',
        'Statements are imported into a bank, card, loan or cash account',
      );
    await confirmMatch(trx, ctx, 'statement', row.signal, account.id);
    const resolved = { resolved_by: ctx.userId, resolved_at: new Date(), updated_at: new Date() };

    // An import already waiting in preview: kept for the same account, dropped for another (it has no transactions).
    if (row.import_batch_id) {
      const batch = await trx
        .selectFrom('app.import_batch')
        .select(['id', 'status', 'ledger_account_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.import_batch_id)
        .executeTakeFirst();
      const waiting = batch && ['needs_mapping', 'preview', 'parsing', 'failed'].includes(batch.status);
      if (waiting && batch.ledger_account_id === account.id && batch.status !== 'failed') {
        // On the phone a confirmation commits only a clean import; this one wasn't, so it waits for the web.
        if (req.commitIfClean) return;
        await trx
          .updateTable('app.document_intake')
          .set({ status: 'done', reason: null, target_id: account.id, automatic: false, ...resolved })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .execute();
        return;
      }
      if (waiting)
        await trx
          .deleteFrom('app.import_batch')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', batch.id)
          .execute();
    }

    const batchId = await this.imports.startBatch(
      trx,
      ctx,
      { fileId: row.file_ids[0]!, accountId: account.id },
      {
        previousResult: (row.reading as Record<string, unknown> | null) ?? null,
        ...(req.commitIfClean
          ? { then: { queue: 'import', type: SETTLE_JOB, payload: { intakeId: id } } }
          : {}),
      },
    );
    await trx
      .updateTable('app.document_intake')
      .set({
        status: req.commitIfClean ? 'importing' : 'done',
        reason: null,
        target_id: account.id,
        automatic: false,
        commit_if_clean: Boolean(req.commitIfClean),
        import_batch_id: batchId,
        ...resolved,
        ...(req.commitIfClean ? { resolved_by: null, resolved_at: null } : {}),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
  }

  private async resolveBill(ctx: Ctx, id: string, req: ResolveIntakeRequest): Promise<void> {
    const row = await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id, true);
      const { status } = await this.effective(trx, ctx, r);
      if (status !== 'suggested' && status !== 'review')
        throw new AppError(409, 'intake.not_open', 'This bill is already filed');
      return r;
    });
    const d = (row.detected ?? {}) as Partial<StoredDetected>;
    const amount = req.amount ?? d.bill?.amount ?? null;
    const dueDate = req.dueDate ?? d.bill?.dueDate ?? null;
    if (!amount || BigInt(amount) <= 0n || !dueDate)
      throw unprocessable('intake.bill_incomplete', 'Enter the amount due and the due date');
    await this.bills.create(
      ctx,
      {
        billerId: req.targetId,
        amount,
        dueDate: calendarDate(dueDate),
        billDate: d.bill?.billDate ? calendarDate(d.bill.billDate) : null,
        periodStart: d.bill?.periodStart ? calendarDate(d.bill.periodStart) : null,
        periodEnd: d.bill?.periodEnd ? calendarDate(d.bill.periodEnd) : null,
        ...(d.bill?.memberId ? { memberId: d.bill.memberId } : {}),
      },
      {
        intakeId: row.id,
        fileIds: row.file_ids,
        reading: row.reading,
        signal: row.signal,
        scanId: row.scan_id,
      },
    );
  }

  async row(trx: Trx, ctx: Ctx, id: string, forUpdate = false): Promise<DocumentIntakeRow> {
    let q = trx
      .selectFrom('app.document_intake')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw notFound('Statement or bill');
    return row;
  }

  /** The stored status, unless the job it waits for failed: then it's in Review. */
  private async effective(
    trx: Trx,
    ctx: Ctx,
    r: DocumentIntakeRow,
  ): Promise<{ status: IntakeStatus; reason: IntakeReason | null }> {
    if (r.status === 'reading' && r.job_id) {
      const job = await trx
        .selectFrom('app.job')
        .select('status')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.job_id)
        .executeTakeFirst();
      if (job?.status === 'failed') return { status: 'review', reason: 'unreadable' };
    }
    if (r.status === 'importing' && r.import_batch_id) {
      const { rows } = await sql<{ status: string; job_status: string | null }>`
        select b.status,
               (select j.status from app.job j
                 where j.workspace_id = b.workspace_id and (j.id = b.job_id or j.payload->>'batchId' = b.id::text)
                 order by j.created_at desc limit 1) as job_status
          from app.import_batch b
         where b.workspace_id = ${ctx.workspaceId} and b.id = ${r.import_batch_id}`.execute(trx);
      const b = rows[0];
      if (!b || b.status === 'failed' || (b.job_status === 'failed' && b.status === 'parsing'))
        return { status: 'review', reason: 'import_failed' };
    }
    return { status: r.status, reason: (r.reason as IntakeReason | null) ?? null };
  }

  async dto(trx: Trx, ctx: Ctx, r: DocumentIntakeRow): Promise<IntakeDto> {
    const { status, reason } = await this.effective(trx, ctx, r);
    const d = (r.detected ?? {}) as Partial<StoredDetected>;
    let targetName: string | null = null;
    if (r.target_id) {
      const target =
        r.kind === 'statement'
          ? await trx
              .selectFrom('app.ledger_account')
              .select('name')
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', '=', r.target_id)
              .executeTakeFirst()
          : await trx
              .selectFrom('app.biller')
              .select('name')
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', '=', r.target_id)
              .executeTakeFirst();
      targetName = target?.name ?? null;
    }
    const memory = await readMemory(trx, ctx, r.kind, r.signal);
    return {
      id: r.id,
      kind: r.kind,
      status,
      reason,
      fileName: r.file_name,
      fileType: r.file_type,
      fileIds: r.file_ids,
      detected: {
        last4: d.last4 ?? null,
        issuer: d.issuer ?? null,
        fileNamePattern: d.fileNamePattern ?? null,
        billerName: d.billerName ?? null,
      },
      candidates: d.candidates ?? [],
      targetId: r.target_id,
      targetName,
      automatic: r.automatic,
      learning:
        r.signal && r.target_id
          ? {
              confirmations: memory && memory.target_id === r.target_id ? memory.confirmations : 0,
              needed: LEARN_AFTER,
            }
          : null,
      importBatchId: r.import_batch_id,
      bill: r.kind === 'bill' ? (d.bill ?? null) : null,
      filed: (r.filed as IntakeDto['filed']) ?? null,
      duplicateOf: d.duplicateOf ?? null,
      createdAt: r.created_at.toISOString(),
      resolvedAt: r.resolved_at?.toISOString() ?? null,
    };
  }
}
