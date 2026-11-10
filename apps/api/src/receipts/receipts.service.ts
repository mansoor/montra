/**
 * Receipts (RCP-01..12, IMP-11, CUR-04, TZ-03; design 04 §7, ADR-0014): upload, the receipt inbox, review,
 * item categorization and learning, matching to transactions and applying the receipt's splits.
 * Extraction runs as jobs (`receipt-jobs.ts`); the arithmetic lives in `@montra/domain` and the matching
 * score in `@montra/importers`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type ReceiptLineRow, type ReceiptRow, type Trx } from '@montra/db';
import {
  abs,
  addDays,
  asCurrencyCode,
  calendarDate,
  convertGroupsAtCharge,
  decimalToString,
  fitToCharged,
  groupReceipt,
  impliedRate,
  isCurrencyCode,
  minorUnits,
  parseMoney,
  receiptHabit,
  todayIn,
  validateReceipt,
  type CalendarDate,
  type CurrencyCode,
  type ReceiptLineAmounts,
} from '@montra/domain';
import {
  matchReceipts,
  normalizeDescription,
  TIP_MCCS,
  type ReceiptForMatch,
  type TransactionForMatch,
} from '@montra/importers';
import { applyRules, compileRules, validateRule, type CompiledRule } from '@montra/categorize';
import type {
  ApplyReceiptRequest,
  CreateReceiptRequest,
  MatchCandidateDto,
  OrderImportResultDto,
  ReceiptDto,
  ReceiptFileDto,
  ReceiptGroupDto,
  ReceiptLineDto,
  ReceiptListQuery,
  ReceiptPageDto,
  ReceiptHabitDto,
  ReceiptRecommendationDto,
  ReceiptStalledDto,
  UpdateReceiptRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { JOB_STALL_MS, JobQueue } from '../jobs/queue.js';
import { STORAGE_PORT, sha256, storageKey, type StoragePort } from '../storage/storage.js';
import { AiService, aiUnavailableWarning } from '../ai/ai.service.js';
import {
  Categorizer,
  ruleRecord,
  toDto,
  type StoredCategorization,
} from '../categorization/categorizer.service.js';
import { MerchantDirectory } from '../categorization/merchants.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { FxRatesService } from '../fx/fx.service.js';
import { TransactionPoster, ownerOf, type TransactionSpec } from '../transactions/poster.js';
import { tripOn } from '../trips/trips.js';
import { parseOrderHistory, OrderHistoryError } from './order-history.js';

type Ctx = { workspaceId: string; userId: string };

/** Retention for receipt images and data (RCP-10). */
export const RETENTION_YEARS = 7;
/** IMP-11: a candidate scoring at least this links automatically (when unambiguous). */
const MATCH_WINDOW_DAYS = 5;
/** RCP-11: multi-department stores where a receipt is worth keeping above the threshold. */
const MULTI_DEPARTMENT = ['walmart', 'target', 'costco', 'amazon'];
const RECOMMEND_THRESHOLD_MAJOR = 50n;
/** The business profile's own default (migration 0018), for a business without a profile yet. */
const DEDUCTIBLE_DEFAULT_MINOR = 7500;
/** Category kinds that don't come with a receipt: never reminded about. */
const NO_RECEIPT_KINDS: ReadonlySet<string> = new Set(['fixed', 'debt', 'savings', 'system', 'income']);

export type ReceiptMediaType = ReceiptFileDto['mediaType'];

/** Sniffs a receipt file; names and declared types are never trusted. */
export function detectReceiptMedia(bytes: Uint8Array): ReceiptMediaType | null {
  const b = Buffer.from(bytes.subarray(0, 1024));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.includes(Buffer.from('%PDF-'))) return 'application/pdf';
  return null;
}

/** Normalized printed text of an item, the key for item history (RCP-03/06). */
export const itemKeyOf = (rawText: string): string =>
  rawText
    .toUpperCase()
    .replace(/[^A-Z0-9%&]+/g, ' ')
    .trim()
    .slice(0, 200);

/** Decimal string → minor units in `currency`, or null when it doesn't fit (too many decimals, junk). */
export function toMinor(value: string | null | undefined, currency: CurrencyCode): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return parseMoney(value, currency).amount;
  } catch {
    return null;
  }
}

/** One extracted or edited line, ready to store. */
export interface LineInput {
  id?: string;
  rawText: string;
  expandedName: string | null;
  qty: string | null;
  unitPriceMinor: bigint | null;
  lineTotalMinor: bigint;
  discountMinor: bigint;
  taxable: boolean;
  categoryId: string | null;
  entityId: string | null;
  memberId: string | null;
  confidence: number | null;
  categorization: StoredCategorization | null;
}

@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(Categorizer) private readonly categorizer: Categorizer,
    @Inject(MerchantDirectory) private readonly merchants: MerchantDirectory,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(FxRatesService) private readonly fx: FxRatesService,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
  ) {}

  // ----- Files and creation -------------------------------------------------------------------------------

  async uploadFile(ctx: Ctx, bytes: Uint8Array, fileName: string): Promise<ReceiptFileDto> {
    const mediaType = detectReceiptMedia(bytes);
    if (!mediaType) {
      throw new AppError(
        415,
        'receipt.unsupported_type',
        'Upload a JPEG, PNG or WebP photo, or a PDF invoice',
      );
    }
    const id = newId();
    const digest = sha256(bytes);
    const key = storageKey(ctx.workspaceId, 'receipt', id);
    await this.storage.put(key, bytes, mediaType);
    return this.db.run(ctx, async (trx) => {
      const earlier = await trx
        .selectFrom('app.file as f')
        .select(['f.id'])
        .where('f.workspace_id', '=', ctx.workspaceId)
        .where('f.kind', '=', 'receipt')
        .where('f.sha256', '=', digest)
        .where('f.deleted_at', 'is', null)
        .orderBy('f.created_at')
        .executeTakeFirst();
      const usedBy = earlier
        ? await trx
            .selectFrom('app.receipt')
            .select('id')
            .where('workspace_id', '=', ctx.workspaceId)
            .where(sql<boolean>`${earlier.id}::uuid = any(attachment_ids)`)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        : undefined;
      await trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          kind: 'receipt',
          storage_key: key,
          file_name: fileName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'receipt',
          mime: mediaType,
          bytes: bytes.length,
          sha256: digest,
          uploaded_by: ctx.userId,
          retain_until: sql<string>`(current_date + make_interval(years => ${RETENTION_YEARS}))::date`,
        })
        .execute();
      return {
        fileId: id,
        mediaType,
        bytes: bytes.length,
        sha256: digest,
        duplicateOf: earlier ? { fileId: earlier.id, receiptId: usedBy?.id ?? null } : null,
      };
    });
  }

  async create(ctx: Ctx, req: CreateReceiptRequest): Promise<ReceiptDto> {
    const id = req.id ?? newId();
    await this.db.run(ctx, async (trx) => {
      if (req.id) {
        const existing = await trx
          .selectFrom('app.receipt')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', req.id)
          .executeTakeFirst();
        if (existing) return; // TXN-09: an offline capture replayed
      }
      const files = await trx
        .selectFrom('app.file')
        .select(['id', 'kind'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', req.fileIds)
        .where('deleted_at', 'is', null)
        .execute();
      if (files.length !== new Set(req.fileIds).size || files.some((f) => f.kind !== 'receipt')) {
        throw unprocessable(
          'receipt.files_not_found',
          'Upload the receipt files first (POST /receipts/files)',
        );
      }
      const entityId = await this.entityFor(trx, ctx, req.entityId, req.transactionId);
      await trx
        .insertInto('app.receipt')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: entityId,
          source: req.source,
          attachment_ids: req.fileIds,
          status: 'processing',
          trip_id: await tripOn(trx, ctx.workspaceId, await this.today(trx, ctx)),
          created_by: ctx.userId,
          ...(req.transactionId
            ? { match_candidates: JSON.stringify([{ transactionId: req.transactionId }]) }
            : {}),
        })
        .execute();
      await this.startExtraction(trx, ctx, id, req.transactionId ?? null);
    });
    return this.get(ctx, id);
  }

  /**
   * Builtin/BYOK read the images when the workspace allows receipt images to go to the provider; otherwise
   * (and always in local mode) the doc-worker OCRs them first and only redacted text is sent. Off goes to
   * review.
   */
  private async startExtraction(trx: Trx, ctx: Ctx, receiptId: string, transactionId: string | null) {
    const runtime = await this.ai.runtime(trx, ctx, { type: 'receipt', id: receiptId });
    const extract = { workspaceId: ctx.workspaceId, receiptId, transactionId };
    if (!runtime.available) {
      await this.setStatus(trx, ctx, receiptId, 'needs_review', {
        mode: runtime.mode,
        model: null,
        confidence: null,
        warnings: [aiUnavailableWarning(runtime, 'enter the lines yourself')],
      });
      return;
    }
    if (!runtime.allowReceiptImages) {
      const keys = await this.storageKeys(trx, ctx, receiptId);
      await this.queue.enqueue(trx, {
        ...ctx,
        queue: 'doc',
        type: 'receipt.ocr',
        payload: { workspaceId: ctx.workspaceId, receiptId, storageKeys: keys },
        then: { queue: 'ai', type: 'receipt.extract', payload: extract },
      });
      return;
    }
    await this.queue.enqueue(trx, { ...ctx, queue: 'ai', type: 'receipt.extract', payload: extract });
  }

  async storageKeys(trx: Trx, ctx: Ctx, receiptId: string): Promise<string[]> {
    const r = await this.row(trx, ctx, receiptId);
    const files = await trx
      .selectFrom('app.file')
      .select(['id', 'storage_key'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where(
        'id',
        'in',
        r.attachment_ids.length ? r.attachment_ids : ['00000000-0000-0000-0000-000000000000'],
      )
      .execute();
    const byId = new Map(files.map((f) => [f.id, f.storage_key]));
    return r.attachment_ids.map((id) => byId.get(id)).filter((k): k is string => Boolean(k));
  }

  /** File bytes for the review screen (RCP-06), only for files attached to the receipt. */
  async file(ctx: Ctx, receiptId: string, fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const f = await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, receiptId);
      if (!r.attachment_ids.includes(fileId)) throw notFound('File');
      return trx
        .selectFrom('app.file')
        .select(['storage_key', 'mime'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirstOrThrow();
    });
    return { bytes: await this.storage.get(f.storage_key), mime: f.mime };
  }

  // ----- Reading ------------------------------------------------------------------------------------------

  async get(ctx: Ctx, id: string): Promise<ReceiptDto> {
    return this.db.run(ctx, async (trx) => this.dto(trx, ctx, await this.row(trx, ctx, id)));
  }

  async list(ctx: Ctx, q: ReceiptListQuery): Promise<ReceiptPageDto> {
    return this.db.run(ctx, async (trx) => {
      let query = trx
        .selectFrom('app.receipt')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('deleted_at', 'is', null);
      if (q.status) query = query.where('status', '=', q.status);
      // RCP-10: full-text over merchant and OCR text, or a merchant prefix.
      if (q.q) {
        const term = q.q;
        query = query.where((eb) =>
          eb.or([
            sql<boolean>`search @@ websearch_to_tsquery('simple', ${term})`,
            eb('merchant', 'ilike', `%${term.replace(/[%_\\]/g, '\\$&')}%`),
          ]),
        );
      }
      if (q.from) query = query.where('receipt_date', '>=', q.from);
      if (q.to) query = query.where('receipt_date', '<=', q.to);
      if (q.cursor) {
        const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
        if (at && id) {
          query = query.where((eb) =>
            eb.or([
              eb('created_at', '<', new Date(at)),
              eb.and([eb('created_at', '=', new Date(at)), eb('id', '<', id)]),
            ]),
          );
        }
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.limit + 1)
        .execute();
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: await Promise.all(page.map((r) => this.dto(trx, ctx, r))),
        nextCursor:
          rows.length > q.limit && last
            ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
            : null,
      };
    });
  }

  async row(trx: Trx, ctx: Ctx, id: string): Promise<ReceiptRow> {
    const r = await trx
      .selectFrom('app.receipt')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) throw notFound('Receipt');
    return r;
  }

  async lines(trx: Trx, ctx: Ctx, receiptId: string): Promise<ReceiptLineRow[]> {
    return trx
      .selectFrom('app.receipt_line')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('receipt_id', '=', receiptId)
      .orderBy('line_no')
      .execute();
  }

  /**
   * Whether anything is reading a `processing` receipt: its latest job (the doc-worker's `receipt.ocr`, then
   * `receipt.extract`) has waited in the queue past JOB_STALL_MS, or failed. Without this, a receipt whose
   * worker isn't running just says "Reading" forever.
   */
  private async stalled(trx: Trx, ctx: Ctx, receiptId: string): Promise<ReceiptStalledDto | null> {
    const job = await trx
      .selectFrom('app.job')
      .select(['queue', 'status', 'run_after', 'updated_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', 'in', ['receipt.ocr', 'receipt.extract'])
      .where(sql<string>`payload->>'receiptId'`, '=', receiptId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!job) return null;
    const worker = job.queue === 'doc' ? 'documents' : 'jobs';
    if (job.status === 'failed') return { worker, reason: 'failed', since: job.updated_at.toISOString() };
    if (job.status === 'queued' && Date.now() - job.run_after.getTime() > JOB_STALL_MS)
      return { worker, reason: 'waiting', since: job.run_after.toISOString() };
    return null;
  }

  async dto(trx: Trx, ctx: Ctx, r: ReceiptRow): Promise<ReceiptDto> {
    const lines = await this.lines(trx, ctx, r.id);
    const groups = r.currency ? groupsOf(r, lines) : [];
    const extraction = r.extraction as ReceiptDto['extraction'] | null;
    return {
      id: r.id,
      entityId: r.entity_id,
      status: r.status,
      source: r.source,
      fileIds: r.attachment_ids,
      merchant: r.merchant,
      receiptDate: r.receipt_date,
      localTime: r.local_time ? r.local_time.slice(0, 5) : null,
      currency: r.currency,
      subtotal: r.subtotal_minor?.toString() ?? null,
      tax: r.tax_minor.toString(),
      taxIncluded: r.tax_included,
      discount: r.discount_minor.toString(),
      fees: r.fees_minor.toString(),
      tip: r.tip_minor.toString(),
      total: r.total_minor?.toString() ?? null,
      cardLast4: r.card_last4,
      validationGap: r.validation_gap_minor?.toString() ?? null,
      lines: lines.map(lineDto),
      groups,
      transactionId: r.transaction_id,
      matchScore: r.match_score === null ? null : Number(r.match_score),
      candidates: ((r.match_candidates as MatchCandidateDto[] | null) ?? []).filter((c) => 'score' in c),
      fxRate: r.fx_rate ? trimRate(r.fx_rate) : null,
      tripId: r.trip_id,
      orderRef: r.order_ref,
      extraction: extraction ?? null,
      stalled: r.status === 'processing' ? await this.stalled(trx, ctx, r.id) : null,
      retainUntil: r.retain_until,
      createdAt: r.created_at.toISOString(),
      version: r.version.toString(),
    };
  }

  // ----- Storing extracted or edited content -------------------------------------------------------------

  /**
   * Writes the header and lines, categorizes lines that have no category yet (RCP-03), validates (RCP-05)
   * and sets the status: `inbox` when the receipt adds up, `needs_review` with the gap otherwise.
   */
  async store(
    trx: Trx,
    ctx: Ctx,
    receiptId: string,
    header: {
      merchant: string | null;
      receiptDate: CalendarDate | null;
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
      ocrText: string | null;
      extraction: ReceiptDto['extraction'];
    },
    lines: LineInput[],
  ): Promise<ReceiptRow> {
    const r = await this.row(trx, ctx, receiptId);
    const categorized = await this.categorizeLines(trx, ctx, r.entity_id, header, lines);
    const validation = validateReceipt(categorized.map(amountsOf), {
      tax: header.taxMinor,
      taxIncluded: header.taxIncluded,
      discount: header.discountMinor,
      fees: header.feesMinor,
      tip: header.tipMinor,
      total: header.totalMinor,
    });
    await trx
      .updateTable('app.receipt')
      .set({
        merchant: header.merchant,
        merchant_raw: r.merchant_raw ?? header.merchant,
        receipt_date: header.receiptDate,
        local_time: header.localTime,
        currency: header.currency,
        subtotal_minor: header.subtotalMinor,
        tax_minor: header.taxMinor,
        tax_included: header.taxIncluded,
        discount_minor: header.discountMinor,
        fees_minor: header.feesMinor,
        tip_minor: header.tipMinor,
        total_minor: header.totalMinor,
        card_last4: header.cardLast4,
        validation_gap_minor: validation.gap,
        ocr_text: header.ocrText ?? searchText(header.merchant, categorized),
        extraction: header.extraction
          ? JSON.stringify(header.extraction)
          : r.extraction
            ? JSON.stringify(r.extraction)
            : null,
        status: r.status === 'matched' ? 'matched' : validation.ok ? 'inbox' : 'needs_review',
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', receiptId)
      .execute();
    await this.replaceLines(trx, ctx, receiptId, categorized);
    return this.row(trx, ctx, receiptId);
  }

  private async replaceLines(trx: Trx, ctx: Ctx, receiptId: string, lines: LineInput[]): Promise<void> {
    await trx
      .deleteFrom('app.receipt_line')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('receipt_id', '=', receiptId)
      .execute();
    if (lines.length === 0) return;
    await trx
      .insertInto('app.receipt_line')
      .values(
        lines.map((l, i) => ({
          workspace_id: ctx.workspaceId,
          id: l.id ?? newId(),
          receipt_id: receiptId,
          line_no: i + 1,
          raw_text: l.rawText.slice(0, 500),
          expanded_name: l.expandedName,
          qty: l.qty,
          unit_price_minor: l.unitPriceMinor,
          line_total_minor: l.lineTotalMinor,
          discount_minor: l.discountMinor,
          taxable: l.taxable,
          is_return: l.lineTotalMinor < 0n,
          category_id: l.categoryId,
          entity_id: l.entityId,
          member_id: l.memberId,
          confidence: l.confidence === null ? null : l.confidence.toFixed(3),
          categorization: l.categorization ? JSON.stringify(l.categorization) : null,
          item_key: itemKeyOf(l.rawText) || null,
        })),
      )
      .execute();
  }

  async setStatus(
    trx: Trx,
    ctx: Ctx,
    receiptId: string,
    status: ReceiptRow['status'],
    extraction?: ReceiptDto['extraction'],
  ): Promise<void> {
    await trx
      .updateTable('app.receipt')
      .set({ status, ...(extraction ? { extraction: JSON.stringify(extraction) } : {}) })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', receiptId)
      .execute();
  }

  // ----- Line categorization (RCP-03, RCP-06, RCP-07) ----------------------------------------------------

  /**
   * Lines the user hasn't categorized go through item rules (scope `receipt_line`), then item history
   * (lines with the same printed text that the user or a rule categorized), then AI over the item names —
   * never the store: a receipt is categorized by what was bought (§3.5). Below the threshold a line keeps
   * the AI suggestion for review and stays uncategorized.
   */
  async categorizeLines(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    header: { merchant: string | null; receiptDate: CalendarDate | null; currency: CurrencyCode },
    lines: LineInput[],
  ): Promise<LineInput[]> {
    const open = lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.categoryId);
    if (open.length === 0) return lines;
    const out = [...lines];
    const prepared = await this.categorizer.prepare(trx, ctx);
    const ruleRows = await trx
      .selectFrom('app.rule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('enabled', '=', true)
      .where('scope', '=', 'receipt_line')
      .execute();
    const { rules } = compileRules(ruleRows.map(ruleRecord));
    const date = header.receiptDate ?? (await this.today(trx, ctx));
    const exponent = minorUnits(header.currency);
    const entityOf = (categoryId: string) => prepared.categoryById.get(categoryId)?.entityId ?? entityId;
    const history = await this.itemHistory(
      trx,
      ctx,
      open.map(({ l }) => itemKeyOf(l.rawText)),
    );
    const forAi: Array<{ i: number; l: LineInput }> = [];
    for (const { l, i } of open) {
      const byRule = this.byItemRule(rules, l, header.merchant, date, entityId, exponent);
      if (byRule) {
        out[i] = { ...l, ...byRule, entityId: byRule.entityId ?? entityOf(byRule.categoryId) };
        continue;
      }
      const past = history.get(itemKeyOf(l.rawText));
      if (past) {
        out[i] = {
          ...l,
          categoryId: past.categoryId,
          entityId: past.entityId ?? entityOf(past.categoryId),
          memberId: l.memberId ?? past.memberId,
          confidence: 0.9,
          categorization: {
            step: 'history',
            confidence: 0.9,
            explanation: 'Same item as on an earlier receipt',
            ruleId: null,
            suggested: null,
          },
        };
        continue;
      }
      forAi.push({ i, l });
    }
    if (forAi.length > 0) {
      const runtime = await this.ai.runtime(trx, ctx);
      if (runtime.available) {
        const entity = prepared.categories.find((c) => c.entityId === entityId)?.entityType ?? 'personal';
        const res = await this.ai.gateway.categorize(
          forAi.map(({ i, l }) => ({
            id: String(i),
            payee: null,
            description: l.expandedName ?? l.rawText,
            amountMinor: -l.lineTotalMinor,
            currency: header.currency,
            date,
            accountType: 'receipt_item',
            entityType: entity,
          })),
          { categories: prepared.categories, members: prepared.members },
          runtime.ctx,
        );
        if (res.ok) {
          for (const o of res.value) {
            const i = Number(o.id);
            const l = out[i]!;
            if (!o.categoryId) continue;
            const apply = o.confidence >= runtime.threshold;
            out[i] = {
              ...l,
              ...(apply ? { categoryId: o.categoryId, entityId: entityOf(o.categoryId) } : {}),
              memberId: l.memberId ?? (apply ? o.memberId : null),
              confidence: o.confidence,
              categorization: {
                step: 'ai',
                confidence: o.confidence,
                explanation: o.explanation,
                ruleId: null,
                suggested: apply
                  ? null
                  : { categoryId: o.categoryId, entityId: entityOf(o.categoryId), memberId: o.memberId },
              },
            };
          }
        }
      }
    }
    return out;
  }

  private byItemRule(
    rules: readonly CompiledRule[],
    l: LineInput,
    merchant: string | null,
    date: CalendarDate,
    entityId: string,
    exponent: number,
  ):
    | (Pick<LineInput, 'categoryId' | 'entityId' | 'memberId' | 'confidence' | 'categorization'> & {
        categoryId: string;
      })
    | null {
    const result = applyRules(rules, {
      payee: merchant,
      payeeKey: merchant ? normalizeDescription(merchant) : null,
      description: l.expandedName ?? l.rawText,
      rawDescription: l.rawText,
      amountMinor: -l.lineTotalMinor,
      exponent,
      accountId: '',
      entityId,
      date,
      itemText: `${l.rawText} ${l.expandedName ?? ''}`.trim(),
    });
    if (!result.actions.categoryId) return null;
    return {
      categoryId: result.actions.categoryId,
      entityId: result.actions.entityId ?? null,
      memberId: l.memberId ?? result.actions.memberId ?? null,
      confidence: 1,
      categorization: {
        step: 'rule',
        confidence: 1,
        explanation: `Matched item rule '${result.ruleName ?? ''}'`,
        ruleId: result.ruleId,
        suggested: null,
      },
    };
  }

  /** The latest user- or rule-chosen category per item key (RCP-06 learning). */
  private async itemHistory(
    trx: Trx,
    ctx: Ctx,
    keys: string[],
  ): Promise<Map<string, { categoryId: string; entityId: string | null; memberId: string | null }>> {
    const unique = [...new Set(keys.filter(Boolean))];
    const out = new Map<string, { categoryId: string; entityId: string | null; memberId: string | null }>();
    if (unique.length === 0) return out;
    const rows = await trx
      .selectFrom('app.receipt_line')
      .select(['item_key', 'category_id', 'entity_id', 'member_id', 'updated_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('item_key', 'in', unique)
      .where('category_id', 'is not', null)
      .where(sql<boolean>`categorization->>'step' in ('user', 'rule')`)
      .orderBy('updated_at', 'desc')
      .execute();
    for (const r of rows) {
      if (r.item_key && r.category_id && !out.has(r.item_key)) {
        out.set(r.item_key, { categoryId: r.category_id, entityId: r.entity_id, memberId: r.member_id });
      }
    }
    return out;
  }

  // ----- Review edits (RCP-06) ----------------------------------------------------------------------------

  async update(ctx: Ctx, id: string, req: UpdateReceiptRequest): Promise<ReceiptDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.version.toString() !== req.version) {
        throw new AppError(409, 'version_mismatch', 'The receipt changed since you opened it; reload it');
      }
      if (r.status === 'processing')
        throw unprocessable('receipt.processing', 'The receipt is still being read');
      const currencyCode = (req.currency ?? r.currency)?.toUpperCase() ?? null;
      if (!currencyCode || !isCurrencyCode(currencyCode)) {
        throw unprocessable('receipt.currency_required', 'Set the receipt currency');
      }
      const currency = currencyCode as CurrencyCode;
      const before = await this.lines(trx, ctx, id);
      const lines: LineInput[] = req.lines
        ? req.lines.map((l) => {
            const prev = l.id ? before.find((b) => b.id === l.id) : undefined;
            const categoryId = l.categoryId === undefined ? (prev?.category_id ?? null) : l.categoryId;
            const userChose = l.categoryId !== undefined && l.categoryId !== (prev?.category_id ?? null);
            return {
              ...(prev ? { id: prev.id } : {}),
              rawText: l.rawText,
              expandedName: l.expandedName === undefined ? (prev?.expanded_name ?? null) : l.expandedName,
              qty: l.qty === undefined ? (prev?.qty ?? null) : l.qty,
              unitPriceMinor:
                l.unitPrice === undefined
                  ? (prev?.unit_price_minor ?? null)
                  : l.unitPrice === null
                    ? null
                    : BigInt(l.unitPrice),
              lineTotalMinor: BigInt(l.lineTotal),
              discountMinor: BigInt(l.discount),
              taxable: l.taxable,
              categoryId,
              entityId: l.entityId === undefined ? (prev?.entity_id ?? null) : l.entityId,
              memberId: l.memberId === undefined ? (prev?.member_id ?? null) : l.memberId,
              confidence:
                userChose || !prev
                  ? categoryId
                    ? 1
                    : null
                  : prev.confidence === null
                    ? null
                    : Number(prev.confidence),
              categorization:
                userChose && categoryId
                  ? {
                      step: 'user',
                      confidence: 1,
                      explanation: 'Chosen by you',
                      ruleId: null,
                      suggested: null,
                    }
                  : ((prev?.categorization as StoredCategorization | null) ?? null),
            } satisfies LineInput;
          })
        : before.map(fromRow);
      if (req.lines) {
        await this.learnFromCorrections(trx, ctx, before, lines);
      }
      const updated = await this.store(
        trx,
        ctx,
        id,
        {
          merchant: req.merchant === undefined ? r.merchant : req.merchant,
          receiptDate:
            req.receiptDate === undefined
              ? r.receipt_date
                ? calendarDate(r.receipt_date)
                : null
              : req.receiptDate,
          localTime: req.localTime === undefined ? r.local_time : req.localTime,
          currency,
          subtotalMinor: r.subtotal_minor,
          taxMinor: req.tax === undefined ? r.tax_minor : BigInt(req.tax),
          taxIncluded: req.taxIncluded ?? r.tax_included,
          discountMinor: req.discount === undefined ? r.discount_minor : BigInt(req.discount),
          feesMinor: req.fees === undefined ? r.fees_minor : BigInt(req.fees),
          tipMinor: req.tip === undefined ? r.tip_minor : BigInt(req.tip),
          totalMinor: req.total === undefined ? r.total_minor : req.total === null ? null : BigInt(req.total),
          cardLast4: r.card_last4,
          ocrText: r.ocr_text,
          extraction: null,
        },
        lines,
      );
      await trx
        .updateTable('app.receipt')
        .set({ reviewed_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      // A linked receipt keeps its transaction in step with the reviewed lines.
      if (updated.status === 'matched' && updated.transaction_id) {
        await this.applyInTrx(trx, ctx, await this.row(trx, ctx, id), updated.transaction_id, null);
      }
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  /**
   * RCP-06: a category the user picks for a line becomes an item rule (scope `receipt_line`) on the printed
   * text, so the same item is categorized the same way next time. Rules are visible and editable (AIA-06).
   */
  private async learnFromCorrections(
    trx: Trx,
    ctx: Ctx,
    before: ReceiptLineRow[],
    after: LineInput[],
  ): Promise<void> {
    for (const l of after) {
      if (l.categorization?.step !== 'user' || !l.categoryId) continue;
      const prev = l.id ? before.find((b) => b.id === l.id) : undefined;
      if (prev && prev.category_id === l.categoryId) continue;
      const text = itemKeyOf(l.rawText);
      if (text.length < 3) continue;
      const conditions = {
        all: [{ field: 'item_text' as const, op: 'contains' as const, value: l.rawText.trim(), ci: true }],
      };
      const actions = { categoryId: l.categoryId, ...(l.entityId ? { entityId: l.entityId } : {}) };
      if (validateRule(conditions, actions).length > 0) continue;
      const existing = await trx
        .selectFrom('app.rule')
        .select(['id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('scope', '=', 'receipt_line')
        .where('origin', '=', 'correction')
        .where(sql<boolean>`conditions = ${JSON.stringify(conditions)}::jsonb`)
        .executeTakeFirst();
      const category = await trx
        .selectFrom('app.ledger_account')
        .select('name')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', l.categoryId)
        .executeTakeFirst();
      const name = `${l.expandedName ?? l.rawText} → ${category?.name ?? 'category'}`.slice(0, 200);
      if (existing) {
        await trx
          .updateTable('app.rule')
          .set({ actions: JSON.stringify(actions), name })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', existing.id)
          .execute();
      } else {
        await trx
          .insertInto('app.rule')
          .values({
            workspace_id: ctx.workspaceId,
            id: newId(),
            name,
            scope: 'receipt_line',
            priority: 100,
            conditions: JSON.stringify(conditions),
            actions: JSON.stringify(actions),
            origin: 'correction',
            created_by: ctx.userId,
          })
          .execute();
      }
    }
  }

  async reject(ctx: Ctx, id: string): Promise<ReceiptDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status === 'matched') {
        throw unprocessable('receipt.matched', 'Unlink the receipt from its transaction before rejecting it');
      }
      await this.setStatus(trx, ctx, id, 'rejected');
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  /** Soft delete: the files stay until their retention date (RCP-10). Linked receipts are unlinked first. */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status === 'matched') {
        throw unprocessable('receipt.matched', 'Unlink the receipt from its transaction before deleting it');
      }
      await trx
        .updateTable('app.receipt')
        .set({ deleted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  // ----- Matching (IMP-11, CUR-04) ------------------------------------------------------------------------

  async rematch(ctx: Ctx, id: string): Promise<ReceiptDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status === 'matched' || r.status === 'rejected' || r.status === 'processing') {
        throw unprocessable('receipt.not_open', 'Only receipts in the inbox or in review are matched');
      }
      await this.matchInTrx(trx, ctx, [id]);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  /**
   * Scores open receipts against unreceipted transactions within ±5 days. A clear match ≥ 0.8 is applied
   * when the receipt adds up; otherwise the candidates are stored for the inbox. Returns receipts linked.
   */
  async matchInTrx(trx: Trx, ctx: Ctx, receiptIds?: string[]): Promise<number> {
    let q = trx
      .selectFrom('app.receipt')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['inbox', 'needs_review'])
      .where('receipt_date', 'is not', null)
      .where('total_minor', 'is not', null);
    if (receiptIds)
      q = q.where('id', 'in', receiptIds.length ? receiptIds : ['00000000-0000-0000-0000-000000000000']);
    const receipts = await q.execute();
    if (receipts.length === 0) return 0;
    const dates = receipts.map((r) => calendarDate(r.receipt_date!)).sort();
    const from = addDays(dates[0]!, -MATCH_WINDOW_DAYS);
    const to = addDays(dates.at(-1)!, MATCH_WINDOW_DAYS);
    const candidates = await this.candidateTransactions(trx, ctx, from, to);
    const currencies = [
      ...new Set([...receipts.map((r) => r.currency!), ...candidates.map((c) => c.currency)]),
    ];
    const rates = await this.fx.table(trx, currencies, from, to);
    const directory = await this.merchants.load(trx);
    const forMatch: ReceiptForMatch[] = receipts.map((r) => {
      const key = r.merchant ? normalizeDescription(r.merchant) : '';
      const m = key ? directory.match(key) : null;
      return {
        id: r.id,
        date: calendarDate(r.receipt_date!),
        total: r.total_minor!,
        currency: asCurrencyCode(r.currency!),
        merchantKey: key,
        merchantId: m?.id ?? null,
        tipAllowed: Boolean(m && ((m.mcc && TIP_MCCS.has(m.mcc)) || m.categoryHint === 'Dining out')),
        cardLast4: r.card_last4,
      };
    });
    const results = matchReceipts(
      forMatch,
      candidates.map((c) => ({
        ...c,
        merchantId: c.payeeKey ? (directory.match(c.payeeKey)?.id ?? null) : null,
      })),
      rates.lookup,
    );
    let linked = 0;
    for (const res of results) {
      const r = receipts.find((x) => x.id === res.receiptId)!;
      const stored: MatchCandidateDto[] = res.candidates.map((c) => {
        const t = candidates.find((x) => x.transactionId === c.transactionId)!;
        return {
          transactionId: c.transactionId,
          date: t.date,
          payee: t.payee,
          amount: { amount: t.amount.toString(), currency: t.currency },
          score: c.score,
          reasons: reasonsOf(c.factors),
        };
      });
      await trx
        .updateTable('app.receipt')
        .set({ match_candidates: JSON.stringify(stored) })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', r.id)
        .execute();
      if (!res.link || r.status !== 'inbox') continue;
      try {
        await this.applyInTrx(trx, ctx, r, res.link.transactionId, res.link.score, res.link.fx?.rate ?? null);
        linked++;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await this.setStatus(trx, ctx, r.id, 'needs_review');
      }
    }
    return linked;
  }

  private async candidateTransactions(
    trx: Trx,
    ctx: Ctx,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Array<TransactionForMatch & { payee: string | null }>> {
    const rows = await trx
      .selectFrom('app.transaction as t')
      .select(['t.id', 't.txn_date', 't.payee_key', 't.payee_raw', 't.description', 't.spec'])
      .where('t.workspace_id', '=', ctx.workspaceId)
      .where('t.status', '=', 'posted')
      .where('t.deleted_at', 'is', null)
      .where('t.txn_date', '>=', from)
      .where('t.txn_date', '<=', to)
      .where(sql<string>`t.spec->>'type'`, '=', 'standard')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('app.receipt as r')
              .select('r.id')
              .whereRef('r.workspace_id', '=', 't.workspace_id')
              .whereRef('r.transaction_id', '=', 't.id')
              .where('r.deleted_at', 'is', null),
          ),
        ),
      )
      .execute();
    const accountIds = [
      ...new Set(rows.map((r) => (r.spec as TransactionSpec & { type: 'standard' }).accountId)),
    ];
    const accounts = accountIds.length
      ? await trx
          .selectFrom('app.ledger_account as la')
          .leftJoin('app.bank_account as ba', (j) => j.onRef('ba.ledger_account_id', '=', 'la.id'))
          .select(['la.id', 'la.currency', 'ba.last4'])
          .where('la.workspace_id', '=', ctx.workspaceId)
          .where('la.id', 'in', accountIds)
          .execute()
      : [];
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return rows.map((r) => {
      const spec = r.spec as TransactionSpec & { type: 'standard' };
      const account = byId.get(spec.accountId);
      return {
        transactionId: r.id,
        date: calendarDate(r.txn_date),
        amount: BigInt(spec.amount),
        currency: asCurrencyCode(account?.currency ?? spec.currency),
        payeeKey: r.payee_key ?? normalizeDescription(r.payee_raw ?? r.description),
        payee: r.payee_raw,
        accountLast4: account?.last4 ?? null,
      };
    });
  }

  // ----- Applying (04 §7 step 7) --------------------------------------------------------------------------

  async apply(ctx: Ctx, id: string, req: ApplyReceiptRequest): Promise<ReceiptDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.version.toString() !== req.version) {
        throw new AppError(409, 'version_mismatch', 'The receipt changed since you opened it; reload it');
      }
      if (r.status === 'processing')
        throw unprocessable('receipt.processing', 'The receipt is still being read');
      if (!r.currency || r.total_minor === null) {
        throw unprocessable('receipt.incomplete', 'Set the currency and total before applying the receipt');
      }
      let transactionId: string;
      if ('transactionId' in req) {
        transactionId = req.transactionId;
      } else {
        // Record the purchase from the receipt itself (cash, or a card line not imported yet).
        transactionId = await this.transactions.createManualInTrx(trx, ctx, {
          date: req.createTransaction.date ?? calendarDate(r.receipt_date ?? (await this.today(trx, ctx))),
          accountId: req.createTransaction.accountId,
          amount: { amount: (-r.total_minor).toString(), currency: asCurrencyCode(r.currency) },
          ...(r.merchant ? { payee: r.merchant } : {}),
        });
      }
      await this.applyInTrx(trx, ctx, r, transactionId, null);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  /**
   * Replaces the transaction's splits with the receipt groups (receipt lines win over merchant
   * categorization). The splits sum to the *transaction* amount: within ±2 minor units the difference goes
   * to the largest group, a later tip at a restaurant goes to the largest group, and a foreign receipt is
   * converted at the implied rate (charged ÷ receipt total), which is stored (CUR-04). Anything else is a
   * 422 with the gap. The receipt's local time goes to the transaction (TZ-03).
   */
  async applyInTrx(
    trx: Trx,
    ctx: Ctx,
    r: ReceiptRow,
    transactionId: string,
    score: number | null,
    matchedRate: string | null = null,
  ): Promise<void> {
    const t = await trx
      .selectFrom('app.transaction')
      .select(['id', 'spec', 'status', 'txn_date'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .executeTakeFirst();
    if (!t) throw notFound('Transaction');
    const spec = t.spec as TransactionSpec | null;
    if (!spec || spec.type !== 'standard' || ownerOf(spec) || t.status === 'void') {
      throw unprocessable(
        'receipt.not_applicable',
        'A receipt applies to a purchase or refund, not a transfer',
      );
    }
    const other = await trx
      .selectFrom('app.receipt')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('transaction_id', '=', transactionId)
      .where('id', '!=', r.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (other) throw unprocessable('receipt.transaction_taken', 'That transaction already has a receipt');

    const receiptCurrency = asCurrencyCode(r.currency!);
    const lines = await this.lines(trx, ctx, r.id);
    if (lines.length === 0) throw unprocessable('receipt.no_lines', 'The receipt has no lines to apply');
    const account = await this.categorizer.accountInfo(trx, ctx, spec.accountId);
    const groups = groupReceipt(
      lines.map((l) => amountsOf(fromRow(l))),
      {
        tax: r.tax_minor,
        taxIncluded: r.tax_included,
        discount: r.discount_minor,
        fees: r.fees_minor,
        tip: r.tip_minor,
        total: r.total_minor,
      },
    );
    const charged = -BigInt(spec.amount);
    let amounts: bigint[];
    let rate: string | null = null;
    if (account.currency === receiptCurrency) {
      const directory = await this.merchants.load(trx);
      const m = r.merchant ? directory.match(normalizeDescription(r.merchant)) : null;
      const fit = fitToCharged(
        groups.map((g) => g.total),
        charged,
        { tipAllowed: Boolean(m && ((m.mcc && TIP_MCCS.has(m.mcc)) || m.categoryHint === 'Dining out')) },
      );
      if (!fit.ok) {
        throw new AppError(
          422,
          'receipt.gap',
          `The receipt's splits differ from the transaction by ${fit.gap} minor units; review the lines`,
        );
      }
      amounts = fit.amounts;
    } else {
      // CUR-04: the receipt is in another currency than the account; convert at the charge's own rate.
      amounts = convertGroupsAtCharge(
        groups.map((g) => g.total),
        charged,
      );
      rate =
        matchedRate ??
        trimRate(
          decimalToString(
            impliedRate(
              abs(charged),
              minorUnits(asCurrencyCode(account.currency)),
              abs(r.total_minor!),
              minorUnits(receiptCurrency),
            ),
          ),
        );
    }
    const uncategorized = await this.poster.uncategorizedAccount(
      trx,
      ctx,
      spec.accountId,
      BigInt(spec.amount),
    );
    const byLine = new Map(lines.map((l, i) => [i, l]));
    const splits = groups
      .map((g, gi) => {
        const first = byLine.get(g.lines[0]!)!;
        const label = g.lines
          .map((i) => byLine.get(i)!)
          .map((l) => l.expanded_name ?? l.raw_text)
          .join(', ');
        return {
          accountId: first.category_id ?? uncategorized,
          amount: { amount: (-amounts[gi]!).toString(), currency: asCurrencyCode(account.currency) },
          memberId: first.member_id,
          memo: `Receipt: ${label}`.slice(0, 500),
        };
      })
      .filter((s) => s.amount.amount !== '0');
    await this.transactions.updateInTrx(
      trx,
      ctx,
      transactionId,
      {
        splits,
        reviewState: 'reviewed',
        // CUR-03/04: the poster derives the rate from the charge and the original (source `implied`).
        ...(rate
          ? { foreign: { original: { amount: r.total_minor!.toString(), currency: receiptCurrency } } }
          : {}),
      },
      undefined,
      {
        learn: false,
        categorization: {
          step: 'receipt',
          confidence: 1,
          explanation: `Split by the receipt from ${r.merchant ?? 'the store'}`,
          ruleId: null,
          suggested: null,
        },
      },
    );
    await trx
      .updateTable('app.transaction')
      .set({ local_time: r.local_time, ...(r.trip_id ? { trip_id: r.trip_id } : {}) })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .execute();
    await trx
      .updateTable('app.receipt')
      .set({
        status: 'matched',
        transaction_id: transactionId,
        match_score: score === null ? '1' : score.toFixed(3),
        fx_rate: rate,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', r.id)
      .execute();
  }

  // ----- RCP-11: receipt recommended ----------------------------------------------------------------------

  async recommended(ctx: Ctx): Promise<ReceiptRecommendationDto[]> {
    return this.db.run(ctx, async (trx) => this.recommendedIn(trx, ctx, await this.today(trx, ctx)));
  }

  /**
   * Spending from the last 90 days with no receipt that's worth one: business spending at or above the business's
   * receipt threshold (UP-09), at a multi-department store above $50 (RCP-11), or, when the workspace set a reminder
   * amount, everyday spending at or above it, cards and imports included. Bills, debt and savings never: they don't
   * come with receipts. Not dismissed, and not a bill that carries its own document.
   */
  private async recommendedIn(trx: Trx, ctx: Ctx, today: CalendarDate): Promise<ReceiptRecommendationDto[]> {
    {
      const ws = await trx
        .selectFrom('app.workspace')
        .select(sql<string | null>`priorities->>'receiptReminderMinor'`.as('reminder'))
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const reminder = ws.reminder && /^\d+$/.test(ws.reminder) ? BigInt(ws.reminder) : null;
      const rows = await trx
        .selectFrom('app.transaction as t')
        .leftJoin('app.entity as e', 'e.id', 't.primary_entity_id')
        .leftJoin('app.business_profile as bp', 'bp.entity_id', 't.primary_entity_id')
        .leftJoin('app.ledger_account as ca', (j) =>
          j.on(sql<boolean>`ca.id::text = t.spec->'splits'->0->>'accountId'`),
        )
        .leftJoin('app.category_group as g', 'g.id', 'ca.category_group_id')
        .select([
          'g.kind as category_kind',
          't.id',
          't.txn_date',
          't.payee_raw',
          't.payee_key',
          't.description',
          't.spec',
          'e.type as entity_type',
          'bp.receipt_threshold_minor',
        ])
        .where('t.workspace_id', '=', ctx.workspaceId)
        .where('t.status', '=', 'posted')
        .where('t.deleted_at', 'is', null)
        .where('t.txn_date', '>=', addDays(today, -90))
        .where(sql<string>`t.spec->>'type'`, '=', 'standard')
        .where(sql<boolean>`(t.spec->>'amount')::bigint < 0`)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('app.receipt as r')
                .select('r.id')
                .whereRef('r.workspace_id', '=', 't.workspace_id')
                .whereRef('r.transaction_id', '=', 't.id')
                .where('r.deleted_at', 'is', null),
            ),
          ),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('app.receipt_flag_dismissal as d')
                .select('d.transaction_id')
                .whereRef('d.workspace_id', '=', 't.workspace_id')
                .whereRef('d.transaction_id', '=', 't.id'),
            ),
          ),
        )
        // A bill's own document is its receipt.
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('app.bill as b')
                .select('b.id')
                .whereRef('b.workspace_id', '=', 't.workspace_id')
                .whereRef('b.transaction_id', '=', 't.id')
                .where(sql<boolean>`cardinality(b.attachment_ids) > 0`),
            ),
          ),
        )
        .orderBy('t.txn_date', 'desc')
        .limit(500)
        .execute();
      const directory = await this.merchants.load(trx);
      const out: ReceiptRecommendationDto[] = [];
      for (const r of rows) {
        const spec = r.spec as TransactionSpec & { type: 'standard' };
        const currency = asCurrencyCode(spec.currency);
        const threshold = RECOMMEND_THRESHOLD_MAJOR * 10n ** BigInt(minorUnits(currency));
        const spent = -BigInt(spec.amount);
        const m = r.payee_key ? directory.match(r.payee_key) : null;
        const everyday = !NO_RECEIPT_KINDS.has(r.category_kind ?? '');
        const reason: ReceiptRecommendationDto['reason'] | null =
          r.entity_type === 'business' &&
          spent >= BigInt(r.receipt_threshold_minor ?? DEDUCTIBLE_DEFAULT_MINOR)
            ? 'deductible'
            : m && MULTI_DEPARTMENT.includes(m.id) && spent > threshold
              ? 'multi_department'
              : reminder !== null && everyday && r.entity_type !== 'business' && spent >= reminder
                ? 'over_threshold'
                : null;
        if (!reason) continue;
        out.push({
          transactionId: r.id,
          date: r.txn_date,
          payee: r.payee_raw,
          merchant: m?.displayName ?? r.payee_raw ?? r.description,
          amount: { amount: spec.amount, currency },
          reason,
        });
      }
      return out;
    }
  }

  /** The gentle nudge (UP-09): this week's receipts kept and missing, the streak, and what's still waiting. */
  async habit(ctx: Ctx): Promise<ReceiptHabitDto> {
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const today = todayIn(ws.time_zone);
      const user = await trx
        .selectFrom('app.app_user')
        .select('week_start')
        .where('id', '=', ctx.userId)
        .executeTakeFirst();
      const waiting = await this.recommendedIn(trx, ctx, today);
      // Twelve weeks back: as far as the recommendations look (90 days).
      const { rows } = await sql<{ d: string; n: string }>`
        select (created_at at time zone ${ws.time_zone})::date::text as d, count(*)::text as n
          from app.receipt
         where workspace_id = ${ctx.workspaceId} and deleted_at is null and status <> 'rejected'
           and created_at >= (${addDays(today, -7 * 13)}::date)
         group by 1`.execute(trx);
      const h = receiptHabit({
        today,
        weekStart: user?.week_start ?? 1,
        weeks: 12,
        capturedOn: rows.flatMap((r) => Array.from({ length: Number(r.n) }, () => calendarDate(r.d))),
        missingOn: waiting.map((w) => calendarDate(w.date)),
      });
      return { ...h, waiting: waiting.length, latest: waiting.slice(0, 3) };
    });
  }

  async dismissRecommendation(ctx: Ctx, transactionId: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      await trx
        .insertInto('app.receipt_flag_dismissal')
        .values({ workspace_id: ctx.workspaceId, transaction_id: transactionId, dismissed_by: ctx.userId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    });
  }

  // ----- RCP-12: online order history ---------------------------------------------------------------------

  async importOrders(ctx: Ctx, bytes: Uint8Array): Promise<OrderImportResultDto> {
    return this.db.run(ctx, async (trx) => {
      const base = await trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      let orders;
      try {
        orders = parseOrderHistory(bytes, asCurrencyCode(base.base_currency));
      } catch (err) {
        if (err instanceof OrderHistoryError)
          throw unprocessable('receipt.order_history_invalid', err.message);
        throw err;
      }
      const entityId = await this.entityFor(trx, ctx, undefined, undefined);
      const existing = new Set(
        (
          await trx
            .selectFrom('app.receipt')
            .select('order_ref')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('order_ref', 'in', orders.length ? orders.map((o) => o.orderRef) : [''])
            .where('deleted_at', 'is', null)
            .execute()
        ).map((r) => r.order_ref),
      );
      const created: string[] = [];
      for (const o of orders) {
        if (existing.has(o.orderRef)) continue;
        const id = newId();
        await trx
          .insertInto('app.receipt')
          .values({
            workspace_id: ctx.workspaceId,
            id,
            entity_id: entityId,
            source: 'order_import',
            status: 'processing',
            order_ref: o.orderRef,
            merchant: 'Amazon',
            created_by: ctx.userId,
          })
          .execute();
        await this.store(
          trx,
          ctx,
          id,
          {
            merchant: 'Amazon',
            receiptDate: o.date,
            localTime: null,
            currency: o.currency,
            subtotalMinor: o.lines.reduce((s, l) => s + l.lineTotalMinor, 0n),
            taxMinor: o.taxMinor,
            taxIncluded: false,
            discountMinor: o.discountMinor,
            feesMinor: o.feesMinor,
            tipMinor: 0n,
            totalMinor: o.totalMinor,
            cardLast4: null,
            ocrText: null,
            extraction: { mode: 'off', model: null, confidence: 1, warnings: [] },
          },
          o.lines.map((l) => ({
            rawText: l.rawText,
            expandedName: null,
            qty: l.qty,
            unitPriceMinor: l.unitPriceMinor,
            lineTotalMinor: l.lineTotalMinor,
            discountMinor: 0n,
            // Tax goes to the items Amazon taxed (RCP-04 allocates by taxable subtotal).
            taxable: l.taxMinor !== 0n,
            categoryId: null,
            entityId: null,
            memberId: null,
            confidence: null,
            categorization: null,
          })),
        );
        created.push(id);
      }
      const matched = created.length ? await this.matchInTrx(trx, ctx, created) : 0;
      return {
        orders: orders.length,
        created: created.length,
        duplicates: orders.length - created.length,
        matched,
        receiptIds: created,
      };
    });
  }

  // ----- Helpers ------------------------------------------------------------------------------------------

  /** The receipt's entity: the caller's choice, the transaction's, or the Personal entity. */
  private async entityFor(trx: Trx, ctx: Ctx, entityId?: string, transactionId?: string): Promise<string> {
    if (entityId) return entityId;
    if (transactionId) {
      const t = await trx
        .selectFrom('app.transaction')
        .select('primary_entity_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      return t.primary_entity_id;
    }
    const e = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', '=', 'personal')
      .executeTakeFirstOrThrow();
    return e.id;
  }

  async today(trx: Trx, ctx: Ctx): Promise<CalendarDate> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('time_zone')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return todayIn(ws.time_zone);
  }
}

// ----- Pure helpers ---------------------------------------------------------------------------------------

export function fromRow(l: ReceiptLineRow): LineInput {
  return {
    id: l.id,
    rawText: l.raw_text,
    expandedName: l.expanded_name,
    qty: l.qty,
    unitPriceMinor: l.unit_price_minor,
    lineTotalMinor: l.line_total_minor,
    discountMinor: l.discount_minor,
    taxable: l.taxable,
    categoryId: l.category_id,
    entityId: l.entity_id,
    memberId: l.member_id,
    confidence: l.confidence === null ? null : Number(l.confidence),
    categorization: l.categorization as StoredCategorization | null,
  };
}

/** Lines with the same (category, entity, member) become one split (RCP-03, RCP-07). */
function amountsOf(l: LineInput): ReceiptLineAmounts {
  return {
    key: `${l.categoryId ?? ''}|${l.entityId ?? ''}|${l.memberId ?? ''}`,
    lineTotal: l.lineTotalMinor,
    discount: l.discountMinor,
    taxable: l.taxable,
  };
}

function groupsOf(r: ReceiptRow, rows: ReceiptLineRow[]): ReceiptGroupDto[] {
  const lines = rows.map(fromRow);
  return groupReceipt(lines.map(amountsOf), {
    tax: r.tax_minor,
    taxIncluded: r.tax_included,
    discount: r.discount_minor,
    fees: r.fees_minor,
    tip: r.tip_minor,
    total: r.total_minor,
  }).map((g) => {
    const first = lines[g.lines[0]!]!;
    return {
      categoryId: first.categoryId,
      entityId: first.entityId ?? r.entity_id,
      memberId: first.memberId,
      lineIds: g.lines.map((i) => rows[i]!.id),
      subtotal: g.subtotal.toString(),
      tax: g.tax.toString(),
      discount: g.discount.toString(),
      fees: g.fees.toString(),
      tip: g.tip.toString(),
      total: g.total.toString(),
    };
  });
}

function lineDto(l: ReceiptLineRow): ReceiptLineDto {
  return {
    id: l.id,
    lineNo: l.line_no,
    rawText: l.raw_text,
    expandedName: l.expanded_name,
    qty: l.qty === null ? null : trimRate(l.qty),
    unitPrice: l.unit_price_minor?.toString() ?? null,
    lineTotal: l.line_total_minor.toString(),
    discount: l.discount_minor.toString(),
    taxable: l.taxable,
    isReturn: l.is_return,
    categoryId: l.category_id,
    entityId: l.entity_id,
    memberId: l.member_id,
    categorization: toDto(l.categorization as StoredCategorization | null),
  };
}

/** Searchable text when there is no OCR text (builtin mode reads images): merchant and item names. */
function searchText(merchant: string | null, lines: LineInput[]): string {
  return [merchant ?? '', ...lines.map((l) => `${l.rawText} ${l.expandedName ?? ''}`)]
    .join('\n')
    .slice(0, 20_000);
}

function reasonsOf(f: {
  amount: { kind: string; bps?: bigint; dayRate?: string };
  days: number;
  merchant: number;
}): string[] {
  const out: string[] = [];
  if (f.amount.kind === 'exact') out.push('same amount');
  if (f.amount.kind === 'tip') out.push(`amount + ${Number(f.amount.bps!) / 100}% (tip)`);
  if (f.amount.kind === 'fx') out.push(`converted at ${f.amount.dayRate} (${Number(f.amount.bps!) / 100}%)`);
  out.push(
    f.days === 0
      ? 'same day'
      : `date ${f.days > 0 ? '+' : ''}${f.days} day${Math.abs(f.days) === 1 ? '' : 's'}`,
  );
  if (f.merchant >= 0.9) out.push('same merchant');
  else if (f.merchant > 0) out.push(`merchant ${Math.trunc(f.merchant * 100)}% similar`);
  return out;
}

const trimRate = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
