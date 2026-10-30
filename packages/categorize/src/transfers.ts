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
 */
export function transferSuggestion(
  item: PipelineItem,
  candidates: readonly TransferCandidate[],
): TransferSuggestion | null {
  if (item.amountMinor === 0n) return null;
  const text = normText(`${item.payee ?? ''} ${item.description} ${item.rawDescription ?? ''}`);
  const isPayment = PAYMENT_WORDS.some((w) => hasWord(text, w));
  const keyword = isPayment || TRANSFER_WORDS.some((w) => hasWord(text, w));

  const scored = candidates
    .filter(
      (c) =>
        c.accountId !== item.accountId &&
        c.amountMinor === -item.amountMinor &&
        Math.abs(diffDays(c.date, item.date)) <= 3,
    )
    .map((c) => ({
      c,
      signal: keyword || (c.accountLast4 !== null && c.accountLast4 !== '' && text.includes(c.accountLast4)),
      gap: Math.abs(diffDays(c.date, item.date)),
    }))
    .sort((a, b) => Number(b.signal) - Number(a.signal) || a.gap - b.gap);
  const best = scored[0];
  if (!best) return null;
  const tied = scored.filter((s) => s.signal === best.signal && s.gap === best.gap).length > 1;
  const confidence = best.signal && !tied ? 0.95 : 0.6;

  const out = item.amountMinor < 0n;
  const label = `${best.c.accountName}${best.c.accountLast4 ? ` ••${best.c.accountLast4}` : ''}`;
  const explanation = isPayment
    ? `Looks like the payment ${out ? 'to' : 'from'} ${label}`
    : `Looks like a transfer ${out ? 'to' : 'from'} ${label}`;
  return { candidate: best.c, confidence, explanation };
}
