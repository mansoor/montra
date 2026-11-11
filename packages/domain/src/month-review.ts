/**
 * Month in review (FLOW-01, AIA-01): what changed from usual, and next month's budget from recent months. Pure: the
 * API computes the inputs, the AI only words the result (AIA-05).
 */
import { draftBudget, meanMinor } from './budget/draft.js';
import { divRound } from './rounding.js';

export interface CategoryMonth {
  categoryId: string;
  spent: bigint;
  /** Spending in the months before, oldest first; months before any data are left out. */
  before: readonly bigint[];
}

export interface CategoryChange {
  categoryId: string;
  spent: bigint;
  usual: bigint;
  /** spent − usual: positive is more than usual. */
  change: bigint;
}

/** The average of the months before, or null without any. */
export const usualOf = (before: readonly bigint[]): bigint | null =>
  before.length ? meanMinor(before) : null;

/**
 * The clearest changes from usual, up and down: at least `min` and at least a fifth of the usual amount, so small
 * categories don't crowd out the ones that matter. Biggest first, at most `count` each way.
 */
export function biggestChanges(
  rows: readonly CategoryMonth[],
  opts: { min: bigint; count?: number } = { min: 0n },
): { up: CategoryChange[]; down: CategoryChange[] } {
  const count = opts.count ?? 3;
  const all = rows.flatMap((r): CategoryChange[] => {
    const usual = usualOf(r.before);
    if (usual === null) return [];
    const change = r.spent - usual;
    const size = change < 0n ? -change : change;
    if (size === 0n || size < opts.min || size * 5n < usual) return [];
    return [{ categoryId: r.categoryId, spent: r.spent, usual, change }];
  });
  const by = (a: CategoryChange, b: CategoryChange) => {
    const x = a.change < 0n ? -a.change : a.change;
    const y = b.change < 0n ? -b.change : b.change;
    return x > y ? -1 : x < y ? 1 : 0;
  };
  return {
    up: all
      .filter((c) => c.change > 0n)
      .sort(by)
      .slice(0, count),
    down: all
      .filter((c) => c.change < 0n)
      .sort(by)
      .slice(0, count),
  };
}

export interface BudgetSuggestion {
  categoryId: string;
  /** Next period's budget now; null when the category has none. */
  current: bigint | null;
  /** The median of the recent months (BUD-02). */
  suggested: bigint;
}

/**
 * Next month's budget from recent months (BUD-02's median), where it differs from what's set by at least a tenth
 * (and `min`). Categories without a budget get one when they had spending. Biggest differences first.
 */
export function budgetSuggestions(
  lines: readonly { categoryId: string; history: readonly bigint[]; current: bigint | null }[],
  opts: { min: bigint; count?: number } = { min: 0n },
): BudgetSuggestion[] {
  const current = new Map(lines.map((l) => [l.categoryId, l.current]));
  const gap = (s: BudgetSuggestion) => {
    const d = s.suggested - (s.current ?? 0n);
    return d < 0n ? -d : d;
  };
  return draftBudget(lines.map((l) => ({ categoryId: l.categoryId, history: l.history })))
    .map((d) => ({
      categoryId: d.categoryId,
      current: current.get(d.categoryId) ?? null,
      suggested: d.suggested,
    }))
    .filter((s) => {
      if (s.suggested <= 0n) return false;
      const d = gap(s);
      return d >= opts.min && (s.current === null || s.current === 0n || d * 10n >= s.current);
    })
    .sort((a, b) => (gap(a) > gap(b) ? -1 : gap(a) < gap(b) ? 1 : 0))
    .slice(0, opts.count ?? 8);
}

/** Share of income kept (income − spending), in whole percent; null without income. */
export function keptPercent(income: bigint, spent: bigint): number | null {
  if (income <= 0n) return null;
  return Number(divRound((income - spent) * 100n, income));
}
