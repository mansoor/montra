/**
 * The arithmetic behind the Home charts (FLOW-01), shared by web and phone so both say the same: the monthly
 * averages, how much of income was kept, and bar lengths. Money stays bigint; only percentages are numbers.
 */
import { divRound } from './rounding.js';

export interface MonthFlow {
  income: string;
  spending: string;
  netWorth: string;
}

export interface MonthsSummary {
  /** Full months averaged. */
  months: number;
  /** Average per month. */
  income: bigint;
  spending: bigint;
  /** The share of income kept, in whole percent; null with no income. Negative when spending ran over. */
  keptPercent: number | null;
  /** Net worth at the last point less the first. */
  netWorthChange: bigint;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Averages the full months: the current month is left out unless it's the only one, and so are months before any
 * money moved, so a new workspace isn't averaged over empty months.
 */
export function summarizeMonths(monthly: readonly MonthFlow[]): MonthsSummary {
  const netWorthChange =
    monthly.length > 1 ? BigInt(monthly[monthly.length - 1]!.netWorth) - BigInt(monthly[0]!.netWorth) : 0n;
  let full = monthly.length > 1 ? monthly.slice(0, -1) : [...monthly];
  const first = full.findIndex((m) => BigInt(m.income) !== 0n || BigInt(m.spending) !== 0n);
  full = first === -1 ? [] : full.slice(first);
  if (full.length === 0) return { months: 0, income: 0n, spending: 0n, keptPercent: null, netWorthChange };
  const income = full.reduce((t, m) => t + BigInt(m.income), 0n);
  const spending = full.reduce((t, m) => t + BigInt(m.spending), 0n);
  const n = BigInt(full.length);
  return {
    months: full.length,
    income: divRound(income, n),
    spending: divRound(spending, n),
    keptPercent: income > 0n ? Number(divRound((income - spending) * 100n, income)) : null,
    netWorthChange,
  };
}

/** Each value's length as a percent of the largest (by size), to one decimal; all zero when everything is. */
export function barShares(values: readonly bigint[]): number[] {
  const max = values.reduce((m, v) => (abs(v) > m ? abs(v) : m), 0n);
  return values.map((v) => (max === 0n ? 0 : Number(divRound(abs(v) * 1000n, max)) / 10));
}

/** `part` as a whole percent of `total`; 0 when the total is. */
export function sharePercent(part: bigint, total: bigint): number {
  return total === 0n ? 0 : Number(divRound(part * 100n, total));
}
