/** Amount bands and personal-history suggestions (pipeline step 4, 04 §5; ADR-0012). */
import { pow10 } from '@montra/domain';
import type { HistoryEntry } from './types.js';

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/**
 * Half-octave log-scale band: `sign × (1 + floor(2·log2(max(1, |major|))))`, 0 for zero. Exact for any size.
 * 2·log2(x) ≥ k ⇔ x² ≥ 2^k, so we compare minor² with 2^k · 10^(2·exponent) in integers.
 */
export function amountBand(amountMinor: bigint, exponent: number): number {
  if (amountMinor === 0n) return 0;
  const sign = amountMinor < 0n ? -1 : 1;
  const a = amountMinor < 0n ? -amountMinor : amountMinor;
  const q = (a * a) / pow10(2 * exponent);
  const k = q === 0n ? 0 : bitLength(q) - 1;
  return sign * (1 + k);
}

export interface HistorySuggestion {
  categoryId: string;
  memberId: string | null;
  confidence: number;
  explanation: string;
}

function pick(entries: readonly HistoryEntry[]): HistorySuggestion | null {
  const byCategory = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    if (e.count <= 0) continue;
    total += e.count;
    byCategory.set(e.categoryId, (byCategory.get(e.categoryId) ?? 0) + e.count);
  }
  if (total === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of byCategory)
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  const share = bestCount / total;
  if (!best || share < 0.8 || bestCount < 2) return null;

  const byMember = new Map<string | null, number>();
  for (const e of entries)
    if (e.categoryId === best && e.count > 0)
      byMember.set(e.memberId, (byMember.get(e.memberId) ?? 0) + e.count);
  let member: string | null = null;
  for (const [id, n] of byMember) if (n / bestCount >= 0.8) member = id;

  return {
    categoryId: best,
    memberId: member,
    confidence: Math.min(0.97, share * Math.min(1, bestCount / 5)),
    explanation: `Similar to ${bestCount} past transaction${bestCount === 1 ? '' : 's'}`,
  };
}

/**
 * The majority category for a payee: same amount band first; otherwise all bands at 90% of the confidence.
 * Needs a share of at least 0.8 and at least 2 transactions.
 */
export function historySuggestion(entries: readonly HistoryEntry[], band: number): HistorySuggestion | null {
  const same = pick(entries.filter((e) => e.amountBand === band));
  if (same) return same;
  const all = pick(entries);
  return all ? { ...all, confidence: all.confidence * 0.9 } : null;
}
