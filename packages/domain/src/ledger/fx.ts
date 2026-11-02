/**
 * FX valuation rules for foreign-currency accounts (ADR-0010, design 04 §2.2, CUR-06/07/08). Pure bigint
 * arithmetic in minor units; the builders in `builder.ts` apply it to postings.
 */
import type { CurrencyCode } from '../currency.js';
import type { Decimal } from '../decimal.js';
import { convert, type Money } from '../money.js';
import { abs, divRound } from '../rounding.js';

/**
 * A foreign-currency account's balance just before a posting, both debit-positive: `foreign` in the
 * account currency, `functional` its carrying value in the entity's functional currency.
 */
export interface CarryingBalance {
  readonly foreign: bigint;
  readonly functional: bigint;
}

/**
 * The functional value of a posting of `amount` (account currency, debit-positive) on a foreign account
 * (ADR-0010 §2–3). `atRate` is the same posting valued at the transaction's own rate.
 *
 * - A posting that grows the position (or opens one) is recorded at the transaction's rate: `atRate`.
 * - A posting that shrinks it is valued at the average carrying rate (`functional ÷ foreign`), and closing
 *   the position takes exactly the remaining functional balance, so an account at €0 is always at $0.
 * - Whatever crosses zero opens a new position at the transaction's rate.
 *
 * The caller posts `result − atRate` as realized FX gain or loss.
 */
export function valueAtCarrying(amount: bigint, balance: CarryingBalance, atRate: bigint): bigint {
  const { foreign, functional } = balance;
  if (amount === 0n || foreign === 0n || amount > 0n === foreign > 0n) return atRate;
  // A carrying value of the opposite sign has no meaningful average rate; value at the day's rate.
  if (functional !== 0n && functional > 0n !== foreign > 0n) return atRate;
  const closes = abs(amount) >= abs(foreign);
  const reduced = closes ? -foreign : amount;
  const carried = closes ? -functional : divRound(functional * reduced, foreign, 'half_even');
  const excess = amount - reduced;
  return carried + (excess === 0n ? 0n : divRound(atRate * excess, amount, 'half_even'));
}

/**
 * Unrealized FX gain (+) or loss (−) on a foreign balance at `latestRate` (functional per account unit):
 * the balance revalued minus its carrying value (CUR-06). Reports show it; it is posted only by an
 * optional period-close `fx_revaluation` entry.
 */
export function unrealizedFx(
  balance: CarryingBalance,
  accountCurrency: CurrencyCode,
  functionalCurrency: CurrencyCode,
  latestRate: Decimal,
): bigint {
  if (accountCurrency === functionalCurrency) return 0n;
  return (
    convert({ amount: balance.foreign, currency: accountCurrency }, functionalCurrency, latestRate).amount -
    balance.functional
  );
}

/**
 * FX cost of a cross-currency transfer against the market rate (CUR-08), in the functional currency:
 * what was given (functional value of the outgoing leg, positive) minus the market value of what arrived.
 * Positive = cost (spread and fees), negative = a better-than-market rate.
 */
export function transferFxCost(
  givenFunctional: bigint,
  received: Money,
  functionalCurrency: CurrencyCode,
  marketRate: Decimal,
): bigint {
  const market =
    received.currency === functionalCurrency
      ? received.amount
      : convert(received, functionalCurrency, marketRate).amount;
  return givenFunctional - market;
}
