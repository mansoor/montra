/**
 * Payroll onboarding rules that don't need the database (PRL-04, PRL-05; ADR-0034). Pure, so clients and tests share them.
 */
import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  isoDayOfWeek,
  startOfMonth,
  type CalendarDate,
} from './calendar-date.js';
import { divRound } from './rounding.js';

export type TaxIdType = 'ssn' | 'itin' | 'ein';

/** "•••-••-1234" for an SSN or ITIN, "••-•••1234" for an EIN; null when there's nothing to show. */
export function maskTin(type: TaxIdType | null, last4: string | null): string | null {
  if (!last4) return null;
  return type === 'ein' ? `••-•••${last4}` : `•••-••-${last4}`;
}

/** "•••• 6789": the end of an account or document number. */
export const maskTail = (last4: string | null): string | null => (last4 ? `•••• ${last4}` : null);

/** The last four characters kept in the clear for a masked display. */
export const lastFour = (value: string): string => value.slice(-4);

/**
 * How long an I-9 and its copies must be kept: the later of 3 years after the hire date and 1 year after employment
 * ends. While someone is still employed there is no date yet, because it depends on when they leave.
 */
export function i9RetainUntil(
  hireDate: CalendarDate | null,
  endDate: CalendarDate | null,
): CalendarDate | null {
  if (!endDate) return null;
  const afterEnd = addMonths(endDate, 12);
  if (!hireDate) return afterEnd;
  const afterHire = addMonths(hireDate, 36);
  return afterHire > afterEnd ? afterHire : afterEnd;
}

/** True once the retention date has passed. */
export const i9MayDestroy = (retainUntil: CalendarDate | null, today: CalendarDate): boolean =>
  retainUntil !== null && today > retainUntil;

/**
 * Section 2 is due within 3 business days of the first day of work: started Monday, due Thursday. Weekends are skipped;
 * federal holidays are not, so the date shown is never later than the real one.
 */
export function i9Section2Due(firstDay: CalendarDate): CalendarDate {
  let d = firstDay;
  let left = 3;
  while (left > 0) {
    d = addDays(d, 1);
    if (isoDayOfWeek(d) < 5) left--;
  }
  return d;
}

/** Employed on a day: hired on or before it and not yet ended. */
export function employmentStatus(
  hireDate: CalendarDate | null,
  endDate: CalendarDate | null,
  today: CalendarDate,
): 'active' | 'starting' | 'ended' {
  if (endDate && endDate < today) return 'ended';
  if (hireDate && hireDate > today) return 'starting';
  return 'active';
}

// ----- Pay periods and gross-to-net (PRL-06, PRL-07) ----------------------------------------------------------------

export type PayFrequency = 'biweekly' | 'semimonthly' | 'monthly';

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = { biweekly: 26, semimonthly: 24, monthly: 12 };

export interface PayPeriod {
  start: CalendarDate;
  end: CalendarDate;
}

/**
 * The pay period a date falls in. Every two weeks counts 14-day periods from `anchor` (any period's first day), either
 * way; twice a month is the 1st–15th and the 16th–end; monthly is the calendar month.
 */
export function payPeriodContaining(
  frequency: PayFrequency,
  anchor: CalendarDate,
  date: CalendarDate,
): PayPeriod {
  if (frequency === 'biweekly') {
    const offset = diffDays(date, anchor);
    const k = Math.floor(offset / 14);
    const start = addDays(anchor, k * 14);
    return { start, end: addDays(start, 13) };
  }
  const first = startOfMonth(date);
  if (frequency === 'monthly') return { start: first, end: endOfMonth(date) };
  return date.slice(8) <= '15'
    ? { start: first, end: addDays(first, 14) }
    : { start: addDays(first, 15), end: endOfMonth(date) };
}

/** The period after this one. */
export const nextPayPeriod = (frequency: PayFrequency, anchor: CalendarDate, p: PayPeriod): PayPeriod =>
  payPeriodContaining(frequency, anchor, addDays(p.end, 1));

/** A salary's share for one period, to the cent (half up): $52,000 a year every two weeks is $2,000.00. */
export const salaryPerPeriod = (annualMinor: bigint, frequency: PayFrequency): bigint =>
  divRound(annualMinor, BigInt(PERIODS_PER_YEAR[frequency]));

/** Hours (in thousandths) times a rate, to the cent: 37.5 h at $22.50 is $843.75. */
export const hoursPay = (hoursMilli: bigint, rateMinor: bigint): bigint =>
  divRound(hoursMilli * rateMinor, 1000n);

/** Overtime is paid at one and a half times the regular rate (FLSA; California daily overtime is entered as hours). */
export const overtimeRate = (rateMinor: bigint): bigint => divRound(rateMinor * 3n, 2n);

export type PaycheckLineKind =
  'earning' | 'pre_tax_deduction' | 'employee_tax' | 'post_tax_deduction' | 'reimbursement' | 'employer_tax';

export interface PaycheckTotals {
  gross: bigint;
  preTax: bigint;
  employeeTaxes: bigint;
  postTax: bigint;
  reimbursements: bigint;
  net: bigint;
  employerTaxes: bigint;
}

/** Gross to net from a paycheck's lines. Reimbursements add to net pay but are never wages; employer taxes don't touch it. */
export function paycheckTotals(lines: readonly { kind: PaycheckLineKind; amount: bigint }[]): PaycheckTotals {
  const sum = (k: PaycheckLineKind) => lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0n);
  const gross = sum('earning');
  const preTax = sum('pre_tax_deduction');
  const employeeTaxes = sum('employee_tax');
  const postTax = sum('post_tax_deduction');
  const reimbursements = sum('reimbursement');
  return {
    gross,
    preTax,
    employeeTaxes,
    postTax,
    reimbursements,
    net: gross - preTax - employeeTaxes - postTax + reimbursements,
    employerTaxes: sum('employer_tax'),
  };
}
