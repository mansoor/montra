/**
 * Budget engine (design 04 §8, ADR-0015). Pure and exact: every amount is bigint minor units in the
 * budget's currency. Only user intent (assigned amounts, rollover modes, moves, income) is input; carried-in,
 * available and left to assign are computed by walking the periods in order.
 */
import type { CalendarDate } from '../calendar-date.js';

export type RolloverMode = 'carry_surplus' | 'carry_deficit' | 'carry_both' | 'reset';

export interface BudgetMove {
  /** null = left to assign. */
  from: string | null;
  to: string | null;
  amount: bigint;
}

export interface PeriodInput {
  start: CalendarDate;
  end: CalendarDate;
  /** Budgeted (take-home) income for the period: expected, with arrived items replaced by actuals. */
  income: bigint;
  /** Per category: assigned amount and rollover mode. A category absent here has assigned 0. */
  lines: ReadonlyMap<string, { assigned: bigint; rollover: RolloverMode }>;
  /** Per category: spending in the period, expense positive (refunds reduce it). */
  activity: ReadonlyMap<string, bigint>;
  moves: readonly BudgetMove[];
}

export interface LineResult {
  categoryId: string;
  carriedIn: bigint;
  assigned: bigint;
  /** Net moves into the category. */
  moved: bigint;
  activity: bigint;
  available: bigint;
  rollover: RolloverMode;
}

export interface PeriodResult {
  start: CalendarDate;
  end: CalendarDate;
  income: bigint;
  /** From the previous period: its left to assign plus whatever its categories did not carry forward. */
  carriedUnassigned: bigint;
  assigned: bigint;
  activity: bigint;
  available: bigint;
  /** Net moves out of left to assign (to categories). */
  movedFromUnassigned: bigint;
  /** income + carriedUnassigned − assigned − movedFromUnassigned. Negative = over-assigned (REC-01). */
  leftToAssign: bigint;
  lines: Map<string, LineResult>;
}

/** What a category carries into the next period (04 §8). */
export function carryForward(available: bigint, mode: RolloverMode): bigint {
  switch (mode) {
    case 'carry_surplus':
      return available > 0n ? available : 0n;
    case 'carry_deficit':
      return available < 0n ? available : 0n;
    case 'carry_both':
      return available;
    case 'reset':
      return 0n;
  }
}

/**
 * Computes the periods in order. A category's rollover mode carries forward to later periods unless a
 * later line changes it. Money is conserved: what a category doesn't carry goes back to left to assign, so
 * after every period `leftToAssign + Σ available = Σ income − Σ activity` (to date).
 */
export function computeBudget(
  periods: readonly PeriodInput[],
  opts: { defaultRollover?: RolloverMode } = {},
): PeriodResult[] {
  const defaultRollover = opts.defaultRollover ?? 'carry_surplus';
  const out: PeriodResult[] = [];
  let carried = new Map<string, bigint>(); // category → carried into the next period
  let modes = new Map<string, RolloverMode>();
  let carriedUnassigned = 0n;

  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    if (i > 0 && p.start <= periods[i - 1]!.start) throw new RangeError('Periods must be in ascending order');

    // Every category seen before stays (with assigned 0), so its line and rollover mode persist.
    const categories = new Set<string>([...modes.keys(), ...p.lines.keys(), ...p.activity.keys()]);
    const moved = new Map<string, bigint>();
    let movedFromUnassigned = 0n;
    for (const m of p.moves) {
      if (m.amount <= 0n) throw new RangeError('A move amount must be positive');
      if (m.from === m.to) throw new RangeError('A move needs two different sides');
      if (m.from === null) movedFromUnassigned += m.amount;
      else {
        moved.set(m.from, (moved.get(m.from) ?? 0n) - m.amount);
        categories.add(m.from);
      }
      if (m.to === null) movedFromUnassigned -= m.amount;
      else {
        moved.set(m.to, (moved.get(m.to) ?? 0n) + m.amount);
        categories.add(m.to);
      }
    }

    const lines = new Map<string, LineResult>();
    let assignedTotal = 0n;
    let activityTotal = 0n;
    let availableTotal = 0n;
    for (const c of [...categories].sort()) {
      const line = p.lines.get(c);
      const rollover = line?.rollover ?? modes.get(c) ?? defaultRollover;
      const carriedIn = carried.get(c) ?? 0n;
      const assigned = line?.assigned ?? 0n;
      const mv = moved.get(c) ?? 0n;
      const activity = p.activity.get(c) ?? 0n;
      const available = carriedIn + assigned + mv - activity;
      lines.set(c, { categoryId: c, carriedIn, assigned, moved: mv, activity, available, rollover });
      assignedTotal += assigned;
      activityTotal += activity;
      availableTotal += available;
    }

    const leftToAssign = p.income + carriedUnassigned - assignedTotal - movedFromUnassigned;
    out.push({
      start: p.start,
      end: p.end,
      income: p.income,
      carriedUnassigned,
      assigned: assignedTotal,
      activity: activityTotal,
      available: availableTotal,
      movedFromUnassigned,
      leftToAssign,
      lines,
    });

    // Next period: carry per rollover mode; the rest goes back to left to assign.
    const nextCarried = new Map<string, bigint>();
    const nextModes = new Map<string, RolloverMode>();
    let released = 0n;
    for (const l of lines.values()) {
      const c = carryForward(l.available, l.rollover);
      if (c !== 0n) nextCarried.set(l.categoryId, c);
      nextModes.set(l.categoryId, l.rollover);
      released += l.available - c;
    }
    carried = nextCarried;
    modes = nextModes;
    carriedUnassigned = leftToAssign + released;
  }
  return out;
}
