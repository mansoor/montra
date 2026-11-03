/**
 * Recommendation rules (REC-01..08; design 04 §12). Pure computations: each returns the numbers and the
 * proposed actions; the API stores them, AI only words them (AIA-05), and nothing applies without the user.
 */
import { divRound } from '../rounding.js';
import { medianMinor } from './draft.js';
import type { GroupKind } from './draft.js';
import type { Pace } from './pace.js';

export interface AssignAction {
  kind: 'assign';
  categoryId: string;
  from: bigint;
  to: bigint;
}
export interface MoveAction {
  kind: 'move';
  /** null = left to assign. */
  from: string | null;
  to: string | null;
  amount: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

// ----- REC-01: planned spending > expected income -----------------------------------------------------------

export interface CutCandidate {
  categoryId: string;
  kind: GroupKind;
  assigned: bigint;
  /** Lowest sensible amount: the 3-month minimum of activity (never cut below it). */
  floor: bigint;
  /** User priority: higher = more important, cut later. */
  priority: number;
  /** Past activity ÷ assigned (3 months); categories with slack (low ratio) are cut first. */
  usageRatio: number;
}

export interface CutsResult {
  deficit: bigint;
  cuts: AssignAction[];
  covered: bigint;
  /** Deficit left after cutting every flexible category to its floor. */
  uncovered: bigint;
}

/** Cuts flexible categories (`daily`, `fun`) to their floors, in rank order, until the deficit is covered. */
export function rec01Cuts(leftToAssign: bigint, candidates: readonly CutCandidate[]): CutsResult | null {
  if (leftToAssign >= 0n) return null;
  const deficit = -leftToAssign;
  const ranked = candidates
    .filter((c) => (c.kind === 'daily' || c.kind === 'fun') && c.assigned > max(c.floor, 0n))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.usageRatio - b.usageRatio ||
        (a.kind === b.kind ? 0 : a.kind === 'fun' ? -1 : 1) ||
        (a.categoryId < b.categoryId ? -1 : 1),
    );
  let remaining = deficit;
  const cuts: AssignAction[] = [];
  for (const c of ranked) {
    if (remaining <= 0n) break;
    const cut = min(c.assigned - max(c.floor, 0n), remaining);
    cuts.push({ kind: 'assign', categoryId: c.categoryId, from: c.assigned, to: c.assigned - cut });
    remaining -= cut;
  }
  return { deficit, cuts, covered: deficit - remaining, uncovered: remaining };
}

// ----- REC-02: category on pace to overspend by ≥ 10% ------------------------------------------------------

export interface PaceLine {
  categoryId: string;
  kind: GroupKind;
  assigned: bigint;
  available: bigint;
  pace: Pace | null;
}

export interface OverspendResult {
  categoryId: string;
  /** projected − assigned. */
  overspend: bigint;
  daysLeft: number;
  /** Advice: spend this much less per day for the rest of the period (rounded up). */
  perDayReduction: bigint;
  /** Moves from categories with money to spare and no pressure (fixed bills are never sources). */
  moves: MoveAction[];
}

export function rec02Overspend(line: PaceLine, others: readonly PaceLine[]): OverspendResult | null {
  if (!line.pace || line.pace.status !== 'over') return null;
  const overspend = line.pace.projected - line.assigned;
  if (overspend <= 0n) return null;
  const daysLeft = Math.max(1, line.pace.days - line.pace.elapsed);
  const perDayReduction = divRound(overspend, BigInt(daysLeft), 'ceil');
  const sources = others
    .filter(
      (o) =>
        o.categoryId !== line.categoryId &&
        o.available > 0n &&
        o.kind !== 'fixed' &&
        o.kind !== 'debt' &&
        o.kind !== 'income' &&
        o.kind !== 'system' &&
        (!o.pace || o.pace.status === 'under'),
    )
    .map((o) => {
      // What a source can give without becoming short itself: available minus its own projected need.
      const need = o.pace ? max(o.pace.projected - (o.assigned - o.available), 0n) : 0n;
      return { o, spare: o.available - need };
    })
    .filter((s) => s.spare > 0n)
    .sort((a, b) =>
      a.spare > b.spare ? -1 : a.spare < b.spare ? 1 : a.o.categoryId < b.o.categoryId ? -1 : 1,
    );
  let remaining = overspend;
  const moves: MoveAction[] = [];
  for (const s of sources) {
    if (remaining <= 0n) break;
    const amount = min(s.spare, remaining);
    moves.push({ kind: 'move', from: s.o.categoryId, to: line.categoryId, amount });
    remaining -= amount;
  }
  return { categoryId: line.categoryId, overspend, daysLeft, perDayReduction, moves };
}

// ----- REC-03: income higher than expected ------------------------------------------------------------------

export interface SurplusTargets {
  /** Emergency fund still short of its target. */
  emergencyFund?: { goalId: string; categoryId: string | null; gap: bigint } | null;
  /** Debts with their funding category; only rates ≥ `highInterestBps` count. */
  debts?: readonly {
    goalId: string | null;
    categoryId: string | null;
    accountId: string;
    rateBps: number;
    balance: bigint;
  }[];
  goals?: readonly { goalId: string; categoryId: string | null; gap: bigint; due: string | null }[];
  /** Whatever is left (REC-03 "then fun"). */
  funCategoryId?: string | null;
  highInterestBps?: number;
}

export interface SurplusAllocation {
  target: 'emergency_fund' | 'debt' | 'goal' | 'fun' | 'unassigned';
  id: string | null;
  categoryId: string | null;
  amount: bigint;
}

/** Allocates a surplus: emergency fund to target → high-interest debt by rate → goals by due date → fun. */
export function rec03Allocate(
  actual: bigint,
  expected: bigint,
  t: SurplusTargets,
): { surplus: bigint; allocations: SurplusAllocation[] } | null {
  const surplus = actual - expected;
  if (surplus <= 0n) return null;
  let left = surplus;
  const out: SurplusAllocation[] = [];
  const give = (
    target: SurplusAllocation['target'],
    id: string | null,
    categoryId: string | null,
    cap: bigint,
  ) => {
    if (left <= 0n || cap <= 0n) return;
    const amount = min(cap, left);
    out.push({ target, id, categoryId, amount });
    left -= amount;
  };
  if (t.emergencyFund)
    give('emergency_fund', t.emergencyFund.goalId, t.emergencyFund.categoryId, t.emergencyFund.gap);
  const high = t.highInterestBps ?? 800;
  for (const d of [...(t.debts ?? [])]
    .filter((d) => d.rateBps >= high)
    .sort((a, b) => b.rateBps - a.rateBps || (a.balance < b.balance ? -1 : 1)))
    give('debt', d.goalId ?? d.accountId, d.categoryId, d.balance);
  for (const g of [...(t.goals ?? [])].sort(
    (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (a.goalId < b.goalId ? -1 : 1),
  ))
    give('goal', g.goalId, g.categoryId, g.gap);
  if (t.funCategoryId) give('fun', null, t.funCategoryId, left);
  if (left > 0n) out.push({ target: 'unassigned', id: null, categoryId: null, amount: left });
  return { surplus, allocations: out };
}

// ----- REC-04: income lower or late ------------------------------------------------------------------------

export interface BareBonesLine {
  categoryId: string;
  kind: GroupKind;
  assigned: bigint;
  /** Essentials floor for daily categories (3-month minimum); minimum payment for debt categories. */
  floor: bigint;
}

/**
 * The "bare-bones" budget: fixed bills stay, debts drop to their minimum payments, daily essentials to their
 * floor, fun and savings to zero. Returns only the lines that change.
 */
export function rec04BareBones(lines: readonly BareBonesLine[]): { cuts: AssignAction[]; saves: bigint } {
  const cuts: AssignAction[] = [];
  let saves = 0n;
  for (const l of lines) {
    let to = l.assigned;
    if (l.kind === 'fun' || l.kind === 'savings') to = 0n;
    else if (l.kind === 'daily' || l.kind === 'debt') to = min(l.assigned, max(l.floor, 0n));
    if (to !== l.assigned) {
      cuts.push({ kind: 'assign', categoryId: l.categoryId, from: l.assigned, to });
      saves += l.assigned - to;
    }
  }
  return { cuts, saves };
}

// ----- REC-05: budget consistently under- or over-set -------------------------------------------------------

/**
 * Three consecutive periods (oldest first) with activity/assigned all below 0.8 or all above 1.2 → suggest
 * the median activity. Periods with nothing assigned and nothing spent don't count.
 */
export function rec05Realistic(
  history: readonly { assigned: bigint; activity: bigint }[],
): { direction: 'under' | 'over'; suggested: bigint } | null {
  if (history.length < 3) return null;
  const last = history.slice(-3);
  const side = (h: { assigned: bigint; activity: bigint }) =>
    h.assigned <= 0n
      ? h.activity > 0n
        ? 'over'
        : null
      : h.activity * 10n < h.assigned * 8n
        ? 'under'
        : h.activity * 10n > h.assigned * 12n
          ? 'over'
          : null;
  const sides = last.map(side);
  if (sides[0] === null || sides.some((s) => s !== sides[0])) return null;
  const suggested = max(medianMinor(last.map((h) => h.activity)), 0n);
  if (suggested === last[2]!.assigned) return null;
  return { direction: sides[0]!, suggested };
}

// ----- REC-07: monthly review ------------------------------------------------------------------------------

export interface ReviewLine {
  categoryId: string;
  kind: GroupKind;
  assigned: bigint;
  activity: bigint;
}

export interface MonthlyReview {
  income: bigint;
  spent: bigint;
  /** income − spent. */
  saved: bigint;
  /** Up to 3 spending categories that came in under budget, largest saving first. */
  wentWell: { categoryId: string; under: bigint }[];
  /** Top 3 leaks: the largest positive variances (activity − assigned). */
  leaks: { categoryId: string; overBy: bigint }[];
}

export function rec07Review(income: bigint, lines: readonly ReviewLine[]): MonthlyReview {
  const spending = lines.filter((l) => !['income', 'system', 'savings'].includes(l.kind));
  const spent = spending.reduce((s, l) => s + l.activity, 0n);
  const byVariance = spending
    .map((l) => ({ categoryId: l.categoryId, variance: l.activity - l.assigned, assigned: l.assigned }))
    .sort((a, b) =>
      a.variance > b.variance ? -1 : a.variance < b.variance ? 1 : a.categoryId < b.categoryId ? -1 : 1,
    );
  const leaks = byVariance
    .filter((v) => v.variance > 0n)
    .slice(0, 3)
    .map((v) => ({ categoryId: v.categoryId, overBy: v.variance }));
  const wentWell = byVariance
    .filter((v) => v.variance < 0n && v.assigned > 0n)
    .reverse()
    .slice(0, 3)
    .map((v) => ({ categoryId: v.categoryId, under: -v.variance }));
  return { income, spent, saved: income - spent, wentWell, leaks };
}

// ----- REC-08: irregular income ----------------------------------------------------------------------------

/** Budget from last month's income; keep a buffer of one month of average expenses. */
export function rec08Buffer(
  lastMonthIncome: bigint,
  averageMonthlyExpenses: bigint,
  bufferBalance: bigint,
): { budgetIncome: bigint; bufferTarget: bigint; bufferGap: bigint } {
  const bufferTarget = max(averageMonthlyExpenses, 0n);
  return {
    budgetIncome: max(lastMonthIncome, 0n),
    bufferTarget,
    bufferGap: max(bufferTarget - bufferBalance, 0n),
  };
}
