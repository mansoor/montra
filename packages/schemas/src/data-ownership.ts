/** Taking data out and back in, and leaving (NFR-05, NFR-06, BAK-04..09, AUTH-12; ADR-0019). */
import { z } from 'zod';
import { CalendarDateDto, Id } from './common.js';

export const SecurityEventKind = z.enum([
  'sign_in_new_device',
  'mfa_changed',
  'password_changed',
  'email_changed',
  'session_revoked',
  'export_requested',
  'export_downloaded',
  'backup_scheduled',
  'restore_started',
  'restore_finished',
  'deletion_requested',
  'deletion_cancelled',
  'support_access',
  'storage_connected',
  'storage_changed',
  'storage_disconnected',
  'sign_in_locked',
  'account_suspended',
  'account_restored',
  'deletion_requested_by_support',
  'phone_changed',
  // The household's Family Document Vault (ADR-0054 §11).
  'vault_connected',
  'vault_changed',
  'vault_key_replaced',
  'vault_move_started',
  'vault_disconnected',
]);
export type SecurityEventKind = z.infer<typeof SecurityEventKind>;

export const SecurityEventDto = z.object({
  id: Id,
  kind: SecurityEventKind,
  at: z.string(),
  workspaceId: Id.nullable(),
  /** Device name, export kind and the like. Never a password or token. */
  detail: z.record(z.string(), z.unknown()),
});
export type SecurityEventDto = z.infer<typeof SecurityEventDto>;

// ----- Backups and tax packages --------------------------------------------------------------------------------

export const ExportJobDto = z.object({
  id: Id,
  kind: z.enum(['backup', 'tax_package']),
  entityId: Id.nullable(),
  taxYear: z.number().int().nullable(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  encrypted: z.boolean(),
  fileName: z.string().nullable(),
  bytes: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  /** A copy sent to the workspace's own storage (ADR-0031 §7), or null when none was asked for. */
  storageCopy: z
    .object({
      status: z.enum(['pending', 'done', 'failed', 'pruned']),
      path: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  /**
   * ADR-0054 §5a: files the archive couldn't include because Montra no longer holds them and the vault didn't give them
   * back (its README lists them). Shown with a link to "Files to provide again".
   */
  missingFiles: z.number().int(),
  /**
   * A background archive (a scheduled backup or a tax package) that met the vault's daily read cap waits once for the
   * vault's reset, until then, and is then made with whatever it can get. Null when it isn't waiting.
   */
  waitingUntil: z.string().nullable(),
});
export type ExportJobDto = z.infer<typeof ExportJobDto>;

export const CreateBackupRequest = z.object({
  /** One entity, or the whole workspace. */
  entityId: Id.optional(),
  /** Encrypts the archive. It isn't stored, and can't be recovered. */
  password: z.string().min(10).max(200).optional(),
  /** Also save it to the workspace's own storage. Defaults to yes when one is connected. Owners only. */
  saveToStorage: z.boolean().optional(),
});
export type CreateBackupRequest = z.output<typeof CreateBackupRequest>;

export const CreateTaxPackageRequest = z.object({
  entityId: Id,
  year: z.number().int().min(2000).max(2100),
});
export type CreateTaxPackageRequest = z.output<typeof CreateTaxPackageRequest>;

export const BackupDestination = z.enum(['email_link', 'storage']);
export type BackupDestination = z.infer<typeof BackupDestination>;

export const BackupScheduleDto = z.object({
  cadence: z.enum(['weekly', 'monthly']),
  /** An emailed download link, or saved to the workspace's own storage (ADR-0031 §7). */
  destination: BackupDestination,
  /** Each archive is encrypted with the password given when scheduling. */
  encrypted: z.boolean(),
  nextRunOn: CalendarDateDto,
  lastRunAt: z.string().nullable(),
  version: z.number().int(),
});
export type BackupScheduleDto = z.infer<typeof BackupScheduleDto>;

export const SaveBackupScheduleRequest = z.object({
  cadence: z.enum(['weekly', 'monthly']),
  destination: BackupDestination.default('email_link'),
  /** A new password; null removes it; left out keeps the current one. It isn't stored, and can't be recovered. */
  password: z.string().min(10).max(200).nullable().optional(),
});
export type SaveBackupScheduleRequest = z.output<typeof SaveBackupScheduleRequest>;

// ----- Restore (BAK-06) --------------------------------------------------------------------------------------------

export const RestorePreviewDto = z.object({
  workspaceName: z.string(),
  createdAt: z.string(),
  entityScoped: z.boolean(),
  /** Took only what its requester could read, so it may not be the whole workspace. */
  partial: z.boolean(),
  entities: z.array(z.object({ name: z.string(), type: z.string() })),
  counts: z.record(z.string(), z.number().int()),
  firstDate: CalendarDateDto.nullable(),
  lastDate: CalendarDateDto.nullable(),
  files: z.number().int(),
  /** In the chosen existing workspace already, by dedupe key. Worked out when a target is given. */
  possibleDuplicates: z.number().int().nullable(),
});
export type RestorePreviewDto = z.infer<typeof RestorePreviewDto>;

export const RestoreJobDto = z.object({
  id: Id,
  status: z.enum(['uploaded', 'ready', 'restoring', 'done', 'failed']),
  preview: RestorePreviewDto.nullable(),
  mode: z.enum(['new', 'existing']).nullable(),
  targetWorkspaceId: Id.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type RestoreJobDto = z.infer<typeof RestoreJobDto>;

export const ConfirmRestoreRequest = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new'), name: z.string().trim().min(1).max(200).optional() }),
  z.object({ mode: z.literal('existing'), workspaceId: Id }),
]);
export type ConfirmRestoreRequest = z.output<typeof ConfirmRestoreRequest>;

// ----- Trash (BAK-06) ------------------------------------------------------------------------------------------------

export const TRASH_KINDS = ['transaction', 'receipt', 'tax_form'] as const;
/**
 * How an item leaves the Trash, with `until`. It can be restored meanwhile, in every case.
 * - `trash`: removed for good on `until`, 30 days after it was deleted.
 * - `retention`: a receipt. It is a tax record, so it is kept until its retention date, `until` (RCP-10).
 * - `owner_approval`: a receipt past its retention date, `until`. It goes only once an owner approves (Settings, Data).
 * - `in_use`: its 30 days ended on `until`, but another record still uses it, so it stays until that changes.
 */
export const TRASH_REMOVALS = ['trash', 'retention', 'owner_approval', 'in_use'] as const;
export const TrashItemDto = z.object({
  kind: z.enum(TRASH_KINDS),
  id: Id,
  title: z.string(),
  deletedAt: z.string(),
  removal: z.enum(TRASH_REMOVALS),
  until: CalendarDateDto,
  amount: z.string().nullable(),
  currency: z.string().nullable(),
});
export type TrashItemDto = z.infer<typeof TrashItemDto>;

// ----- Past their retention date (RCP-10, BAK-09; migration 0079) ----------------------------------------------------

export const RETENTION_ITEM_KINDS = ['receipt', 'file'] as const;
export const RetentionItemRef = z.object({ kind: z.enum(RETENTION_ITEM_KINDS), id: Id });
export type RetentionItemRef = z.infer<typeof RetentionItemRef>;

/** A receipt or file past its date, waiting for an owner. Owners only. */
export const RetentionItemDto = z.object({
  kind: z.enum(RETENTION_ITEM_KINDS),
  id: Id,
  retainUntil: CalendarDateDto,
  /** The receipt's merchant, or the file's name. */
  title: z.string(),
  /** For a file: what it was stored as (`payslip`, `invoice`, …). */
  fileKind: z.string().nullable(),
  /** For a receipt: its date, total and currency. */
  date: CalendarDateDto.nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  /** The transaction a receipt belongs to. It stays when the receipt goes. */
  transaction: z.object({ id: Id, date: CalendarDateDto, payee: z.string().nullable() }).nullable(),
  /** Set once an owner approved deleting it; the retention job then removes it. */
  approvedAt: z.string().nullable(),
});
export type RetentionItemDto = z.infer<typeof RetentionItemDto>;

export const RetentionReviewDto = z.object({
  items: z.array(RetentionItemDto),
  /** How many years "Keep for longer" adds (RETENTION_EXTEND_YEARS). */
  extendYears: z.number().int(),
});
export type RetentionReviewDto = z.infer<typeof RetentionReviewDto>;

/** "Delete these" and "Keep for longer": exactly the items listed, never ones found later. */
export const RetentionItemsRequest = z.object({ items: z.array(RetentionItemRef).min(1).max(1000) });
export type RetentionItemsRequest = z.infer<typeof RetentionItemsRequest>;

export const RetentionResultDto = z.object({ count: z.number().int() });
export type RetentionResultDto = z.infer<typeof RetentionResultDto>;

// ----- Storage (BAK-08) ----------------------------------------------------------------------------------------------

export const StorageUsageDto = z.object({
  usedBytes: z.string(),
  quotaBytes: z.string(),
  byKind: z.record(z.string(), z.string()),
});
export type StorageUsageDto = z.infer<typeof StorageUsageDto>;

// ----- Leaving (NFR-06, BAK-09) ---------------------------------------------------------------------------------------

export const DeletionStatusDto = z.object({
  requested: z.boolean(),
  purgeAfter: z.string().nullable(),
  /** Workspaces that go too, because this is their only owner. */
  workspaces: z.array(z.object({ id: Id, name: z.string(), otherMembers: z.number().int() })),
});
export type DeletionStatusDto = z.infer<typeof DeletionStatusDto>;

export const RequestDeletionRequest = z.object({ confirm: z.literal('DELETE') });
export type RequestDeletionRequest = z.output<typeof RequestDeletionRequest>;
