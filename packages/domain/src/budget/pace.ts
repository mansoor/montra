/** Spending pace (FLOW-04, REC-02; design 04 §8). */
import { diffDays, type CalendarDate } from '../calendar-date.js';
import { divRound } from '../rounding.js';
import { periodDays, type Period } from './period.js';

export type PaceStatus = 'under' | 'on_track' | 'over';

/** Group kinds whose spending is paced (variable spending; fixed bills are paid once and aren't). */
export const PACE_KINDS: ReadonlySet<string> = new Set(['daily', 'fun']);

export interface Pace {
  /** Days elapsed including today (1 … period days). */
  elapsed: number;
  days: number;
  expectedByToday: bigint;
  /** Activity extrapolated linearly to the period end. */
  projected: bigint;
  status: PaceStatus;
}

/**
 * `expected_by_today = assigned × elapsed / days`. A category is over pace when its activity is ≥ 110% of
 * that and the projection is ≥ 110% of the assigned amount (judged once a fifth of the period has passed);
 * under pace below 90%. Null outside the period.
 * `weights` (optional, one per day of the period) replaces the linear share with the category's historical
 * day-of-month pattern.
 */
export function spendingPace(
  period: Period,
  today: CalendarDate,
  assigned: bigint,
  activity: bigint,
  weights?: readonly number[],
): Pace | null {
  if (today < period.start || today > period.end) return null;
  const days = periodDays(period);
  const elapsed = diffDays(today, period.start) + 1;
  let expectedByToday: bigint;
  if (weights && weights.length === days && weights.every((w) => w >= 0) && weights.some((w) => w > 0)) {
    // Weights are non-money ratios: scale them to integers once, then stay in bigint.
    const scaled = weights.map((w) => BigInt(Math.trunc(w * 1_000_000)));
    const total = scaled.reduce((a, b) => a + b, 0n);
    const sofar = scaled.slice(0, elapsed).reduce((a, b) => a + b, 0n);
    expectedByToday = total === 0n ? 0n : divRound(assigned * sofar, total);
  } else {
    expectedByToday = divRound(assigned * BigInt(elapsed), BigInt(days));
  }
  const projected = divRound(activity * BigInt(days), BigInt(elapsed));
  let status: PaceStatus = 'on_track';
  // A few days in, one shopping trip projects as a huge overspend: judge pace once a fifth of the period is gone.
  const settled = elapsed * 5 >= days;
  if (assigned <= 0n) status = activity > 0n ? 'over' : 'on_track';
  else if (settled && activity * 100n >= expectedByToday * 110n && projected * 100n >= assigned * 110n)
    status = 'over';
  else if (activity * 100n < expectedByToday * 90n) status = 'under';
  return { elapsed, days, expectedByToday, projected, status };
}
