/**
 * FX valuation rules for foreign-currency accounts (ADR-0010, design 04 §2.2, CUR-06/07/08). Pure bigint
 * arithmetic in minor units; the builders in `builder.ts` apply it to postings.
 */
import { minorUnits, type CurrencyCode } from '../currency.js';
import type { Decimal } from '../decimal.js';
import { convert, type Money } from '../money.js';
import { impliedRate } from '../receipt.js';
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

/**
 * The rate a cross-currency transfer actually got (CUR-08): units of the received currency per one unit sent,
 * implied by the two amounts (10 decimal places).
 */
export function transferEffectiveRate(sent: Money, received: Money): Decimal {
  if (sent.amount <= 0n || received.amount <= 0n) {
    throw new RangeError('transferEffectiveRate needs two positive amounts');
  }
  return impliedRate(received.amount, minorUnits(received.currency), sent.amount, minorUnits(sent.currency));
}

/** A cross-currency transfer measured against the market (CUR-08), in the functional currency. */
export interface TransferFxQuote {
  /** What was sent, valued at the market rate. */
  readonly sentValue: bigint;
  /** `sentValue` minus the market value of what arrived: positive = cost, negative = better than market. */
  readonly cost: bigint;
  /** The cost as a share of `sentValue` in basis points (1% = 100), half-up; null when nothing was sent. */
  readonly costBps: bigint | null;
}

/**
 * CUR-08: both legs of a transfer valued at the day's market rates (`market.sent` and `market.received`:
 * functional units per one unit of each currency). Valuing the sent leg at market too, not at the account's
 * carrying value, keeps earlier gains on held currency out of the cost: what is left is the spread and fees.
 */
export function transferFxQuote(
  sent: Money,
  received: Money,
  functionalCurrency: CurrencyCode,
  market: { readonly sent: Decimal; readonly received: Decimal },
): TransferFxQuote {
  const sentValue =
    sent.currency === functionalCurrency
      ? sent.amount
      : convert(sent, functionalCurrency, market.sent).amount;
  const cost = transferFxCost(sentValue, received, functionalCurrency, market.received);
  return {
    sentValue,
    cost,
    costBps: sentValue === 0n ? null : divRound(cost * 10_000n, sentValue, 'half_up'),
  };
}
