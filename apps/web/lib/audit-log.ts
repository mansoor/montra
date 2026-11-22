/**
 * Pure helpers for the audit trails: the workspace audit log in Settings (NFR-03) and the staff log in the console
 * (OPS-01). They turn raw actions such as `posting.insert` into words, find a name for the record touched, list what
 * changed, and group the rows one save wrote.
 */
import type { AuditEntryDto } from '@montra/schemas';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Every table the audit triggers watch, plus the record types the services name. Each has `audit.subject.<type>`. */
export const AUDIT_SUBJECT_TYPES = [
  'account_move',
  'account_valuation',
  'allocation_rule',
  'asset_assignment',
  'asset_depreciation',
  'bank_account',
  'bank_feed_account',
  'bill',
  'biller',
  'budget',
  'budget_move',
  'business_asset',
  'business_party',
  'business_profile',
  'business_registration',
  'category_group',
  'contractor_time',
  'depreciation_schedule',
  'employer',
  'entity',
  'entity_grant',
  'expected_income',
  'expense_detail',
  'family_member',
  'file',
  'goal',
  'household_bill',
  'import_batch',
  'invoice',
  'journal_entry',
  'lease',
  'lease_cost',
  'lease_person',
  'leave_entry',
  'leave_policy',
  'ledger_account',
  'loan_schedule',
  'maintenance_log',
  'mileage_trip',
  'pay_run',
  'pay_schedule',
  'paycheck',
  'paycheck_day',
  'paycheck_line',
  'payee',
  'payroll_de4',
  'payroll_deposit',
  'payroll_i9',
  'payroll_i9_document',
  'payroll_person',
  'payroll_settings',
  'payroll_w4',
  'payroll_w9',
  'payslip',
  'period_lock',
  'posting',
  'property',
  'property_budget',
  'receipt',
  'reconciliation',
  'recurring_item',
  'reimbursement',
  'rent_charge',
  'rental_contact',
  'rental_reminder',
  'rule',
  'tag',
  'tax_form',
  'tenant',
  'transaction',
  'transaction_tag',
  'trip',
  'unit',
  'workspace',
  'workspace_invite',
  'workspace_member',
] as const;

/** The trigger operations, `audit.op.<op>`. */
export const AUDIT_OPS = ['insert', 'update', 'delete'] as const;
type AuditOp = (typeof AUDIT_OPS)[number];

/** Actions the services write by name, each with `audit.action.<action>`. */
export const AUDIT_ACTIONS = [
  'bank_feed.account_ignored',
  'bank_feed.account_linked',
  'bank_feed.account_unlinked',
  'business.revealed',
  'file.brought_back',
  'file.found_again',
  'file.marked_missing',
  'file.moved_to_vault',
  'file.provided_again',
  'file.vault_link_made',
  'import_batch.discarded',
  'journal_entry.unlock',
  'payroll.document_viewed',
  'payroll.form_downloaded',
  'payroll.revealed',
  'reconciliation.undo',
  'rental.revealed',
  'tax_form.file_viewed',
  'workspace.accountant_tax_forms_changed',
] as const;

/** What staff do, each with `admin.log.action.<action>`. */
export const STAFF_ACTIONS = [
  'account.close',
  'account.restore',
  'account.suspend',
  'ai_ceiling.save',
  'app_version.save',
  'flag.delete',
  'flag.save',
  'notice.create',
  'notice.end',
  'password_policy.save',
  'plan.coupon',
  'plan.give',
  'plan.move',
  'plan.price',
  'plan.price_end',
  'plan.save',
  'plan.set',
  'plan.version',
  'providers.save',
  'reference.merchant.save',
  'reference.mileage.save',
  'staff.remove',
  'staff.set',
  'support.view',
  'support_request.close',
  'trial.extend',
] as const;

/** "rent_charge" → "Rent charge"; "bank_feed.account_linked" → "Bank feed: account linked". */
export function humanize(raw: string): string {
  const words = raw
    .split('.')
    .map((part) => part.replace(/_/g, ' ').trim())
    .filter(Boolean)
    .join(': ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isOneOf = <L extends readonly string[]>(list: L, v: string): v is L[number] =>
  (list as readonly string[]).includes(v);

/** The record type in words. */
export function subjectTypeLabel(type: string, t: T): string {
  return isOneOf(AUDIT_SUBJECT_TYPES, type) ? t(`audit.subject.${type}`) : humanize(type);
}

/** A trigger row's operation, or null for an action a service named. */
export function triggerOp(action: string, subjectType: string): AuditOp | null {
  const op = action.slice(subjectType.length + 1);
  return action.startsWith(subjectType + '.') && isOneOf(AUDIT_OPS, op) ? op : null;
}

/** The action in words: "Transaction added", "Reconciliation undone". */
export function auditActionText(entry: Pick<AuditEntryDto, 'action' | 'subjectType'>, t: T): string {
  const op = triggerOp(entry.action, entry.subjectType);
  if (op) return t(`audit.op.${op}`, { subject: subjectTypeLabel(entry.subjectType, t) });
  return isOneOf(AUDIT_ACTIONS, entry.action) ? t(`audit.action.${entry.action}`) : humanize(entry.action);
}

/** A staff action in words. */
export function staffActionText(action: string, t: T): string {
  return isOneOf(STAFF_ACTIONS, action) ? t(`admin.log.action.${action}`) : humanize(action);
}

/** Who did it. Background jobs act for someone; support acts with the owner's permission. */
export function auditWho(
  entry: Pick<AuditEntryDto, 'actorName' | 'actorType' | 'actorUserId'>,
  t: T,
): string {
  if (entry.actorType === 'worker')
    return entry.actorName ? t('audit.who.worker_for', { name: entry.actorName }) : t('audit.who.worker');
  if (entry.actorType === 'support') return t('audit.who.support');
  if (entry.actorType === 'system') return t('audit.who.system');
  if (entry.actorName) return entry.actorName;
  return entry.actorUserId ? t('audit.who.former') : t('audit.who.system');
}

const NAME_FIELDS = [
  'name',
  'display_name',
  'title',
  'description',
  'payee_raw',
  'label',
  'legal_name',
  'email',
  'invoice_number',
  'number',
  'file_name',
  'original_name',
] as const;

const asDiff = (diff: unknown): Record<string, unknown> | null =>
  diff && typeof diff === 'object' && !Array.isArray(diff) ? (diff as Record<string, unknown>) : null;

const short = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A name for the record from what the row carries: the new name for a change, else none. */
export function auditRecordName(entry: Pick<AuditEntryDto, 'diff'>): string | null {
  const diff = asDiff(entry.diff);
  if (!diff) return null;
  for (const field of NAME_FIELDS) {
    let v = diff[field];
    if (Array.isArray(v) && v.length === 2) v = v[1] ?? v[0];
    if (typeof v === 'string' && v.trim() && v !== '[redacted]') return short(v.trim());
  }
  return null;
}

/** Columns that say nothing to a person reading the log. */
const QUIET_FIELDS = new Set([
  'id',
  'workspace_id',
  'created_at',
  'updated_at',
  'version',
  'created_by',
  'updated_by',
  'field_clock',
  'search',
]);

export interface AuditChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A change to a JSON column, such as a transaction's `spec`, as the keys inside it that differ (`spec.description`),
 * so the reader doesn't compare two long blobs.
 */
function nestedChanges(field: string, before: unknown, after: unknown): AuditChange[] {
  const b = asObject(before);
  const a = asObject(after);
  if (!b || !a) return [{ field, before, after }];
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const differ = keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  return differ.length === 0
    ? [{ field, before, after }]
    : differ.map((k) => ({ field: `${field}.${k}`, before: b[k] ?? null, after: a[k] ?? null }));
}

/**
 * What changed: before and after for an update; what was added or deleted, without empty fields; an action's own
 * details. At most `max` lines.
 */
export function auditChanges(
  entry: Pick<AuditEntryDto, 'action' | 'subjectType' | 'diff'>,
  max = 30,
): AuditChange[] {
  const diff = asDiff(entry.diff);
  if (!diff) return [];
  const op = triggerOp(entry.action, entry.subjectType);
  const out: AuditChange[] = [];
  for (const [field, v] of Object.entries(diff)) {
    if (QUIET_FIELDS.has(field)) continue;
    if (op === 'update') {
      if (Array.isArray(v) && v.length === 2) out.push(...nestedChanges(field, v[0], v[1]));
      else out.push({ field, after: v });
    } else if (op === 'delete') {
      if (v !== null && v !== '') out.push({ field, before: v });
    } else if (v !== null && v !== '') out.push({ field, after: v });
  }
  return out.slice(0, max);
}

/** A field's name in words. */
export const fieldLabel = (field: string): string =>
  humanize(field.endsWith('_enc') ? field.slice(0, -4) : field.replace(/_id$/, ''));

/** A value as one short line of text. */
export function formatAuditValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return short(v, 120);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return short(JSON.stringify(v), 120);
}

export interface AuditGroup {
  key: string;
  entries: AuditEntryDto[];
}

/**
 * Rows one save wrote share its time (Postgres's `now()` is the transaction's start) and its person, so they're
 * shown together: adding a transaction writes the transaction, its journal entry and the entry's lines.
 */
export function groupAuditEntries(entries: AuditEntryDto[]): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    const head = last?.entries[0];
    if (head && head.at === e.at && head.actorUserId === e.actorUserId && head.actorType === e.actorType)
      last.entries.push(e);
    else groups.push({ key: e.id, entries: [e] });
  }
  return groups;
}
