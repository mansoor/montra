/**
 * Money helpers for forms and display. All conversions go through @montra/domain (bigint minor units);
 * the UI never does float math on money.
 */
import { asCurrencyCode, formatMoney, isCurrencyCode, minorUnits, parseMoney } from '@montra/domain';

export type ParseResult = { ok: true; minor: bigint } | { ok: false; error: string };

/** Parses what a user typed in a major-unit field ("12.50", "1,234", "(5.00)") into minor units. */
export function parseAmountInput(input: string, currency: string, locale = 'en-US'): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Enter an amount' };
  if (!isCurrencyCode(currency.toUpperCase())) return { ok: false, error: `Unknown currency ${currency}` };
  const decimal = decimalSeparator(locale);
  try {
    const m = parseMoney(trimmed, currency, decimal === ',' ? { decimal: ',' } : undefined);
    return { ok: true, minor: m.amount };
  } catch (err) {
    if (err instanceof RangeError) {
      const places = minorUnits(asCurrencyCode(currency));
      return {
        ok: false,
        error: places === 0 ? `${currency} has no decimal places` : `Use at most ${places} decimal places`,
      };
    }
    return { ok: false, error: 'Enter a number, e.g. 12.50' };
  }
}

/** Formats minor units (bigint or integer string) for display, e.g. "-4210" USD → "-$42.10". */
export function formatMinor(
  amount: bigint | string,
  currency: string,
  options: { locale?: string; accounting?: boolean } = {},
): string {
  return formatMoney(
    { amount: typeof amount === 'string' ? BigInt(amount) : amount, currency: asCurrencyCode(currency) },
    { locale: options.locale, style: options.accounting ? 'accounting' : 'standard' },
  );
}

/** Minor units as a plain major-unit string for inputs, e.g. 1250n USD → "12.50". */
export function minorToInput(amount: bigint, currency: string): string {
  const exp = minorUnits(asCurrencyCode(currency));
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(exp + 1, '0');
  const int = digits.slice(0, digits.length - exp);
  const frac = exp ? '.' + digits.slice(digits.length - exp) : '';
  return (negative ? '-' : '') + int + frac;
}

export function decimalSeparator(locale: string): '.' | ',' {
  const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal');
  return part?.value === ',' ? ',' : '.';
}

/** Sums minor-unit strings per currency (for net position and totals). */
export function sumByCurrency(items: { amount: string; currency: string }[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const i of items) totals.set(i.currency, (totals.get(i.currency) ?? 0n) + BigInt(i.amount));
  return totals;
}
