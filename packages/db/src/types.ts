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
  purge_after: Date | null;
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
  storage_quota_bytes: Int8Default;
  deleted_at: Date | null;
  purge_after: Date | null;
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
  due_day: number | null;
  pay_from_account_id: string | null;
  pay_rule: string | null;
  pay_fixed_minor: Int8 | null;
  purchase_price_minor: Int8 | null;
  purchase_date: string | null;
  loan_account_id: string | null;
  due_date: string | null;
  /** Debt payoff (BUD-08): the minimum monthly payment. */
  min_payment_minor: Int8 | null;
  /** FLOW-03: the forecast warns below this balance (migration 0015). */
  low_balance_minor: Int8Default;
  plan_type: string | null;
  employer_id: string | null;
  employer_contributions: ColumnType<boolean, boolean | undefined, boolean>;
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
  source: Generated<
    | 'manual'
    | 'camera'
    | 'import'
    | 'receipt'
    | 'payslip'
    | 'recurring'
    | 'system'
    | 'feed'
    | 'invoice'
    | 'bill'
    | 'rent'
    | 'security_deposit'
    | 'loan'
  >;
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
  payee_key: string | null;
  /** How the category was chosen: { step, confidence, explanation, ruleId, suggested } (AI-06). */
  categorization: Json<Record<string, unknown>> | null;
  /** Field-group clocks for offline LWW: { group: { v, at } } (ADR-0013). */
  field_clock: Generated<Json<Record<string, { v: number; at: string }>>>;
  /** Travel mode (CUR-09). */
  trip_id: string | null;
  /** The receipt's wall-clock time, 'HH:MM:SS' (TZ-03); txn_date stays the statement date. */
  local_time: string | null;
  /** Where fx_rate came from (CUR-05, ADR-0014). */
  fx_rate_source: 'implied' | 'reference' | 'user' | null;
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
  /** The receipt line this split came from (RCP-09 item reports). */
  receipt_line_id: string | null;
  /** In a restricted entry, this line stays visible (a payslip's net deposit; migration 0017). */
  public_line: Generated<boolean>;
  /** Copied from the journal entry by trigger (migration 0015, read models). */
  restricted_member_id: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** RCP-10: receipt images are kept until this date (7 years by default). */
  retain_until: CalendarDateCol | null;
  page_count: number | null;
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

/** Switching from another app (IMP-13): the batches made from one export, and the user's plan for it. */
export interface ImportMigrationTable {
  workspace_id: string;
  id: string;
  source: string;
  plan: Json<Record<string, unknown>>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ImportBatchTable {
  workspace_id: string;
  id: string;
  entity_id: string;
  ledger_account_id: string;
  file_id: string;
  file_name: string;
  file_type: 'csv' | 'xlsx' | 'xls' | 'pdf' | 'qif' | 'ofx';
  profile_id: string | null;
  fingerprint: string | null;
  mapping: Json<Record<string, unknown>> | null;
  mapping_source: 'profile' | 'reference' | 'heuristic' | 'ai' | 'user' | null;
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
  /** The migration (switching from another app) this batch belongs to (IMP-13). */
  migration_id: string | null;
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
  member_id: string | null;
  entity_id: string | null;
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
  domain: string | null;
  logo_url: string | null;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface RuleTable {
  workspace_id: string;
  id: string;
  entity_id: string | null;
  name: string;
  scope: Generated<'transaction' | 'receipt_line'>;
  priority: Generated<number>;
  conditions: Json<Record<string, unknown>>;
  actions: Json<Record<string, unknown>>;
  origin: Generated<'user' | 'ai_suggested' | 'correction'>;
  enabled: Generated<boolean>;
  hit_count: Generated<number>;
  last_hit_at: Date | null;
  created_by: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayeeHistoryTable {
  workspace_id: string;
  id: Generated<string>;
  payee_key: string;
  amount_band: number;
  category_id: string;
  member_id: string | null;
  count: Generated<number>;
  last_used_at: Generated<Date>;
}

export interface CorrectionTable {
  workspace_id: string;
  id: Generated<string>;
  transaction_id: string;
  payee_key: string;
  field: 'category' | 'member' | 'entity';
  from_value: string | null;
  to_value: string | null;
  from_step: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface RuleSuggestionTable {
  workspace_id: string;
  id: Generated<string>;
  payee_key: string;
  name: string;
  conditions: Json<Record<string, unknown>>;
  actions: Json<Record<string, unknown>>;
  evidence: number;
  status: Generated<'pending' | 'accepted' | 'dismissed'>;
  rule_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AiCacheTable {
  workspace_id: string;
  task: string;
  key_hash: string;
  output: Json<unknown>;
  model: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
}

export interface AiEventTable {
  workspace_id: string;
  id: Generated<string>;
  task: string;
  provider: string;
  model: string;
  prompt_version: string;
  input_hash: string;
  outcome: 'ok' | 'cached' | 'off' | 'budget' | 'invalid_output' | 'provider_error' | 'refused';
  output: Json<unknown> | null;
  confidence: string | null;
  items: Generated<number>;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micro_usd: Int8Default;
  user_action: 'pending' | 'accepted' | 'edited' | 'rejected' | null;
  subject_type: string | null;
  subject_id: string | null;
  created_at: Generated<Date>;
}

export interface AiUsageTable {
  workspace_id: string;
  month: CalendarDateCol;
  calls: Generated<number>;
  cost_micro_usd: Int8Default;
}

export interface AiCredentialTable {
  workspace_id: string;
  provider: 'anthropic' | 'openai_compatible';
  key_enc: Buffer;
  last4: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AiTaskTable {
  workspace_id: string;
  id: Generated<string>;
  task: string;
  input: Json<unknown>;
  status: Generated<'pending' | 'claimed' | 'done' | 'expired'>;
  subject_type: string;
  subject_id: string;
  claimed_at: Date | null;
  result: Json<unknown> | null;
  created_at: Generated<Date>;
  expires_at: Generated<Date>;
}

export type InsightKind =
  | 'recurring'
  | 'unusual_amount'
  | 'duplicate_charge'
  | 'new_subscription'
  | 'price_increase'
  | 'separation'
  | 'capital_improvement';

export interface InsightTable {
  workspace_id: string;
  id: Generated<string>;
  kind: InsightKind;
  entity_id: string;
  transaction_id: string | null;
  payee_key: string | null;
  dedupe_key: string;
  data: Json<Record<string, unknown>>;
  status: Generated<'open' | 'dismissed' | 'accepted'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SyncOpTable {
  workspace_id: string;
  op_id: string;
  user_id: string;
  kind: string;
  result: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface PushDeviceTable {
  id: Generated<string>;
  user_id: string;
  token: string;
  platform: 'ios' | 'android';
  device_name: string | null;
  app_version: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

// ----- Phase 5: receipts and multi-currency (migration 0012, ADR-0014) -----

export interface RefCurrencyTable {
  code: string;
  minor_units: number;
  name: string;
  symbol: string | null;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export type FxRateSource = 'ecb' | 'oxr';

export interface RefFxRateTable {
  rate_date: CalendarDateCol;
  base: string;
  quote: string;
  /** numeric(20, 10) as a string: 1 base = rate quote. */
  rate: string;
  source: FxRateSource;
  fetched_at: Generated<Date>;
}

export interface TripTable {
  workspace_id: string;
  id: Generated<string>;
  name: string;
  start_date: CalendarDateCol;
  end_date: CalendarDateCol;
  currency: string;
  time_zone: string | null;
  created_by: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export type ReceiptStatus = 'processing' | 'inbox' | 'matched' | 'needs_review' | 'rejected';

export interface ReceiptTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  source: Generated<'camera' | 'upload' | 'order_import'>;
  /** Ordered: multi-shot pages and PDF invoices keep page order. */
  attachment_ids: Generated<string[]>;
  status: Generated<ReceiptStatus>;
  merchant: string | null;
  merchant_raw: string | null;
  payee_id: string | null;
  receipt_date: CalendarDateCol | null;
  local_time: string | null;
  currency: string | null;
  subtotal_minor: Int8 | null;
  tax_minor: Int8Default;
  /** Prices include the tax (VAT receipts): reported, not added (migration 0014). */
  tax_included: Generated<boolean>;
  discount_minor: Int8Default;
  fees_minor: Int8Default;
  tip_minor: Int8Default;
  total_minor: Int8 | null;
  card_last4: string | null;
  validation_gap_minor: Int8 | null;
  /** { provider, model, confidence, warnings[], mode } */
  extraction: Json<Record<string, unknown>> | null;
  transaction_id: string | null;
  match_score: string | null;
  /** [{ transactionId, score, reasons[] }] */
  match_candidates: Json<unknown[]> | null;
  fx_rate: string | null;
  trip_id: string | null;
  order_ref: string | null;
  ocr_text: string | null;
  /** Generated tsvector over merchant and OCR text (RCP-10); query it with sql, never write it. */
  search: ColumnType<string, never, never>;
  retain_until: ColumnType<string, string | undefined, string>;
  reviewed_at: Date | null;
  created_by: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface ReceiptLineTable {
  workspace_id: string;
  id: Generated<string>;
  receipt_id: string;
  line_no: number;
  raw_text: string;
  expanded_name: string | null;
  /** numeric(12, 3) as a string. */
  qty: string | null;
  unit_price_minor: Int8 | null;
  /** Negative for returns (RCP-08); is_return must agree. */
  line_total_minor: Int8;
  discount_minor: Int8Default;
  taxable: Generated<boolean>;
  is_return: Generated<boolean>;
  category_id: string | null;
  entity_id: string | null;
  member_id: string | null;
  confidence: string | null;
  categorization: Json<Record<string, unknown>> | null;
  /** Normalized printed text, for item history (RCP-03/06). */
  item_key: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReceiptFlagDismissalTable {
  workspace_id: string;
  transaction_id: string;
  dismissed_by: string | null;
  created_at: Generated<Date>;
}

// Phase 6: budgeting, goals, expected income, recommendations and read models (migration 0015, ADR-0015).

export type BudgetMethod = 'zero_based' | 'category_limits' | 'light';
export type BudgetPeriodType = 'monthly' | 'weekly' | 'biweekly';
export type RolloverMode = 'carry_surplus' | 'carry_deficit' | 'carry_both' | 'reset';

export interface BudgetTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  /** Null = the household budget (FAM-06). */
  member_id: string | null;
  name: string;
  method: Generated<BudgetMethod>;
  period_type: Generated<BudgetPeriodType>;
  /** Weekly/biweekly: the first day of a period. */
  anchor_date: CalendarDateCol | null;
  /** UP-11 light mode: savings set aside first each period. */
  revenue_target_minor: Int8 | null;
  savings_target_minor: Int8 | null;
  archived_at: Date | null;
  created_by: string | null;
  /** Bumped by every period, line and move change: the budget's concurrency token. */
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BudgetPeriodTable {
  workspace_id: string;
  id: Generated<string>;
  budget_id: string;
  start_date: CalendarDateCol;
  end_date: CalendarDateCol;
  /** BUD-03: null = derived from expected income. */
  expected_income_minor: Int8 | null;
  status: Generated<'open' | 'closed'>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BudgetLineTable {
  workspace_id: string;
  budget_period_id: string;
  category_id: string;
  assigned_minor: Int8Default;
  rollover_mode: Generated<RolloverMode>;
  updated_at: Generated<Date>;
}

export interface BudgetMoveTable {
  workspace_id: string;
  id: Generated<string>;
  budget_period_id: string;
  /** Null = "left to assign". */
  from_category_id: string | null;
  to_category_id: string | null;
  amount_minor: Int8;
  note: string | null;
  moved_by: string | null;
  moved_at: Generated<Date>;
}

export type GoalType = 'emergency_fund' | 'debt_payoff' | 'savings' | 'sinking_fund';

export interface GoalTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  member_id: string | null;
  name: string;
  type: GoalType;
  target_minor: Int8 | null;
  due_date: CalendarDateCol | null;
  category_id: string | null;
  strategy: 'snowball' | 'avalanche' | null;
  linked_account_ids: Generated<string[]>;
  extra_payment_minor: Int8 | null;
  archived_at: Date | null;
  created_by: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type IncomeCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly';

export interface ExpectedIncomeTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  member_id: string | null;
  name: string;
  source_type: 'salary' | 'business' | 'rent' | 'other';
  amount_minor: Int8;
  currency: string;
  cadence: IncomeCadence;
  next_date: CalendarDateCol;
  account_id: string | null;
  payee_key: string | null;
  /** PAY-07: follows this employer's payslips. */
  employer_id: string | null;
  active: Generated<boolean>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type RecommendationType =
  | 'REC-01'
  | 'REC-02'
  | 'REC-03'
  | 'REC-04'
  | 'REC-05'
  | 'REC-06'
  | 'REC-07'
  | 'REC-08'
  | 'REC-09'
  | 'BIZ-09'
  | 'BIZ-11';
export type RecommendationStatus = 'open' | 'accepted' | 'edited' | 'dismissed' | 'expired';

export interface RecommendationTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  budget_id: string | null;
  type: RecommendationType;
  period_start: CalendarDateCol;
  dedupe_key: string;
  payload: Json<Record<string, unknown>>;
  wording: string | null;
  status: Generated<RecommendationStatus>;
  notified_at: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Read model (trigger-maintained, select only). Zero uuid = Household / no restricted member. */
export interface CategoryActivityMonthlyTable {
  workspace_id: string;
  entity_id: string;
  ledger_account_id: string;
  month: CalendarDateCol;
  member_key: string;
  restricted: boolean;
  restricted_member_key: string;
  /** Σ functional amounts, debit positive. */
  activity_minor: Int8;
  postings: number;
}

/** Read model (trigger-maintained, select only): balance through a date = Σ delta. */
export interface AccountBalanceDailyTable {
  workspace_id: string;
  entity_id: string;
  ledger_account_id: string;
  date: CalendarDateCol;
  restricted: boolean;
  restricted_member_key: string;
  delta_minor: Int8;
  functional_delta_minor: Int8;
}

// Phase 7: employers and payslips (migration 0017, ADR-0016). Amounts are positive minor units.

export type EmployerType = 'employer' | 'freelance' | 'pension' | 'benefits' | 'other';
export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly';

export interface EmployerTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  member_id: string;
  name: string;
  type: Generated<EmployerType>;
  pay_frequency: Generated<PayFrequency>;
  deposit_account_id: string;
  payee_key: string | null;
  retirement_account_id: string | null;
  archived_at: Date | null;
  restricted: Generated<boolean>;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PayslipStatus = 'processing' | 'needs_review' | 'posted' | 'rejected';

export interface PayslipTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  employer_id: string;
  member_id: string;
  status: Generated<PayslipStatus>;
  pay_date: CalendarDateCol | null;
  period_start: CalendarDateCol | null;
  period_end: CalendarDateCol | null;
  currency: string;
  gross_minor: Int8Default;
  net_minor: Int8Default;
  employer_posted_minor: Int8Default;
  attachment_ids: Generated<string[]>;
  /** { provider, model, confidence, warnings[], mode } */
  extraction: Json<Record<string, unknown>> | null;
  transaction_id: string | null;
  /** The matched deposit's spec before the payslip took it over (restored if the payslip is deleted). */
  deposit_spec: Json<Record<string, unknown>> | null;
  /** [{ transactionId, date, amount, payee }] when more than one deposit could be this pay. */
  match_candidates: Json<unknown[]> | null;
  restricted: Generated<boolean>;
  created_by: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PayslipLineSection = 'earning' | 'pre_tax' | 'tax' | 'post_tax' | 'employer';

export interface PayslipLineTable {
  workspace_id: string;
  id: Generated<string>;
  payslip_id: string;
  line_no: number;
  section: PayslipLineSection;
  code: string;
  label: string;
  amount_minor: Int8;
  ytd_minor: Int8 | null;
  ledger_account_id: string | null;
}

export interface EmployerDepositTable {
  workspace_id: string;
  id: Generated<string>;
  employer_id: string;
  account_id: string;
  amount_minor: Int8;
  sort_order: Generated<number>;
}

export interface PayslipDepositTable {
  workspace_id: string;
  id: Generated<string>;
  payslip_id: string;
  account_id: string;
  amount_minor: Int8;
  sort_order: Generated<number>;
  transaction_id: string | null;
  deposit_spec: Json<unknown> | null;
}

export interface SavedReportTable {
  workspace_id: string;
  id: string;
  user_id: string;
  name: string;
  type: string;
  filters: Json<Record<string, unknown>>;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type NotificationChannelStatus = 'sent' | 'off' | 'capped' | 'failed' | 'none';

export interface NotificationTable {
  workspace_id: string;
  id: Generated<string>;
  user_id: string;
  type: string;
  title: string;
  body: Generated<string>;
  link: string | null;
  dedupe_key: string;
  deliver_after: Timestamp;
  email_status: NotificationChannelStatus | null;
  push_status: NotificationChannelStatus | null;
  read_at: Date | null;
  created_at: Generated<Date>;
}

export interface NotificationPrefTable {
  user_id: string;
  channels: Json<Record<string, { inApp: boolean; email: boolean; push: boolean }>>;
  quiet_start: number | null;
  quiet_end: number | null;
  daily_cap: Generated<number>;
  digest_weekday: Generated<number>;
  large_transaction_minor: Int8Default;
  low_balance_days: Generated<number>;
  import_reminder_days: Generated<number>;
  email_unsubscribed_at: Date | null;
  unsubscribe_token: Generated<string>;
  version: Int8Default;
  updated_at: Generated<Date>;
}

// Phase 11: running the service (migration 0021, ADR-0020).

export interface SubscriptionTable {
  workspace_id: string;
  plan: Generated<string>;
  status: Generated<string>;
  provider: string | null;
  customer_ref: string | null;
  subscription_ref: string | null;
  billing_interval: string | null;
  trial_end: Date | null;
  current_period_end: Date | null;
  grace_until: Date | null;
  cancel_at_period_end: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface FeatureFlagTable {
  key: string;
  enabled: Generated<boolean>;
  rollout: Generated<number>;
  note: Generated<string>;
  updated_at: Generated<Date>;
}

export interface FeatureFlagOverrideTable {
  key: string;
  workspace_id: string;
  enabled: boolean;
}

export interface SystemNoticeTable {
  id: Generated<string>;
  kind: string;
  title: string;
  body: Generated<string>;
  show_from: Generated<Date>;
  starts_at: Date | null;
  ends_at: Date | null;
  created_at: Generated<Date>;
}

export interface SystemSettingTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface SupportGrantTable {
  workspace_id: string;
  id: Generated<string>;
  granted_by: string;
  reason: Generated<string>;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface SupportRequestTable {
  id: Generated<string>;
  user_id: string;
  workspace_id: string | null;
  kind: string;
  subject: string;
  body: string;
  context: Json<Record<string, unknown>>;
  screenshot: Buffer | null;
  status: Generated<string>;
  created_at: Generated<Date>;
}

export interface AdminLogTable {
  id: Generated<string>;
  staff_id: string;
  action: string;
  subject: string | null;
  detail: Json<Record<string, unknown>>;
  at: Generated<Date>;
}

export interface ReconciliationRunTable {
  id: Generated<string>;
  finished_at: Generated<Date>;
  unbalanced_entries: number;
  read_model_gaps: number;
  sample: Json<unknown[]>;
}

export interface SecurityEventTable {
  id: Generated<string>;
  user_id: string;
  workspace_id: string | null;
  kind: string;
  detail: Json<Record<string, unknown>>;
  at: Generated<Date>;
}

export interface ExportJobTable {
  workspace_id: string;
  id: string;
  requested_by: string;
  kind: 'backup' | 'tax_package';
  entity_id: string | null;
  tax_year: number | null;
  status: Generated<'queued' | 'running' | 'ready' | 'failed' | 'expired'>;
  encrypted: Generated<boolean>;
  storage_key: string | null;
  file_name: string | null;
  bytes: Int8 | null;
  error: string | null;
  created_at: Generated<Date>;
  finished_at: Date | null;
  expires_at: Date | null;
}

export interface BackupScheduleTable {
  workspace_id: string;
  user_id: string;
  cadence: 'weekly' | 'monthly';
  destination: Generated<'email_link'>;
  next_run_on: CalendarDateCol;
  last_run_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
}

export interface RestoreJobTable {
  id: string;
  user_id: string;
  status: Generated<'uploaded' | 'ready' | 'restoring' | 'done' | 'failed'>;
  storage_key: string;
  wrapped_key: Buffer;
  preview: Json<unknown> | null;
  mode: 'new' | 'existing' | null;
  target_workspace_id: string | null;
  result: Json<unknown> | null;
  error: string | null;
  created_at: Generated<Date>;
  finished_at: Date | null;
  expires_at: Timestamp;
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
  'app.import_migration': ImportMigrationTable;
  'app.import_row': ImportRowTable;
  'app.transaction_source': TransactionSourceTable;
  'app.payee_alias': PayeeAliasTable;
  'app.reconciliation': ReconciliationTable;
  'ref.import_profile': RefImportProfileTable;
  'ref.merchant': RefMerchantTable;
  'app.rule': RuleTable;
  'app.payee_history': PayeeHistoryTable;
  'app.correction': CorrectionTable;
  'app.rule_suggestion': RuleSuggestionTable;
  'app.ai_cache': AiCacheTable;
  'app.ai_event': AiEventTable;
  'app.ai_usage': AiUsageTable;
  'app.ai_credential': AiCredentialTable;
  'app.ai_task': AiTaskTable;
  'app.insight': InsightTable;
  'app.sync_op': SyncOpTable;
  'app.push_device': PushDeviceTable;
  'ref.currency': RefCurrencyTable;
  'ref.fx_rate': RefFxRateTable;
  'app.trip': TripTable;
  'app.receipt': ReceiptTable;
  'app.receipt_line': ReceiptLineTable;
  'app.receipt_flag_dismissal': ReceiptFlagDismissalTable;
  'app.budget': BudgetTable;
  'app.budget_period': BudgetPeriodTable;
  'app.budget_line': BudgetLineTable;
  'app.budget_move': BudgetMoveTable;
  'app.goal': GoalTable;
  'app.expected_income': ExpectedIncomeTable;
  'app.recommendation': RecommendationTable;
  'app.category_activity_monthly': CategoryActivityMonthlyTable;
  'app.account_balance_daily': AccountBalanceDailyTable;
  'app.employer': EmployerTable;
  'app.payslip': PayslipTable;
  'app.payslip_line': PayslipLineTable;
  'app.employer_deposit': EmployerDepositTable;
  'app.payslip_deposit': PayslipDepositTable;
  'app.business_profile': BusinessProfileTable;
  'app.business_party': BusinessPartyTable;
  'app.invoice': InvoiceTable;
  'app.invoice_line': InvoiceLineTable;
  'app.invoice_payment': InvoicePaymentTable;
  'app.bill': BillTable;
  'app.mileage_trip': MileageTripTable;
  'app.property': PropertyTable;
  'app.unit': UnitTable;
  'app.tenant': TenantTable;
  'app.lease': LeaseTable;
  'app.lease_tenant': LeaseTenantTable;
  'app.rent_charge': RentChargeTable;
  'app.rent_payment': RentPaymentTable;
  'app.security_deposit_event': SecurityDepositEventTable;
  'app.allocation_rule': AllocationRuleTable;
  'app.loan_schedule': LoanScheduleTable;
  'app.account_valuation': AccountValuationTable;
  'app.loan_payment': LoanPaymentTable;
  'app.depreciation_schedule': DepreciationScheduleTable;
  'app.rental_reminder': RentalReminderTable;
  'app.maintenance_log': MaintenanceLogTable;
  'app.property_budget': PropertyBudgetTable;
  'app.property_budget_line': PropertyBudgetLineTable;
  'app.saved_report': SavedReportTable;
  'app.notification': NotificationTable;
  'app.notification_pref': NotificationPrefTable;
  'app.security_event': SecurityEventTable;
  'app.export_job': ExportJobTable;
  'app.backup_schedule': BackupScheduleTable;
  'app.restore_job': RestoreJobTable;
  'app.subscription': SubscriptionTable;
  'app.feature_flag': FeatureFlagTable;
  'app.feature_flag_override': FeatureFlagOverrideTable;
  'app.system_notice': SystemNoticeTable;
  'app.system_setting': SystemSettingTable;
  'app.support_grant': SupportGrantTable;
  'app.support_request': SupportRequestTable;
  'app.admin_log': AdminLogTable;
  'app.reconciliation_run': ReconciliationRunTable;
  'ref.tax_line': TaxLineTable;
  'ref.mileage_rate': MileageRateTable;
}

// Phase 8: small business (migration 0018, ADR-0017). Amounts are positive minor units.

export interface BusinessProfileTable {
  workspace_id: string;
  entity_id: string;
  legal_name: string | null;
  address: string | null;
  email: string | null;
  invoice_prefix: Generated<string>;
  next_invoice_number: Generated<number>;
  default_terms_days: Generated<number>;
  default_deposit_account_id: string | null;
  tax_rate_bps: number | null;
  tax_savings_account_id: string | null;
  receipt_threshold_minor: Int8Default;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BusinessPartyTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  kind: 'customer' | 'vendor';
  name: string;
  payee_key: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  terms_days: number | null;
  notes: string | null;
  archived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InvoiceTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  party_id: string;
  number: string;
  status: Generated<'draft' | 'sent' | 'void'>;
  issue_date: string;
  due_date: string;
  currency: string;
  subtotal_minor: Int8Default;
  tax_minor: Int8Default;
  total_minor: Int8Default;
  notes: string | null;
  pdf_file_id: string | null;
  sent_at: Date | null;
  sent_to: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InvoiceLineTable {
  workspace_id: string;
  id: Generated<string>;
  invoice_id: string;
  line_no: number;
  description: string;
  quantity_milli: Int8;
  unit_price_minor: Int8;
  tax_rate_bps: Generated<number>;
  amount_minor: Int8;
  tax_minor: Int8;
  income_account_id: string;
}

export interface InvoicePaymentTable {
  workspace_id: string;
  id: Generated<string>;
  invoice_id: string;
  entity_id: string;
  transaction_id: string;
  amount_minor: Int8;
  source: 'auto' | 'manual';
  deposit_spec: unknown;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface BillTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  party_id: string;
  reference: string | null;
  status: Generated<'open' | 'paid' | 'void'>;
  bill_date: string;
  due_date: string;
  currency: string;
  amount_minor: Int8;
  expense_account_id: string;
  notes: string | null;
  attachment_ids: Generated<string[]>;
  transaction_id: string | null;
  payment_source: 'auto' | 'manual' | null;
  payment_spec: unknown;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MileageTripTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  trip_date: string;
  origin: string | null;
  destination: string | null;
  purpose: string;
  vehicle: string | null;
  miles_tenths: number;
  tenths_of_cent: number;
  deduction_minor: Int8;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TaxLineTable {
  country: string;
  code: string;
  form: string;
  line: string;
  label: string;
  sort_order: number;
  deductible_bps: Generated<number>;
  version: Int8Default;
  updated_at: Generated<Date>;
}

export interface MileageRateTable {
  country: string;
  effective_from: string;
  tenths_of_cent: number;
  source: string;
  version: Int8Default;
  updated_at: Generated<Date>;
}

// Phase 9: rental properties (migration 0019, ADR-0018). Amounts are non-negative minor units.

export interface PropertyTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  name: string;
  address: string | null;
  type: Generated<'sfh' | 'multi_family' | 'condo' | 'str' | 'commercial'>;
  purchase_date: string | null;
  purchase_price_minor: Int8 | null;
  land_value_minor: Int8 | null;
  cash_invested_minor: Int8 | null;
  ownership_bps: Generated<number>;
  current_value_minor: Int8 | null;
  sqft: number | null;
  improvements_account_id: string | null;
  archived_at: Date | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UnitTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  property_id: string;
  label: string;
  beds: number | null;
  baths_tenths: number | null;
  sqft: number | null;
  market_rent_minor: Int8 | null;
  under_repair: Generated<boolean>;
  archived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TenantTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  payee_keys: Generated<string[]>;
  notes: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LeaseTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  property_id: string;
  unit_id: string;
  start_date: string;
  end_date: string | null;
  ended_on: string | null;
  rent_minor: Int8;
  due_day: Generated<number>;
  late_grace_days: Generated<number>;
  late_fee_flat_minor: Int8Default;
  late_fee_bps: Generated<number>;
  late_fee_cap_minor: Int8 | null;
  deposit_minor: Int8Default;
  deposit_account_id: string | null;
  attachment_ids: Generated<string[]>;
  notes: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LeaseTenantTable {
  workspace_id: string;
  lease_id: string;
  tenant_id: string;
}

export interface RentChargeTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  lease_id: string;
  kind: Generated<'rent' | 'late_fee'>;
  period_start: string;
  due_date: string;
  amount_minor: Int8;
  waived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RentPaymentTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  lease_id: string;
  transaction_id: string;
  amount_minor: Int8;
  source: 'auto' | 'manual';
  deposit_spec: unknown;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface SecurityDepositEventTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  lease_id: string;
  kind: 'received' | 'returned' | 'forfeited';
  event_date: string;
  amount_minor: Int8;
  transaction_id: string;
  deposit_spec: unknown;
  source: Generated<'auto' | 'manual'>;
  notes: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AllocationRuleTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  name: string;
  basis: 'percent' | 'units' | 'sqft';
  targets: unknown;
  archived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AccountValuationTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  account_id: string;
  value_date: string;
  value_minor: Int8;
  change_minor: Int8;
  entry_id: string | null;
  note: string | null;
  created_at: Generated<Date>;
}

export interface LoanScheduleTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  property_id: string | null;
  loan_account_id: string;
  name: string;
  principal_minor: Int8;
  rate_bps: number;
  term_months: number;
  first_payment_date: string;
  escrow_taxes_minor: Int8Default;
  escrow_insurance_minor: Int8Default;
  start_date: string | null;
  paying_account_id: string | null;
  payment_minor: Int8 | null;
  payments_before: ColumnType<number, number | undefined, number>;
  auto_record: ColumnType<boolean, boolean | undefined, boolean>;
  archived_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoanPaymentTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  loan_id: string;
  number: number;
  transaction_id: string;
  source: 'auto' | 'manual';
  deposit_spec: unknown;
  interest_minor: Int8 | null;
  principal_minor: Int8 | null;
  escrow_minor: Int8 | null;
  created_at: Generated<Date>;
}

export interface DepreciationScheduleTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  property_id: string;
  name: string;
  basis_minor: Int8;
  in_service_date: string;
  method: Generated<'SL_27_5' | 'SL_39'>;
  transaction_id: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RentalReminderTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  property_id: string | null;
  kind: 'insurance' | 'property_tax' | 'inspection' | 'other';
  title: string;
  due_date: string;
  lead_days: Generated<number>;
  done_at: Date | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MaintenanceLogTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  property_id: string;
  unit_id: string | null;
  issue: string;
  vendor: string | null;
  cost_minor: Int8 | null;
  status: Generated<'open' | 'scheduled' | 'done'>;
  reported_on: string;
  completed_on: string | null;
  attachment_ids: Generated<string[]>;
  transaction_ids: Generated<string[]>;
  notes: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PropertyBudgetTable {
  workspace_id: string;
  property_id: string;
  entity_id: string;
  capex_reserve_per_unit_minor: Int8Default;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PropertyBudgetLineTable {
  workspace_id: string;
  property_id: string;
  entity_id: string;
  category_id: string;
  amount_minor: Int8;
}

export type LedgerAccountRow = Selectable<LedgerAccountTable>;
export type NewLedgerAccount = Insertable<LedgerAccountTable>;
export type EntityRow = Selectable<EntityTable>;
export type TransactionRow = Selectable<TransactionTable>;
export type TransactionUpdate = Updateable<TransactionTable>;
export type PostingRow = Selectable<PostingTable>;
export type ReceiptRow = Selectable<ReceiptTable>;
export type ReceiptLineRow = Selectable<ReceiptLineTable>;
export type TripRow = Selectable<TripTable>;
export type BudgetRow = Selectable<BudgetTable>;
export type BusinessProfileRow = Selectable<BusinessProfileTable>;
export type BusinessPartyRow = Selectable<BusinessPartyTable>;
export type InvoiceRow = Selectable<InvoiceTable>;
export type InvoiceLineRow = Selectable<InvoiceLineTable>;
export type BillRow = Selectable<BillTable>;
export type MileageTripRow = Selectable<MileageTripTable>;
export type PropertyRow = Selectable<PropertyTable>;
export type UnitRow = Selectable<UnitTable>;
export type TenantRow = Selectable<TenantTable>;
export type LeaseRow = Selectable<LeaseTable>;
export type RentChargeRow = Selectable<RentChargeTable>;
export type LoanRow = Selectable<LoanScheduleTable>;
export type DepreciationRow = Selectable<DepreciationScheduleTable>;
export type MaintenanceRow = Selectable<MaintenanceLogTable>;
export type ReminderRow = Selectable<RentalReminderTable>;
export type BudgetPeriodRow = Selectable<BudgetPeriodTable>;
export type BudgetLineRow = Selectable<BudgetLineTable>;
export type GoalRow = Selectable<GoalTable>;
export type ExpectedIncomeRow = Selectable<ExpectedIncomeTable>;
export type RecommendationRow = Selectable<RecommendationTable>;
export type EmployerRow = Selectable<EmployerTable>;
export type PayslipRow = Selectable<PayslipTable>;
export type PayslipLineRow = Selectable<PayslipLineTable>;
