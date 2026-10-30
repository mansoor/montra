/**
 * Exact decimal values as (coefficient, scale): value = coefficient / 10^scale.
 * Used for exchange rates, percentages and quantities. Parsed from strings, never from numbers.
 */
import { divRound, pow10, type RoundingMode } from './rounding.js';

export interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export interface DecimalFormat {
  /** Decimal separator, '.' by default. */
  decimal?: '.' | ',';
  /** Grouping separator(s) to ignore, e.g. ',' or '.' or ' ' or "'". Defaults to the opposite of `decimal` plus spaces. */
  group?: string;
}

const MAX_SCALE = 18;

/**
 * Parses a decimal string such as "1,234.56", "-0.5", "(12.30)" (accounting negative), "1.234,56" (with
 * `decimal: ','`), "+3", "1 000,5". Throws on anything ambiguous or malformed.
 */
export function parseDecimal(input: string, format: DecimalFormat = {}): Decimal {
  const decimalSep = format.decimal ?? '.';
  const groups = format.group ?? (decimalSep === '.' ? ',' : '.');
  let s = input.trim().replace(/[\s\u00a0\u202f]/g, '');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-') || s.startsWith('\u2212')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  for (const g of groups) s = s.split(g).join('');
  if (decimalSep === ',') s = s.replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new SyntaxError(`Not a decimal number: "${input}"`);
  const [intPart = '', fracPart = ''] = s.split('.');
  if (fracPart.length > MAX_SCALE) throw new RangeError(`Too many decimal places: "${input}"`);
  const coefficient = BigInt((intPart || '0') + fracPart);
  return { coefficient: negative ? -coefficient : coefficient, scale: fracPart.length };
}

export function decimalToString(d: Decimal): string {
  const negative = d.coefficient < 0n;
  const digits = (negative ? -d.coefficient : d.coefficient).toString().padStart(d.scale + 1, '0');
  const intPart = digits.slice(0, digits.length - d.scale);
  const frac = d.scale > 0 ? '.' + digits.slice(digits.length - d.scale) : '';
  return (negative ? '-' : '') + intPart + frac;
}

/** Rescales a decimal to `scale` digits with the given rounding. */
export function rescale(d: Decimal, scale: number, mode: RoundingMode = 'half_up'): bigint {
  if (scale >= d.scale) return d.coefficient * pow10(scale - d.scale);
  return divRound(d.coefficient, pow10(d.scale - scale), mode);
}

/** Multiplies an integer by a decimal and rounds to an integer: round(n × d). */
export function mulRound(n: bigint, d: Decimal, mode: RoundingMode = 'half_up'): bigint {
  return divRound(n * d.coefficient, pow10(d.scale), mode);
}

export function isZeroDecimal(d: Decimal): boolean {
  return d.coefficient === 0n;
}
