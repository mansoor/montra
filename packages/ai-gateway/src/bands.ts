/**
 * Amount bands (ADR-0012 §6): half-octave log-scale buckets of the absolute amount in major units, signed.
 * band = sign × (1 + floor(2·log2(max(1, |major|)))), 0 for zero. Stored in payee_history and part of the
 * AI cache key, so the formula must not change without a data migration.
 */
export function amountBand(amountMinor: bigint, exponent: number): number {
  if (amountMinor === 0n) return 0;
  const sign = amountMinor < 0n ? -1 : 1;
  const abs = amountMinor < 0n ? -amountMinor : amountMinor;
  const major = Number(abs) / 10 ** exponent;
  return sign * (1 + Math.floor(2 * Math.log2(Math.max(1, major))));
}

/** |amount| rounded to 2 significant figures, sign kept, for the model: -1234.56 → "-1200", -4.83 → "-4.8". */
export function roundedAmount(amountMinor: bigint, exponent: number): string {
  if (amountMinor === 0n) return '0';
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const digits = abs.toString().length;
  let rounded = abs;
  if (digits > 2) {
    const scale = 10n ** BigInt(digits - 2);
    rounded = ((abs + scale / 2n) / scale) * scale; // half-up on integers
  }
  const s = rounded.toString().padStart(exponent + 1, '0');
  const int = exponent > 0 ? s.slice(0, s.length - exponent) : s;
  const frac = exponent > 0 ? s.slice(s.length - exponent).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}
