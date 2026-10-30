/**
 * Amount parsing for statement columns (IMP-03): currency symbols and codes, thousands separators,
 * comma decimals, accounting parentheses, trailing minus and CR/DR markers. Always exact (bigint minor units).
 */
import { minorUnits, parseDecimal, rescale, type CurrencyCode } from '@montra/domain';

export type DecimalSeparator = '.' | ',';

const CURRENCY_NOISE = /(?:[A-Z]{3}|[$€£¥₹₩₪₫₺₴₦₱฿]|R\$|CHF|kr\.?|zł|Fr\.)/gi;

export interface CleanAmount {
  text: string;
  /** -1 for explicit debit markers (DR, -), +1 for credit markers (CR), 0 when unmarked. */
  marker: -1 | 0 | 1;
}

/** Removes symbols and markers, returning a decimal string for `parseDecimal` plus any sign marker. */
export function cleanAmount(raw: string): CleanAmount | null {
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  let marker: -1 | 0 | 1 = 0;
  const crdr = /\s*\b(CR|DR|Cr|Dr|H|S)\.?$/.exec(s);
  if (crdr) {
    marker = /^(CR|Cr|H)$/.test(crdr[1]!) ? 1 : -1;
    s = s.slice(0, crdr.index);
  }
  s = s.replace(CURRENCY_NOISE, '').replace(/\s+/g, ' ').trim();
  if (!/\d/.test(s) || /[a-z]/i.test(s)) return null;
  return { text: s, marker };
}

/** Decides the decimal separator for a column from where separators appear in its values. */
export function detectDecimalSeparator(values: string[]): DecimalSeparator {
  let comma = 0;
  let dot = 0;
  for (const raw of values.slice(0, 500)) {
    const c = cleanAmount(raw);
    if (!c) continue;
    const s = c.text.replace(/[()\-+\s]/g, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot && /,\d{1,3}$/.test(s) && !/,\d{3}$/.test(s)) comma++;
    else if (lastDot > lastComma && /\.\d{1,3}$/.test(s) && !/\.\d{3}$/.test(s)) dot++;
    else if (lastComma > lastDot && /,\d{3}$/.test(s) && lastDot >= 0)
      comma++; // 1.234,567 (3-decimal currencies)
    else if (lastDot > lastComma && /\.\d{3}$/.test(s) && lastComma >= 0) dot++;
  }
  return comma > dot ? ',' : '.';
}

/** Parses one amount into signed minor units, or null when the cell is empty or not a number. */
export function parseAmount(raw: string, currency: CurrencyCode, decimal: DecimalSeparator): bigint | null {
  const c = cleanAmount(raw);
  if (!c) return null;
  try {
    const d = parseDecimal(c.text, { decimal, group: decimal === '.' ? ", '" : ". '" });
    let minor = rescale(d, minorUnits(currency), 'half_up');
    if (c.marker === -1 && minor > 0n) minor = -minor;
    if (c.marker === 1 && minor < 0n) minor = -minor;
    return minor;
  } catch {
    return null;
  }
}

/** Share of non-empty values in a column that parse as amounts. */
export function amountRate(values: string[], decimal: DecimalSeparator): number {
  const nonEmpty = values.filter((v) => v.trim());
  if (nonEmpty.length === 0) return 0;
  return nonEmpty.filter((v) => parseAmount(v, 'USD', decimal) !== null).length / nonEmpty.length;
}
