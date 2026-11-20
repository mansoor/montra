/**
 * The bank feed port (ADR-0055 §1): what Montra needs from a provider, in Montra's terms. SimpleFIN Bridge is the only
 * implementation; Plaid, Teller or GoCardless would each be another adapter behind the same port ("Later providers").
 *
 * Nothing here holds a provider's raw response: adapters turn it into a `FeedSnapshot` and drop the rest (§8).
 */
import type { CalendarDate } from '@montra/domain';

/** What went wrong, for the whole feed or one institution or account (§7). */
export type FeedProblemCode =
  | 'reauth_needed'
  | 'account_failed'
  | 'missing_data'
  | 'quota_warning'
  | 'revoked'
  | 'payment_required'
  | 'unknown';

export interface FeedProblem {
  code: FeedProblemCode;
  /** The provider's words, sanitized: plain text, one line, length-capped. */
  message: string;
  /** The institution (SimpleFIN: connection) or account it is about, when it says. */
  institutionId: string | null;
  accountId: string | null;
}

export interface FeedInstitution {
  id: string;
  name: string;
  url: string | null;
}

/** A posted transaction. Positive is money in. Pending ones never get this far (§5). */
export interface FeedTransaction {
  /** The provider's id: never reused within an account, so it is the dedupe key (§5). */
  id: string;
  date: CalendarDate;
  amount: bigint;
  description: string;
  payee: string | null;
  memo: string | null;
}

export interface FeedAccount {
  id: string;
  institutionId: string | null;
  name: string;
  /** ISO 4217, or null for a custom currency: such an account can't be linked, and its amounts aren't read. */
  currency: string | null;
  balance: bigint | null;
  available: bigint | null;
  balanceDate: CalendarDate | null;
  transactions: FeedTransaction[];
  /** Rows dropped because they couldn't be read exactly (an amount with too many decimals, no id, no date). */
  rowErrors: number;
}

export interface FeedSnapshot {
  institutions: FeedInstitution[];
  accounts: FeedAccount[];
  problems: FeedProblem[];
  /** Pending rows the provider sent anyway, dropped (§5). */
  droppedPending: number;
}

/** Settings' check: whether the access works, and what each institution says. */
export interface FeedHealth {
  ok: boolean;
  problems: FeedProblem[];
}

/**
 * Failures that stop a whole request, as codes the API turns into words. `detail` carries codes only, never a URL,
 * a credential or a response body.
 */
export type BankFeedErrorCode =
  | 'invalid_token'
  | 'token_used'
  | 'not_allowed_host'
  | 'revoked'
  | 'payment_required'
  | 'unreachable'
  | 'too_large'
  | 'bad_response'
  | 'over_budget';

export class BankFeedError extends Error {
  constructor(
    readonly code: BankFeedErrorCode,
    readonly detail: string | null = null,
  ) {
    super(detail ? `bank feed: ${code} (${detail})` : `bank feed: ${code}`);
    this.name = 'BankFeedError';
  }
}

export interface BankFeedProvider {
  readonly kind: 'simplefin';
  /** Turn what the person pasted into a secret to seal. Called once; never retried on its own (§3). */
  connect(input: { setupToken: string }): Promise<{ secret: string; host: string }>;
  /** Institutions and accounts, with balances; no transactions. */
  listAccounts(secret: string): Promise<FeedSnapshot>;
  /** Transactions from `from` up to, not including, `to`, for all accounts, in one request. */
  fetchTransactions(secret: string, q: { from: CalendarDate; to: CalendarDate }): Promise<FeedSnapshot>;
  /** A cheap check for Settings. */
  health(secret: string): Promise<FeedHealth>;
}
