import type { CalendarDate } from '../calendar-date.js';
import type { CurrencyCode } from '../currency.js';

/** Chart-of-accounts types (DE-02). */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Accounts the system creates and posts to automatically; at most one per role per entity. */
export const SYSTEM_ROLES = [
  'opening_balance_equity',
  'uncategorized_income',
  'uncategorized_expense',
  'owner_contribution',
  'owner_draw',
  'inter_entity_clearing',
  'due_to_entity',
  'due_from_entity',
  'fx_gain_loss',
  'fx_rounding',
  'security_deposits_held',
  'bank_fees',
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const ENTITY_TYPES = ['personal', 'business', 'rental'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const JOURNAL_KINDS = [
  'standard',
  'transfer',
  'opening_balance',
  'adjustment',
  'reversal',
  'depreciation',
  'fx_revaluation',
  'closing',
  'manual',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface EntityRef {
  readonly id: string;
  readonly type: EntityType;
  readonly functionalCurrency: CurrencyCode;
}

export interface LedgerAccountRef {
  readonly id: string;
  readonly entityId: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  readonly systemRole?: SystemRole | null;
}

/** Optional dimensions carried on a posting (FAM-03, RNT tagging). Null member = Household. */
export interface PostingTags {
  readonly memberId?: string | null;
  readonly propertyId?: string | null;
  readonly unitId?: string | null;
  readonly memo?: string | null;
}

/**
 * One line of a journal entry. Sign convention: debit = positive, credit = negative.
 * `amount` is in the account's currency; `functionalAmount` is in the entity's functional currency.
 */
export interface PostingDraft extends PostingTags {
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountEntityId: string;
  readonly currency: CurrencyCode;
  readonly amount: bigint;
  readonly functionalAmount: bigint;
  /** Functional units per 1 unit of `currency`, as an exact decimal string; null when currencies match. */
  readonly fxRate: string | null;
}

export interface JournalEntryDraft {
  readonly entityId: string;
  readonly functionalCurrency: CurrencyCode;
  readonly entryDate: CalendarDate;
  readonly kind: JournalKind;
  readonly description: string;
  readonly postings: readonly PostingDraft[];
}

/** Debit-normal accounts grow with debits; credit-normal ones with credits. */
export const isDebitNormal = (type: AccountType): boolean => type === 'asset' || type === 'expense';

/**
 * Converts a debit-positive sum into the account's natural balance, e.g. a credit card with
 * postings summing to −500 (credits) has a natural balance of 500 owed. Used by the simple +/− view (DE-06).
 */
export const naturalBalance = (type: AccountType, debitPositive: bigint): bigint =>
  isDebitNormal(type) ? debitPositive : -debitPositive;

/** Accounts that hold money (shown in registers) rather than categorize it. */
export const isBalanceSheet = (type: AccountType): boolean =>
  type === 'asset' || type === 'liability' || type === 'equity';
