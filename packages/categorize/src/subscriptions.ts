/**
 * Subscriptions you may not be using (REC-06). Montra can't see whether a service is used; it sees spending. So it
 * only points at two patterns, and says "may", never "is":
 *
 * - **idle**: there was other spending at the subscription's merchant before (Uber rides beside Uber One, Amazon
 *   orders beside Prime), but none for `idleMonths`, while the charge kept coming.
 * - **similar**: `similarMin` or more subscriptions in one category from the same kind of merchant (the reference
 *   merchant's MCC: Netflix, Hulu and Disney+ are all streaming).
 *
 * All numbers are computed here; no model is involved (AIA-05). Thresholds come from the workspace's planning
 * settings.
 */
import { addMonths, type CalendarDate } from '@montra/domain';
import type { Cadence } from './types.js';

export interface SubscriptionItem {
  /** The recurring item. */
  id: string;
  name: string;
  /** Normalized payee key of the charge (the importers' normalizeDescription of its payee or name). */
  payeeKey: string;
  categoryId: string | null;
  /** The reference merchant's MCC when the payee matches one. */
  mcc: string | null;
  /** Signed minor units; a subscription is negative. */
  amountMinor: bigint;
  currency: string;
  cadence: Cadence;
  /** When Montra started scheduling it. */
  startDate: CalendarDate;
}

/** A posted spending transaction (negative amount) that may be at a subscription's merchant. */
export interface MerchantTxn {
  id: string;
  date: CalendarDate;
  payeeKey: string;
  amountMinor: bigint;
  /** Set when a recurring item created it. */
  recurringItemId: string | null;
}

export interface UnusedSubscriptionSettings {
  /** No other spending at the merchant for this many months. 0: off. */
  idleMonths: number;
  /** This many similar subscriptions in one category. Below 2: off. */
  similarMin: number;
}

export type UnusedSubscriptionFinding =
  | {
      kind: 'idle';
      itemId: string;
      /** The last other spending at the merchant. */
      lastOtherSpending: CalendarDate;
      costPerYearMinor: bigint;
    }
  | {
      kind: 'similar';
      /** Sorted, so the same set gives the same key. */
      itemIds: string[];
      categoryId: string;
      mcc: string;
      costPerYearMinor: bigint;
    };

const PER_YEAR: Record<Cadence, bigint> = {
  weekly: 52n,
  biweekly: 26n,
  semimonthly: 24n,
  monthly: 12n,
  quarterly: 4n,
  yearly: 1n,
};

const absBig = (n: bigint) => (n < 0n ? -n : n);

/** What a subscription costs a year, positive minor units. */
export function costPerYear(amountMinor: bigint, cadence: Cadence): bigint {
  return absBig(amountMinor) * PER_YEAR[cadence];
}

/** Words that say how someone paid, not who they paid. */
const NOISE = new Set([
  'THE',
  'POS',
  'ACH',
  'DEBIT',
  'CREDIT',
  'CARD',
  'PURCHASE',
  'RECURRING',
  'ONLINE',
  'PAYMENT',
  'PMT',
  'AUTOPAY',
  'BILL',
]);

/**
 * The merchant's first name word in a normalized payee key: "UBER" for both "UBER ONE" and "UBER TRIP". Empty
 * when there is none (account digits and noise words don't count).
 */
export function merchantWord(payeeKey: string): string {
  for (const w of payeeKey.toUpperCase().split(' '))
    if (w.length >= 2 && !NOISE.has(w) && !w.startsWith('••') && /\p{L}/u.test(w)) return w;
  return '';
}

/** Within 5% of the charge: a subscription's own charge (or a price change of it), not other spending. */
function nearCharge(amount: bigint, charge: bigint): boolean {
  const a = absBig(amount);
  const c = absBig(charge);
  return a * 100n >= c * 95n && a * 100n <= c * 105n;
}

export function unusedSubscriptions(input: {
  items: readonly SubscriptionItem[];
  /** Spending since at least `idleMonths` + 12 months ago. Other entities' and income rows are left out. */
  txns: readonly MerchantTxn[];
  today: CalendarDate;
  settings: UnusedSubscriptionSettings;
}): UnusedSubscriptionFinding[] {
  const items = input.items.filter((i) => i.amountMinor < 0n);
  const out: UnusedSubscriptionFinding[] = [];

  if (input.settings.idleMonths > 0) {
    const cutoff = addMonths(input.today, -input.settings.idleMonths);
    const itemIds = new Set(items.map((i) => i.id));
    for (const item of items) {
      // It has to have been charging for the whole window.
      if (item.startDate > cutoff) continue;
      const word = merchantWord(item.payeeKey);
      if (!word) continue;
      const charges = items.filter((i) => merchantWord(i.payeeKey) === word).map((i) => i.amountMinor);
      let last: CalendarDate | null = null;
      for (const t of input.txns) {
        if (t.amountMinor >= 0n || merchantWord(t.payeeKey) !== word) continue;
        if (t.recurringItemId && itemIds.has(t.recurringItemId)) continue;
        if (charges.some((c) => nearCharge(t.amountMinor, c))) continue;
        if (!last || t.date > last) last = t.date;
      }
      // No other spending ever: nothing to compare with, so no hint either way.
      if (!last || last >= cutoff) continue;
      out.push({
        kind: 'idle',
        itemId: item.id,
        lastOtherSpending: last,
        costPerYearMinor: costPerYear(item.amountMinor, item.cadence),
      });
    }
  }

  if (input.settings.similarMin >= 2) {
    const groups = new Map<string, SubscriptionItem[]>();
    for (const i of items) {
      if (!i.mcc || !i.categoryId) continue;
      const k = `${i.categoryId}|${i.mcc}|${i.currency}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    for (const g of groups.values()) {
      if (g.length < input.settings.similarMin) continue;
      out.push({
        kind: 'similar',
        itemIds: g.map((i) => i.id).sort(),
        categoryId: g[0]!.categoryId!,
        mcc: g[0]!.mcc!,
        costPerYearMinor: g.reduce((t, i) => t + costPerYear(i.amountMinor, i.cadence), 0n),
      });
    }
  }
  return out;
}
