/**
 * Receipt ↔ transaction matching (IMP-11, CUR-04; design 04 §7 step 6, ADR-0014). Pure: the API supplies the
 * receipts, the candidate transactions and a rate lookup, and stores the result.
 *
 * A pair is a candidate only inside the hard limits:
 * - dates within ±5 days;
 * - the same direction (a purchase receipt against money out, a refund against money in);
 * - amount: same currency within ±2 minor units, or for restaurants total ≤ charged ≤ total × 1.30;
 *   different currencies convert the receipt at the day's rate and allow ±3% (plus the tip range for
 *   restaurants);
 * - card last-4, when both sides know it, must agree.
 *
 * Candidates are scored 0.45 × amount + 0.20 × date + 0.35 × merchant and assigned one-to-one, best score
 * first, so one transaction never takes two receipts. A receipt links automatically when its score is
 * ≥ 0.8 and no other candidate comes within 0.05 of it (two identical coffees stay for the user to pick).
 */
import {
  abs,
  convert,
  decimalToString,
  deviationBps,
  diffDays,
  FX_MATCH_TOLERANCE_BPS,
  impliedRate,
  minorUnits,
  RECEIPT_TOLERANCE_MINOR,
  TIP_TOLERANCE_PERCENT,
  type CalendarDate,
  type CurrencyCode,
  type Decimal,
} from '@montra/domain';
import { similarity } from './payees.js';

export const RECEIPT_MATCH_WINDOW_DAYS = 5;
export const RECEIPT_AUTO_LINK_SCORE = 0.8;
export const RECEIPT_AMBIGUITY_MARGIN = 0.05;
const MAX_CANDIDATES = 5;
const WEIGHTS = { amount: 0.45, date: 0.2, merchant: 0.35 } as const;

/** MCCs where a tip may be added after the receipt is printed: restaurants, bars, fast food. */
export const TIP_MCCS: ReadonlySet<string> = new Set(['5812', '5813', '5814']);

export interface ReceiptForMatch {
  id: string;
  date: CalendarDate | null;
  /** Printed total in minor units of the receipt currency: positive for a purchase, negative for a refund. */
  total: bigint;
  currency: CurrencyCode;
  /** `normalizeDescription(merchant)`; empty when extraction couldn't read it. */
  merchantKey: string;
  /** Reference merchant (`ref.merchant.id`), when known: an exact link counts as a perfect merchant match. */
  merchantId?: string | null;
  /** Allow a later tip (see `TIP_MCCS`). */
  tipAllowed?: boolean;
  cardLast4?: string | null;
}

export interface TransactionForMatch {
  transactionId: string;
  date: CalendarDate;
  /** Signed from the account's view, as on `TransactionDto.amount`: negative = money out. */
  amount: bigint;
  currency: CurrencyCode;
  /** The transaction's normalized payee (`payee_key`). */
  payeeKey: string;
  merchantId?: string | null;
  /** Last four digits of the paying card or account, when known. */
  accountLast4?: string | null;
}

/** Units of `to` per one unit of `from` on `date` (the latest published rate on or before it), or null. */
export type RateLookup = (from: CurrencyCode, to: CurrencyCode, date: CalendarDate) => Decimal | null;

export type AmountMatch =
  | { kind: 'exact'; gap: bigint }
  /** A tip added after printing; `bps` is gap ÷ total in basis points. */
  | { kind: 'tip'; gap: bigint; bps: bigint }
  /** Converted at the day's rate; `bps` is the deviation of the charge from the converted total. */
  | { kind: 'fx'; dayRate: string; bps: bigint };

export interface MatchFactors {
  amount: AmountMatch;
  /** Transaction date − receipt date. */
  days: number;
  /** 0..1, trigram similarity of the merchant and payee keys (1 for the same reference merchant). */
  merchant: number;
}

export interface ReceiptMatchCandidate {
  transactionId: string;
  score: number;
  factors: MatchFactors;
  /**
   * The rate to store on the receipt and the transaction when the currencies differ (CUR-04): implied by
   * the two amounts, or the day's rate when the difference is a tip. Home units per receipt unit.
   */
  fx: { rate: string; source: 'implied' | 'reference' } | null;
}

export interface ReceiptMatchResult {
  receiptId: string;
  /** Set when the best candidate is linked automatically. */
  link: ReceiptMatchCandidate | null;
  /** Best first, at most five, including the linked one. Empty: the receipt stays in the inbox. */
  candidates: ReceiptMatchCandidate[];
}

/** Scores one pair, or returns null when it is outside the hard limits. */
export function scoreReceiptMatch(
  receipt: ReceiptForMatch,
  txn: TransactionForMatch,
  rateOf: RateLookup,
): ReceiptMatchCandidate | null {
  if (receipt.date === null || receipt.total === 0n || txn.amount === 0n) return null;
  // A purchase receipt pairs with money out; a refund receipt with money in.
  if (receipt.total > 0n !== txn.amount < 0n) return null;
  if (receipt.cardLast4 && txn.accountLast4 && receipt.cardLast4 !== txn.accountLast4) return null;
  const days = diffDays(txn.date, receipt.date);
  if (Math.abs(days) > RECEIPT_MATCH_WINDOW_DAYS) return null;

  const total = abs(receipt.total);
  const charged = abs(txn.amount);
  let amount: AmountMatch;
  let amountScore: number;
  let fx: ReceiptMatchCandidate['fx'] = null;

  if (receipt.currency === txn.currency) {
    const gap = charged - total;
    if (abs(gap) <= RECEIPT_TOLERANCE_MINOR) {
      amount = { kind: 'exact', gap };
      amountScore = 1;
    } else if (receipt.tipAllowed && gap > 0n && gap * 100n <= total * TIP_TOLERANCE_PERCENT) {
      const bps = (gap * 10_000n) / total;
      amount = { kind: 'tip', gap, bps };
      amountScore = 1 - Number(bps) / 10_000; // a 20% tip scores 0.8
    } else {
      return null;
    }
  } else {
    const rate = rateOf(receipt.currency, txn.currency, receipt.date);
    if (!rate) return null;
    const expected = convert({ amount: total, currency: receipt.currency }, txn.currency, rate).amount;
    if (expected === 0n) return null;
    const bps = deviationBps(charged, expected);
    const tipCeiling = TIP_TOLERANCE_PERCENT * 100n + FX_MATCH_TOLERANCE_BPS;
    const inRate = abs(bps) <= FX_MATCH_TOLERANCE_BPS;
    const inTip = !!receipt.tipAllowed && bps > FX_MATCH_TOLERANCE_BPS && bps <= tipCeiling;
    if (!inRate && !inTip) return null;
    amount = { kind: 'fx', dayRate: decimalToString(rate), bps };
    amountScore = inRate
      ? 1 - (Number(abs(bps)) / Number(FX_MATCH_TOLERANCE_BPS)) * 0.5 // ±3% scores 0.5
      : 1 - Number(bps) / 10_000;
    fx = inRate
      ? {
          rate: decimalToString(
            impliedRate(charged, minorUnits(txn.currency), total, minorUnits(receipt.currency)),
          ),
          source: 'implied',
        }
      : { rate: decimalToString(rate), source: 'reference' };
  }

  const merchant =
    receipt.merchantId && txn.merchantId && receipt.merchantId === txn.merchantId
      ? 1
      : merchantSimilarity(receipt.merchantKey, txn.payeeKey);
  const dateScore = 1 - 0.15 * Math.abs(days);
  const score = round(WEIGHTS.amount * amountScore + WEIGHTS.date * dateScore + WEIGHTS.merchant * merchant);
  return {
    transactionId: txn.transactionId,
    score,
    factors: { amount, days, merchant: round(merchant) },
    fx,
  };
}

/**
 * Matches receipts against candidate transactions (those without a receipt, already narrowed by the
 * caller to the receipts' date range and the workspace's spending accounts).
 */
export function matchReceipts(
  receipts: readonly ReceiptForMatch[],
  transactions: readonly TransactionForMatch[],
  rateOf: RateLookup,
): ReceiptMatchResult[] {
  const scored = receipts.map((r) =>
    transactions
      .map((t) => scoreReceiptMatch(r, t, rateOf))
      .filter((c): c is ReceiptMatchCandidate => c !== null)
      .sort((a, b) => b.score - a.score || a.transactionId.localeCompare(b.transactionId)),
  );

  // One-to-one: take the strongest unambiguous pairs first, so a weaker receipt can't claim a transaction
  // that a better receipt matches.
  const pairs = scored
    .flatMap((cands, i) => cands.map((c) => ({ i, c })))
    .filter(({ i, c }) => c.score >= RECEIPT_AUTO_LINK_SCORE && isClear(scored[i]!, c))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i);
  const links = new Map<number, ReceiptMatchCandidate>();
  const taken = new Set<string>();
  for (const { i, c } of pairs) {
    if (links.has(i) || taken.has(c.transactionId)) continue;
    links.set(i, c);
    taken.add(c.transactionId);
  }

  return receipts.map((r, i) => {
    const link = links.get(i) ?? null;
    // Transactions linked to another receipt are no longer offered.
    const candidates = scored[i]!.filter((c) => c === link || !taken.has(c.transactionId)).slice(
      0,
      MAX_CANDIDATES,
    );
    return { receiptId: r.id, link, candidates };
  });
}

/** No other candidate of the same receipt comes within the ambiguity margin of `c`. */
function isClear(cands: readonly ReceiptMatchCandidate[], c: ReceiptMatchCandidate): boolean {
  return cands.every((o) => o === c || c.score - o.score >= RECEIPT_AMBIGUITY_MARGIN);
}

/**
 * Trigram similarity, raised to 0.9 when one key is a whole-word prefix of the other: receipts print the
 * brand ("SHELL"), statements add a suffix ("SHELL OIL", "LE PETIT BISTRO PARIS").
 */
export function merchantSimilarity(receiptKey: string, payeeKey: string): number {
  if (!receiptKey || !payeeKey) return 0;
  const s = similarity(receiptKey, payeeKey);
  const prefix = payeeKey.startsWith(`${receiptKey} `) || receiptKey.startsWith(`${payeeKey} `);
  return prefix ? Math.max(s, 0.9) : s;
}

const round = (n: number) => Number(n.toFixed(4));
