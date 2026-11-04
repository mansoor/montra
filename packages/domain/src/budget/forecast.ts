/** Cash-flow forecast (FLOW-03; design 04 §11): a deterministic day-by-day simulation per account. */
import { addDays, compareDates, type CalendarDate } from '../calendar-date.js';
import { divRound } from '../rounding.js';

export interface ForecastItem {
  date: CalendarDate;
  accountId: string;
  /** Signed, account currency: income positive, bills negative. */
  amount: bigint;
  kind: 'recurring' | 'income' | 'card_payment' | 'burn' | 'invoice' | 'bill';
  name: string;
  sourceId: string | null;
}

export interface ForecastAccount {
  accountId: string;
  /** End-of-day balance on the day before `from`. */
  start: bigint;
  /** Warn below this (default 0). */
  threshold: bigint;
}

export interface AccountForecast {
  accountId: string;
  /** End-of-day balances for `from` … `from + days − 1`. */
  balances: bigint[];
  items: ForecastItem[];
  lowBalance: { date: CalendarDate; balance: bigint; drivers: ForecastItem[] } | null;
}

/**
 * Discretionary burn (04 §11): what's left of the variable categories' budgets, spread evenly over the
 * remaining days of the period (falling back to the 3-month daily average when there is no budget).
 * Returns one negative item per day; the remainder of the division lands on the first days.
 */
export function burnItems(
  accountId: string,
  remaining: bigint,
  from: CalendarDate,
  days: number,
  name = 'Everyday spending',
): ForecastItem[] {
  if (remaining <= 0n || days <= 0) return [];
  const base = remaining / BigInt(days);
  const extra = remaining - base * BigInt(days);
  const out: ForecastItem[] = [];
  for (let i = 0; i < days; i++) {
    const amount = base + (BigInt(i) < extra ? 1n : 0n);
    if (amount > 0n)
      out.push({ date: addDays(from, i), accountId, amount: -amount, kind: 'burn', name, sourceId: null });
  }
  return out;
}

/** The daily average of a total over a number of days (half up), for the burn fallback. */
export const dailyAverage = (total: bigint, days: number): bigint =>
  days > 0 ? divRound(total, BigInt(days)) : 0n;

/**
 * Simulates each account for `days` days from `from`. The low-balance warning names the first day below
 * the threshold and the largest outflows up to that day (at most 5) as its drivers.
 */
export function forecast(
  accounts: readonly ForecastAccount[],
  items: readonly ForecastItem[],
  from: CalendarDate,
  days: number,
): AccountForecast[] {
  const last = addDays(from, days - 1);
  return accounts.map((a) => {
    const mine = items
      .filter(
        (i) =>
          i.accountId === a.accountId && compareDates(i.date, from) >= 0 && compareDates(i.date, last) <= 0,
      )
      .sort((x, y) => compareDates(x.date, y.date));
    const balances: bigint[] = [];
    let balance = a.start;
    let k = 0;
    let lowBalance: AccountForecast['lowBalance'] = null;
    for (let d = 0; d < days; d++) {
      const date = addDays(from, d);
      while (k < mine.length && mine[k]!.date === date) balance += mine[k++]!.amount;
      balances.push(balance);
      if (!lowBalance && balance < a.threshold) {
        const drivers = mine
          .slice(0, k)
          .filter((i) => i.amount < 0n && i.kind !== 'burn')
          .sort((x, y) => (x.amount < y.amount ? -1 : x.amount > y.amount ? 1 : 0))
          .slice(0, 5);
        lowBalance = { date, balance, drivers };
      }
    }
    return { accountId: a.accountId, balances, items: mine, lowBalance };
  });
}
