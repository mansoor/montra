/**
 * Anomaly flags (AI-09, REC-06): unusual amount for a payee, possible duplicate charge, new subscription and
 * price increase. All numbers are computed here; no model is involved (AIA-05).
 */
import { asCurrencyCode, diffDays, formatMoney, money, type CalendarDate } from '@montra/domain';
import type { Anomaly, HistoryTxn, RecurringProposal } from './types.js';

export type AnomalyTxn = HistoryTxn & { payeeKey: string; payee: string; currency: string };

export interface AnomalyInput {
  /** The new or recent transactions to check. */
  txns: readonly AnomalyTxn[];
  /** Earlier transactions for a payee (may include the checked ones; they are excluded by id). */
  history: (payeeKey: string) => readonly HistoryTxn[];
  recurring: readonly RecurringProposal[];
  today: CalendarDate;
}

const absBig = (n: bigint) => (n < 0n ? -n : n);
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

function medianBig(values: readonly bigint[]): bigint {
  const s = [...values].sort(cmpBig);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

function fmt(amount: bigint, currency: string): string {
  try {
    return formatMoney(money(amount, asCurrencyCode(currency)));
  } catch {
    return `${amount} ${currency}`;
  }
}

/** a / b to one decimal place, rounded half up, as text ("3.2"). */
function ratio(a: bigint, b: bigint): string {
  const tenths = (a * 10n * 2n + b) / (2n * b);
  return `${tenths / 10n}.${tenths % 10n}`;
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: 'weekly',
  biweekly: 'every two weeks',
  semimonthly: 'twice a month',
  monthly: 'monthly',
  quarterly: 'quarterly',
  yearly: 'yearly',
};

export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const out: Anomaly[] = [];
  const seen = new Set<string>();
  const push = (a: Anomaly) => {
    if (seen.has(a.dedupeKey)) return;
    seen.add(a.dedupeKey);
    out.push(a);
  };

  for (const t of input.txns) {
    const history = input.history(t.payeeKey);

    // Unusual amount: well above the payee's typical amount, with at least 4 earlier transactions.
    const prior = history.filter(
      (h) =>
        h.id !== t.id &&
        h.date <= t.date &&
        h.amountMinor !== 0n &&
        h.amountMinor < 0n === t.amountMinor < 0n,
    );
    if (prior.length >= 4 && t.amountMinor !== 0n) {
      const abs = prior.map((h) => absBig(h.amountMinor));
      const med = medianBig(abs);
      const mad = medianBig(abs.map((v) => absBig(v - med)));
      const amount = absBig(t.amountMinor);
      const limit = 2n * med > med + 4n * mad ? 2n * med : med + 4n * mad;
      if (med > 0n && amount > limit)
        push({
          kind: 'unusual_amount',
          transactionId: t.id,
          payeeKey: t.payeeKey,
          dedupeKey: `unusual_amount:${t.id}`,
          message: `${fmt(amount, t.currency)} is ${ratio(amount, med)}× your usual ${fmt(med, t.currency)} at ${t.payee}`,
          data: {
            amount: amount.toString(),
            usual: med.toString(),
            ratio: Number(ratio(amount, med)),
            priorCount: prior.length,
          },
        });
    }

    // Possible duplicate charge: same payee, account and amount within 2 days; the later one is flagged.
    if (t.amountMinor < 0n) {
      const pool = [...history, ...input.txns.filter((o) => o.payeeKey === t.payeeKey)];
      const earlier = pool.find(
        (o) =>
          o.id !== t.id &&
          o.accountId === t.accountId &&
          o.amountMinor === t.amountMinor &&
          Math.abs(diffDays(o.date, t.date)) <= 2 &&
          (o.date < t.date || (o.date === t.date && o.id < t.id)),
      );
      if (earlier)
        push({
          kind: 'duplicate_charge',
          transactionId: t.id,
          payeeKey: t.payeeKey,
          dedupeKey: `duplicate_charge:${t.id}`,
          message: `Possible duplicate: ${fmt(absBig(t.amountMinor), t.currency)} at ${t.payee} was also charged on ${earlier.date}`,
          data: {
            otherTransactionId: earlier.id,
            otherDate: earlier.date,
            amount: absBig(t.amountMinor).toString(),
          },
        });
    }
  }

  // New subscriptions and price increases, attached to the latest occurrence when it is among `txns`.
  for (const r of input.recurring) {
    const t = input.txns.find(
      (x) => x.payeeKey === r.payeeKey && x.accountId === r.accountId && x.date === r.lastDate,
    );
    if (!t) continue;
    if (r.isNew && r.amountMinor < 0n)
      push({
        kind: 'new_subscription',
        transactionId: t.id,
        payeeKey: r.payeeKey,
        dedupeKey: `new_subscription:${t.id}`,
        message: `New recurring charge: ${r.payee}, ${CADENCE_LABEL[r.cadence]}, ${fmt(absBig(r.amountMinor), t.currency)}`,
        data: { cadence: r.cadence, amount: absBig(r.amountMinor).toString(), nextDate: r.nextDate },
      });
    if (r.priceIncrease)
      push({
        kind: 'price_increase',
        transactionId: t.id,
        payeeKey: r.payeeKey,
        dedupeKey: `price_increase:${t.id}`,
        message: `${r.payee} went up ${r.priceIncrease.percent}% from ${fmt(absBig(r.priceIncrease.fromMinor), t.currency)} to ${fmt(absBig(r.priceIncrease.toMinor), t.currency)}`,
        data: {
          from: absBig(r.priceIncrease.fromMinor).toString(),
          to: absBig(r.priceIncrease.toMinor).toString(),
          percent: r.priceIncrease.percent,
        },
      });
  }
  return out;
}
