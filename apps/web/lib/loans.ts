/**
 * Small pure helpers for the loan screens (ADR-0024 §13, §14): the interest method a new loan starts on, Montra's own
 * split of a payment for the date it's paid (to prefill the lender's split), and the late fee to suggest.
 */
import {
  dailyInterest,
  interestDays,
  loanPaymentLate,
  type AccountKind,
  type CalendarDate,
} from '@montra/domain';
import type { LoanDto } from '@montra/api-client';

export type InterestMethod = 'monthly' | 'daily';

/**
 * Auto and personal loans charge daily simple interest; mortgages charge a month's interest at a time. Montra's only
 * installment kinds are `loan` and `mortgage`, so a `loan` starts on daily and everything else on monthly.
 */
export const defaultInterestMethod = (kind: AccountKind): InterestMethod =>
  kind === 'loan' ? 'daily' : 'monthly';

type NextPayment = NonNullable<LoanDto['next']>;

/**
 * What Montra works out for the next payment if it's paid on `date`, as the API would record it. A daily loan's
 * interest runs to that date, and the level payment's rest is principal; the last payment clears what's owed.
 */
export function expectedSplit(
  loan: Pick<LoanDto, 'interestMethod' | 'rateBps' | 'payment' | 'scheduledBalance'>,
  next: Pick<NextPayment, 'interest' | 'principal' | 'accruesFrom'>,
  date: string,
): { interest: bigint; principal: bigint } {
  if (loan.interestMethod !== 'daily' || !next.accruesFrom || !date) {
    return { interest: BigInt(next.interest), principal: BigInt(next.principal) };
  }
  const owed = BigInt(loan.scheduledBalance);
  const interest = dailyInterest(owed, loan.rateBps, interestDays(next.accruesFrom, date as CalendarDate));
  if (BigInt(next.principal) >= owed) return { interest, principal: owed };
  let principal = BigInt(loan.payment) - interest;
  if (principal < 0n) principal = 0n;
  if (principal > owed) principal = owed;
  return { interest, principal };
}

/** The late fee to suggest for paying the next payment on `date`: the loan's fee once past the grace period, else 0. */
export function suggestedLateFee(
  loan: Pick<LoanDto, 'graceDays'>,
  next: Pick<NextPayment, 'date' | 'lateFee'>,
  date: string,
): bigint {
  if (!date) return 0n;
  return loanPaymentLate(next.date, date as CalendarDate, loan.graceDays) ? BigInt(next.lateFee) : 0n;
}

/** The English-style ordinal category of a day of the month ("27th"), for `account.loan.ordinal_<category>`. */
export function ordinalCategory(day: number, locale: string): 'one' | 'two' | 'few' | 'other' {
  const c = new Intl.PluralRules(locale, { type: 'ordinal' }).select(day);
  return c === 'one' || c === 'two' || c === 'few' ? c : 'other';
}
