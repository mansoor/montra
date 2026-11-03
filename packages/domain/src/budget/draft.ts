/** Draft budget from history (BUD-02), 50/30/20 split (BUD-01) and copy helpers (BUD-09). Design 04 §8. */
import { divRound } from '../rounding.js';

/** Median of amounts; the mean of the two middle values (half up) for an even count. 0 for none. */
export function medianMinor(values: readonly bigint[]): bigint {
  if (!values.length) return 0n;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : divRound(s[mid - 1]! + s[mid]!, 2n);
}

/** Mean of amounts (half up). */
export function meanMinor(values: readonly bigint[]): bigint {
  if (!values.length) return 0n;
  return divRound(
    values.reduce((a, b) => a + b, 0n),
    BigInt(values.length),
  );
}

/**
 * Fixed vs variable: the coefficient of variation (population σ / mean) is below 0.1. Needs two or more
 * months; a single month is "variable". This is a classification, not money, so floats are fine here.
 */
export function isFixed(values: readonly bigint[]): boolean {
  if (values.length < 2) return false;
  const xs = values.map(Number);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return false;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean < 0.1;
}

export interface DraftInput {
  categoryId: string;
  /** Monthly spending, oldest first (1–3 months). Months without spending are 0. */
  history: readonly bigint[];
  /** A detected recurring bill's monthly amount, used when there is no history. */
  recurringMonthly?: bigint | null;
}

export interface DraftLine {
  categoryId: string;
  suggested: bigint;
  fixed: boolean;
  source: 'history' | 'recurring';
}

/** BUD-02: per category, the median of the last 1–3 months; recurring bills fill categories without history. */
export function draftBudget(inputs: readonly DraftInput[]): DraftLine[] {
  const out: DraftLine[] = [];
  for (const i of inputs) {
    const spent = i.history.some((v) => v !== 0n);
    if (spent) {
      const m = medianMinor(i.history);
      out.push({
        categoryId: i.categoryId,
        suggested: m > 0n ? m : 0n,
        fixed: isFixed(i.history),
        source: 'history',
      });
    } else if (i.recurringMonthly && i.recurringMonthly > 0n) {
      out.push({ categoryId: i.categoryId, suggested: i.recurringMonthly, fixed: true, source: 'recurring' });
    }
  }
  return out;
}

export type GroupKind =
  'income' | 'fixed' | 'daily' | 'fun' | 'savings' | 'debt' | 'business' | 'rental' | 'system';

export interface FiftyThirtyTwenty {
  base: bigint;
  needs: bigint;
  wants: bigint;
  savings: bigint;
  /** Percent of the base, one decimal (display only). */
  percents: { needs: number; wants: number; savings: number };
}

/** BUD-01 light view: needs = fixed + daily, wants = fun, savings = savings + debt. */
export function fiftyThirtyTwenty(base: bigint, byKind: ReadonlyMap<GroupKind, bigint>): FiftyThirtyTwenty {
  const get = (k: GroupKind) => byKind.get(k) ?? 0n;
  const needs = get('fixed') + get('daily');
  const wants = get('fun');
  const savings = get('savings') + get('debt');
  const pct = (v: bigint) => (base > 0n ? Number(divRound(v * 1000n, base)) / 10 : 0);
  return {
    base,
    needs,
    wants,
    savings,
    percents: { needs: pct(needs), wants: pct(wants), savings: pct(savings) },
  };
}

/**
 * BUD-09 copy: `last` = the previous period's assigned amounts; `avg3` = the mean of the last three
 * periods' activity (spending, not plan), floored at 0.
 */
export function copyAmounts(
  from: 'last' | 'avg3',
  previous: { assigned: ReadonlyMap<string, bigint>; activity: readonly ReadonlyMap<string, bigint>[] },
): Map<string, bigint> {
  if (from === 'last') return new Map([...previous.assigned].filter(([, v]) => v > 0n));
  const cats = new Set(previous.activity.flatMap((m) => [...m.keys()]));
  const out = new Map<string, bigint>();
  for (const c of cats) {
    const v = meanMinor(previous.activity.map((m) => m.get(c) ?? 0n));
    if (v > 0n) out.set(c, v);
  }
  return out;
}
