import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_KINDS, BALANCE_RANGES, PAY_RULES, PLAN_TYPES } from '@montra/domain';
import { catalogs } from '@montra/i18n';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.next', 'e2e', 'test-results', 'playwright-report']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const en = catalogs.en!;
const files = sources(ROOT).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

/** Values that dynamic keys (`t(\`prefix.${x}\`)`) can take, so every combination is checked. */
const DYNAMIC: Record<string, readonly string[]> = {
  'status.': ['operational', 'maintenance', 'incident', 'down'],
  'status.worker.': ['documents', 'jobs'],
  'ai.problem.': ['no_key', 'no_endpoint', 'not_configured'],
  'receipts.stalled.': ['documents_waiting', 'documents_failed', 'jobs_waiting', 'jobs_failed'],
  'help.status_': ['open', 'closed'],
  'admin.tab.': ['accounts', 'support', 'imports', 'ai', 'flags', 'notices', 'reference'],
  'account.kind.': [
    'checking',
    'savings',
    'credit_card',
    'cash',
    'loan',
    'mortgage',
    'line_of_credit',
    'investment',
    'asset',
    'liability',
  ],
  'account.add_kind.': ACCOUNT_KINDS,
  'account.kind_help.': ACCOUNT_KINDS,
  'account.kind_example.': ACCOUNT_KINDS,
  'account.holder.': ['bank', 'issuer', 'lender', 'provider', 'creditor'],
  'account.plan.': PLAN_TYPES,
  'card.rule_': PAY_RULES,
  'card.choice_': ['due', 'minimum', 'other'],
  'account.balance_word.': ['balance', 'value', 'owed'],
  'account.details_empty.': ['creditLimit', 'interestRate', 'lowBalance'],
  'account.history.': ['balance', 'value', 'owed'],
  'account.history.range_': BALANCE_RANGES,
  'account.history.title_': ['balance', 'value', 'owed'],
  'register.': ['balance', 'value', 'owed'],
  'account.type.': ['asset', 'liability', 'equity', 'income', 'expense'],
  'account.type_plural.': ['asset', 'liability', 'equity', 'income', 'expense'],
  'entity.type.': ['personal', 'business', 'rental'],
  'imports.status.': [
    'uploaded',
    'parsing',
    'needs_mapping',
    'preview',
    'committing',
    'committed',
    'failed',
    'undone',
  ],
  'imports.role.': [
    'ignore',
    'date',
    'description',
    'payee',
    'amount',
    'debit',
    'credit',
    'balance',
    'category',
    'reference',
  ],
  'imports.row_error.': ['invalid_date', 'invalid_amount', 'missing_amount'],
  'invoices.status.': ['draft', 'sent', 'partial', 'paid', 'overdue', 'void'],
  'bills.status.': ['open', 'overdue', 'paid', 'void'],
  'business.format_': ['csv', 'xlsx', 'quickbooks_iif', 'xero_csv'],
  'business.range_': ['month', 'quarter', 'ytd', 'last_year'],
  'business.show_': ['pnl', 'customers', 'vendors'],
  // ADR-0032: the business landing page reuses Home's period labels; ADR-0033: moving an account.
  'home.charts.range_': ['3', '6', '12', '24'],
  'account.books.': ['business', 'rental'],
  'account.move.cleared.': ['default_deposit_account', 'tax_savings_account'],
  'parties.add_': ['customer', 'vendor'],
  'parties.new_': ['customer', 'vendor'],
  'parties.empty_': ['customer', 'vendor'],
  'parties.year_total_': ['customer', 'vendor'],
  'payslips.status.': ['processing', 'needs_review', 'posted', 'rejected'],
  'payslips.section.': ['earning', 'pre_tax', 'tax', 'post_tax', 'employer'],
  'payslips.code.': [
    'salary',
    'overtime',
    'bonus',
    'commission',
    '401k',
    'hsa',
    'fsa',
    'health',
    'fed_tax',
    'state_tax',
    'local_tax',
    'social_security',
    'medicare',
    'roth_401k',
    'loan',
    'union_dues',
    'match',
  ],
  'employers.type_': ['employer', 'freelance', 'pension', 'benefits', 'other'],
  'employers.frequency_': ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'],
  'members_report.range_': ['month', 'ytd', 'last_year'],
  'imports.kept_reason.': [
    'bill',
    'invoice',
    'lease',
    'loan',
    'payslip',
    'reconciled',
    'reversed_in_open_period',
    'security_deposit',
    'transfer',
  ],
  'entities.action.': ['lock', 'unlock', 'relock'],
  'journal.kind.': [
    'standard',
    'transfer',
    'opening_balance',
    'adjustment',
    'reversal',
    'depreciation',
    'fx_revaluation',
    'closing',
    'manual',
  ],
  'members.relationship.': ['self', 'spouse_partner', 'child', 'parent', 'other'],
  'realtime.': ['connecting', 'live', 'polling'],
  'role.': ['owner', 'partner', 'viewer', 'accountant'],
  'security.group.': ['profile', 'password', 'totp', 'webauthn', 'passkey', 'lookup_secret'],
  'sharing.invite_status.': ['pending', 'accepted', 'revoked', 'expired'],
  'sharing.member_status.': ['invited', 'active', 'revoked'],
  'sharing.role_hint.': ['partner', 'viewer', 'accountant'],
  'ai.mode.': ['builtin', 'byok', 'local', 'off'],
  'ai.mode_hint.': ['builtin', 'byok', 'local', 'off'],
  'ai.model.': ['small', 'vision', 'large'],
  'ai.outcome.': ['ok', 'cached', 'off', 'budget', 'invalid_output', 'provider_error', 'refused'],
  'ai.runner.': ['inactive', 'waiting', 'ok', 'unreachable'],
  'ai.usage_state.': ['ok', 'downgraded', 'exhausted'],
  'insights.kind.': [
    'recurring',
    'unusual_amount',
    'duplicate_charge',
    'new_subscription',
    'price_increase',
    'separation',
    'capital_improvement',
  ],
  'rentals.type_': ['sfh', 'multi_family', 'condo', 'str', 'commercial'],
  'rentals.unit_': ['occupied', 'vacant', 'under_repair'],
  'rentals.method_': ['SL_27_5', 'SL_39'],
  'rentals.lease_': ['upcoming', 'active', 'ended'],
  'rentals.rent_': ['paid', 'partial', 'upcoming', 'due', 'late', 'waived'],
  'rentals.deposit_': ['received', 'returned', 'forfeited'],
  'rentals.maintenance_': ['open', 'scheduled', 'done'],
  'rentals.reminder_': ['insurance', 'property_tax', 'inspection', 'other', 'lease_end'],
  'rentals.basis_': ['percent', 'units', 'sqft'],
  'reports.type.': [
    'spending',
    'income-expense',
    'budget-actual',
    'cash-flow',
    'net-worth',
    'pnl',
    'schedule-c',
    'schedule-e',
    'general-ledger',
    'trial-balance',
    'balance-sheet',
    'by-member',
    'items',
  ],
  'reports.about.': [
    'spending',
    'income-expense',
    'budget-actual',
    'cash-flow',
    'net-worth',
    'pnl',
    'schedule-c',
    'schedule-e',
    'general-ledger',
    'trial-balance',
    'balance-sheet',
    'by-member',
    'items',
  ],
  'reports.col.': [
    'category',
    'payee',
    'tag',
    'amount',
    'share',
    'month',
    'income',
    'expense',
    'net',
    'assigned',
    'activity',
    'available',
    'inflow',
    'outflow',
    'transfers',
    'date',
    'assets',
    'liabilities',
    'net_worth',
    'line',
    'item',
    'description',
    'debit',
    'credit',
    'balance',
    'account',
    'member',
    'spending',
    'store',
    'stores',
    'lines',
  ],
  'reports.section.': [
    'income',
    'expense',
    'net',
    'assets',
    'liabilities',
    'equity',
    'retained',
    'liabilities_and_equity',
  ],
  'reports.note.': [
    'converted',
    'no_rate',
    'truncated',
    'ledger_truncated',
    'tags_overlap',
    'no_budget',
    'tax_not_advice',
    'unmapped',
    'section_labels',
  ],
  'reports.export_': ['pdf', 'csv', 'xlsx'],
  'ask.metric_': ['spending', 'income', 'net'],
  'notify.channel_': ['inApp', 'email', 'push'],
  'notify.type_': [
    'bill_due',
    'low_balance',
    'overspend_pace',
    'large_transaction',
    'rent_overdue',
    'lease_expiring',
    'reminder',
    'tax_due',
    'import_reminder',
    'monthly_review',
    'suggestion',
    'weekly_digest',
  ],
  'security.kind_': [
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
  ],
  'data.kind_': ['backup', 'tax_package'],
  'storage.kind_': ['s3', 'webdav'],
  'storage.status_': ['active', 'paused', 'failing'],
  'storage.copy_': ['pending', 'done', 'failed', 'pruned'],
  'storage.file_kind_': ['statement', 'receipt', 'payslip', 'invoice', 'lease', 'other'],
  'switch.problem_': ['unsupported_type', 'unreadable', 'no_transactions', 'needs_mapping'],
  'data.status_': ['queued', 'running', 'ready', 'failed', 'expired'],
  'trash.kind_': ['transaction', 'receipt'],
  'rules.dow.': ['0', '1', '2', '3', '4', '5', '6'],
  'rules.field.': [
    'payee',
    'description',
    'raw_description',
    'amount',
    'account',
    'entity',
    'date_dow',
    'item_text',
  ],
  'rules.op.': ['equals', 'contains', 'starts_with', 'regex', 'between', 'gt', 'lt', 'in'],
  'receipts.status.': ['processing', 'inbox', 'needs_review', 'matched', 'rejected'],
  'fx.source.': ['implied', 'reference', 'user'],
  // Phase 6: budgets, flow, goals, recommendations.
  'budget.method_': [
    'zero_based',
    'category_limits',
    'light',
    'zero_based_hint',
    'category_limits_hint',
    'light_hint',
  ],
  'budget.period_': ['monthly', 'biweekly', 'weekly'],
  'budget.rollover_': ['carry_surplus', 'carry_deficit', 'carry_both', 'reset'],
  'budget.split_': ['needs', 'wants', 'savings'],
  'budget.tab_': ['plan', 'income', 'moves'],
  'cadence.': ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'],
  'calendar.status_': ['upcoming', 'paid', 'overdue'],
  'calendar.weekday_': ['0', '1', '2', '3', '4', '5', '6'],
  'flow.kind_': ['asset', 'liability'],
  'flow.tab_': ['flow', 'forecast', 'net-worth'],
  'goal.strategy_': ['avalanche', 'snowball'],
  'goal.type_': ['emergency_fund', 'savings', 'sinking_fund', 'debt_payoff'],
  'income.source_': ['salary', 'business', 'rent', 'other'],
  'planning.priority_': ['1', '2', '3', '4', '5'],
  'rec.status_': ['open', 'accepted', 'dismissed'],
  'rec.type_': [
    'REC-01',
    'REC-02',
    'REC-03',
    'REC-04',
    'REC-05',
    'REC-06',
    'REC-07',
    'REC-08',
    'REC-09',
    'BIZ-09',
    'BIZ-11',
  ],
};

describe('message catalog coverage (TZ-06)', () => {
  it('has every literal key used in apps/web', () => {
    const missing: string[] = [];
    let count = 0;
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) {
        count++;
        if (!(m[1]! in en)) missing.push(`${path}: ${m[1]}`);
      }
      // Keys stored in tables and passed to t() later, e.g. `label: 'transactions.filter.all'`.
      for (const m of text.matchAll(/label: '([a-z0-9_]+\.[a-z0-9_.]+)'/g)) {
        if (!(m[1]! in en)) missing.push(`${path}: ${m[1]}`);
      }
    }
    expect(count).toBeGreaterThan(200);
    expect(missing).toEqual([]);
  });

  it('has every value of every dynamic key, and no unknown dynamic prefix is used', () => {
    const unknown: string[] = [];
    const missing: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\bt\(\s*`([a-z0-9_.]+)\$\{/g)) {
        const prefix = m[1]!;
        const values = DYNAMIC[prefix];
        if (!values) unknown.push(`${path}: ${prefix}`);
        else for (const v of values) if (!(prefix + v in en)) missing.push(prefix + v);
      }
    }
    expect(unknown).toEqual([]);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('keeps placeholders balanced in every message', () => {
    const broken = Object.entries(en).filter(
      ([, v]) => (v.match(/\{/g) ?? []).length !== (v.match(/\}/g) ?? []).length,
    );
    expect(broken).toEqual([]);
  });
});
