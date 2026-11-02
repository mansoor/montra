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

export const ReceiptDto = z.object({
  id: Id,
  entityId: Id,
  status: ReceiptStatus,
  source: z.enum(RECEIPT_SOURCES),
  fileIds: z.array(Id),
  merchant: z.string().nullable(),
  receiptDate: z.string().nullable(),
  localTime: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: Minor.nullable(),
  tax: Minor,
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
  receiptDate: CalendarDateDto.nullable().optional(),
  localTime: LocalTime.nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  tax: Minor.optional(),
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
