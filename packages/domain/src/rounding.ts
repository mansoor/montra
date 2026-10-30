/** Integer rounding helpers. All money math is bigint; nothing here touches floating point. */

export type RoundingMode = 'half_up' | 'half_even' | 'floor' | 'ceil' | 'trunc';

export const pow10 = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pow10 expects a non-negative integer, got ${n}`);
  return 10n ** BigInt(n);
};

export const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * Divides `numerator / denominator` and rounds to an integer with the given mode.
 * `half_up` rounds half away from zero (commercial rounding), `half_even` is banker's rounding.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode = 'half_up'): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const q = numerator / denominator; // truncates toward zero
  const r = numerator % denominator; // same sign as numerator
  if (r === 0n) return q;
  const negative = numerator < 0n;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return negative ? q - 1n : q;
    case 'ceil':
      return negative ? q : q + 1n;
    case 'half_up':
    case 'half_even': {
      const twice = abs(r) * 2n;
      const away = negative ? q - 1n : q + 1n;
      if (twice > denominator) return away;
      if (twice < denominator) return q;
      if (mode === 'half_up') return away;
      return q % 2n === 0n ? q : away;
    }
  }
}
