/**
 * Receipt arithmetic (04 §7 steps 3, 5 and 7; RCP-03/04/05/07/08). Pure bigint functions in minor units of
 * the receipt currency; nothing here does I/O. Every allocation uses `allocate(…, 'largest')`, so splits
 * always sum exactly to their target.
 */
import { allocate } from './allocate.js';
import { divRound, abs, pow10 } from './rounding.js';
import type { Decimal } from './decimal.js';

/** RCP-05: a receipt validates when its parts are within ±2 minor units of the printed total. */
export const RECEIPT_TOLERANCE_MINOR = 2n;

export interface ReceiptLineAmounts {
  /** Negative for returns (RCP-08). */
  lineTotal: bigint;
  /** Line-level discount or coupon, ≥ 0, already printed against this line. */
  discount: bigint;
  taxable: boolean;
  /** Grouping key: lines with the same (category, entity, member) become one split (RCP-03/07). */
  key: string;
}

export interface ReceiptTotals {
  tax: bigint;
  /** Order-level discount, ≥ 0. */
  discount: bigint;
  fees: bigint;
  tip: bigint;
  /** The printed total; null when extraction couldn't read it. */
  total: bigint | null;
}

export interface ReceiptValidation {
  /** Σ (line total − line discount) − order discount + tax + fees + tip. */
  computed: bigint;
  /** printed total − computed; null without a printed total. */
  gap: bigint | null;
  ok: boolean;
}

export function validateReceipt(
  lines: readonly ReceiptLineAmounts[],
  totals: ReceiptTotals,
): ReceiptValidation {
  const net = lines.reduce((s, l) => s + l.lineTotal - l.discount, 0n);
  const computed = net - totals.discount + totals.tax + totals.fees + totals.tip;
  if (totals.total === null) return { computed, gap: null, ok: false };
  const gap = totals.total - computed;
  return { computed, gap, ok: abs(gap) <= RECEIPT_TOLERANCE_MINOR };
}

export interface ReceiptGroup {
  key: string;
  /** Indexes into the input lines, in receipt order. */
  lines: number[];
  /** Σ (line total − line discount). */
  subtotal: bigint;
  taxableSubtotal: bigint;
  tax: bigint;
  discount: bigint;
  fees: bigint;
  tip: bigint;
  /** subtotal + tax − discount + fees + tip. */
  total: bigint;
}

/**
 * Groups lines by key (first appearance order) and allocates the order-level amounts (RCP-04):
 * tax by each group's taxable subtotal, order discount, fees and printed tip by each group's subtotal.
 * The group totals sum exactly to `validateReceipt(...).computed`.
 */
export function groupReceipt(lines: readonly ReceiptLineAmounts[], totals: ReceiptTotals): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  const byKey = new Map<string, ReceiptGroup>();
  lines.forEach((l, i) => {
    let g = byKey.get(l.key);
    if (!g) {
      g = {
        key: l.key,
        lines: [],
        subtotal: 0n,
        taxableSubtotal: 0n,
        tax: 0n,
        discount: 0n,
        fees: 0n,
        tip: 0n,
        total: 0n,
      };
      byKey.set(l.key, g);
      groups.push(g);
    }
    g.lines.push(i);
    const net = l.lineTotal - l.discount;
    g.subtotal += net;
    if (l.taxable) g.taxableSubtotal += net;
  });
  if (groups.length === 0) return groups;

  const subtotals = groups.map((g) => g.subtotal);
  const taxable = groups.map((g) => g.taxableSubtotal);
  // Tax on a receipt with no taxable lines (or a misread flag) still has to land somewhere: by subtotal.
  const taxWeights = taxable.some((w) => w !== 0n) ? taxable : subtotals;
  const tax = allocateSigned(totals.tax, taxWeights);
  const discount = allocateSigned(totals.discount, subtotals);
  const fees = allocateSigned(totals.fees, subtotals);
  const tip = allocateSigned(totals.tip, subtotals);
  groups.forEach((g, i) => {
    g.tax = tax[i]!;
    g.discount = discount[i]!;
    g.fees = fees[i]!;
    g.tip = tip[i]!;
    g.total = g.subtotal + g.tax - g.discount + g.fees + g.tip;
  });
  return groups;
}

/**
 * `allocate` for weights that may be negative (returns, RCP-08). All-positive and all-negative weights use
 * `allocate` directly; mixed signs allocate proportionally to the signed weights, with the residual on the
 * weight of largest magnitude. Parts always sum to `total`.
 */
export function allocateSigned(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.every((w) => w >= 0n)) return allocate(total, weights, 'largest');
  if (weights.every((w) => w <= 0n))
    return allocate(
      -total,
      weights.map((w) => -w),
      'largest',
    ).map((p) => -p);
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  const largest = indexOfLargestMagnitude(weights);
  if (weightSum === 0n) return weights.map((_, i) => (i === largest ? total : 0n));
  const parts = weights.map((w) => divRound(total * w, weightSum, 'half_up'));
  parts[largest]! += total - parts.reduce((a, b) => a + b, 0n);
  return parts;
}

export type FitResult =
  | { ok: true; amounts: bigint[]; adjustment: bigint }
  | { ok: false; amounts: bigint[]; gap: bigint; reason: 'gap' | 'empty' };

export interface FitOptions {
  /** Restaurant receipts: the charged amount may exceed the receipt by up to 30% (a tip added later). */
  tipAllowed?: boolean;
  /** The group a later tip goes to (dining); otherwise the tip is spread by group totals. */
  tipGroup?: number;
}

/** 04 §7 step 6/7: a charge up to 30% above a restaurant receipt is a tip added after printing. */
export const TIP_TOLERANCE_PERCENT = 30n;

/**
 * Fits same-currency group totals to the *transaction* amount (04 §7 step 7). Within ±2 minor units the
 * difference goes to the largest group; a later tip (restaurants) goes to `tipGroup` or is spread; any
 * other gap is returned for review. Magnitudes: pass positive amounts for a purchase.
 */
export function fitToCharged(
  groupTotals: readonly bigint[],
  charged: bigint,
  options: FitOptions = {},
): FitResult {
  if (groupTotals.length === 0) return { ok: false, amounts: [], gap: charged, reason: 'empty' };
  const receiptTotal = groupTotals.reduce((a, b) => a + b, 0n);
  const gap = charged - receiptTotal;
  if (gap === 0n) return { ok: true, amounts: [...groupTotals], adjustment: 0n };
  if (abs(gap) <= RECEIPT_TOLERANCE_MINOR) {
    const amounts = [...groupTotals];
    amounts[indexOfLargestMagnitude(groupTotals)]! += gap;
    return { ok: true, amounts, adjustment: gap };
  }
  const withinTip = gap > 0n && receiptTotal > 0n && gap * 100n <= receiptTotal * TIP_TOLERANCE_PERCENT;
  if (options.tipAllowed && withinTip) {
    const amounts = [...groupTotals];
    if (options.tipGroup !== undefined && options.tipGroup >= 0 && options.tipGroup < amounts.length) {
      amounts[options.tipGroup]! += gap;
    } else {
      allocateSigned(gap, groupTotals).forEach((p, i) => (amounts[i]! += p));
    }
    return { ok: true, amounts, adjustment: gap };
  }
  return { ok: false, amounts: [...groupTotals], gap, reason: 'gap' };
}

/**
 * Converts group totals in the receipt currency to the charged amount in the account currency at the
 * implied rate (04 §7 step 7, CUR-04): allocation by the group totals is exactly conversion at
 * `charged ÷ receipt total`, with rounding residuals on the largest group (the `fx_rounding` rule stays
 * inside the split, so splits sum to the charge).
 */
export function convertGroupsAtCharge(groupTotals: readonly bigint[], charged: bigint): bigint[] {
  return allocateSigned(charged, groupTotals);
}

/** Rates are kept to 10 decimal places (`numeric(20, 10)`). */
export const RATE_SCALE = 10;

/**
 * The implied rate (home per foreign unit) from two amounts in minor units with their exponents, rounded
 * half-even to 10 places: e.g. €40.00 charged as $43.60 → 1.09.
 */
export function impliedRate(
  home: bigint,
  homeExponent: number,
  foreign: bigint,
  foreignExponent: number,
): Decimal {
  if (foreign === 0n) throw new RangeError('impliedRate needs a non-zero foreign amount');
  // (home / 10^he) / (foreign / 10^fe) × 10^RATE_SCALE
  const numerator = home * pow10(foreignExponent + RATE_SCALE);
  const denominator = foreign * pow10(homeExponent);
  return { coefficient: divRound(numerator, denominator, 'half_even'), scale: RATE_SCALE };
}

/** Relative deviation of `actual` from `expected` in basis points (1% = 100), rounded half-up. */
export function deviationBps(actual: bigint, expected: bigint): bigint {
  if (expected === 0n) throw new RangeError('deviationBps needs a non-zero expected amount');
  return divRound((actual - expected) * 10_000n, abs(expected), 'half_up');
}

/** CUR-04: a foreign receipt matches its home statement line within ±3% of the day's rate. */
export const FX_MATCH_TOLERANCE_BPS = 300n;

function indexOfLargestMagnitude(values: readonly bigint[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (abs(values[i]!) > abs(values[best]!)) best = i;
  return best;
}
