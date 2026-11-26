/**
 * Receipt jobs (04 §7, ADR-0014): `receipt.extract` reads a receipt with the AI gateway (after the doc-worker's
 * `receipt.ocr` in local mode), stores and categorizes its lines, validates it, then links it to its
 * transaction; `receipt.match` re-matches the inbox (after every import, IMP-11).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  asCurrencyCode,
  calendarDate,
  isCalendarDate,
  isCurrencyCode,
  lineDiscountsTakenTwice,
  parseDecimal,
  pow10,
  type CurrencyCode,
} from '@montra/domain';
import type { ImagePart, ReceiptExtraction } from '@montra/ai-gateway';
import type { ReceiptDto } from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError } from '../common/errors.js';
import { JobQueue, PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { FileBytes } from '../storage/file-bytes.js';
import { AiService } from '../ai/ai.service.js';
import { ReceiptsService, toMinor, type LineInput } from './receipts.service.js';

type Ctx = { workspaceId: string; userId: string };

interface ExtractPayload {
  receiptId: string;
  /** Link to this transaction once read (the receipt was added from the transaction screen). */
  transactionId?: string | null;
  /** The doc-worker's `receipt.ocr` result (local mode). */
  previousResult?: { kind?: string; pages?: string[] };
}

/** Never send more than this to a model in one request (Claude accepts up to 32 MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

@Injectable()
export class ReceiptJobs {
  private readonly logger = new Logger('ReceiptJobs');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(FileBytes) private readonly files: FileBytes,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  register(): void {
    this.worker.register('receipt.extract', (job) => this.extract(job));
    this.worker.register('receipt.match', (job) => this.match(job));
    this.worker.register('ai.local_result.receipt', (job) => this.localResult(job));
  }

  /**
   * Local mode on the hosted service (06 §2, backlog item 2): a client on the user's network answered the reading of
   * a receipt that waits in review for it. Read it again from the same text, which now uses that answer. A receipt
   * someone has since typed lines into, or moved on, is left alone.
   */
  async localResult(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const receiptId = (job.payload as { subjectId?: string }).subjectId;
    if (!receiptId) throw new PermanentJobError('job.invalid', 'No receipt');
    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const r = await trx
        .selectFrom('app.receipt')
        .select(['id', 'status', 'extraction', 'ocr_text'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', receiptId)
        .executeTakeFirst();
      const warnings = ((r?.extraction as { warnings?: unknown } | null)?.warnings ?? []) as unknown[];
      const waiting =
        r?.status === 'needs_review' && warnings.some((w) => String(w).includes('(pending_local)'));
      if (!r || !waiting) return { skipped: r?.status ?? 'gone' };
      const lines = await trx
        .selectFrom('app.receipt_line')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('receipt_id', '=', r.id)
        .executeTakeFirst();
      if (lines) return { skipped: 'has_lines' };
      await this.receipts.setStatus(trx, ctx, r.id, 'processing');
      await this.queue.enqueue(trx, {
        ...ctx,
        queue: 'ai',
        type: 'receipt.extract',
        payload: {
          receiptId: r.id,
          ...(r.ocr_text ? { previousResult: { kind: 'receipt_text', pages: [r.ocr_text] } } : {}),
        },
      });
      return { reread: r.id };
    });
  }

  private ctxOf(job: Job): Ctx {
    if (!job.workspace_id || !job.created_by)
      throw new PermanentJobError('job.invalid', 'Job without workspace or user');
    return { workspaceId: job.workspace_id, userId: job.created_by };
  }

  async extract(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const p = job.payload as unknown as ExtractPayload;
    // Read the files outside the database transaction; storage may be slow.
    const files = await this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const r = await this.receipts.row(trx, ctx, p.receiptId);
      return trx
        .selectFrom('app.file')
        .select(['id', 'storage_key', 'sha256', 'mime', 'bytes'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where(
          'id',
          'in',
          r.attachment_ids.length ? r.attachment_ids : ['00000000-0000-0000-0000-000000000000'],
        )
        .execute()
        .then((rows) => r.attachment_ids.map((id) => rows.find((f) => f.id === id)!).filter(Boolean));
    });
    const ocrText =
      p.previousResult?.kind === 'receipt_text' ? (p.previousResult.pages ?? []).join('\n\n') : null;
    // Images go to the provider only with the workspace's permission (UP-06, ADR-0014 §7).
    const allowImages = await this.db.run(
      ctx,
      async (trx) => (await this.ai.runtime(trx, ctx)).allowReceiptImages,
    );
    const images: ImagePart[] = [];
    let total = 0;
    for (const f of allowImages ? files : []) {
      total += Number(f.bytes);
      if (total > MAX_IMAGE_BYTES) break;
      images.push({
        mediaType: f.mime as ImagePart['mediaType'],
        data: Buffer.from(await this.files.forJob(ctx, f)).toString('base64'),
      });
    }

    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const r = await this.receipts.row(trx, ctx, p.receiptId);
      if (r.status !== 'processing') return { skipped: r.status };
      const runtime = await this.ai.runtime(trx, ctx, { type: 'receipt', id: r.id });
      const ws = await trx
        .selectFrom('app.workspace')
        .select(['base_currency'])
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const trip = r.trip_id
        ? await trx.selectFrom('app.trip').select('currency').where('id', '=', r.trip_id).executeTakeFirst()
        : undefined;
      const hint = trip?.currency ?? ws.base_currency;
      const user = await trx
        .selectFrom('app.app_user')
        .select('locale')
        .where('id', '=', ctx.userId)
        .executeTakeFirst();
      const res = await this.ai.gateway.extractReceipt(
        { images, ocrText, currencyHint: hint, locale: user?.locale ?? 'en-US' },
        runtime.ctx,
      );
      const meta = (warnings: string[], confidence: number | null): ReceiptDto['extraction'] => ({
        mode: runtime.mode,
        model: res.meta?.model ?? null,
        confidence,
        warnings,
      });
      if (!res.ok) {
        // Degrade (AIA-04): the receipt waits in review for the user to type the lines.
        await trx
          .updateTable('app.receipt')
          .set({
            status: 'needs_review',
            ocr_text: ocrText,
            extraction: JSON.stringify(meta([`Could not read the receipt (${res.reason})`], null)),
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', r.id)
          .execute();
        return { ok: false, reason: res.reason };
      }
      const x = res.value;
      const currency = (x.currency && isCurrencyCode(x.currency) ? x.currency : hint) as CurrencyCode;
      const { header, lines, warnings } = fromExtraction(x, asCurrencyCode(currency));
      const stored = await this.receipts.store(
        trx,
        ctx,
        r.id,
        { ...header, ocrText, extraction: meta(warnings, x.confidence) },
        lines,
      );
      // Added from a transaction: link to it; otherwise look for the transaction (IMP-11).
      if (p.transactionId && stored.status === 'inbox') {
        try {
          await this.receipts.applyInTrx(trx, ctx, stored, p.transactionId, null);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          await this.receipts.setStatus(trx, ctx, r.id, 'needs_review');
        }
      } else if (!p.transactionId) {
        await this.receipts.matchInTrx(trx, ctx, [r.id]);
      }
      const after = await this.receipts.row(trx, ctx, r.id);
      return { ok: true, status: after.status, lines: lines.length, transactionId: after.transaction_id };
    });
  }

  async match(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const ids = (job.payload as { receiptIds?: string[] }).receiptIds;
    const linked = await this.db.run({ ...ctx, actorType: 'worker' }, (trx) =>
      this.receipts.matchInTrx(trx, ctx, ids),
    );
    if (linked) this.logger.log(`linked ${linked} receipt(s) in ${ctx.workspaceId}`);
    return { linked };
  }
}

/** Extraction (decimal strings) → stored header and lines (minor units); bad amounts become warnings. */
export function fromExtraction(
  x: ReceiptExtraction,
  currency: CurrencyCode,
): {
  header: {
    merchant: string | null;
    receiptDate: ReturnType<typeof calendarDate> | null;
    localTime: string | null;
    currency: CurrencyCode;
    subtotalMinor: bigint | null;
    taxMinor: bigint;
    taxIncluded: boolean;
    discountMinor: bigint;
    feesMinor: bigint;
    tipMinor: bigint;
    totalMinor: bigint | null;
    cardLast4: string | null;
    store: { address: string | null; phone: string | null; website: string | null };
  };
  lines: LineInput[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines: LineInput[] = [];
  for (const l of x.lines) {
    const total = toMinor(l.lineTotal, currency);
    if (total === null) {
      warnings.push(`Skipped "${l.rawText}": unreadable amount ${l.lineTotal}`);
      continue;
    }
    lines.push({
      rawText: l.rawText,
      expandedName: l.expandedName,
      qty: l.qty && /^\d{1,9}(\.\d{1,3})?$/.test(l.qty) ? l.qty : null,
      unitPriceMinor: toMinor(l.unitPrice, currency),
      lineTotalMinor: total,
      discountMinor: toMinor(l.discount, currency) ?? 0n,
      taxable: l.taxable ?? true,
      categoryId: null,
      entityId: null,
      memberId: null,
      confidence: null,
      categorization: null,
      memberReason: null,
      decideMember: true,
    });
  }
  const header = {
    merchant: x.merchant,
    receiptDate: x.date && isCalendarDate(x.date) ? calendarDate(x.date) : null,
    localTime: x.localTime,
    currency,
    subtotalMinor: toMinor(x.subtotal, currency),
    taxMinor: toMinor(x.tax, currency) ?? 0n,
    taxIncluded: x.taxIncluded === true,
    discountMinor: toMinor(x.discount, currency) ?? 0n,
    feesMinor: toMinor(x.fees, currency) ?? 0n,
    tipMinor: toMinor(x.tip, currency) ?? 0n,
    totalMinor: toMinor(x.total, currency),
    cardLast4: x.cardLast4,
    store: { address: x.storeAddress, phone: x.storePhone, website: x.storeWebsite },
  };
  const savingsTakenTwice = lineDiscountsTakenTwice(
    lines.map((l) => ({ lineTotal: l.lineTotalMinor, discount: l.discountMinor })),
    {
      tax: header.taxMinor,
      taxIncluded: header.taxIncluded,
      discount: header.discountMinor,
      fees: header.feesMinor,
      tip: header.tipMinor,
      total: header.totalMinor,
    },
  );
  return {
    header,
    lines: savingsTakenTwice ? lines.map(priceBeforeSavings) : lines,
    warnings,
  };
}

/**
 * A line read at the price paid after its savings, with the savings as its discount too (`lineDiscountsTakenTwice`):
 * store the price before the savings, so price − savings = paid. A unit price that was the paid price goes too
 * (`lineQuantity` fills it in again from the new amount where that is exact); a printed regular unit price stays.
 */
function priceBeforeSavings(l: LineInput): LineInput {
  if (l.discountMinor <= 0n) return l;
  const paid = l.lineTotalMinor;
  const unitWasPaid = l.unitPriceMinor !== null && timesQty(l.unitPriceMinor, l.qty) === paid;
  return {
    ...l,
    lineTotalMinor: paid + l.discountMinor,
    unitPriceMinor: unitWasPaid ? null : l.unitPriceMinor,
  };
}

/** unit × qty in minor units when exact (a missing quantity is 1), else null. */
function timesQty(unit: bigint, qty: string | null): bigint | null {
  if (qty === null) return unit;
  const d = parseDecimal(qty);
  const scaled = unit * d.coefficient;
  const div = pow10(d.scale);
  return scaled % div === 0n ? scaled / div : null;
}
