import { z } from 'zod';
import { CalendarDateDto } from './common.js';

// ----- Workspace audit log (NFR-03) ------------------------------------------------------------------------

/**
 * Rows the database triggers write for the ledger's own bookkeeping: journal entries, their lines, the chart of
 * accounts and transaction tags. A new workspace writes about eighty `ledger_account` rows, and each transaction
 * two or more `posting` rows, so the Settings screen hides these by default. Explicit actions on them (for example
 * `journal_entry.unlock`) are never hidden.
 */
export const AUDIT_BOOKKEEPING_SUBJECTS = [
  'posting',
  'journal_entry',
  'ledger_account',
  'transaction_tag',
] as const;

export const AuditActorType = z.enum(['user', 'system', 'support', 'worker']);
export type AuditActorType = z.infer<typeof AuditActorType>;

export const AuditEntryDto = z.object({
  /** Increasing within a workspace; the paging cursor. */
  id: z.string(),
  at: z.string(),
  actorUserId: z.string().nullable(),
  /** The person's name, or their email without one. Null for someone no longer in the workspace, or no person. */
  actorName: z.string().nullable(),
  actorType: AuditActorType,
  /** `<table>.insert|update|delete` from the triggers, or an explicit action such as `reconciliation.undo`. */
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string().nullable(),
  /**
   * For an update, `{ field: [before, after] }` for each field that changed; for an insert or delete, the row. Fields
   * ending in `_enc` read `[redacted]`. Explicit actions carry their own details.
   */
  diff: z.unknown().nullable(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

export const AuditLogPageDto = z.object({
  data: z.array(AuditEntryDto),
  /** Pass back as `cursor` for older entries; null at the end. */
  nextCursor: z.string().nullable(),
});
export type AuditLogPageDto = z.infer<typeof AuditLogPageDto>;

/** `GET /v1/workspaces/:id/audit-log`, owners and admins. Dates are the workspace's calendar days, both inclusive. */
export const AuditLogQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  subjectId: z.string().min(1).max(100).optional(),
  subjectType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,62}$/)
    .optional(),
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_.]{0,99}$/)
    .optional(),
  actorUserId: z.uuid().optional(),
  actorType: AuditActorType.optional(),
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
  /** `hide` leaves out the trigger rows on `AUDIT_BOOKKEEPING_SUBJECTS`. Everything is shown by default. */
  bookkeeping: z.enum(['show', 'hide']).default('show'),
});
export type AuditLogQuery = Omit<z.input<typeof AuditLogQuery>, 'limit'> & { limit?: number };

// ----- Staff log (OPS-01) -----------------------------------------------------------------------------------

export const AdminLogEntryDto = z.object({
  id: z.string(),
  at: z.string(),
  staffId: z.string(),
  /** Null when the account is gone. */
  staffEmail: z.string().nullable(),
  staffName: z.string().nullable(),
  /** For example `plan.save`, `account.suspend`, `support.view`. */
  action: z.string(),
  /** What it was done to: a workspace or account id, a plan or flag key. */
  subject: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type AdminLogEntryDto = z.infer<typeof AdminLogEntryDto>;

export const AdminLogStaffDto = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
});
export type AdminLogStaffDto = z.infer<typeof AdminLogStaffDto>;

export const AdminLogPageDto = z.object({
  data: z.array(AdminLogEntryDto),
  nextCursor: z.string().nullable(),
  /** Everyone who appears in the log, for the Who filter. */
  staff: z.array(AdminLogStaffDto),
});
export type AdminLogPageDto = z.infer<typeof AdminLogPageDto>;

/** `GET /v1/admin/log`, admins and owners. Dates are UTC days, both inclusive. */
export const AdminLogQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_.]{0,99}$/)
    .optional(),
  staffId: z.uuid().optional(),
  subject: z.string().min(1).max(200).optional(),
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
});
export type AdminLogQuery = Omit<z.input<typeof AdminLogQuery>, 'limit'> & { limit?: number };
