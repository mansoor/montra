/**
 * Each account type's details on the phone (ADR-0023…0027). Every figure comes from the server: the synced account, or a
 * live read of its loan, statement, performance or interest. This only picks what a type shows and lays it out; no ledger
 * logic lives here.
 */
import {
  accountProfile,
  summarizeAccounts,
  withOtherAssets,
  type AccountsSummary,
  type CalendarDate,
  type SummarizableAccount,
} from '@montra/domain';
import type { AccountDto, LoanDto, NetWorthDto } from '@montra/schemas';

/** Which sections an account's screen shows, from its type and what's been set up on it. */
export interface AccountSections {
  /** A tracked loan: next payment, payoff and recording a payment (ADR-0024). */
  loan: boolean;
  /** A loan or mortgage whose payments aren't tracked yet; tracking is set up on the web. */
  untrackedLoan: boolean;
  /** An investment or retirement account's gain (ADR-0025). */
  performance: boolean;
  /** A card or line of credit's statement (ADR-0026). */
  statement: boolean;
  /** Interest earned this year on savings (ADR-0027). */
  interest: boolean;
  /** A home or car's value, loan and equity (ADR-0027). */
  asset: boolean;
  /** When money owed outside a bank is due (ADR-0027). */
  dueDate: boolean;
}

export function accountSections(account: Pick<AccountDto, 'kind' | 'loanId'>): AccountSections {
  const type = accountProfile(account.kind);
  return {
    loan: account.loanId !== null,
    untrackedLoan: account.loanId === null && type.installment,
    performance: account.kind === 'investment',
    statement: type.statement,
    interest: account.kind === 'savings',
    asset: type.details.includes('purchase'),
    dueDate: type.details.includes('dueDate'),
  };
}

/** What a home or car is worth against the loan linked to it, and against what it cost. */
export interface AssetFigures {
  value: bigint;
  loan: { name: string; owed: bigint } | null;
  equity: bigint | null;
  purchasePrice: bigint | null;
  change: bigint | null;
}

export function assetFigures(
  account: Pick<AccountDto, 'balance' | 'loanAccountId' | 'purchasePrice'>,
  accounts: readonly Pick<AccountDto, 'id' | 'name' | 'balance'>[],
): AssetFigures {
  const value = BigInt(account.balance.amount);
  const linked = account.loanAccountId ? accounts.find((a) => a.id === account.loanAccountId) : undefined;
  const loan = linked ? { name: linked.name, owed: BigInt(linked.balance.amount) } : null;
  const purchasePrice = account.purchasePrice === null ? null : BigInt(account.purchasePrice);
  return {
    value,
    loan,
    equity: loan ? value - loan.owed : null,
    purchasePrice,
    change: purchasePrice === null ? null : value - purchasePrice,
  };
}

/** Accounts a loan payment can come from: open cash accounts in the loan's books and currency, the usual one first. */
export function loanPayingAccounts<
  A extends Pick<AccountDto, 'id' | 'kind' | 'entityId' | 'currency' | 'archived'>,
>(loan: Pick<LoanDto, 'entityId' | 'currency' | 'payingAccountId'>, accounts: readonly A[]): A[] {
  return accounts
    .filter(
      (a) =>
        !a.archived &&
        a.entityId === loan.entityId &&
        a.currency === loan.currency &&
        accountProfile(a.kind).forecast === 'cash',
    )
    .sort((a, b) => Number(b.id === loan.payingAccountId) - Number(a.id === loan.payingAccountId));
}

/** A payment is dated today unless it's overdue, when it was more likely paid on its date (as on the web). */
export const loanPaymentDate = (
  next: Pick<NonNullable<LoanDto['next']>, 'date'>,
  today: CalendarDate,
): string => (next.date < today ? next.date : today);

/** Past its date with something still owed. */
export const isOverdue = (date: string | null, owed: string | bigint, today: CalendarDate): boolean =>
  date !== null && date < today && BigInt(owed) > 0n;

/** Rental properties worth counting on Accounts: your share, left out when it's nothing. */
export const countedProperties = (worth: Pick<NetWorthDto, 'properties'> | null): NetWorthDto['properties'] =>
  (worth?.properties ?? []).filter((p) => BigInt(p.value) !== 0n);

/**
 * The Accounts totals, with your share of rental properties added to what you have and to the net, so they match net
 * worth (ADR-0027). Properties are in the workspace's base currency.
 */
export function accountsWithProperties<T extends SummarizableAccount>(
  accounts: readonly T[],
  worth: Pick<NetWorthDto, 'properties' | 'currency'> | null,
): AccountsSummary<T> {
  return withOtherAssets(
    summarizeAccounts(accounts),
    countedProperties(worth).map((p) => ({ currency: worth!.currency, amount: BigInt(p.value) })),
  );
}
