/**
 * Rental arithmetic (RNT-04..11, RNT-14; design 04 §13, ADR-0018). Pure and exact: amounts are bigint minor units. Figures
 * such as depreciation and returns are helpers for the owner, never tax or investment advice.
 */
import { allocate } from './allocate.js';
import { addDays, compareDates, type CalendarDate } from './calendar-date.js';
import { divRound } from './rounding.js';

const pad = (n: number) => String(n).padStart(2, '0');
const parts = (d: CalendarDate) => d.split('-').map(Number) as [number, number, number];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const day = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}` as CalendarDate;
const nextMonth = (y: number, m: number): [number, number] => (m === 12 ? [y + 1, 1] : [y, m + 1]);

/** Whole days from `a` to `b`. */
export const daysBetween = (a: CalendarDate, b: CalendarDate): number =>
  // Both are UTC midnights, so this is always a whole number of days.
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

// ----- The rent roll (RNT-04) ---------------------------------------------------------------------------------

export interface LeaseTerms {
  start: CalendarDate;
  /** Null: month to month. */
  end: CalendarDate | null;
  /** Moved out, which stops the charges even if the lease ran longer. */
  endedOn: CalendarDate | null;
  dueDay: number;
}

export interface RentPeriod {
  /** First of the month the charge belongs to. */
  periodStart: CalendarDate;
  due: CalendarDate;
}

/**
 * One charge per month, due on the due day (or the month's last day when it's shorter). A lease starting after the due
 * day is charged on its first day: rent is usually due at move-in. No proration: the landlord edits a charge that's less.
 */
export function rentPeriods(lease: LeaseTerms, through: CalendarDate): RentPeriod[] {
  const out: RentPeriod[] = [];
  const stops = [through, lease.end, lease.endedOn].filter((d): d is CalendarDate => d !== null);
  const last = stops.reduce((a, b) => (b < a ? b : a));
  let [y, m] = parts(lease.start);
  for (;;) {
    const periodStart = day(y, m, 1);
    if (periodStart > last) break;
    const regular = day(y, m, Math.min(lease.dueDay, daysInMonth(y, m)));
    const due = regular < lease.start ? lease.start : regular;
    if (due <= last) out.push({ periodStart, due });
    [y, m] = nextMonth(y, m);
  }
  return out;
}

export interface LateFeeRule {
  graceDays: number;
  flat: bigint;
  bps: number;
  cap: bigint | null;
}

/** flat + percent of the rent, up to the cap. */
export function lateFee(rule: LateFeeRule, rent: bigint): bigint {
  const fee = rule.flat + divRound(rent * BigInt(rule.bps), 10_000n);
  return rule.cap !== null && fee > rule.cap ? rule.cap : fee;
}

export interface ChargeInput {
  id: string;
  kind: 'rent' | 'late_fee';
  due: CalendarDate;
  amount: bigint;
  waived: boolean;
}

export type RentStatus = 'paid' | 'partial' | 'upcoming' | 'due' | 'late' | 'waived';

export interface ChargeState extends ChargeInput {
  paid: bigint;
  open: bigint;
  status: RentStatus;
  /** Past the due date, when something is still owed. */
  daysLate: number;
}

/**
 * What the lease's payments have covered, oldest charge first and rent before its fee. Derived rather than stored, so taking
 * a payment away just recomputes. Anything left over is a credit, which the next charges use up.
 */
export function applyRentPayments(
  charges: readonly ChargeInput[],
  paidTotal: bigint,
  today: CalendarDate,
  graceDays: number,
): { charges: ChargeState[]; credit: bigint } {
  const order = [...charges].sort((a, b) =>
    a.due < b.due ? -1 : a.due > b.due ? 1 : a.kind === b.kind ? 0 : a.kind === 'rent' ? -1 : 1,
  );
  let left = paidTotal;
  const out: ChargeState[] = order.map((c) => {
    if (c.waived) return { ...c, paid: 0n, open: 0n, status: 'waived', daysLate: 0 };
    const paid = left < c.amount ? left : c.amount;
    left -= paid;
    const open = c.amount - paid;
    const daysLate = open > 0n && c.due < today ? daysBetween(c.due, today) : 0;
    let status: RentStatus;
    if (open === 0n) status = 'paid';
    else if (c.due > today) status = paid > 0n ? 'partial' : 'upcoming';
    else if (daysLate > graceDays) status = 'late';
    else status = paid > 0n ? 'partial' : 'due';
    return { ...c, paid, open, status, daysLate };
  });
  return { charges: out, credit: left };
}

/** The rent charges past their grace with money still owed, and no late fee yet: the ones to assess. */
export function chargesDueALateFee(
  states: readonly ChargeState[],
  feePeriods: ReadonlySet<CalendarDate>,
  periodOf: (id: string) => CalendarDate,
): ChargeState[] {
  return states.filter((c) => c.kind === 'rent' && c.status === 'late' && !feePeriods.has(periodOf(c.id)));
}

// ----- Matching a deposit to a tenant (RNT-04) ------------------------------------------------------------------

const GENERIC = new Set([
  'ach',
  'credit',
  'debit',
  'deposit',
  'transfer',
  'payment',
  'pmt',
  'zelle',
  'venmo',
  'rent',
  'from',
  'to',
  'the',
  'and',
  'online',
  'mobile',
  'check',
  'chk',
  'wire',
  'incoming',
  'llc',
  'inc',
  'mr',
  'mrs',
  'ms',
]);
const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !GENERIC.has(t) && !/^\d+$/.test(t));

/** A statement line naming the tenant: their surname at least, or all of a one-word name. */
export function payerMatchesTenant(payer: string, tenantName: string): boolean {
  const name = tokens(tenantName);
  if (name.length === 0) return false;
  const seen = new Set(tokens(payer));
  return seen.has(name[name.length - 1]!);
}

export interface OpenLease {
  id: string;
  tenantNames: readonly string[];
  payeeKeys: readonly string[];
  /** Rent still owed on charges in the window, oldest first. */
  openCharges: readonly { open: bigint; due: CalendarDate }[];
  /** The security deposit, while not yet received. */
  depositOwed: bigint;
  start: CalendarDate;
}

export interface DepositLine {
  id: string;
  date: CalendarDate;
  amount: bigint;
  payer: string;
  payeeKey: string | null;
}

export interface RentMatch {
  leaseId: string;
  depositId: string;
  kind: 'rent' | 'security_deposit';
}

/** Rent counts from 5 days before it's due to 30 after. */
const RENT_BEFORE = 5;
const RENT_AFTER = 30;
/** A security deposit counts from 10 days before the lease starts to 30 after. */
const DEPOSIT_BEFORE = 10;
const DEPOSIT_AFTER = 30;

/**
 * The links safe to make without asking (ADR-0018 §3).
 * - A line naming a tenant, or under a name a past payment was linked from, is theirs, whatever the amount.
 * - Otherwise it takes the exact rent, with one lease and one line in it.
 * - A security deposit comes first: one the same size as a month's rent mustn't be taken as rent, since that would make
 *   a liability into income.
 * Lines naming no one, for no exact amount, are left for the user.
 */
export function matchRentDeposits(leases: readonly OpenLease[], lines: readonly DepositLine[]): RentMatch[] {
  const out: RentMatch[] = [];
  const used = new Set<string>();
  const inDepositWindow = (l: OpenLease, d: DepositLine) =>
    d.date >= addDays(l.start, -DEPOSIT_BEFORE) && d.date <= addDays(l.start, DEPOSIT_AFTER);
  const inRentWindow = (l: OpenLease, d: DepositLine) =>
    l.openCharges.some((c) => d.date >= addDays(c.due, -RENT_BEFORE) && d.date <= addDays(c.due, RENT_AFTER));
  const named = (l: OpenLease, d: DepositLine) =>
    (d.payeeKey !== null && l.payeeKeys.includes(d.payeeKey)) ||
    l.tenantNames.some((n) => payerMatchesTenant(d.payer, n));

  // One line, one lease: a name shared by two leases proves nothing.
  const namedLease = (d: DepositLine, fits: (l: OpenLease) => boolean): OpenLease | null => {
    const hits = leases.filter((l) => named(l, d) && fits(l));
    return hits.length === 1 ? hits[0]! : null;
  };

  // Security deposits first.
  for (const d of lines) {
    const hit = namedLease(d, (l) => l.depositOwed === d.amount && inDepositWindow(l, d));
    if (hit && !out.some((m) => m.leaseId === hit.id && m.kind === 'security_deposit')) {
      out.push({ leaseId: hit.id, depositId: d.id, kind: 'security_deposit' });
      used.add(d.id);
    }
  }
  for (const l of leases) {
    if (l.depositOwed === 0n || out.some((m) => m.leaseId === l.id && m.kind === 'security_deposit'))
      continue;
    const fits = lines.filter((d) => !used.has(d.id) && d.amount === l.depositOwed && inDepositWindow(l, d));
    const rivals = leases.filter(
      (o) => fits[0] && o.depositOwed === fits[0].amount && inDepositWindow(o, fits[0]),
    );
    if (fits.length === 1 && rivals.length === 1) {
      out.push({ leaseId: l.id, depositId: fits[0]!.id, kind: 'security_deposit' });
      used.add(fits[0]!.id);
    }
  }

  // A line naming a tenant, for any amount: rent can be part paid, or several months at once.
  for (const d of lines) {
    if (used.has(d.id)) continue;
    const hit = namedLease(d, (l) => inRentWindow(l, d));
    if (hit) {
      out.push({ leaseId: hit.id, depositId: d.id, kind: 'rent' });
      used.add(d.id);
    }
  }

  // The exact rent, with nothing else competing on either side.
  const exact = (l: OpenLease, d: DepositLine) =>
    l.openCharges.some(
      (c) =>
        c.open === d.amount && d.date >= addDays(c.due, -RENT_BEFORE) && d.date <= addDays(c.due, RENT_AFTER),
    );
  // A lease a line has just been linked to is out of the running: it can't also be why this one is ambiguous.
  const open = leases.filter((l) => !out.some((m) => m.leaseId === l.id && m.kind === 'rent'));
  for (const l of open) {
    const fits = lines.filter((d) => !used.has(d.id) && exact(l, d));
    if (fits.length !== 1) continue;
    if (open.filter((o) => exact(o, fits[0]!)).length !== 1) continue;
    out.push({ leaseId: l.id, depositId: fits[0]!.id, kind: 'rent' });
    used.add(fits[0]!.id);
  }
  return out;
}

// ----- Allocation (RNT-07) ------------------------------------------------------------------------------------

/** Splits an amount by weights, to the cent. Keeps the sign of a refund or a charge. */
export function allocateShared(amount: bigint, weights: readonly bigint[]): bigint[] {
  const negative = amount < 0n;
  const parts_ = allocate(negative ? -amount : amount, weights);
  return negative ? parts_.map((p) => -p) : parts_;
}

// ----- Mortgages (RNT-08) -------------------------------------------------------------------------------------

export interface LoanTerms {
  principal: bigint;
  rateBps: number;
  termMonths: number;
}

const RATE_DENOMINATOR = 120_000n; // bps per year → per month

/** The level payment: P·r / (1 − (1+r)^−n), computed with integers, half up. Zero rate: principal over the term. */
export function monthlyPayment(l: LoanTerms): bigint {
  const n = BigInt(l.termMonths);
  if (l.rateBps === 0) return divRound(l.principal, n, 'ceil');
  const num = RATE_DENOMINATOR + BigInt(l.rateBps);
  const growth = num ** n;
  const base = RATE_DENOMINATOR ** n;
  return divRound(l.principal * BigInt(l.rateBps) * growth, RATE_DENOMINATOR * (growth - base));
}

export interface AmortizationRow {
  number: number;
  date: CalendarDate;
  payment: bigint;
  interest: bigint;
  principal: bigint;
  balance: bigint;
}

/** The payment date in month `n` of the loan, keeping the first payment's day where the month has it. */
export function loanPaymentDate(first: CalendarDate, n: number): CalendarDate {
  const [y, m, d] = parts(first);
  const zero = y * 12 + (m - 1) + (n - 1);
  const year = Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  return day(year, month, Math.min(d, daysInMonth(year, month)));
}

/** The schedule from the terms alone. The last payment clears whatever rounding has left. */
export function amortize(l: LoanTerms, firstPayment: CalendarDate): AmortizationRow[] {
  return projectLoan({
    balance: l.principal,
    rateBps: l.rateBps,
    payment: monthlyPayment(l),
    firstPayment,
    termMonths: l.termMonths,
  });
}

export interface LoanProjection {
  /** What's owed now. */
  balance: bigint;
  rateBps: number;
  /** Principal and interest each month. */
  payment: bigint;
  firstPayment: CalendarDate;
  termMonths: number;
  /** Payments already in the balance when tracking began. */
  before?: number;
  /** Payment numbers already recorded, so they're skipped. */
  recorded?: ReadonlySet<number>;
}

/**
 * The payments still to come, from what's actually owed (ADR-0024). So an extra payment or a changed rate shows up by itself:
 * interest follows the balance, and the loan ends early or late. The payment on or after the last month of the term clears
 * what's left. A payment too small to cover the interest repays nothing until then.
 */
export function projectLoan(l: LoanProjection): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  let balance = l.balance;
  for (let n = (l.before ?? 0) + 1; balance > 0n; n++) {
    if (l.recorded?.has(n)) continue;
    const interest = divRound(balance * BigInt(l.rateBps), RATE_DENOMINATOR);
    let principal = l.payment - interest;
    if (principal < 0n) principal = 0n;
    if (principal > balance || n >= l.termMonths) principal = balance;
    balance -= principal;
    rows.push({
      number: n,
      date: loanPaymentDate(l.firstPayment, n),
      payment: principal + interest,
      interest,
      principal,
      balance,
    });
  }
  return rows;
}

/** How many scheduled payments fall on or before a date, up to the term: these are already in a balance as of that date. */
export function paymentsOnOrBefore(first: CalendarDate, termMonths: number, date: CalendarDate): number {
  let n = 0;
  while (n < termMonths && compareDates(loanPaymentDate(first, n + 1), date) <= 0) n++;
  return n;
}

// ----- Depreciation (RNT-09) ----------------------------------------------------------------------------------

export type DepreciationMethod = 'SL_27_5' | 'SL_39';
const HALF_MONTHS: Record<DepreciationMethod, bigint> = { SL_27_5: 660n, SL_39: 936n };

/** Half-months in service by the end of `year`, under the mid-month convention: the first month counts as a half. */
function halfMonthsThrough(inService: CalendarDate, year: number, method: DepreciationMethod): bigint {
  const [y, m] = parts(inService);
  if (year < y) return 0n;
  const whole = (year - y) * 12 + (12 - m);
  const halves = BigInt(whole * 2 + 1);
  return halves > HALF_MONTHS[method] ? HALF_MONTHS[method] : halves;
}

/**
 * Straight line, mid-month. Taken as the difference of the running total, so the years add up to the basis exactly and
 * the last year is the short one, as on the IRS tables.
 */
export function depreciationForYear(
  basis: bigint,
  inService: CalendarDate,
  year: number,
  method: DepreciationMethod,
): bigint {
  const total = (y: number) => divRound(basis * halfMonthsThrough(inService, y, method), HALF_MONTHS[method]);
  return total(year) - total(year - 1);
}

// ----- Returns (RNT-11) ---------------------------------------------------------------------------------------

/** NOI ÷ value in basis points; null without a value. */
export const capRateBps = (noi: bigint, currentValue: bigint | null): number | null =>
  currentValue === null || currentValue <= 0n ? null : Number(divRound(noi * 10_000n, currentValue));

/** Cash flow ÷ cash invested in basis points; null without an amount invested. */
export const cashOnCashBps = (cashFlow: bigint, invested: bigint | null): number | null =>
  invested === null || invested <= 0n ? null : Number(divRound(cashFlow * 10_000n, invested));

export interface OccupancyPeriod {
  start: CalendarDate;
  end: CalendarDate | null;
}

/** Days in the range covered by any of these, without counting an overlap twice. Both ends count. */
export function occupiedDays(
  periods: readonly OccupancyPeriod[],
  from: CalendarDate,
  to: CalendarDate,
): number {
  const clipped = periods
    .map((p) => ({ start: p.start < from ? from : p.start, end: p.end === null || p.end > to ? to : p.end }))
    .filter((p) => p.start <= p.end)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  let total = 0;
  let cursor: CalendarDate | null = null;
  for (const p of clipped) {
    const start: CalendarDate = cursor !== null && p.start <= cursor ? addDays(cursor, 1) : p.start;
    if (start > p.end) continue;
    total += daysBetween(start, p.end) + 1;
    cursor = p.end;
  }
  return total;
}

/** Occupied unit-days ÷ all unit-days, in basis points; null with no units. */
export function occupancyBps(
  occupied: number,
  units: number,
  from: CalendarDate,
  to: CalendarDate,
): number | null {
  const all = units * (daysBetween(from, to) + 1);
  return all <= 0 ? null : Number(divRound(BigInt(occupied) * 10_000n, BigInt(all)));
}

// ----- Reminders (RNT-12) -------------------------------------------------------------------------------------

export const LEASE_REMINDER_DAYS = [60, 30] as const;

/** Which reminder a lease ending on `end` is at: within 30 days, within 60, or none yet. */
export function leaseExpiryWindow(end: CalendarDate, today: CalendarDate): 30 | 60 | null {
  const left = daysBetween(today, end);
  if (left < 0) return null;
  return left <= 30 ? 30 : left <= 60 ? 60 : null;
}
