/**
 * Kysely table types for schema `app` (docs/design/03-data-model.md). Hand-written in Phase 0; replaced by
 * kysely-codegen output checked in CI once the schema grows.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CalendarDateCol = ColumnType<string, string, string>;
type Int8 = ColumnType<bigint, bigint | number | string, bigint | number | string>;
type Int8Default = ColumnType<bigint, bigint | number | string | undefined, bigint | number | string>;
type Json<T = unknown> = ColumnType<T, T | string | undefined, T | string>;

export interface AppUserTable {
  id: Generated<string>;
  identity_id: string | null;
  email: string;
  display_name: Generated<string>;
  locale: Generated<string>;
  time_zone: Generated<string>;
  date_format: string | null;
  week_start: Generated<number>;
  email_verified_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface WorkspaceTable {
  id: string;
  name: string;
  base_currency: string;
  time_zone: Generated<string>;
  ai_mode: Generated<'builtin' | 'byok' | 'local' | 'off'>;
  ai_settings: Json<Record<string, unknown>>;
  priorities: Json<Record<string, unknown>>;
  inter_entity_mode: Generated<'equity' | 'due_to_from'>;
  plan: Generated<string>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type MemberRole = 'owner' | 'partner' | 'viewer' | 'accountant';

export interface WorkspaceMemberTable {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  status: Generated<'invited' | 'active' | 'revoked'>;
  invited_email: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EntityTable {
  workspace_id: string;
  id: string;
  type: 'personal' | 'business' | 'rental';
  name: string;
  functional_currency: string;
  fiscal_year_start_month: Generated<number>;
  business_type: string | null;
  tax_profile: Json<Record<string, unknown>>;
  archived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EntityGrantTable {
  workspace_id: string;
  user_id: string;
  entity_id: string;
  access: 'none' | 'read' | 'write';
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface FamilyMemberTable {
  workspace_id: string;
  id: string;
  name: string;
  relationship: 'self' | 'spouse_partner' | 'child' | 'parent' | 'other';
  birth_date: CalendarDateCol | null;
  color: string | null;
  status: Generated<'active' | 'inactive'>;
  linked_user_id: string | null;
  is_dependent: Generated<boolean>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CategoryGroupTable {
  workspace_id: string;
  id: string;
  entity_id: string;
  name: string;
  kind: 'income' | 'fixed' | 'daily' | 'fun' | 'savings' | 'debt' | 'business' | 'rental' | 'system';
  sort_order: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerAccountTable {
  workspace_id: string;
  id: string;
  entity_id: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype: Generated<string>;
  name: string;
  parent_id: string | null;
  currency: string;
  is_category: Generated<boolean>;
  category_group_id: string | null;
  tax_line_code: string | null;
  system_role: string | null;
  counterparty_entity_id: string | null;
  tracks_account_id: string | null;
  sort_order: Generated<number>;
  archived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type BankAccountKind =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'cash'
  | 'loan'
  | 'mortgage'
  | 'line_of_credit'
  | 'investment'
  | 'asset'
  | 'liability';

export interface BankAccountTable {
  workspace_id: string;
  ledger_account_id: string;
  kind: BankAccountKind;
  institution: string | null;
  last4: string | null;
  account_number_enc: Buffer | null;
  opening_balance_minor: Int8Default;
  opening_date: CalendarDateCol | null;
  default_member_id: string | null;
  credit_limit_minor: Int8 | null;
  interest_rate_bps: number | null;
  statement_day: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayeeTable {
  workspace_id: string;
  id: string;
  display_name: string;
  normalized_key: string;
  kind: Generated<string>;
  default_category_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TagTable {
  workspace_id: string;
  id: string;
  name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TransactionTable {
  workspace_id: string;
  id: string;
  primary_entity_id: string;
  txn_date: CalendarDateCol;
  payee_raw: string | null;
  payee_id: string | null;
  description: Generated<string>;
  memo_enc: Buffer | null;
  status: Generated<'scheduled' | 'pending' | 'posted' | 'void'>;
  review_state: Generated<'auto_applied' | 'needs_review' | 'reviewed'>;
  source: Generated<'manual' | 'camera' | 'import' | 'receipt' | 'payslip' | 'recurring' | 'system' | 'feed'>;
  dedupe_key: string | null;
  original_amount_minor: Int8 | null;
  original_currency: string | null;
  fx_rate: string | null;
  recurring_item_id: string | null;
  /** The user-level input the entries were built from (TransactionSpec in the API). */
  spec: Json<Record<string, unknown>> | null;
  posted_at: Date | null;
  statement_date: CalendarDateCol | null;
  raw_description: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface TransactionTagTable {
  workspace_id: string;
  transaction_id: string;
  tag_id: string;
}

export interface JournalEntryTable {
  workspace_id: string;
  id: string;
  entity_id: string;
  transaction_id: string | null;
  entry_date: CalendarDateCol;
  description: Generated<string>;
  kind: Generated<string>;
  reverses_entry_id: string | null;
  locked: Generated<boolean>;
  restricted: Generated<boolean>;
  restricted_member_id: string | null;
  posted_by: string | null;
  posted_at: Generated<Date>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PostingTable {
  workspace_id: string;
  id: string;
  journal_entry_id: string;
  /** Copied from the journal entry by trigger; any value written is overwritten. */
  entity_id: ColumnType<string, string | undefined, string>;
  entry_date: ColumnType<string, string | undefined, string>;
  restricted: Generated<boolean>;
  line_no: number;
  ledger_account_id: string;
  amount_minor: Int8;
  currency: string;
  functional_amount_minor: Int8;
  fx_rate: string | null;
  member_id: string | null;
  property_id: string | null;
  unit_id: string | null;
  memo: string | null;
  cleared: Generated<'uncleared' | 'cleared' | 'reconciled'>;
  reconciliation_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PeriodLockTable {
  workspace_id: string;
  entity_id: string;
  locked_through: CalendarDateCol;
  locked_by: string | null;
  locked_at: Generated<Date>;
  note: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PeriodLockEventTable {
  workspace_id: string;
  id: Generated<bigint>;
  entity_id: string;
  action: 'lock' | 'unlock' | 'relock';
  locked_through: CalendarDateCol | null;
  actor_user_id: string | null;
  note: string | null;
  at: Generated<Date>;
}

export interface AuditLogTable {
  workspace_id: string;
  id: Generated<bigint>;
  actor_user_id: string | null;
  actor_type: Generated<string>;
  action: string;
  subject_type: string;
  subject_id: string | null;
  diff: Json | null;
  at: Generated<Date>;
}

export interface ChangeLogTable {
  workspace_id: string;
  /** Shared by all changes of one transaction (migration 0009); `sub` orders them. */
  seq: bigint;
  sub: number;
  table_name: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
  entity_id: string | null;
  restricted: boolean;
  changed_at: Date;
}

export interface IdempotencyKeyTable {
  workspace_id: string;
  key: string;
  request_hash: string;
  status_code: number;
  response: Json | null;
  created_at: Generated<Date>;
  expires_at: Timestamp;
}

export interface WorkspaceInviteTable {
  workspace_id: string;
  id: string;
  email: string;
  role: 'partner' | 'viewer' | 'accountant';
  entity_grants: Json<{ entityId: string; access: 'none' | 'read' | 'write' }[]>;
  token_hash: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: Date | null;
  accepted_by: string | null;
  revoked_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RecurringItemTable {
  workspace_id: string;
  id: string;
  primary_entity_id: string;
  name: string;
  spec: Json<Record<string, unknown>>;
  cadence: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly';
  start_date: CalendarDateCol;
  end_date: CalendarDateCol | null;
  next_date: CalendarDateCol;
  auto_create: Generated<'scheduled' | 'posted'>;
  status: Generated<'active' | 'paused' | 'ended'>;
  detected: Generated<boolean>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WorkspaceKeyTable {
  workspace_id: string;
  key_version: Generated<number>;
  wrapped_key: Buffer;
  created_at: Generated<Date>;
}

export interface AccountVisibilityTable {
  workspace_id: string;
  user_id: string;
  ledger_account_id: string;
  hidden: Generated<boolean>;
}

export interface SessionDeviceTable {
  user_id: string;
  kratos_session_id: string;
  user_agent: string | null;
  ip_address: string | null;
  first_seen_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

export interface EmailChangeRequestTable {
  id: Generated<string>;
  user_id: string;
  new_email: string;
  old_code_hash: string;
  new_code_hash: string;
  old_confirmed_at: Date | null;
  new_confirmed_at: Date | null;
  attempts: Generated<number>;
  expires_at: Generated<Date>;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Generated<Date>;
}

export interface MfaResetRequestTable {
  id: Generated<string>;
  user_id: string;
  requested_at: Generated<Date>;
  eligible_at: Generated<Date>;
  status: Generated<'pending' | 'cancelled' | 'completed'>;
  closed_at: Date | null;
}

export interface FileTable {
  workspace_id: string;
  id: string;
  kind: 'statement' | 'receipt' | 'payslip' | 'lease' | 'invoice' | 'export' | 'other';
  storage_key: string;
  file_name: string;
  mime: string;
  bytes: Int8;
  sha256: string;
  uploaded_by: string | null;
  created_at: Generated<Date>;
  deleted_at: Date | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobTable {
  id: Generated<string>;
  workspace_id: string | null;
  queue: 'import' | 'doc' | 'schedule' | 'ai' | 'report' | 'notify';
  type: string;
  payload: Json<Record<string, unknown>>;
  status: Generated<JobStatus>;
  priority: Generated<number>;
  run_after: Generated<Date>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  locked_by: string | null;
  locked_at: Date | null;
  progress: number | null;
  result: Json<Record<string, unknown>> | null;
  error: string | null;
  then_job: Json<{ queue: string; type: string; payload: Record<string, unknown> }> | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  finished_at: Date | null;
}

export interface ImportProfileTable {
  workspace_id: string;
  id: string;
  name: string;
  institution: string | null;
  fingerprint: string;
  mapping: Json<Record<string, unknown>>;
  ledger_account_id: string | null;
  use_count: Generated<number>;
  last_used_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ImportBatchStatus =
  'uploaded' | 'parsing' | 'needs_mapping' | 'preview' | 'committing' | 'committed' | 'failed' | 'undone';

export interface ImportBatchTable {
  workspace_id: string;
  id: string;
  entity_id: string;
  ledger_account_id: string;
  file_id: string;
  file_name: string;
  file_type: 'csv' | 'xlsx' | 'xls' | 'pdf';
  profile_id: string | null;
  fingerprint: string | null;
  mapping: Json<Record<string, unknown>> | null;
  mapping_source: 'profile' | 'reference' | 'heuristic' | 'user' | null;
  mapping_confidence: string | null;
  status: Generated<ImportBatchStatus>;
  currency: string;
  rows_read: Generated<number>;
  rows_added: Generated<number>;
  rows_matched: Generated<number>;
  rows_skipped: Generated<number>;
  rows_failed: Generated<number>;
  min_date: CalendarDateCol | null;
  max_date: CalendarDateCol | null;
  statement_opening_minor: Int8 | null;
  statement_closing_minor: Int8 | null;
  balance_check: Generated<'ok' | 'mismatch' | 'n_a'>;
  balance_gap_minor: Int8 | null;
  warnings: Json<string[]>;
  analysis: Json<Record<string, unknown>> | null;
  job_id: string | null;
  error: string | null;
  committed_at: Date | null;
  undo_until: Date | null;
  undone_at: Date | null;
  created_by: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ImportRowStatus = 'new' | 'duplicate' | 'probable_duplicate' | 'match' | 'error';

export interface ImportRowTable {
  workspace_id: string;
  id: string;
  import_batch_id: string;
  row_no: number;
  raw: Json<string[]>;
  txn_date: CalendarDateCol | null;
  amount_minor: Int8 | null;
  description: string | null;
  payee_raw: string | null;
  normalized_desc: string | null;
  balance_minor: Int8 | null;
  ordinal: Generated<number>;
  dedupe_key: string | null;
  status: ImportRowStatus;
  decision: 'import' | 'skip' | 'match' | null;
  match_transaction_id: string | null;
  duplicate_of_transaction_id: string | null;
  score: string | null;
  suggestion: Json<Record<string, unknown>> | null;
  category_id: string | null;
  error: string | null;
  outcome: 'added' | 'matched' | 'skipped' | 'failed' | null;
  transaction_id: string | null;
  created_at: Generated<Date>;
}

export interface TransactionSourceTable {
  workspace_id: string;
  transaction_id: string;
  import_row_id: string;
  import_batch_id: string;
  ledger_account_id: string;
  role: 'created' | 'matched' | 'second_leg';
  before_image: Json<Record<string, unknown>> | null;
  created_at: Generated<Date>;
}

export interface PayeeAliasTable {
  workspace_id: string;
  pattern: string;
  payee_id: string;
  created_at: Generated<Date>;
}

export interface ReconciliationTable {
  workspace_id: string;
  id: string;
  entity_id: string;
  ledger_account_id: string;
  statement_date: CalendarDateCol;
  statement_balance_minor: Int8;
  status: Generated<'in_progress' | 'completed'>;
  completed_at: Date | null;
  completed_by: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RefImportProfileTable {
  id: string;
  name: string;
  institution: string | null;
  source: 'bank' | 'app_template';
  fingerprint: string;
  mapping: Json<Record<string, unknown>>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface RefMerchantTable {
  id: string;
  display_name: string;
  match_key: string;
  mcc: string | null;
  category_hint: string | null;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface Database {
  'app.app_user': AppUserTable;
  'app.workspace': WorkspaceTable;
  'app.workspace_member': WorkspaceMemberTable;
  'app.entity': EntityTable;
  'app.entity_grant': EntityGrantTable;
  'app.family_member': FamilyMemberTable;
  'app.category_group': CategoryGroupTable;
  'app.ledger_account': LedgerAccountTable;
  'app.bank_account': BankAccountTable;
  'app.payee': PayeeTable;
  'app.tag': TagTable;
  'app.transaction': TransactionTable;
  'app.transaction_tag': TransactionTagTable;
  'app.journal_entry': JournalEntryTable;
  'app.posting': PostingTable;
  'app.period_lock': PeriodLockTable;
  'app.period_lock_event': PeriodLockEventTable;
  'app.audit_log': AuditLogTable;
  'app.change_log': ChangeLogTable;
  'app.idempotency_key': IdempotencyKeyTable;
  'app.workspace_invite': WorkspaceInviteTable;
  'app.recurring_item': RecurringItemTable;
  'app.workspace_key': WorkspaceKeyTable;
  'app.account_visibility': AccountVisibilityTable;
  'app.session_device': SessionDeviceTable;
  'app.email_change_request': EmailChangeRequestTable;
  'app.mfa_reset_request': MfaResetRequestTable;
  'app.file': FileTable;
  'app.job': JobTable;
  'app.import_profile': ImportProfileTable;
  'app.import_batch': ImportBatchTable;
  'app.import_row': ImportRowTable;
  'app.transaction_source': TransactionSourceTable;
  'app.payee_alias': PayeeAliasTable;
  'app.reconciliation': ReconciliationTable;
  'ref.import_profile': RefImportProfileTable;
  'ref.merchant': RefMerchantTable;
}

export type LedgerAccountRow = Selectable<LedgerAccountTable>;
export type NewLedgerAccount = Insertable<LedgerAccountTable>;
export type EntityRow = Selectable<EntityTable>;
export type TransactionRow = Selectable<TransactionTable>;
export type TransactionUpdate = Updateable<TransactionTable>;
export type PostingRow = Selectable<PostingTable>;
