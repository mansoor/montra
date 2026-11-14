import { z } from 'zod';
import { Id } from './common.js';

/**
 * Scanned documents read before they're filed (ADR-0048 §3): a statement, payslip or bill from the Add wheel. The
 * reading suggests where it goes; the import, payslip or bill is then made from the same reading with `scanId`.
 */
export const SCAN_KINDS = ['statement', 'payslip', 'bill'] as const;
export const ScanKind = z.enum(SCAN_KINDS);
export type ScanKind = z.infer<typeof ScanKind>;

export const CreateScanRequest = z.object({
  kind: ScanKind,
  /** Uploaded files: one PDF for a statement (`/uploads`), the pages for a payslip (`/payslips/files`). */
  fileIds: z.array(Id).min(1).max(20),
});
export type CreateScanRequest = z.output<typeof CreateScanRequest>;

/** An account a scanned statement may be for, and why. */
export const ScanAccountDto = z.object({
  accountId: Id,
  name: z.string(),
  last4: z.string().nullable(),
  reason: z.enum(['last4', 'recent']),
});
export type ScanAccountDto = z.infer<typeof ScanAccountDto>;

/** An employer a scanned payslip may be from. */
export const ScanEmployerDto = z.object({
  employerId: Id,
  name: z.string(),
  memberId: Id,
  memberName: z.string(),
});
export type ScanEmployerDto = z.infer<typeof ScanEmployerDto>;

export const ScanStatementDetectedDto = z.object({
  /** Read from the statement ("account ending 1234"), or null. */
  accountLast4: z.string().nullable(),
  /** The account when only one fits; the person still confirms. */
  accountId: Id.nullable(),
  candidates: z.array(ScanAccountDto),
});
export type ScanStatementDetectedDto = z.infer<typeof ScanStatementDetectedDto>;

export const ScanPayslipDetectedDto = z.object({
  /** The employer's name as printed, or null. */
  employerName: z.string().nullable(),
  /** The person the payslip is for, from the pseudonym the reading named (names never reach the AI). */
  memberId: Id.nullable(),
  /** The employer when one matches by name (and person, when both are known). */
  employerId: Id.nullable(),
  candidates: z.array(ScanEmployerDto),
  payDate: z.string().nullable(),
  /** Net pay in the payslip's currency, minor units, or null. */
  net: z.string().nullable(),
  currency: z.string().nullable(),
});
export type ScanPayslipDetectedDto = z.infer<typeof ScanPayslipDetectedDto>;

export const ScanDto = z.object({
  id: Id,
  kind: ScanKind,
  status: z.enum(['reading', 'ready', 'failed', 'used']),
  fileIds: z.array(Id),
  statement: ScanStatementDetectedDto.nullable(),
  payslip: ScanPayslipDetectedDto.nullable(),
  /** Why it couldn't be read; it can still be filed by hand. */
  error: z.string().nullable(),
  /** The import or payslip made from it. */
  usedId: Id.nullable(),
  createdAt: z.string(),
});
export type ScanDto = z.infer<typeof ScanDto>;
