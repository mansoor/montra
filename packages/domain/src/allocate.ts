/**
 * Splits an integer amount across weights so the parts always sum exactly to the total.
 *
 * - `largest`: each part is rounded half-up on its own, then the residual goes to the part with the
 *   largest weight (first one on ties). This is the receipt tax rule RCP-04.
 * - `largest_remainder`: Hamilton's method — floor every part, then hand out the remaining units to the
 *   parts with the largest fractional remainders. Used for even spreading (RNT-07).
 */
import { abs, divRound } from './rounding.js';

export type AllocationPolicy = 'largest' | 'largest_remainder';

export function allocate(
  total: bigint,
  weights: readonly bigint[],
  policy: AllocationPolicy = 'largest',
): bigint[] {
  if (weights.length === 0) throw new RangeError('allocate needs at least one weight');
  if (weights.some((w) => w < 0n)) throw new RangeError('allocate weights must be non-negative');
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) {
    // Nothing to weigh by: everything goes to the first part.
    return weights.map((_, i) => (i === 0 ? total : 0n));
  }

  if (policy === 'largest') {
    const parts = weights.map((w) => divRound(total * w, weightSum, 'half_up'));
    const residual = total - parts.reduce((a, b) => a + b, 0n);
    if (residual !== 0n) parts[indexOfLargest(weights)]! += residual;
    return parts;
  }

  // Hamilton / largest remainder, symmetric for negative totals.
  const sign = total < 0n ? -1n : 1n;
  const magnitude = abs(total);
  const floors = weights.map((w) => (magnitude * w) / weightSum);
  const remainders = weights.map((w, i) => magnitude * w - floors[i]! * weightSum);
  let left = magnitude - floors.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a]!;
      const rb = remainders[b]!;
      if (ra !== rb) return ra > rb ? -1 : 1;
      const wa = weights[a]!;
      const wb = weights[b]!;
      if (wa !== wb) return wa > wb ? -1 : 1;
      return a - b;
    });
  for (const i of order) {
    if (left === 0n) break;
    floors[i]! += 1n;
    left -= 1n;
  }
  return floors.map((f) => f * sign);
}

function indexOfLargest(weights: readonly bigint[]): number {
  let best = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i]! > weights[best]!) best = i;
  return best;
}
