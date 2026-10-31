/** Small text and number helpers shared by the rule engine, the pipeline and the quick-add parser. */
import { parseDecimal, pow10, type Decimal } from '@montra/domain';

/** Collapses runs of whitespace and trims; lower-cases when `ci`. */
export function normText(s: string, ci = true): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return ci ? t.toLowerCase() : t;
}

/** Strict signed decimal ("-200.00", "5", "+3.5"). Grouping separators are not accepted in rule values. */
export function parseRuleDecimal(value: string): Decimal | null {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  try {
    return parseDecimal(value.trim());
  } catch {
    return null;
  }
}

/** Compares `minor / 10^exponent` with a decimal exactly: -1, 0 or 1. */
export function compareMinorToDecimal(minor: bigint, exponent: number, d: Decimal): number {
  const scale = Math.max(exponent, d.scale);
  const a = minor * pow10(scale - exponent);
  const b = d.coefficient * pow10(scale - d.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Word-boundary containment for lower-cased text (keywords may contain spaces). */
export function hasWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}
