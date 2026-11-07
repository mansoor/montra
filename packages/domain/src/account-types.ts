/**
 * What makes each account type different (ADR-0023). Forms, pages and the server read this rather than keeping their
 * own lists of kinds, so a new behaviour for a type is one change here.
 */
import {
  addDays,
  compareDates,
  diffDays,
  endOfMonth,
  startOfMonth,
  type CalendarDate,
} from './calendar-date.js';

/** What you have first, then what you owe, most everyday first. */
export const ACCOUNT_KINDS = [
  'checking',
  'savings',
  'cash',
  'investment',
  'asset',
  'credit_card',
  'line_of_credit',
  'loan',
  'mortgage',
  'liability',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Optional facts an account of this type can hold. */
export type AccountDetail = 'creditLimit' | 'interestRate' | 'minPayment' | 'lowBalance';

export interface AccountProfile {
  side: 'asset' | 'liability';
  /** How the balance is described. */
  balanceWord: 'balance' | 'value' | 'owed';
  /** Who holds the account, which names the field. Null when nobody does, so the form doesn't ask. */
  holder: 'bank' | 'issuer' | 'lender' | 'provider' | null;
  /** Whether it has an account or card number worth recognizing it by. */
  hasNumber: boolean;
  details: readonly AccountDetail[];
  /** On the forecast: cash can go low, a card can reach its limit. Null when it isn't forecast. */
  forecast: 'cash' | 'card' | null;
  /** What money moving into it counts as on the cash-flow chart. */
  moneyFlow: 'savings' | 'debt' | null;
  /** Whether it can follow a repayment schedule. */
  schedule: boolean;
  /** Whether adding one offers full payment tracking: a fixed term, repaid in level payments. */
  installment: boolean;
}

const CASH_DETAILS: readonly AccountDetail[] = ['lowBalance'];
const DEBT_DETAILS: readonly AccountDetail[] = ['interestRate', 'minPayment'];
const REVOLVING_DETAILS: readonly AccountDetail[] = ['creditLimit', 'interestRate', 'minPayment'];

const bank = {
  side: 'asset',
  balanceWord: 'balance',
  holder: 'bank',
  hasNumber: true,
  details: CASH_DETAILS,
  forecast: 'cash',
  moneyFlow: null,
  schedule: false,
  installment: false,
} as const;

const debt = {
  side: 'liability',
  balanceWord: 'owed',
  holder: 'lender',
  hasNumber: true,
  details: DEBT_DETAILS,
  forecast: null,
  moneyFlow: 'debt',
  schedule: true,
  installment: true,
} as const;

export const ACCOUNT_PROFILES: Readonly<Record<AccountKind, AccountProfile>> = {
  checking: bank,
  savings: { ...bank, moneyFlow: 'savings' },
  cash: { ...bank, holder: null, hasNumber: false },
  investment: {
    ...bank,
    balanceWord: 'value',
    holder: 'provider',
    details: [],
    forecast: null,
    moneyFlow: 'savings',
  },
  asset: {
    ...bank,
    balanceWord: 'value',
    holder: null,
    hasNumber: false,
    details: [],
    forecast: null,
  },
  credit_card: {
    ...debt,
    holder: 'issuer',
    details: REVOLVING_DETAILS,
    forecast: 'card',
    moneyFlow: null,
    schedule: false,
    installment: false,
  },
  line_of_credit: { ...debt, details: REVOLVING_DETAILS, installment: false },
  loan: debt,
  mortgage: debt,
  liability: {
    ...debt,
    holder: null,
    hasNumber: false,
    moneyFlow: null,
    schedule: false,
    installment: false,
  },
};

/** The type of a stored kind. The database only allows the kinds above. */
export const accountProfile = (kind: string): AccountProfile => ACCOUNT_PROFILES[kind as AccountKind];

/** Every kind with this trait. */
export const kindsWhere = (test: (t: AccountProfile) => boolean): AccountKind[] =>
  ACCOUNT_KINDS.filter((k) => test(ACCOUNT_PROFILES[k]));

/**
 * "19.99" to 1999 basis points. Parsed as text, because 19.99 * 100 in floating point is 1998.9999…, which truncates to
 * 19.98%. Returns null for anything that isn't a percentage from 0 to 100 with at most two decimals.
 */
export function percentToBps(input: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/** 1999 to "19.99". */
export const bpsToPercent = (bps: number): string =>
  `${String((bps - (bps % 100)) / 100)}.${String(bps % 100).padStart(2, '0')}`;

export const BALANCE_RANGES = ['3m', '6m', '1y', 'all'] as const;
export type BalanceRange = (typeof BALANCE_RANGES)[number];

const RANGE_DAYS: Readonly<Record<Exclude<BalanceRange, 'all'>, number>> = { '3m': 91, '6m': 182, '1y': 365 };

/** The first day a range covers. It never starts before the account has any history, which would draw a false zero. */
export function balanceRangeStart(
  range: BalanceRange,
  today: CalendarDate,
  firstActivity: CalendarDate,
): CalendarDate {
  if (range === 'all') return firstActivity;
  const start = addDays(today, -RANGE_DAYS[range]);
  return compareDates(start, firstActivity) < 0 ? firstActivity : start;
}

/**
 * The days to plot between two dates, always including both ends: every day for a few months, every week for a couple of
 * years, then month ends, so a long-lived account stays a few hundred points at most.
 */
export function balanceHistoryDates(from: CalendarDate, to: CalendarDate): CalendarDate[] {
  if (compareDates(from, to) > 0) return [];
  const span = diffDays(to, from);
  const out: CalendarDate[] = [];
  if (span <= 100) {
    for (let d = from; compareDates(d, to) <= 0; d = addDays(d, 1)) out.push(d);
    return out;
  }
  if (span <= 800) {
    for (let d = from; compareDates(d, to) < 0; d = addDays(d, 7)) out.push(d);
  } else {
    out.push(from);
    for (let d = endOfMonth(from); compareDates(d, to) < 0; d = endOfMonth(addDays(startOfMonth(d), 32))) {
      if (d !== from) out.push(d);
    }
  }
  out.push(to);
  return out;
}

/**
 * Natural balances on each date from a side's daily changes (debit-positive, as the ledger stores them, sorted by date).
 * Money owed reads as a positive amount, like everywhere else an account shows its balance.
 */
export function balancesOn(
  side: 'asset' | 'liability',
  changes: readonly { date: CalendarDate; delta: bigint }[],
  dates: readonly CalendarDate[],
): { date: CalendarDate; balance: bigint }[] {
  const sign = side === 'liability' ? -1n : 1n;
  let running = 0n;
  let next = 0;
  return dates.map((date) => {
    while (next < changes.length && compareDates(changes[next]!.date, date) <= 0)
      running += changes[next++]!.delta;
    return { date, balance: sign * running };
  });
}
