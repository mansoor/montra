/**
 * FX valuation rules for foreign-currency accounts (ADR-0010, design 04 §2.2, CUR-06/07/08). Pure bigint
 * arithmetic in minor units; the builders in `builder.ts` apply it to postings.
 */
import type { CalendarDate } from '../calendar-date.js';
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
 * Unrealized FX on a foreign balance, shown in a report's currency (CUR-06). The gain or loss is measured in the
 * books' functional currency at `toFunctional` (account → functional at the period end), as `unrealizedFx` does,
 * then translated at `toReport` (functional → report) when the report is in another currency.
 *
 * Zero for an account in its books' own currency. Null when a rate it needs is missing, so the caller leaves the
 * account out instead of guessing, as net worth does.
 */
export function unrealizedFxIn(
  balance: CarryingBalance,
  accountCurrency: CurrencyCode,
  functionalCurrency: CurrencyCode,
  toFunctional: Decimal | null,
  reportCurrency: CurrencyCode,
  toReport: Decimal | null,
): bigint | null {
  if (accountCurrency === functionalCurrency) return 0n;
  if (!toFunctional) return null;
  const gain = unrealizedFx(balance, accountCurrency, functionalCurrency, toFunctional);
  if (functionalCurrency === reportCurrency) return gain;
  if (!toReport) return null;
  return convert({ amount: gain, currency: functionalCurrency }, reportCurrency, toReport).amount;
}

/** A change in a set of books' net assets, in its functional currency, with the rate to the report currency that day. */
export interface TranslatedMovement {
  readonly amount: bigint;
  /** Report-currency units per one functional unit on the movement's date; null when there is none. */
  readonly rate: Decimal | null;
}

/**
 * Translation adjustment (ADR-0010 §7; IAS 21 ¶39–41, ASC 830-30): what translating a set of books kept in another
 * functional currency produces, in the report currency, beyond its own figures.
 *
 * Net assets are translated at the closing rate; what was there at the start counts at `opening.translated`, and each
 * movement since (income, expense, money in or out) at its own date's rate. The adjustment is
 *
 *   closing-rate net assets − (opening translated net assets + movements at their rates)
 *
 * With `opening.translated` the opening net assets at the opening closing rate, this is the period's adjustment
 * (other comprehensive income). With the opening at zero and every movement since the books began, or with
 * `opening.translated` the opening net assets at their own historical rates, it is the cumulative adjustment shown on
 * a balance sheet. It is shown, never posted.
 *
 * Zero when the books are in the report currency. Null when a rate it needs is missing (a movement or opening of
 * zero needs none), so the caller leaves it out instead of guessing.
 */
export function translationAdjustment(
  functionalCurrency: CurrencyCode,
  reportCurrency: CurrencyCode,
  opening: { readonly netAssets: bigint; readonly translated: bigint },
  movements: readonly TranslatedMovement[],
  closingRate: Decimal | null,
): bigint | null {
  if (functionalCurrency === reportCurrency) return 0n;
  const atRates = translateMovements(functionalCurrency, reportCurrency, movements);
  if (atRates === null) return null;
  const netAssets = movements.reduce((t, m) => t + m.amount, opening.netAssets);
  const translated = opening.translated + atRates;
  if (netAssets === 0n) return -translated;
  if (!closingRate) return null;
  return (
    convert({ amount: netAssets, currency: functionalCurrency }, reportCurrency, closingRate).amount -
    translated
  );
}

/** Movements each translated at their own date's rate and summed; null when one that isn't zero has no rate. */
function translateMovements(
  functionalCurrency: CurrencyCode,
  reportCurrency: CurrencyCode,
  movements: readonly TranslatedMovement[],
): bigint | null {
  let total = 0n;
  for (const m of movements) {
    if (m.amount === 0n) continue;
    if (!m.rate) return null;
    total += convert({ amount: m.amount, currency: functionalCurrency }, reportCurrency, m.rate).amount;
  }
  return total;
}

/**
 * The cumulative translation adjustment at each of `dates` (ADR-0010 §7), for one set of books or one account in
 * them: `movements` are its net changes in the functional currency since it began (one per day is enough), `rate`
 * the functional → report rate on a day. Walks the history once, rolling each date's adjustment forward from the one
 * before with `translationAdjustment`, the opening counted at its historical rates. A date after a movement without
 * a rate is null, and so is a date without a closing rate while anything is held.
 */
export function translationAdjustments(
  functionalCurrency: CurrencyCode,
  reportCurrency: CurrencyCode,
  movements: readonly { readonly date: CalendarDate; readonly amount: bigint }[],
  dates: readonly CalendarDate[],
  rate: (date: CalendarDate) => Decimal | null,
): Map<CalendarDate, bigint | null> {
  const out = new Map<CalendarDate, bigint | null>();
  const sorted = [...movements].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let i = 0;
  let netAssets = 0n;
  let translated: bigint | null = 0n;
  for (const d of [...new Set(dates)].sort()) {
    const period: TranslatedMovement[] = [];
    for (; i < sorted.length && sorted[i]!.date <= d; i++) {
      const m = sorted[i]!;
      if (m.amount !== 0n) period.push({ amount: m.amount, rate: rate(m.date) });
    }
    out.set(
      d,
      translated === null
        ? null
        : translationAdjustment(
            functionalCurrency,
            reportCurrency,
            { netAssets, translated },
            period,
            rate(d),
          ),
    );
    const atRates: bigint | null =
      translated === null ? null : translateMovements(functionalCurrency, reportCurrency, period);
    translated = translated === null || atRates === null ? null : translated + atRates;
    netAssets = period.reduce((t, m) => t + m.amount, netAssets);
  }
  return out;
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
