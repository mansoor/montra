/**
 * Money as bigint minor units plus an ISO 4217 currency (NFR-09, ADR-0004).
 */
import { asCurrencyCode, minorUnits, type CurrencyCode } from './currency.js';
import { decimalToString, parseDecimal, rescale, type Decimal, type DecimalFormat } from './decimal.js';
import { divRound, pow10, type RoundingMode } from './rounding.js';

export interface Money {
  readonly amount: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export const money = (amount: bigint | number | string, currency: CurrencyCode | string): Money => {
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
    throw new RangeError(`Minor-unit amount must be a safe integer, got ${amount}`);
  }
  return { amount: BigInt(amount), currency: asCurrencyCode(currency) };
};

export const zero = (currency: CurrencyCode): Money => ({ amount: 0n, currency });

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export const add = (a: Money, b: Money): Money => (same(a, b), { amount: a.amount + b.amount, currency: a.currency });
export const sub = (a: Money, b: Money): Money => (same(a, b), { amount: a.amount - b.amount, currency: a.currency });
export const negate = (a: Money): Money => ({ amount: -a.amount, currency: a.currency });
export const isZero = (a: Money): boolean => a.amount === 0n;
export const isNegative = (a: Money): boolean => a.amount < 0n;
export const equals = (a: Money, b: Money): boolean => a.currency === b.currency && a.amount === b.amount;

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  let total = 0n;
  for (const m of items) {
    if (m.currency !== currency) throw new CurrencyMismatchError(currency, m.currency);
    total += m.amount;
  }
  return { amount: total, currency };
}

/** Parses a major-unit decimal string ("12.34", "1.234,56", "(5.00)") into Money. Rejects excess precision. */
export function parseMoney(input: string, currency: CurrencyCode | string, format?: DecimalFormat): Money {
  const code = asCurrencyCode(currency);
  const d = parseDecimal(input, format);
  const exp = minorUnits(code);
  if (d.scale > exp) {
    // Allow trailing zeros beyond the exponent ("12.340" USD), reject real excess precision.
    const scaled = rescale(d, exp, 'trunc');
    if (scaled * pow10(d.scale - exp) !== d.coefficient) {
      throw new RangeError(`"${input}" has more than ${exp} decimal places for ${code}`);
    }
    return { amount: scaled, currency: code };
  }
  return { amount: rescale(d, exp), currency: code };
}

/** Major-unit decimal string without grouping, e.g. 123456n USD → "1234.56". */
export function toDecimalString(m: Money): string {
  return decimalToString({ coefficient: m.amount, scale: minorUnits(m.currency) });
}

/** Multiplies money by an exact decimal factor (tax rate, quantity) with explicit rounding. */
export function multiply(m: Money, factor: Decimal, mode: RoundingMode = 'half_up'): Money {
  return { amount: divRound(m.amount * factor.coefficient, pow10(factor.scale), mode), currency: m.currency };
}

/**
 * Converts money to another currency at `rate` (units of `to` per 1 unit of `from`), rounding to the
 * target currency's minor units. Default rounding is half-even, as used for FX (CUR-07).
 */
export function convert(m: Money, to: CurrencyCode, rate: Decimal, mode: RoundingMode = 'half_even'): Money {
  if (rate.coefficient <= 0n) throw new RangeError('Exchange rate must be positive');
  if (m.currency === to) return m;
  const expDiff = minorUnits(to) - minorUnits(m.currency);
  let numerator = m.amount * rate.coefficient;
  let denominator = pow10(rate.scale);
  if (expDiff >= 0) numerator *= pow10(expDiff);
  else denominator *= pow10(-expDiff);
  return { amount: divRound(numerator, denominator, mode), currency: to };
}

export interface FormatOptions {
  locale?: string;
  /** "accounting" renders negatives as (5.00). */
  style?: 'standard' | 'accounting';
  display?: 'symbol' | 'code' | 'narrowSymbol';
}

/** Locale-aware formatting (CUR-10). Uses Intl with an exact decimal string, never a float. */
export function formatMoney(m: Money, options: FormatOptions = {}): string {
  const exp = minorUnits(m.currency);
  const nf = new Intl.NumberFormat(options.locale ?? 'en-US', {
    style: 'currency',
    currency: m.currency,
    currencyDisplay: options.display ?? 'symbol',
    currencySign: options.style === 'accounting' ? 'accounting' : 'standard',
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  });
  // Intl.NumberFormat v3 formats numeric strings exactly; the cast is for older lib typings.
  return nf.format(toDecimalString(m) as unknown as number);
}
