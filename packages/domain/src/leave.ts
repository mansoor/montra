/**
 * Vacation and paid sick leave balances (PRL-23..26; ADR-0036). Pure: the pay run plans each paycheck's leave with
 * these, shows the plan on a draft, and writes the same plan as entries when the run is approved.
 *
 * Hours are thousandths (8 hours = 8000). A year is the calendar year.
 */
import { addDays, type CalendarDate } from './calendar-date.js';
import { divRound } from './rounding.js';
import { PERIODS_PER_YEAR, type PayFrequency } from './payroll.js';

export type LeaveKind = 'vacation' | 'sick';
/** None: only what's entered and used moves the balance. Grant: a yearly amount on 1 January (front-loading). */
export type LeaveMethod = 'none' | 'accrual' | 'grant';

export interface LeavePolicy {
  method: LeaveMethod;
  /** Accrual: `accrueMilli` earned for every `perHoursMilli` worked. */
  accrueMilli: bigint | null;
  perHoursMilli: bigint | null;
  /** Grant: the hours given at the start of each year. */
  grantMilli: bigint | null;
  /** Nothing more accrues or is granted above this balance. */
  maxBalanceMilli: bigint | null;
  /** At the start of a year, the balance above this is forfeited; null carries everything over. */
  carryoverMaxMilli: bigint | null;
  /** Using more than this in a year warns. */
  useCapMilli: bigint | null;
}

// ----- California paid sick leave (Labor Code §§245–249) ------------------------------------------------------------

/**
 * California's paid sick leave minimums by the date they took effect. Source: California Labor Commissioner, "California
 * Paid Sick Leave: Frequently Asked Questions" (dir.ca.gov/dlse/paid_sick_leave.htm, updated 2025-12-31), FAQ 1, 4, 13,
 * 14, 16, 24, 26, 36 and 41; the 2024 figures are SB 616. A law change is a new row here and its tests.
 */
export interface CaSickLeaveRule {
  from: CalendarDate;
  /** At least this much a year: 40 hours or 5 days, whichever is more. */
  minHoursMilli: bigint;
  minDays: number;
  /** The accrual floor: 1 hour for every 30 worked. */
  accrueMilli: bigint;
  perHoursMilli: bigint;
  /** An employer may cap the balance at 80 hours or 10 days, whichever is more. */
  accrualCapHoursMilli: bigint;
  accrualCapDays: number;
  /** An employer may limit use to 40 hours or 5 days a year. */
  useCapHoursMilli: bigint;
  useCapDays: number;
  /** Usable from the 90th day of employment. */
  usableFromDay: number;
  /** Another accrual schedule must give 24 hours by the 120th day and 40 hours by the 200th. */
  altAccrual: { byDay: number; hoursMilli: bigint }[];
}

export const CA_PAID_SICK_LEAVE: readonly CaSickLeaveRule[] = [
  {
    from: '2015-07-01' as CalendarDate,
    minHoursMilli: 24000n,
    minDays: 3,
    accrueMilli: 1000n,
    perHoursMilli: 30000n,
    accrualCapHoursMilli: 48000n,
    accrualCapDays: 6,
    useCapHoursMilli: 24000n,
    useCapDays: 3,
    usableFromDay: 90,
    altAccrual: [],
  },
  {
    from: '2024-01-01' as CalendarDate,
    minHoursMilli: 40000n,
    minDays: 5,
    accrueMilli: 1000n,
    perHoursMilli: 30000n,
    accrualCapHoursMilli: 80000n,
    accrualCapDays: 10,
    useCapHoursMilli: 40000n,
    useCapDays: 5,
    usableFromDay: 90,
    altAccrual: [
      { byDay: 120, hoursMilli: 24000n },
      { byDay: 200, hoursMilli: 40000n },
    ],
  },
];

/** The rule in force on a date (the earliest one before 2015-07-01). */
export function caSickLeaveRule(date: CalendarDate): CaSickLeaveRule {
  let rule = CA_PAID_SICK_LEAVE[0]!;
  for (const r of CA_PAID_SICK_LEAVE) if (r.from <= date) rule = r;
  return rule;
}

/** The statutory minimum as a policy: 1 hour per 30 worked, balance capped at 80 hours, use limited to 40 a year. */
export const caSickDefaultPolicy = (rule: CaSickLeaveRule): LeavePolicy => ({
  method: 'accrual',
  accrueMilli: rule.accrueMilli,
  perHoursMilli: rule.perHoursMilli,
  grantMilli: null,
  maxBalanceMilli: rule.accrualCapHoursMilli,
  carryoverMaxMilli: null,
  useCapMilli: rule.useCapHoursMilli,
});

export type SickShortfall = 'method' | 'accrual_rate' | 'balance_cap' | 'use_cap' | 'grant' | 'carryover';

/**
 * Where a sick policy gives less than California's minimum, in hours. Days aren't checked: for someone whose workday is
 * longer than 8 hours, 5 days is more than 40 hours, which the screen says.
 */
export function sickPolicyShortfalls(p: LeavePolicy, rule: CaSickLeaveRule): SickShortfall[] {
  const out: SickShortfall[] = [];
  if (p.method === 'none') return ['method'];
  if (p.useCapMilli !== null && p.useCapMilli < rule.useCapHoursMilli) out.push('use_cap');
  if (p.method === 'accrual') {
    // accrue / per ≥ 1 / 30
    if (
      p.accrueMilli === null ||
      p.perHoursMilli === null ||
      p.accrueMilli * rule.perHoursMilli < rule.accrueMilli * p.perHoursMilli
    ) {
      out.push('accrual_rate');
    }
    if (p.maxBalanceMilli !== null && p.maxBalanceMilli < rule.accrualCapHoursMilli) out.push('balance_cap');
    // Accrued sick leave carries over (subject to the cap); only a front-loaded policy may drop it.
    if (p.carryoverMaxMilli !== null) out.push('carryover');
  } else if (p.grantMilli === null || p.grantMilli < rule.minHoursMilli) {
    out.push('grant');
  }
  return out;
}

// ----- Hours worked ---------------------------------------------------------------------------------------------------

/**
 * Hours a salaried (exempt) employee is deemed to work in a period: 40 a week, so 2,080 a year over the periods. Leave
 * taken in the period isn't work. California counts exempt employees as working 40 hours a week for sick leave.
 */
export function deemedHoursMilli(frequency: PayFrequency, leaveMilli: bigint): bigint {
  const deemed = divRound(2_080_000n, BigInt(PERIODS_PER_YEAR[frequency]));
  return deemed > leaveMilli ? deemed - leaveMilli : 0n;
}

// ----- One paycheck's plan -------------------------------------------------------------------------------------------

export type LeaveSource = 'grant' | 'carryover' | 'used' | 'accrual' | 'payout';
export type LeaveWarning = 'over_balance' | 'over_use_cap' | 'waiting_period';

export interface LeaveState {
  /** Every entry before this paycheck (its own left out). */
  balance: bigint;
  /** Entries dated before 1 January of the pay year: what a carry-over limit cuts. */
  balanceAtYearStart: bigint;
  /** Hours used earlier in the pay year (positive). */
  usedThisYear: bigint;
  /** This year's grant / carry-over cut have already been applied by an earlier paycheck. */
  grantDone: boolean;
  carryoverDone: boolean;
}

export interface LeaveUse {
  year: number;
  workedMilli: bigint;
  usedMilli: bigint;
  /** Vacation paid out on a final paycheck. */
  payoutMilli: bigint;
  /** California vacation is wages once earned, so it's never forfeited at the year's end. */
  vested: boolean;
  /** Leave used in a period starting before this date warns (California sick leave's 90th day). */
  usableFrom: CalendarDate | null;
  periodStart: CalendarDate;
}

export interface LeaveEntryDraft {
  source: LeaveSource;
  hoursMilli: bigint;
  leaveYear: number | null;
}

export interface LeavePlan {
  entries: LeaveEntryDraft[];
  before: bigint;
  used: bigint;
  /** Accrual and the yearly grant, less any carry-over cut. */
  accrued: bigint;
  paidOut: bigint;
  after: bigint;
  /** The balance a final paycheck could pay out: after this paycheck's use and accrual. */
  payable: bigint;
  warnings: LeaveWarning[];
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * In order: the year's carry-over cut and grant (once a year, on its first paycheck), the hours used, the accrual on
 * hours worked (stopping at the cap, measured after the hours used), then any payout. Using more than the balance
 * available before this paycheck's accrual warns; the owner may allow it.
 */
export function planLeave(policy: LeavePolicy, state: LeaveState, use: LeaveUse): LeavePlan {
  const entries: LeaveEntryDraft[] = [];
  let balance = state.balance;
  let accrued = 0n;
  const warnings: LeaveWarning[] = [];

  if (policy.carryoverMaxMilli !== null && !use.vested && !state.carryoverDone) {
    const cut = max(0n, state.balanceAtYearStart - policy.carryoverMaxMilli);
    entries.push({ source: 'carryover', hoursMilli: -cut, leaveYear: use.year });
    balance -= cut;
    accrued -= cut;
  }
  if (policy.method === 'grant' && !state.grantDone) {
    let grant = policy.grantMilli ?? 0n;
    if (policy.maxBalanceMilli !== null) grant = min(grant, max(0n, policy.maxBalanceMilli - balance));
    entries.push({ source: 'grant', hoursMilli: grant, leaveYear: use.year });
    balance += grant;
    accrued += grant;
  }

  const available = balance;
  if (use.usedMilli > 0n) {
    entries.push({ source: 'used', hoursMilli: -use.usedMilli, leaveYear: null });
    balance -= use.usedMilli;
    if (use.usedMilli > available) warnings.push('over_balance');
    if (policy.useCapMilli !== null && state.usedThisYear + use.usedMilli > policy.useCapMilli) {
      warnings.push('over_use_cap');
    }
    if (use.usableFrom && use.periodStart < use.usableFrom) warnings.push('waiting_period');
  }

  if (policy.method === 'accrual' && policy.accrueMilli && policy.perHoursMilli && use.workedMilli > 0n) {
    let earned = divRound(use.workedMilli * policy.accrueMilli, policy.perHoursMilli);
    if (policy.maxBalanceMilli !== null) earned = min(earned, max(0n, policy.maxBalanceMilli - balance));
    if (earned > 0n) {
      entries.push({ source: 'accrual', hoursMilli: earned, leaveYear: null });
      balance += earned;
      accrued += earned;
    }
  }

  const payable = max(0n, balance);
  if (use.payoutMilli > 0n) {
    entries.push({ source: 'payout', hoursMilli: -use.payoutMilli, leaveYear: null });
    if (use.payoutMilli > payable && !warnings.includes('over_balance')) warnings.push('over_balance');
    balance -= use.payoutMilli;
  }

  return {
    entries,
    before: state.balance,
    used: use.usedMilli,
    accrued,
    paidOut: use.payoutMilli,
    after: balance,
    payable,
    warnings,
  };
}

/** The 90th day of employment, counting the hire date as the first: when California sick leave can be used. */
export const sickUsableFrom = (hireDate: CalendarDate | null, rule: CaSickLeaveRule): CalendarDate | null =>
  hireDate ? addDays(hireDate, rule.usableFromDay - 1) : null;
