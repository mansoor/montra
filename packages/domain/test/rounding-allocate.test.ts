import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate, divRound } from '../src/index.js';

describe('divRound', () => {
  it.each([
    [5n, 2n, 'half_up', 3n],
    [-5n, 2n, 'half_up', -3n],
    [5n, 2n, 'half_even', 2n],
    [7n, 2n, 'half_even', 4n],
    [-7n, 2n, 'half_even', -4n],
    [7n, 3n, 'floor', 2n],
    [-7n, 3n, 'floor', -3n],
    [-7n, 3n, 'ceil', -2n],
    [7n, -2n, 'half_up', -4n],
  ] as const)('%s / %s (%s) = %s', (n, d, mode, expected) => {
    expect(divRound(n, d, mode)).toBe(expected);
  });
});

describe('allocate', () => {
  it('reproduces the receipt tax example in requirements §3.5 (RCP-04)', () => {
    // Taxable subtotals: groceries 0 (food is untaxed), electronics 12.88, clothing 8.98; tax 1.75.
    const tax = allocate(175n, [0n, 1288n, 898n], 'largest');
    expect(tax).toEqual([0n, 103n, 72n]);
    const splits = [510n + tax[0]!, 1288n + tax[1]!, 898n + tax[2]!];
    expect(splits).toEqual([510n, 1391n, 970n]);
    expect(splits.reduce((a, b) => a + b)).toBe(2871n);
  });

  it('gives the rounding residual to the largest part', () => {
    expect(allocate(100n, [1n, 1n, 1n], 'largest')).toEqual([34n, 33n, 33n]);
    expect(allocate(100n, [1n, 1n, 1n], 'largest_remainder')).toEqual([34n, 33n, 33n]);
    expect(allocate(-100n, [1n, 2n], 'largest_remainder')).toEqual([-33n, -67n]);
  });

  it('always sums exactly to the total (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 20 }),
        fc.constantFrom('largest' as const, 'largest_remainder' as const),
        (total, weights, policy) => {
          const parts = allocate(total, weights, policy);
          expect(parts).toHaveLength(weights.length);
          expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
        },
      ),
    );
  });

  it('largest_remainder keeps every part within one unit of its exact share (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 6n }), { minLength: 1, maxLength: 10 }),
        (total, weights) => {
          const ws = weights.reduce((a, b) => a + b, 0n);
          allocate(total, weights, 'largest_remainder').forEach((p, i) => {
            const exactTimesWs = total * weights[i]!;
            expect(p * ws >= exactTimesWs - ws && p * ws <= exactTimesWs + ws).toBe(true);
          });
        },
      ),
    );
  });
});
