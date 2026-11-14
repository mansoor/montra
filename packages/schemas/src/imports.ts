import { z } from 'zod';
import { CalendarDateDto, Id, MoneyDto } from './common.js';
import { BankAccountKind } from './accounts.js';

// ----- Uploads (IMP-01) ----------------------------------------------------------------------------------

/** Statement file types. `qif` is Quicken's QIF; `ofx` is OFX 1.x/2.x and QFX (ADR-0030). */
export const IMPORT_FILE_TYPES = ['csv', 'xlsx', 'xls', 'pdf', 'qif', 'ofx'] as const;
export type ImportFileType = (typeof IMPORT_FILE_TYPES)[number];

export const UploadDto = z.object({
  fileId: z.string(),
  fileName: z.string(),
  fileType: z.enum(IMPORT_FILE_TYPES).nullable(),
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
    /** The bank's transaction id column (OFX `FITID`), which dedupe keys on. */
    externalId: col.optional(),
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
  /** A statement scanned and read already (ADR-0048): its reading is used instead of reading the file again. */
  scanId: Id.optional(),
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
  fileType: z.enum(IMPORT_FILE_TYPES),
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

export const RECONCILIATION_STATUSES = ['in_progress', 'completed', 'undone'] as const;
export const ReconciliationStatus = z.enum(RECONCILIATION_STATUSES);

/** Who did something on a reconciliation, by the name other members of the workspace see. */
export const ReconciliationActorDto = z.object({ userId: z.string(), name: z.string() });

/** DE-12: the balance adjustment posted on finishing with a difference; natural terms, signed. */
export const ReconciliationAdjustmentDto = z.object({ transactionId: z.string(), amount: MoneyDto });

/**
 * A statement reconciliation (DE-08, DE-11). Amounts are natural terms (held for assets, owed for liabilities):
 * opening (the previous completed statement's ending balance, 0 for the first) + cleared deposits − cleared payments
 * = the cleared balance, and the difference is the statement's ending balance less the cleared balance.
 */
export const ReconciliationDto = z.object({
  id: z.string(),
  accountId: z.string(),
  statementDate: z.string(),
  /** The statement's ending balance. */
  statementBalance: MoneyDto,
  /** DE-11: the ending balance of the previous completed statement, or 0 for the first. */
  openingBalance: MoneyDto,
  previousStatementDate: z.string().nullable(),
  /** What this statement's cleared lines add to and take from the balance; both ≥ 0. */
  clearedDeposits: MoneyDto,
  clearedPayments: MoneyDto,
  clearedBalance: MoneyDto,
  difference: MoneyDto,
  /**
   * DE-11: set while in progress when the reconciled lines up to the previous statement date no longer add up to the
   * opening balance (one was changed, deleted or un-reconciled since): what they add up to now.
   */
  chainBreak: z.object({ reconciledBalance: MoneyDto }).nullable(),
  /** DE-12: while the difference isn't 0, the category an adjustment would use unless another is picked. */
  adjustmentCategoryId: z.string().nullable(),
  adjustment: ReconciliationAdjustmentDto.nullable(),
  status: ReconciliationStatus,
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

/**
 * POST reconciliations/:id/complete. With a difference left, `adjustment` posts a "Reconciliation adjustment" for it
 * on the statement date, reconciled with the statement (DE-12); without one, a difference is refused.
 */
export const CompleteReconciliationRequest = z.object({
  adjustment: z.object({ categoryId: Id.optional() }).optional(),
});
export type CompleteReconciliationRequest = z.output<typeof CompleteReconciliationRequest>;

/** POST reconciliations/:id/undo (DE-13): owners and accountants, the account's latest completed one only. */
export const UndoReconciliationRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type UndoReconciliationRequest = z.output<typeof UndoReconciliationRequest>;

/** One reconciliation on an account's history page (DE-14), newest statement first. */
export const ReconciliationHistoryItemDto = z.object({
  id: z.string(),
  statementDate: z.string(),
  openingBalance: MoneyDto,
  statementBalance: MoneyDto,
  status: ReconciliationStatus,
  startedAt: z.string(),
  startedBy: ReconciliationActorDto.nullable(),
  completedAt: z.string().nullable(),
  completedBy: ReconciliationActorDto.nullable(),
  adjustment: ReconciliationAdjustmentDto.nullable(),
  undoneAt: z.string().nullable(),
  undoneBy: ReconciliationActorDto.nullable(),
  undoReason: z.string().nullable(),
  /** The account's latest completed reconciliation, and the caller may undo (owner or accountant). */
  canUndo: z.boolean(),
});
export type ReconciliationHistoryItemDto = z.infer<typeof ReconciliationHistoryItemDto>;

/** GET accounts/:accountId/reconciliations/history (DE-11, DE-14). */
export const ReconciliationHistoryDto = z.object({
  accountId: z.string(),
  /** The last completed statement's date: "Reconciled through". */
  reconciledThrough: z.string().nullable(),
  /** What starting the next one suggests: a month after the last statement date, opening at its ending balance. */
  next: z.object({ statementDate: z.string().nullable(), openingBalance: MoneyDto }),
  inProgressId: z.string().nullable(),
  items: z.array(ReconciliationHistoryItemDto),
});
export type ReconciliationHistoryDto = z.infer<typeof ReconciliationHistoryDto>;

// ----- Switching from another app (IMP-13, ADR-0029) ----------------------------------------------------------

/**
 * The apps the Switch page has export instructions for; `bank` is your banks' own OFX/QFX downloads, and `other` is
 * any CSV with dates and amounts.
 */
export const MIGRATION_SOURCES = [
  'ynab',
  'monarch',
  'mint',
  'lunch_money',
  'actual',
  'tiller',
  'empower',
  'copilot',
  'rocket_money',
  'pocketsmith',
  'simplifi',
  'goodbudget',
  'quicken_windows',
  'quicken_mac',
  'bank',
  'other',
] as const;
export const MigrationSource = z.enum(MIGRATION_SOURCES);
export type MigrationSource = z.infer<typeof MigrationSource>;

/**
 * GET /migrations/eligibility — switching from another app is for a fresh start: a workspace without transactions of its
 * own (accounts set up, opening balances and an earlier switch's imports are fine). Otherwise the Switch page offers a
 * new workspace instead, so nothing has to be merged or reset.
 */
export const MigrationEligibilityDto = z.object({
  eligible: z.boolean(),
  /** Transactions that would have to be merged with the export. */
  transactions: z.number().int(),
});
export type MigrationEligibilityDto = z.infer<typeof MigrationEligibilityDto>;

/** POST /migrations/analyze — what an export holds: its accounts and categories, before anything is created. */
export const AnalyzeMigrationRequest = z.object({
  source: MigrationSource,
  fileIds: z.array(Id).min(1).max(10),
  /** Files whose spending shows as positive amounts: their signs are flipped. */
  inverted: z.array(Id).max(10).default([]),
});
export type AnalyzeMigrationRequest = z.output<typeof AnalyzeMigrationRequest>;

const Minor = z.string().regex(/^-?\d{1,19}$/);

export const MigrationAnalysisDto = z.object({
  source: MigrationSource,
  currency: z.string(),
  files: z.array(
    z.object({
      fileId: Id,
      fileName: z.string(),
      /** The export it was recognized as (ynab, monarch, …), or null when read by its column names. */
      template: z.string().nullable(),
      rows: z.number().int(),
      /** Why it can't be used here (then import it on the Import page instead), or null. */
      problem: z.enum(['unsupported_type', 'unreadable', 'no_transactions', 'needs_mapping']).nullable(),
    }),
  ),
  /** Each account in the export: by its name in the file, or the file's name when it has no account column. */
  accounts: z.array(
    z.object({
      key: z.string(),
      rows: z.number().int(),
      from: CalendarDateDto.nullable(),
      to: CalendarDateDto.nullable(),
      /** Money in and out over the export (minor units, positive). */
      moneyIn: Minor,
      moneyOut: Minor,
      /** The opening balance the export gives (YNAB's Starting Balance), or null. */
      opening: Minor.nullable(),
      /** An account of yours with the same name. */
      matchId: Id.nullable(),
      /** A guess at the kind of a new account from its name (cards and loans are owed). */
      suggestedKind: BankAccountKind,
    }),
  ),
  /** Each category name in the export, with its group when the export has one. */
  categories: z.array(
    z.object({
      name: z.string(),
      group: z.string().nullable(),
      rows: z.number().int(),
      moneyIn: Minor,
      moneyOut: Minor,
      /** A category of yours with the same name. */
      matchId: Id.nullable(),
      /** Looks like a transfer or card payment: best left uncategorized, so it can be paired as a transfer. */
      transfer: z.boolean(),
    }),
  ),
});
export type MigrationAnalysisDto = z.infer<typeof MigrationAnalysisDto>;

const AccountTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('existing'), accountId: Id }),
  z.object({
    type: z.literal('new'),
    name: z.string().trim().min(1).max(200),
    kind: BankAccountKind,
    /** Today's balance (owed, for cards and loans): the opening balance is worked out so it ends up right. */
    balance: MoneyDto.nullable().optional(),
  }),
  z.object({ type: z.literal('skip') }),
]);

const CategoryTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('existing'), categoryId: Id }),
  z.object({
    type: z.literal('new'),
    name: z.string().trim().min(1).max(200),
    group: z.string().trim().min(1).max(200),
    kind: z.enum(['expense', 'income']),
  }),
  /** Leave its rows to the usual suggestions (and transfer pairing). */
  z.object({ type: z.literal('skip') }),
]);

/** POST /migrations — creates the new accounts and categories and one import per account, then previews them. */
export const StartMigrationRequest = z.object({
  source: MigrationSource,
  fileIds: z.array(Id).min(1).max(10),
  inverted: z.array(Id).max(10).default([]),
  /** The books new accounts and categories go into (default: personal). */
  entityId: Id.optional(),
  accounts: z
    .array(z.object({ key: z.string().max(300), target: AccountTarget }))
    .min(1)
    .max(100),
  categories: z
    .array(z.object({ name: z.string().max(300), target: CategoryTarget }))
    .max(500)
    .default([]),
});
export type StartMigrationRequest = z.output<typeof StartMigrationRequest>;

export const MigrationDto = z.object({
  id: Id,
  source: MigrationSource,
  createdAt: z.string(),
  batches: z.array(
    z.object({
      batchId: Id,
      accountId: Id,
      accountName: z.string(),
      fileName: z.string(),
      status: z.string(),
      rowsRead: z.number().int(),
      rowsAdded: z.number().int(),
      rowsMatched: z.number().int(),
      error: z.string().nullable(),
    }),
  ),
  /** Every batch has its preview: ready to import. */
  ready: z.boolean(),
  /** Every batch is imported. */
  done: z.boolean(),
  /** Pairs of its transactions that look like transfers between its accounts, not yet made transfers. */
  transferPairs: z.number().int(),
});
export type MigrationDto = z.infer<typeof MigrationDto>;
