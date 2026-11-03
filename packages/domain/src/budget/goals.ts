/** Sinking funds, goal projections and debt payoff (BUD-07, BUD-08, FAM-07; design 04 §8). */
import { addMonths, parts, startOfMonth, type CalendarDate } from '../calendar-date.js';
import { divRound } from '../rounding.js';

/** Calendar months from `from`'s month through `to`'s month, inclusive (same month = 1; past = 1). */
export function monthsRemaining(from: CalendarDate, to: CalendarDate): number {
  const a = parts(from);
  const b = parts(to);
  return Math.max(1, (b.year - a.year) * 12 + (b.month - a.month) + 1);
}

/** BUD-07: `ceil((target − saved) / months remaining)`, never negative. Rounds up so the fund is never short. */
export function sinkingFundMonthly(
  target: bigint,
  saved: bigint,
  today: CalendarDate,
  due: CalendarDate,
): bigint {
  const remaining = target - saved;
  if (remaining <= 0n) return 0n;
  return divRound(remaining, BigInt(monthsRemaining(today, due)), 'ceil');
}

export interface GoalProjection {
  /** Average monthly contribution over the given months (rounded down). */
  monthlyAverage: bigint;
  /** First of the month the target is reached; null without a target or without contributions. */
  projectedCompletion: CalendarDate | null;
  /** 0–100 (one decimal), null without a target. */
  percent: number | null;
  /** Null without a due date or target. */
  onTrack: boolean | null;
}

/**
 * BUD-08: linear projection of the average contribution over the last months (oldest first, usually 3).
 * Reached targets complete "this month".
 */
export function projectGoal(
  target: bigint | null,
  saved: bigint,
  contributions: readonly bigint[],
  today: CalendarDate,
  due: CalendarDate | null = null,
): GoalProjection {
  const total = contributions.reduce((a, b) => a + b, 0n);
  const monthlyAverage = contributions.length ? divRound(total, BigInt(contributions.length), 'floor') : 0n;
  if (target === null || target <= 0n)
    return { monthlyAverage, projectedCompletion: null, percent: null, onTrack: null };
  const clamped = saved < 0n ? 0n : saved > target ? target : saved;
  const percent = Number(divRound(clamped * 1000n, target, 'floor')) / 10;
  const remaining = target - saved;
  let projectedCompletion: CalendarDate | null = null;
  if (remaining <= 0n) projectedCompletion = startOfMonth(today);
  else if (monthlyAverage > 0n) {
    const months = Number(divRound(remaining, monthlyAverage, 'ceil'));
    if (months <= 1200) projectedCompletion = addMonths(startOfMonth(today), months);
  }
  const onTrack =
    due === null ? null : projectedCompletion !== null && projectedCompletion <= startOfMonth(due);
  return { monthlyAverage, projectedCompletion, percent, onTrack };
}

// ----- Debt payoff (BUD-08) ---------------------------------------------------------------------------------

export interface Debt {
  id: string;
  /** Amount owed, positive. */
  balance: bigint;
  /** Annual percentage rate in basis points (1999 = 19.99%). */
  rateBps: number;
  /** Minimum monthly payment. */
  minPayment: bigint;
}

export interface DebtResult {
  id: string;
  /** Months until paid off (1 = paid in the first month); null if never within the horizon. */
  months: number | null;
  interest: bigint;
}

export interface PayoffPlan {
  strategy: 'snowball' | 'avalanche';
  monthlyPayment: bigint;
  /** Months until every debt is paid; null when the payments never cover the interest (or > horizon). */
  months: number | null;
  totalInterest: bigint | null;
  debts: DebtResult[];
}

/** Order debts for extra payments: snowball = smallest balance first; avalanche = highest rate first. */
function order<T extends { id: string; balance: bigint; rateBps: number }>(
  debts: T[],
  strategy: 'snowball' | 'avalanche',
): T[] {
  return [...debts].sort((a, b) => {
    if (strategy === 'snowball') {
      if (a.balance !== b.balance) return a.balance < b.balance ? -1 : 1;
      if (a.rateBps !== b.rateBps) return b.rateBps - a.rateBps;
    } else {
      if (a.rateBps !== b.rateBps) return b.rateBps - a.rateBps;
      if (a.balance !== b.balance) return a.balance < b.balance ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Month-by-month simulation: interest accrues monthly (balance × APR / 12, rounded half up), every debt
 * gets its minimum, and the extra payment plus the minimums of debts already paid off go to the first
 * debt in strategy order (the "snowball" roll-over). Order is decided once from the starting balances.
 */
export function simulatePayoff(
  debts: readonly Debt[],
  extra: bigint,
  strategy: 'snowball' | 'avalanche',
  horizonMonths = 600,
): PayoffPlan {
  const monthlyPayment = debts.reduce((s, d) => s + d.minPayment, 0n) + (extra > 0n ? extra : 0n);
  const state = order(
    debts.filter((d) => d.balance > 0n).map((d) => ({ ...d, interest: 0n, months: null as number | null })),
    strategy,
  );
  for (const d of debts) if (d.balance <= 0n) state.push({ ...d, interest: 0n, months: 0 });
  let month = 0;
  while (state.some((d) => d.balance > 0n) && month < horizonMonths) {
    month++;
    let pool = monthlyPayment;
    for (const d of state) {
      if (d.balance <= 0n) continue;
      const interest = divRound(d.balance * BigInt(d.rateBps), 120_000n);
      d.balance += interest;
      d.interest += interest;
    }
    // Minimums first, then everything left to the debts in order.
    for (const d of state) {
      if (d.balance <= 0n) continue;
      const pay = d.minPayment < d.balance ? d.minPayment : d.balance;
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of state) {
      if (pool <= 0n) break;
      if (d.balance <= 0n) continue;
      const pay = pool < d.balance ? pool : d.balance;
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of state) if (d.balance <= 0n && d.months === null) d.months = month;
  }
  const done = state.every((d) => d.balance <= 0n);
  const byId = new Map(state.map((d) => [d.id, d]));
  return {
    strategy,
    monthlyPayment,
    months: done ? month : null,
    totalInterest: done ? state.reduce((s, d) => s + d.interest, 0n) : null,
    debts: debts.map((d) => {
      const s = byId.get(d.id)!;
      return { id: d.id, months: s.months, interest: s.interest };
    }),
  };
}
