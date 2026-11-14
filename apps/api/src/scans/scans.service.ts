/**
 * Scanned documents read before they're filed (ADR-0048 §3). A statement, payslip or bill scanned from the Add wheel
 * is read once (`scan.read`), and the reading suggests where it goes: the account for a statement, the employer and
 * person for a payslip. The person confirms, and the import or payslip is made from the same reading (`scanId`).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { DocumentScanRow, Trx } from '@montra/db';
import type { CreateScanRequest, ScanDto } from '@montra/schemas';
import { Db } from '../db/database.js';
import { notFound, unprocessable } from '../common/errors.js';
import { JobQueue } from '../jobs/queue.js';
import { AiService, aiUnavailableWarning } from '../ai/ai.service.js';

type Ctx = { workspaceId: string; userId: string };

@Injectable()
export class ScansService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  async create(ctx: Ctx, req: CreateScanRequest): Promise<ScanDto> {
    return this.db.run(ctx, async (trx) => {
      const files = await trx
        .selectFrom('app.file')
        .select(['id', 'storage_key', 'file_name', 'mime'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', req.fileIds)
        .where('deleted_at', 'is', null)
        .execute();
      const ordered = req.fileIds.map((id) => files.find((f) => f.id === id));
      if (ordered.some((f) => !f)) throw notFound('Uploaded file');
      if (req.kind === 'statement' && (ordered.length !== 1 || ordered[0]!.mime !== 'application/pdf'))
        throw unprocessable('scan.statement_pdf', 'A scanned statement is one PDF');
      const scan = await trx
        .insertInto('app.document_scan')
        .values({ workspace_id: ctx.workspaceId, user_id: ctx.userId, kind: req.kind, file_ids: req.fileIds })
        .returningAll()
        .executeTakeFirstOrThrow();
      const read = { workspaceId: ctx.workspaceId, scanId: scan.id };
      let jobId: string | null = null;
      if (req.kind === 'statement') {
        // The doc-worker reads the PDF (text layer or OCR) and the statement's facts, its account's last 4 among them.
        const f = ordered[0]!;
        jobId = await this.queue.enqueue(trx, {
          ...ctx,
          queue: 'doc',
          type: 'doc.extract',
          payload: {
            workspaceId: ctx.workspaceId,
            fileId: f.id,
            storageKey: f.storage_key,
            fileName: f.file_name,
            mime: f.mime,
            fileType: 'pdf',
          },
          then: { queue: 'import', type: 'scan.read', payload: read },
        });
      } else {
        const runtime = await this.ai.runtime(trx, ctx, { type: 'scan', id: scan.id });
        if (!runtime.available) {
          await this.fail(trx, ctx, scan.id, aiUnavailableWarning(runtime, 'choose where it goes yourself'));
          return this.dto(await this.row(trx, ctx, scan.id));
        }
        const imagesAllowed =
          (runtime.mode === 'builtin' || runtime.mode === 'byok') && runtime.allowDocumentsToLlm;
        jobId = imagesAllowed
          ? await this.queue.enqueue(trx, { ...ctx, queue: 'ai', type: 'scan.read', payload: read })
          : await this.queue.enqueue(trx, {
              ...ctx,
              queue: 'doc',
              type: 'receipt.ocr',
              payload: { workspaceId: ctx.workspaceId, storageKeys: ordered.map((f) => f!.storage_key) },
              then: { queue: 'ai', type: 'scan.read', payload: read },
            });
      }
      await trx
        .updateTable('app.document_scan')
        .set({ job_id: jobId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', scan.id)
        .execute();
      return this.dto(await this.row(trx, ctx, scan.id));
    });
  }

  async get(ctx: Ctx, id: string): Promise<ScanDto> {
    return this.db.run(ctx, async (trx) => this.dto(await this.row(trx, ctx, id)));
  }

  async row(trx: Trx, ctx: Ctx, id: string): Promise<DocumentScanRow> {
    const row = await trx
      .selectFrom('app.document_scan')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Scan');
    return row;
  }

  async fail(trx: Trx, ctx: Ctx, id: string, error: string): Promise<void> {
    await trx
      .updateTable('app.document_scan')
      .set({ status: 'failed', error, updated_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
  }

  dto(r: DocumentScanRow): ScanDto {
    const d = (r.detected ?? null) as Record<string, unknown> | null;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      fileIds: r.file_ids,
      statement: r.kind === 'statement' && d ? (d as ScanDto['statement']) : null,
      payslip: r.kind === 'payslip' && d ? (d as ScanDto['payslip']) : null,
      error: r.error,
      usedId: r.used_id,
      createdAt: r.created_at.toISOString(),
    };
  }
}
