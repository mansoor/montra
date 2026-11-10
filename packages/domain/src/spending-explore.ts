/**
 * Explore spending (FLOW-01): a category's habits over the months shown, and what-ifs on them. Shared by web and phone
 * so both say the same. Money stays bigint; only percentages and counts per month are numbers. The month in progress
 * shows in the series but isn't averaged: it isn't over.
 */
import { divRound } from './rounding.js';
import { sharePercent } from './dashboard-charts.js';

const sum = (xs: readonly bigint[]) => xs.reduce((t, x) => t + x, 0n);
const avg = (xs: readonly bigint[]) => (xs.length ? divRound(sum(xs), BigInt(xs.length)) : 0n);
const full = <T>(xs: readonly T[]) => (xs.length > 1 ? xs.slice(0, -1) : [...xs]);

export interface CategoryStats {
  /** Over every month shown, the current one included. */
  total: bigint;
  /** Per full month. */
  average: bigint;
  /** The biggest month (by index into the series), or null when nothing was spent. */
  highest: { index: number; amount: bigint } | null;
  /** The last three full months against the full months before them (up to three); null with nothing to compare. */
  recent: bigint;
  earlier: bigint | null;
  changePercent: number | null;
  /** Of all spending in the full months, whole percent. */
  share: number;
  /** Purchases per full month, to one decimal. */
  purchasesPerMonth: number;
  /** A typical purchase: the total over the purchases; null with none. */
  typical: bigint | null;
}

export function categoryStats(
  monthly: readonly bigint[],
  counts: readonly number[],
  spending: readonly bigint[],
): CategoryStats {
  const f = full(monthly);
  const recentMonths = f.slice(-3);
  const earlierMonths = f.slice(-6, -3);
  const recent = avg(recentMonths);
  const earlier = earlierMonths.length ? avg(earlierMonths) : null;
  const max = monthly.reduce<{ index: number; amount: bigint } | null>(
    (m, v, i) => (v > 0n && (!m || v > m.amount) ? { index: i, amount: v } : m),
    null,
  );
  const fullCounts = full(counts);
  const purchases = counts.reduce((t, n) => t + n, 0);
  const total = sum(monthly);
  return {
    total,
    average: avg(f),
    highest: max,
    recent,
    earlier,
    changePercent:
      earlier !== null && earlier > 0n ? Number(divRound((recent - earlier) * 100n, earlier)) : null,
    share: sharePercent(sum(f), sum(full(spending))),
    purchasesPerMonth: fullCounts.length
      ? Number(divRound(BigInt(fullCounts.reduce((t, n) => t + n, 0)) * 10n, BigInt(fullCounts.length))) / 10
      : 0,
    typical: purchases > 0 ? divRound(total, BigInt(purchases)) : null,
  };
}

/** A what-if on one category: cut it by a percent, or cap it at an amount a month. */
export type WhatIfChange =
  { categoryId: string; cutPercent: number } | { categoryId: string; capMinor: bigint };

export interface WhatIfResult {
  /** Saved a month against the category's average, per change and in all. */
  perCategory: Array<{ categoryId: string; monthly: bigint }>;
  monthly: bigint;
  yearly: bigint;
  /** The share of income kept on average, before and after; null with no income. */
  keptBefore: number | null;
  keptAfter: number | null;
  /** Months to each goal at the average kept a month, before and after; null when never at that pace. */
  goals: Array<{ id: string; name: string; monthsBefore: number | null; monthsAfter: number | null }>;
}

const months = (remaining: bigint, perMonth: bigint): number | null =>
  remaining <= 0n ? 0 : perMonth > 0n ? Number((remaining + perMonth - 1n) / perMonth) : null;

export function whatIf(input: {
  income: readonly bigint[];
  spending: readonly bigint[];
  categories: ReadonlyArray<{ categoryId: string; monthly: readonly bigint[] }>;
  changes: readonly WhatIfChange[];
  goals?: ReadonlyArray<{ id: string; name: string; remaining: bigint }>;
}): WhatIfResult {
  const perCategory = input.changes.map((ch) => {
    const c = input.categories.find((x) => x.categoryId === ch.categoryId);
    const average = c ? avg(full(c.monthly)) : 0n;
    let saved = 0n;
    if (average > 0n) {
      if ('cutPercent' in ch) {
        const p = Math.max(0, Math.min(100, Math.trunc(ch.cutPercent)));
        saved = divRound(average * BigInt(p), 100n);
      } else saved = ch.capMinor >= 0n && ch.capMinor < average ? average - ch.capMinor : 0n;
    }
    return { categoryId: ch.categoryId, monthly: saved };
  });
  const monthly = sum(perCategory.map((x) => x.monthly));
  const inc = avg(full(input.income));
  const out = avg(full(input.spending));
  const kept = (spent: bigint) => (inc > 0n ? Number(divRound((inc - spent) * 100n, inc)) : null);
  const net = inc - out;
  return {
    perCategory,
    monthly,
    yearly: monthly * 12n,
    keptBefore: kept(out),
    keptAfter: kept(out - monthly),
    goals: (input.goals ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      monthsBefore: months(g.remaining, net),
      monthsAfter: months(g.remaining, net + monthly),
    })),
  };
}
