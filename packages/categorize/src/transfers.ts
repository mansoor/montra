/** Transfer and card-payment detection (pipeline step 3, 04 §5). */
import { diffDays } from '@montra/domain';
import { hasWord, normText } from './text.js';
import type { PipelineItem, TransferCandidate } from './types.js';

const PAYMENT_WORDS = [
  'payment',
  'pymt',
  'pmt',
  'autopay',
  'auto pay',
  'thank you',
  'epay',
  'e-pay',
  'bill pay',
];
const TRANSFER_WORDS = [
  'transfer',
  'xfer',
  'trnsfr',
  'tfr',
  'ach',
  'online banking',
  'direct debit',
  'sweep',
];

export interface TransferSuggestion {
  candidate: TransferCandidate;
  confidence: number;
  explanation: string;
}

/**
 * Opposite-sign, equal-amount pair on another account within ±3 days. 0.95 when a payment/transfer keyword or
 * the other account's last 4 digits appear in the text; amount-only pairs (and ties) are capped at 0.60.
 *
 * Candidates without a transaction (the other side isn't in yet) stand for the account itself. They count only when
 * the text reads like a payment or transfer and names that account's last 4 digits (0.80); a real other side wins.
 */
export function transferSuggestion(
  item: PipelineItem,
  candidates: readonly TransferCandidate[],
): TransferSuggestion | null {
  if (item.amountMinor === 0n) return null;
  const text = normText(`${item.payee ?? ''} ${item.description} ${item.rawDescription ?? ''}`);
  const isPayment = PAYMENT_WORDS.some((w) => hasWord(text, w));
  const keyword = isPayment || TRANSFER_WORDS.some((w) => hasWord(text, w));

  const names = (c: TransferCandidate) =>
    c.accountLast4 !== null && c.accountLast4 !== '' && text.includes(c.accountLast4);
  const scored = candidates
    .filter(
      (c) =>
        c.accountId !== item.accountId &&
        c.amountMinor === -item.amountMinor &&
        Math.abs(diffDays(c.date, item.date)) <= 3 &&
        (c.transactionId !== null || (keyword && names(c))),
    )
    .map((c) => ({
      c,
      real: c.transactionId !== null,
      signal: keyword || names(c),
      gap: Math.abs(diffDays(c.date, item.date)),
    }))
    .sort((a, b) => Number(b.signal) - Number(a.signal) || Number(b.real) - Number(a.real) || a.gap - b.gap);
  const best = scored[0];
  if (!best) return null;
  const tied =
    scored.filter((s) => s.signal === best.signal && s.real === best.real && s.gap === best.gap).length > 1;
  const confidence = !best.real ? (tied ? 0.6 : 0.8) : best.signal && !tied ? 0.95 : 0.6;

  const out = item.amountMinor < 0n;
  const label = `${best.c.accountName}${best.c.accountLast4 ? ` ••${best.c.accountLast4}` : ''}`;
  const explanation = isPayment
    ? `Looks like the payment ${out ? 'to' : 'from'} ${label}`
    : `Looks like a transfer ${out ? 'to' : 'from'} ${label}`;
  return { candidate: best.c, confidence, explanation };
}
