/**
 * Pure helpers for a tracked loan's charts (ADR-0024): the payment schedule as stacked bars, the amount owed continued
 * to payoff, and how much has been paid so far. Every figure comes from the rows and loan the API already returned; the
 * only arithmetic here is grouping and summing, in bigint minor units.
 */
import type { AmortizationRowDto, LoanDto } from '@montra/api-client';

/**
 * Above this many payments the schedule chart shows one bar per calendar year instead of one per payment, so a 30-year
 * mortgage stays readable. A display choice, not a limit on loans.
 */
export const SCHEDULE_BARS_BY_YEAR_ABOVE = 120;

/** One bar of the schedule chart: a payment, or a calendar year's payments that are all recorded or all to come. */
export interface ScheduleBar {
  key: string;
  /** The payment's date, or the first payment's date in a year bar. */
  date: string;
  /** The last payment's date (the same as `date` for a single payment). */
  lastDate: string;
  /** Set on a year bar. */
  year: number | null;
  /** How many payments the bar holds. */
  count: number;
  recorded: boolean;
  principal: bigint;
  interest: bigint;
  lateFee: bigint;
  escrow: bigint;
  /** What left the bank, as the table shows it: principal, interest and escrow. */
  payment: bigint;
  /** Owed after the bar's last payment. */
  owedAfter: bigint;
}

const one = (r: AmortizationRowDto): ScheduleBar => ({
  key: `p${r.number}`,
  date: r.date,
  lastDate: r.date,
  year: null,
  count: 1,
  recorded: r.transactionId !== null,
  principal: BigInt(r.principal),
  interest: BigInt(r.interest),
  lateFee: BigInt(r.lateFee),
  escrow: BigInt(r.escrow),
  payment: BigInt(r.payment) + BigInt(r.escrow),
  owedAfter: BigInt(r.balance),
});

/**
 * The schedule table's rows as bars, in order. Past `threshold` payments, rows are summed by calendar year; a year with
 * both recorded payments and ones still to come becomes two bars, so "today" always falls between bars.
 */
export function scheduleBars(
  rows: readonly AmortizationRowDto[],
  threshold: number = SCHEDULE_BARS_BY_YEAR_ABOVE,
): { byYear: boolean; bars: ScheduleBar[] } {
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  if (sorted.length <= threshold) return { byYear: false, bars: sorted.map(one) };
  const bars: ScheduleBar[] = [];
  for (const r of sorted) {
    const row = one(r);
    const year = Number(r.date.slice(0, 4));
    const last = bars[bars.length - 1];
    if (last && last.year === year && last.recorded === row.recorded) {
      last.lastDate = row.date;
      last.count += 1;
      last.principal += row.principal;
      last.interest += row.interest;
      last.lateFee += row.lateFee;
      last.escrow += row.escrow;
      last.payment += row.payment;
      last.owedAfter = row.owedAfter;
    } else {
      bars.push({ ...row, key: `y${year}${row.recorded ? 'r' : 'u'}`, year });
    }
  }
  return { byYear: true, bars };
}

/** Where "today" goes among the bars: after the last recorded one (0 when nothing is recorded). */
export const todayIndex = (bars: readonly ScheduleBar[]): number => {
  let i = 0;
  bars.forEach((b, at) => {
    if (b.recorded) i = at + 1;
  });
  return i;
};

export interface OwedPoint {
  date: string;
  owed: bigint;
}

/**
 * The amount owed continued to payoff: from what's owed today along each upcoming payment's "owed after". A payment
 * that's overdue still counts from today, the earliest it can now be paid. Empty once the loan is paid off.
 */
export function payoffProjection(
  loan: Pick<LoanDto, 'scheduledBalance'>,
  rows: readonly AmortizationRowDto[],
  today: string,
): OwedPoint[] {
  const upcoming = rows.filter((r) => r.transactionId === null).sort((a, b) => a.number - b.number);
  if (upcoming.length === 0) return [];
  return [
    { date: today, owed: BigInt(loan.scheduledBalance) },
    ...upcoming.map((r) => ({ date: r.date < today ? today : r.date, owed: BigInt(r.balance) })),
  ];
}

/** The amount owed chart's own range, for a tracked loan only: the whole history, then on to payoff. */
export const PAYOFF_RANGE = 'payoff';

/**
 * How much has been paid against what the loan costs in all: principal repaid of the original amount, and interest paid
 * (recorded here) of that plus what's still to pay. Shares are whole percents, for drawing only.
 */
export function paidSoFar(
  loan: Pick<LoanDto, 'principal' | 'principalPaid' | 'interestPaid' | 'interestRemaining'>,
): {
  principalPaid: bigint;
  principal: bigint;
  interestPaid: bigint;
  interestTotal: bigint;
} {
  const interestPaid = BigInt(loan.interestPaid);
  return {
    principalPaid: BigInt(loan.principalPaid),
    principal: BigInt(loan.principal),
    interestPaid,
    interestTotal: interestPaid + BigInt(loan.interestRemaining),
  };
}

/** The schedule's last choice between the table and the chart, per browser. */
export const SCHEDULE_VIEW_KEY = 'montra.loan-schedule-view';
export type ScheduleView = 'table' | 'chart';
export const readScheduleView = (stored: string | null): ScheduleView =>
  stored === 'chart' ? 'chart' : 'table';

/**
 * Clean axis steps from 0 up to at least `max` (minor units, as a number for drawing): 1, 2 or 5 times a power of ten,
 * about `count` of them. Only the scale; labels are formatted from bigint.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  // Never below one minor unit.
  const power = Math.max(1, 10 ** Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const ticks: number[] = [0];
  for (let i = 1; ticks[ticks.length - 1]! < max; i++) ticks.push(i * step);
  return ticks;
}
