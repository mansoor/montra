import { z } from 'zod';
import { CalendarDateDto, Id } from './common.js';
import { MinorDto } from './budgets.js';
import { FiledBillDto } from './household-bills.js';

/**
 * Intakes (ADR-0051): a statement uploaded without an account, or a bill scanned to be filed automatically. Each is read
 * once and matched to an account or biller. A learned match imports or files it straight away when nothing needs a
 * decision; anything else waits in Review for a person to pick, and their pick teaches the match memory.
 */
export const INTAKE_KINDS = ['statement', 'bill'] as const;
export const IntakeKind = z.enum(INTAKE_KINDS);
export type IntakeKind = z.infer<typeof IntakeKind>;

export const INTAKE_FILE_TYPES = ['csv', 'xlsx', 'xls', 'pdf', 'qif', 'ofx', 'image'] as const;
export const IntakeFileType = z.enum(INTAKE_FILE_TYPES);
export type IntakeFileType = z.infer<typeof IntakeFileType>;

/**
 * - `reading`: the file is being read.
 * - `suggested`: one account or biller fits but isn't learned yet: confirm it (it's in Review until then).
 * - `review`: a decision is needed (see `reason`).
 * - `importing`: an import is being made and checked.
 * - `done`: imported or filed. `dismissed`: put aside; the file stays.
 */
export const INTAKE_STATUSES = ['reading', 'suggested', 'review', 'importing', 'done', 'dismissed'] as const;
export const IntakeStatus = z.enum(INTAKE_STATUSES);
export type IntakeStatus = z.infer<typeof IntakeStatus>;

/** Why an intake is in Review. */
export const INTAKE_REASONS = [
  /** Nothing identifies the account or biller. */
  'no_match',
  /** More than one fits. */
  'several',
  /** The file couldn't be read. */
  'unreadable',
  /** The import needs its columns mapped. */
  'needs_mapping',
  /** The import has likely duplicates to decide. */
  'duplicates',
  /** Some rows couldn't be read. */
  'errors',
  /** The statement's balances don't add up. */
  'balance',
  /** Every row was imported before. */
  'nothing_new',
  /** The import failed. */
  'import_failed',
  /** An automatic import was undone: pick the account again. */
  'undone',
  /** Its import was discarded before it was committed: pick the account again. */
  'discarded',
  /** A bill's amount or due date wasn't read. */
  'bill_incomplete',
] as const;
export const IntakeReason = z.enum(INTAKE_REASONS);
export type IntakeReason = z.infer<typeof IntakeReason>;

/** Why an account or biller is offered. */
export const INTAKE_CANDIDATE_REASONS = [
  'learned',
  'last4',
  'issuer',
  'account_id',
  'profile',
  'name',
  'recent',
] as const;

export const IntakeCandidateDto = z.object({
  /** An account (statements) or a biller (bills). */
  id: Id,
  name: z.string(),
  last4: z.string().nullable(),
  reason: z.enum(INTAKE_CANDIDATE_REASONS),
});
export type IntakeCandidateDto = z.infer<typeof IntakeCandidateDto>;

/** What the file says about where it goes. */
export const IntakeDetectedDto = z.object({
  /** Last four digits printed, in the file name, or of an OFX account id. */
  last4: z.string().nullable(),
  /** The institution the statement names, among the workspace's accounts' institutions. */
  issuer: z.string().nullable(),
  /** The file name with its digits as `#` (`chase#_activity_#`). */
  fileNamePattern: z.string().nullable(),
  /** A bill's provider as printed. */
  billerName: z.string().nullable(),
});
export type IntakeDetectedDto = z.infer<typeof IntakeDetectedDto>;

/** A bill's reading, for filing it. */
export const IntakeBillDto = z.object({
  amount: MinorDto.nullable(),
  currency: z.string().nullable(),
  dueDate: CalendarDateDto.nullable(),
  billDate: CalendarDateDto.nullable(),
  periodStart: CalendarDateDto.nullable(),
  periodEnd: CalendarDateDto.nullable(),
  memberId: Id.nullable(),
});
export type IntakeBillDto = z.infer<typeof IntakeBillDto>;

export const IntakeDto = z.object({
  id: Id,
  kind: IntakeKind,
  status: IntakeStatus,
  reason: IntakeReason.nullable(),
  fileName: z.string(),
  fileType: IntakeFileType,
  fileIds: z.array(Id),
  detected: IntakeDetectedDto,
  candidates: z.array(IntakeCandidateDto),
  /** The account or biller suggested, picked automatically or chosen. */
  targetId: Id.nullable(),
  targetName: z.string().nullable(),
  /** Picked by the match memory, not a person. */
  automatic: z.boolean(),
  /** The memory for this file's signal: confirmations so far towards `targetId`, and how many make it automatic. */
  learning: z.object({ confirmations: z.number().int(), needed: z.number().int() }).nullable(),
  /** The import made from it. Undo is the import's (IMP-09). */
  importBatchId: Id.nullable(),
  bill: IntakeBillDto.nullable(),
  /** What filing a bill made. */
  filed: FiledBillDto.nullable(),
  /** An earlier upload with the same content. */
  duplicateOf: z.object({ fileId: Id, importBatchId: Id.nullable(), uploadedAt: z.string() }).nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type IntakeDto = z.infer<typeof IntakeDto>;

/** A statement uploaded already (`POST uploads`), to find its account. Multipart `POST intakes/files` does both. */
export const CreateIntakeRequest = z.object({ fileId: Id });
export type CreateIntakeRequest = z.output<typeof CreateIntakeRequest>;

export const ListIntakesQuery = z.object({
  /** `open`: suggested or in review (the default); `recent`: everything from the last 30 days. */
  status: z.enum(['open', 'recent']).default('open'),
  kind: IntakeKind.optional(),
});
export type ListIntakesQuery = z.output<typeof ListIntakesQuery>;

const PositiveMinor = MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be positive');

/**
 * Picks the account (statement) or biller (bill) and finishes. This is a confirmation the memory learns from, or a
 * correction when it isn't what was suggested.
 */
export const ResolveIntakeRequest = z.object({
  targetId: Id,
  /** Statements: commit the import straight away when it's clean (the phone); otherwise it opens in preview. */
  commitIfClean: z.boolean().optional(),
  /** Bills: when the amount or due date wasn't read, or to correct them. */
  amount: PositiveMinor.optional(),
  dueDate: CalendarDateDto.optional(),
});
export type ResolveIntakeRequest = z.output<typeof ResolveIntakeRequest>;
