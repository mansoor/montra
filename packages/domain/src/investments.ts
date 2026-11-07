/**
 * Retirement and investment accounts (ADR-0025): plan types, where payslip money goes, and gain over time. Gains are
 * worked out at the account's level from its value and the money put in. There are no holdings or prices, and nothing
 * here is advice (NFR-14).
 */
import { addDays, compareDates, diffDays, endOfMonth, type CalendarDate } from './calendar-date.js';
import { divRound } from './rounding.js';

export const PLAN_TYPES = [
  'brokerage',
  '401k',
  'roth_401k',
  '403b',
  'ira',
  'roth_ira',
  'hsa',
  '529',
  'pension',
  'other',
] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** Plans an employer pays into from payslips. */
export const WORKPLACE_PLANS: ReadonlySet<PlanType> = new Set([
  '401k',
  'roth_401k',
  '403b',
  'hsa',
  'pension',
]);

/** Where each payslip savings line goes, best match first. FSA isn't an investment: it keeps the old destination. */
export const PAYSLIP_PLAN_ROUTES: Readonly<Record<string, readonly PlanType[]>> = {
  '401k': ['401k', '403b', 'roth_401k'],
  roth_401k: ['roth_401k', '401k', '403b'],
  ira: ['ira', 'roth_ira'],
  hsa: ['hsa'],
  pension: ['pension'],
  espp: ['brokerage'],
};

/** Where each employer contribution goes, when the account counts them. */
export const EMPLOYER_PLAN_ROUTES: Readonly<Record<string, readonly PlanType[]>> = {
  match: ['401k', '403b', 'roth_401k', 'pension'],
  hsa: ['hsa'],
};

/** The first account whose plan fits the line, in route order. */
export function routeToPlan<T extends { planType: PlanType | null }>(
  routes: readonly PlanType[] | undefined,
  accounts: readonly T[],
): T | undefined {
  for (const plan of routes ?? []) {
    const found = accounts.find((a) => a.planType === plan);
    if (found) return found;
  }
  return undefined;
}

/** One day's change to an account, natural sign. `valuation` is the part that's a change in market value. */
export interface ValueChange {
  date: CalendarDate;
  delta: bigint;
  valuation: bigint;
}

export interface Performance {
  /** Value at the end of the day before `from`. */
  start: bigint;
  end: bigint;
  /** Money put in, and taken out, other than changes in value. */
  moneyIn: bigint;
  moneyOut: bigint;
  /** Changes in market value. */
  gain: bigint;
  /**
   * Gain over the money at work, weighting what came in by how long it was there (modified Dietz), in basis points.
   * Null when nothing was at work, so a percentage would mean nothing.
   */
  returnBps: number | null;
}

/** Performance between two dates, both included. `changes` are sorted by date. */
export function performance(
  changes: readonly ValueChange[],
  from: CalendarDate,
  to: CalendarDate,
): Performance {
  const days = BigInt(diffDays(to, from) + 1);
  let start = 0n;
  let end = 0n;
  let moneyIn = 0n;
  let moneyOut = 0n;
  let gain = 0n;
  let weighted = 0n;
  for (const c of changes) {
    if (compareDates(c.date, to) > 0) break;
    end += c.delta;
    if (compareDates(c.date, from) < 0) {
      start += c.delta;
      continue;
    }
    const flow = c.delta - c.valuation;
    if (flow > 0n) moneyIn += flow;
    else moneyOut -= flow;
    gain += c.valuation;
    // Money that arrives at the end of a day is at work for the days after it.
    weighted += flow * BigInt(diffDays(to, c.date));
  }
  const atWork = start * days + weighted;
  return {
    start,
    end,
    moneyIn,
    moneyOut,
    gain,
    returnBps: atWork > 0n ? Number(divRound(gain * 10_000n * days, atWork)) : null,
  };
}

/** A return over more than a year as a yearly rate, in basis points. Display only: never used for money. */
export function annualizedBps(returnBps: number | null, from: CalendarDate, to: CalendarDate): number | null {
  const days = diffDays(to, from) + 1;
  if (returnBps === null || days < 365 || returnBps <= -10_000) return null;
  return Number((((1 + returnBps / 10_000) ** (365 / days) - 1) * 10_000).toFixed(0));
}

/**
 * The months, quarters or years that a table of performance breaks into, so it stays short however long the span. The ends
 * are clipped to the span.
 */
export function performancePeriods(
  from: CalendarDate,
  to: CalendarDate,
): { from: CalendarDate; to: CalendarDate }[] {
  if (compareDates(from, to) > 0) return [];
  const span = diffDays(to, from);
  const step = span > 1100 ? 12 : span > 400 ? 3 : 1;
  const out: { from: CalendarDate; to: CalendarDate }[] = [];
  let start = from;
  while (compareDates(start, to) <= 0) {
    // The last month of the calendar month, quarter or year that `start` is in.
    const month = Number(start.slice(5, 7));
    const lastMonth = Math.ceil(month / step) * step;
    const close = endOfMonth(`${start.slice(0, 4)}-${String(lastMonth).padStart(2, '0')}-01` as CalendarDate);
    const end = compareDates(close, to) > 0 ? to : close;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}

/** The value, and the value without changes in market value, at the end of each date: what the chart draws. */
export function valueAndInvested(
  changes: readonly ValueChange[],
  dates: readonly CalendarDate[],
): { date: CalendarDate; value: bigint; invested: bigint }[] {
  let value = 0n;
  let invested = 0n;
  let next = 0;
  return dates.map((date) => {
    while (next < changes.length && compareDates(changes[next]!.date, date) <= 0) {
      value += changes[next]!.delta;
      invested += changes[next]!.delta - changes[next]!.valuation;
      next++;
    }
    return { date, value, invested };
  });
}
