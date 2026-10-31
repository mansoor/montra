import { z } from 'zod';
import { CalendarDateDto, Id, MoneyDto } from './common.js';

// ----- Uploads (IMP-01) ----------------------------------------------------------------------------------

export const UploadDto = z.object({
  fileId: z.string(),
  fileName: z.string(),
  fileType: z.enum(['csv', 'xlsx', 'xls', 'pdf']).nullable(),
  bytes: z.number(),
  sha256: z.string(),
  /** An earlier upload with identical content (same statement uploaded twice). */
  duplicateOf: z
    .object({ fileId: z.string(), importBatchId: z.string().nullable(), uploadedAt: z.string() })
    .nullable(),
});
export type UploadDto = z.infer<typeof UploadDto>;

// ----- Column mapping (IMP-03/04) — mirrors @montra/importers ColumnMapping ---------------------------------

const col = z.number().int().min(0).max(255);
export const DATE_FORMAT_IDS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'DD.MM.YY',
  'D MMM YYYY',
  'MMM D YYYY',
  'DD-MMM-YY',
  'DD-MMM-YYYY',
] as const;

export const ColumnMappingDto = z
  .object({
    sheet: z.string().max(100).optional(),
    headerRow: z.number().int().min(0).nullable(),
    dataStart: z.number().int().min(0),
    date: col,
    dateFormat: z.enum(DATE_FORMAT_IDS),
    description: z.array(col).max(4),
    payee: col.optional(),
    amount: col.optional(),
    debit: col.optional(),
    credit: col.optional(),
    direction: z.object({ column: col, debitValues: z.array(z.string().max(50)).max(10) }).optional(),
    sign: z.enum(['normal', 'inverted']),
    balance: col.optional(),
    category: col.optional(),
    reference: col.optional(),
    skipPatterns: z.array(z.string().max(100)).max(20).optional(),
    filter: z.object({ column: col, values: z.array(z.string().max(200)).max(20) }).optional(),
    decimal: z.enum(['.', ',']),
  })
  .refine((m) => m.amount !== undefined || (m.debit !== undefined && m.credit !== undefined), {
    message: 'Map either an amount column or both debit and credit columns',
    path: ['amount'],
  });
export type ColumnMappingDto = z.output<typeof ColumnMappingDto>;

// ----- Import batches (IMP-06..09) --------------------------------------------------------------------------

export const CreateImportRequest = z.object({
  fileId: Id,
  accountId: Id,
  /** For multi-account app exports (YNAB, Mint, …): which account's rows to import. */
  accountFilter: z.string().trim().max(200).optional(),
});
export type CreateImportRequest = z.output<typeof CreateImportRequest>;

export const UpdateMappingRequest = z.object({
  mapping: ColumnMappingDto,
  /** Remember this mapping for files of the same shape (default true). */
  saveProfile: z.boolean().default(true),
});
export type UpdateMappingRequest = z.output<typeof UpdateMappingRequest>;

export const UpdateImportRowRequest = z
  .object({
    decision: z.enum(['import', 'skip', 'match']).nullable(),
    categoryId: Id.nullable(),
  })
  .partial();
export type UpdateImportRowRequest = z.output<typeof UpdateImportRowRequest>;

export const BulkImportRowsRequest = z
  .object({
    rowIds: z.array(Id).max(5000).optional(),
    /** Apply to every row with this classification, e.g. "skip all probable duplicates". */
    status: z.enum(['new', 'duplicate', 'probable_duplicate', 'match', 'error']).optional(),
    decision: z.enum(['import', 'skip', 'match']).nullable(),
  })
  .refine((r) => Boolean(r.rowIds?.length) !== Boolean(r.status), {
    message: 'Give either rowIds or status',
    path: ['rowIds'],
  });
export type BulkImportRowsRequest = z.output<typeof BulkImportRowsRequest>;

export const ImportStatus = z.enum([
  'uploaded',
  'parsing',
  'needs_mapping',
  'preview',
  'committing',
  'committed',
  'failed',
  'undone',
]);

export const ImportBatchDto = z.object({
  id: z.string(),
  accountId: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  fileType: z.enum(['csv', 'xlsx', 'xls', 'pdf']),
  status: ImportStatus,
  currency: z.string(),
  mapping: ColumnMappingDto.nullable(),
  mappingSource: z.enum(['profile', 'reference', 'heuristic', 'ai', 'user']).nullable(),
  mappingConfidence: z.number().nullable(),
  /** Header, sample rows and (for app exports) the account names found — for the mapping UI. */
  analysis: z
    .object({
      header: z.array(z.string()).nullable(),
      sample: z.array(z.array(z.string())),
      accounts: z.array(z.string()),
      /** Column holding account names in multi-account app exports (for the account-filter picker). */
      accountColumn: z.number().nullable(),
      templateId: z.string().nullable(),
    })
    .nullable(),
  /** The batch's latest job: tells parse, commit and undo apart and carries their results (e.g. undo's kept rows). */
  job: z
    .object({
      id: z.string(),
      type: z.string(),
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
      progress: z.number().nullable(),
      result: z.record(z.string(), z.unknown()).nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  counts: z.object({
    read: z.number(),
    new: z.number(),
    duplicate: z.number(),
    probableDuplicate: z.number(),
    match: z.number(),
    error: z.number(),
    skipped: z.number(),
    added: z.number(),
    matched: z.number(),
    failed: z.number(),
  }),
  minDate: z.string().nullable(),
  maxDate: z.string().nullable(),
  statement: z.object({ opening: MoneyDto.nullable(), closing: MoneyDto.nullable() }),
  balanceCheck: z.enum(['ok', 'mismatch', 'n_a']),
  balanceGap: MoneyDto.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  committedAt: z.string().nullable(),
  undoUntil: z.string().nullable(),
  undoneAt: z.string().nullable(),
  jobId: z.string().nullable(),
  createdAt: z.string(),
});
export type ImportBatchDto = z.infer<typeof ImportBatchDto>;

export const ImportRowDto = z.object({
  id: z.string(),
  rowNo: z.number(),
  date: z.string().nullable(),
  amount: MoneyDto.nullable(),
  description: z.string().nullable(),
  payee: z.string().nullable(),
  balance: MoneyDto.nullable(),
  status: z.enum(['new', 'duplicate', 'probable_duplicate', 'match', 'error']),
  decision: z.enum(['import', 'skip', 'match']).nullable(),
  /** What commit will do with the row given status and decision. */
  effective: z.enum(['import', 'skip', 'match', 'fail']),
  transactionId: z.string().nullable(),
  matchTransactionId: z.string().nullable(),
  duplicateOfTransactionId: z.string().nullable(),
  score: z.number().nullable(),
  categoryId: z.string().nullable(),
  suggestion: z
    .object({ categoryId: z.string().nullable(), confidence: z.number(), explanation: z.string() })
    .nullable(),
  error: z.string().nullable(),
  outcome: z.enum(['added', 'matched', 'skipped', 'failed']).nullable(),
  raw: z.array(z.string()),
});
export type ImportRowDto = z.infer<typeof ImportRowDto>;

export const UndoResultDto = z.object({
  voided: z.number(),
  restored: z.number(),
  kept: z.array(z.object({ transactionId: z.string(), reason: z.string() })),
});
export type UndoResultDto = z.infer<typeof UndoResultDto>;

export const JobDto = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type JobDto = z.infer<typeof JobDto>;

// ----- Reconciliation (DE-08) ------------------------------------------------------------------------------

export const StartReconciliationRequest = z.object({
  statementDate: CalendarDateDto,
  /** Statement ending balance in natural terms (held for assets, owed for liabilities). */
  statementBalance: MoneyDto,
});
export type StartReconciliationRequest = z.output<typeof StartReconciliationRequest>;

export const ToggleClearedRequest = z.object({
  clear: z.array(Id).max(2000).default([]),
  unclear: z.array(Id).max(2000).default([]),
});
export type ToggleClearedRequest = z.output<typeof ToggleClearedRequest>;

export const ReconciliationDto = z.object({
  id: z.string(),
  accountId: z.string(),
  statementDate: z.string(),
  statementBalance: MoneyDto,
  clearedBalance: MoneyDto,
  difference: MoneyDto,
  status: z.enum(['in_progress', 'completed']),
  lines: z.array(
    z.object({
      postingId: z.string(),
      transactionId: z.string().nullable(),
      date: z.string(),
      description: z.string(),
      amount: z.string(),
      cleared: z.enum(['uncleared', 'cleared', 'reconciled']),
    }),
  ),
  completedAt: z.string().nullable(),
});
export type ReconciliationDto = z.infer<typeof ReconciliationDto>;
