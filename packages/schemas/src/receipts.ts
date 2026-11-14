import { z } from 'zod';
import { CalendarDateDto, Id, MoneyDto } from './common.js';
import { CategorizationDto } from './ai.js';
import { RateDto } from './fx.js';

// ----- Receipts (RCP-01..12, IMP-11, ADR-0014; design 03 §6, 04 §7) -------------------------------------

export const RECEIPT_STATUSES = ['processing', 'inbox', 'matched', 'needs_review', 'rejected'] as const;
export const ReceiptStatus = z.enum(RECEIPT_STATUSES);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

export const RECEIPT_SOURCES = ['camera', 'upload', 'order_import'] as const;

/** Minor units as an integer string in the receipt's currency. */
const Minor = z.string().regex(/^-?\d{1,19}$/, 'Amount must be an integer number of minor units');
/** Wall-clock time on the receipt (TZ-03). */
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Expected HH:MM or HH:MM:SS');

/** A receipt file stored for later use in `CreateReceiptRequest` (images or a PDF invoice). */
export const ReceiptFileDto = z.object({
  fileId: Id,
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  bytes: z.number().int(),
  sha256: z.string(),
  /** The same picture uploaded before, and the receipt that used it. */
  duplicateOf: z.object({ fileId: Id, receiptId: Id.nullable() }).nullable(),
});
export type ReceiptFileDto = z.infer<typeof ReceiptFileDto>;

/**
 * Upload: one receipt from one or more files (multi-shot pages in order, or one PDF invoice). The files are
 * uploaded first (`POST /files`, kind `receipt`); the extract job starts when the receipt is created.
 */
export const CreateReceiptRequest = z.object({
  fileIds: z.array(Id).min(1).max(20),
  source: z.enum(RECEIPT_SOURCES).default('upload'),
  /** Link straight to a known transaction (e.g. "add receipt" from the transaction screen). */
  transactionId: Id.optional(),
  entityId: Id.optional(),
  /** Client-generated id, so offline captures replay idempotently (TXN-09). */
  id: Id.optional(),
});
export type CreateReceiptRequest = z.output<typeof CreateReceiptRequest>;

export const ReceiptLineDto = z.object({
  id: Id,
  lineNo: z.number().int().positive(),
  rawText: z.string(),
  /** RCP-02: "GV 2% MLK GAL" → "Great Value 2% milk, 1 gal". */
  expandedName: z.string().nullable(),
  /** Decimal string, e.g. "1" or "0.452" (weighed items). */
  qty: z.string().nullable(),
  unitPrice: Minor.nullable(),
  /** Negative for returns (RCP-08). */
  lineTotal: Minor,
  discount: Minor,
  taxable: z.boolean(),
  isReturn: z.boolean(),
  categoryId: Id.nullable(),
  entityId: Id.nullable(),
  memberId: Id.nullable(),
  categorization: CategorizationDto.nullable(),
});
export type ReceiptLineDto = z.infer<typeof ReceiptLineDto>;

export const MatchCandidateDto = z.object({
  transactionId: Id,
  date: z.string(),
  payee: z.string().nullable(),
  amount: MoneyDto,
  /** 0..1; ≥ 0.8 links automatically (IMP-11). */
  score: z.number(),
  /** E.g. "amount within tip tolerance", "date +2 days", "converted at 1.0912 (−1.4%)". */
  reasons: z.array(z.string()),
});
export type MatchCandidateDto = z.infer<typeof MatchCandidateDto>;

/** One split the receipt would produce: lines grouped by (category, entity, member), with allocations. */
export const ReceiptGroupDto = z.object({
  categoryId: Id.nullable(),
  entityId: Id.nullable(),
  memberId: Id.nullable(),
  lineIds: z.array(Id),
  subtotal: Minor,
  tax: Minor,
  discount: Minor,
  fees: Minor,
  tip: Minor,
  /** In the receipt currency. */
  total: Minor,
});
export type ReceiptGroupDto = z.infer<typeof ReceiptGroupDto>;

/**
 * A `processing` receipt that nothing is reading: its job has waited in the queue for minutes (no worker is
 * taking it) or failed. `documents` is the doc-worker's OCR (images not allowed to the AI, or local mode);
 * `jobs` is the API's job worker that runs the AI read.
 */
export const ReceiptStalledDto = z.object({
  worker: z.enum(['documents', 'jobs']),
  reason: z.enum(['waiting', 'failed']),
  since: z.string(),
});
export type ReceiptStalledDto = z.infer<typeof ReceiptStalledDto>;

/** Another receipt with the same store, date and total: probably the same one scanned twice. */
export const ReceiptDuplicateDto = z.object({
  id: Id,
  merchant: z.string().nullable(),
  receiptDate: z.string().nullable(),
  total: Minor.nullable(),
  status: ReceiptStatus,
  createdAt: z.string(),
});
export type ReceiptDuplicateDto = z.infer<typeof ReceiptDuplicateDto>;

export const ReceiptDto = z.object({
  id: Id,
  entityId: Id,
  status: ReceiptStatus,
  source: z.enum(RECEIPT_SOURCES),
  fileIds: z.array(Id),
  merchant: z.string().nullable(),
  /** The store's details as printed on the receipt (RCP-01); null when not printed or read before they were kept. */
  storeAddress: z.string().nullable(),
  storePhone: z.string().nullable(),
  storeWebsite: z.string().nullable(),
  receiptDate: z.string().nullable(),
  localTime: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: Minor.nullable(),
  tax: Minor,
  /** VAT-style receipt: the prices include `tax` (RCP-05). */
  taxIncluded: z.boolean(),
  discount: Minor,
  fees: Minor,
  tip: Minor,
  total: Minor.nullable(),
  cardLast4: z.string().nullable(),
  /** RCP-05: total − computed total; outside ±2 minor units the receipt needs review. */
  validationGap: Minor.nullable(),
  lines: z.array(ReceiptLineDto),
  groups: z.array(ReceiptGroupDto),
  transactionId: Id.nullable(),
  matchScore: z.number().nullable(),
  candidates: z.array(MatchCandidateDto),
  /** Home per receipt unit, once matched across currencies (CUR-04). */
  fxRate: RateDto.nullable(),
  tripId: Id.nullable(),
  orderRef: z.string().nullable(),
  extraction: z
    .object({
      mode: z.enum(['builtin', 'byok', 'local', 'off']),
      model: z.string().nullable(),
      confidence: z.number().nullable(),
      warnings: z.array(z.string()),
    })
    .nullable(),
  stalled: ReceiptStalledDto.nullable(),
  /** Receipts that look like this one scanned again, for the user to compare and discard one (RCP-13). */
  likelyDuplicates: z.array(ReceiptDuplicateDto),
  retainUntil: z.string(),
  createdAt: z.string(),
  version: z.string(),
});
export type ReceiptDto = z.infer<typeof ReceiptDto>;

export const ReceiptListQuery = z.object({
  status: ReceiptStatus.optional(),
  /** RCP-10: full-text search over merchant and OCR text. */
  q: z.string().trim().min(1).max(200).optional(),
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReceiptListQuery = z.output<typeof ReceiptListQuery>;

/**
 * Item search (RCP-09): receipts with lines that match every word of `q` (the start of a word, in the printed or the
 * expanded name), dated from `from` (default: three months before `to`) to `to` (default: today).
 */
export const ReceiptItemSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
});
export type ReceiptItemSearchQuery = z.output<typeof ReceiptItemSearchQuery>;

export const ReceiptItemMatchDto = z.object({
  lineId: Id,
  /** The expanded name when there is one, else the line as printed. */
  name: z.string(),
  qty: z.string().nullable(),
  /** Line total less its discount; negative for a return. */
  amount: Minor,
});
export type ReceiptItemMatchDto = z.infer<typeof ReceiptItemMatchDto>;

export const ReceiptItemHitDto = z.object({
  receiptId: Id,
  merchant: z.string().nullable(),
  receiptDate: z.string(),
  currency: z.string(),
  /** The receipt's total, null when it wasn't read. */
  total: Minor.nullable(),
  /** The matching lines' amounts added up. */
  itemsAmount: Minor,
  items: z.array(ReceiptItemMatchDto),
});
export type ReceiptItemHitDto = z.infer<typeof ReceiptItemHitDto>;

export const ReceiptItemSearchDto = z.object({
  query: z.string(),
  from: z.string(),
  to: z.string(),
  /** Spent on the item, one entry per currency (usually one). */
  totals: z.array(
    z.object({ currency: z.string(), amount: Minor, items: z.number().int(), receipts: z.number().int() }),
  ),
  /** Newest first. */
  receipts: z.array(ReceiptItemHitDto),
  /** More receipts matched than are listed (the totals still count them all). */
  more: z.boolean(),
});
export type ReceiptItemSearchDto = z.infer<typeof ReceiptItemSearchDto>;

export const ReceiptLineInput = z.object({
  /** Omitted for a line the user adds. */
  id: Id.optional(),
  rawText: z.string().trim().min(1).max(500),
  expandedName: z.string().trim().max(500).nullable().optional(),
  qty: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,3})?$/)
    .nullable()
    .optional(),
  unitPrice: Minor.nullable().optional(),
  lineTotal: Minor,
  discount: Minor.default('0'),
  taxable: z.boolean().default(true),
  categoryId: Id.nullable().optional(),
  entityId: Id.nullable().optional(),
  memberId: Id.nullable().optional(),
});
export type ReceiptLineInput = z.output<typeof ReceiptLineInput>;

/** Review edits (RCP-06). Changing a line's category teaches an item-level rule after repeated corrections. */
export const UpdateReceiptRequest = z.object({
  version: z.string(),
  merchant: z.string().trim().max(200).nullable().optional(),
  storeAddress: z.string().trim().max(300).nullable().optional(),
  storePhone: z.string().trim().max(40).nullable().optional(),
  storeWebsite: z.string().trim().max(200).nullable().optional(),
  receiptDate: CalendarDateDto.nullable().optional(),
  localTime: LocalTime.nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  tax: Minor.optional(),
  taxIncluded: z.boolean().optional(),
  discount: Minor.optional(),
  fees: Minor.optional(),
  tip: Minor.optional(),
  total: Minor.nullable().optional(),
  lines: z.array(ReceiptLineInput).max(500).optional(),
});
export type UpdateReceiptRequest = z.output<typeof UpdateReceiptRequest>;

/** Link to a transaction (or create one) and replace its splits with the receipt groups (04 §7 step 7). */
export const ApplyReceiptRequest = z.union([
  z.object({ transactionId: Id, version: z.string() }),
  z.object({
    createTransaction: z.object({ accountId: Id, date: CalendarDateDto.optional() }),
    version: z.string(),
  }),
]);
export type ApplyReceiptRequest = z.output<typeof ApplyReceiptRequest>;

export const ReceiptPageDto = z.object({ data: z.array(ReceiptDto), nextCursor: z.string().nullable() });
export type ReceiptPageDto = z.infer<typeof ReceiptPageDto>;

/** RCP-11: a purchase at a multi-department store above the threshold, with no receipt yet. */
export const ReceiptRecommendationDto = z.object({
  transactionId: Id,
  date: z.string(),
  payee: z.string().nullable(),
  merchant: z.string(),
  amount: MoneyDto,
  /**
   * Why a receipt is worth keeping: business spending above the business's receipt threshold, which a deduction
   * needs (UP-09); a multi-department store, where it splits the purchase (RCP-11); or everyday spending above the
   * workspace's reminder amount (planning settings, off unless set).
   */
  reason: z.enum(['deductible', 'multi_department', 'over_threshold']),
});
export type ReceiptRecommendationDto = z.infer<typeof ReceiptRecommendationDto>;

/**
 * GET /receipts/habit — the gentle nudge (UP-09): this week's receipts kept and missing, the streak of weeks with
 * none missing, and the latest few purchases still waiting (all of them are at /receipts/recommended).
 */
export const ReceiptHabitDto = z.object({
  week: z.object({ start: CalendarDateDto, end: CalendarDateDto }),
  /** Receipts captured this week. */
  captured: z.number().int(),
  /** Purchases this week that could use a receipt and have none. */
  missing: z.number().int(),
  /** Weeks in a row with receipts captured and none missing (the week in progress never breaks it). */
  streakWeeks: z.number().int(),
  /** Purchases from the last 90 days still waiting for a receipt. */
  waiting: z.number().int(),
  /** The latest three of them. */
  latest: z.array(ReceiptRecommendationDto),
});
export type ReceiptHabitDto = z.infer<typeof ReceiptHabitDto>;

/** RCP-12: an order-history file turned into one receipt per order (idempotent by order id). */
export const OrderImportResultDto = z.object({
  orders: z.number().int(),
  created: z.number().int(),
  duplicates: z.number().int(),
  matched: z.number().int(),
  receiptIds: z.array(Id),
});
export type OrderImportResultDto = z.infer<typeof OrderImportResultDto>;
