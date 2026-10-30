/**
 * Duplicate and match classification for imported rows (IMP-07, design 04 §3.5). Silently dropping a real
 * transaction is the worst failure, so only exact duplicates are skipped automatically:
 * - exact duplicate: same account, date, amount, normalized description and per-file ordinal as a
 *   previously imported transaction;
 * - probable duplicate (flagged, never skipped): same amount within ±3 days, description similarity ≥ 0.6,
 *   inside a date range an earlier import of this account covered;
 * - match: a manual / camera / scheduled entry with the same amount within ±3 days and similar description
 *   (≥ 0.5) or the same payee, assigned one-to-one.
 */
import { diffDays, type CalendarDate } from '@montra/domain';
import { createHash } from 'node:crypto';
import { similarity } from './payees.js';

export interface DedupeInputRow {
  date: CalendarDate;
  amount: bigint;
  normalizedDescription: string;
}

export interface ImportedCandidate {
  transactionId: string;
  date: CalendarDate;
  amount: bigint;
  normalizedDescription: string;
  dedupeKey: string | null;
}

export interface ManualCandidate {
  transactionId: string;
  date: CalendarDate;
  amount: bigint;
  /** Normalized payee or description of the manual entry. */
  normalizedDescription: string;
}

export interface Classification {
  status: 'new' | 'duplicate' | 'probable_duplicate' | 'match';
  ordinal: number;
  dedupeKey: string;
  transactionId: string | null;
  score: number | null;
}

export const MATCH_WINDOW_DAYS = 3;

export function dedupeKey(accountId: string, row: DedupeInputRow, ordinal: number): string {
  return createHash('sha256')
    .update([accountId, row.date, row.amount.toString(), row.normalizedDescription, ordinal].join('|'))
    .digest('hex')
    .slice(0, 40);
}

/** Ordinal of each row among identical (date, amount, description) rows of the same file. */
export function ordinals(rows: readonly DedupeInputRow[]): number[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = `${r.date}|${r.amount}|${r.normalizedDescription}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n;
  });
}

const within = (a: CalendarDate, b: CalendarDate, days: number) => Math.abs(diffDays(a, b)) <= days;

export function classifyRows(
  accountId: string,
  rows: readonly DedupeInputRow[],
  imported: readonly ImportedCandidate[],
  manual: readonly ManualCandidate[],
  coveredRanges: readonly { min: CalendarDate; max: CalendarDate }[],
): Classification[] {
  const ords = ordinals(rows);
  const keys = rows.map((r, i) => dedupeKey(accountId, r, ords[i]!));
  const byKey = new Map(imported.filter((c) => c.dedupeKey).map((c) => [c.dedupeKey!, c]));
  const out: Classification[] = rows.map((_, i) => ({
    status: 'new',
    ordinal: ords[i]!,
    dedupeKey: keys[i]!,
    transactionId: null,
    score: null,
  }));
  const usedImported = new Set<string>();

  // 1. Exact duplicates (re-importing the same or an overlapping file).
  rows.forEach((_, i) => {
    const hit = byKey.get(keys[i]!);
    if (hit && !usedImported.has(hit.transactionId)) {
      out[i] = { ...out[i]!, status: 'duplicate', transactionId: hit.transactionId, score: 1 };
      usedImported.add(hit.transactionId);
    }
  });

  // 2. Probable duplicates, only where an earlier import could overlap.
  const covered = (d: CalendarDate) => coveredRanges.some((r) => d >= r.min && d <= r.max);
  rows.forEach((r, i) => {
    if (out[i]!.status !== 'new' || !covered(r.date)) return;
    let best: { c: ImportedCandidate; s: number } | null = null;
    for (const c of imported) {
      if (
        usedImported.has(c.transactionId) ||
        c.amount !== r.amount ||
        !within(c.date, r.date, MATCH_WINDOW_DAYS)
      )
        continue;
      const s = similarity(c.normalizedDescription, r.normalizedDescription);
      if (s >= 0.6 && (!best || s > best.s)) best = { c, s };
    }
    if (best) {
      out[i] = {
        ...out[i]!,
        status: 'probable_duplicate',
        transactionId: best.c.transactionId,
        score: round(best.s),
      };
      usedImported.add(best.c.transactionId);
    }
  });

  // 3. Matches to manual entries: score every viable pair, then assign greedily one-to-one by score.
  const pairs: { i: number; c: ManualCandidate; score: number }[] = [];
  rows.forEach((r, i) => {
    if (out[i]!.status !== 'new') return;
    for (const c of manual) {
      if (c.amount !== r.amount || !within(c.date, r.date, MATCH_WINDOW_DAYS)) continue;
      const sim =
        c.normalizedDescription && r.normalizedDescription
          ? similarity(c.normalizedDescription, r.normalizedDescription)
          : 0;
      if (sim < 0.5) continue;
      const days = Math.abs(diffDays(c.date, r.date));
      pairs.push({ i, c, score: round(0.6 * sim + 0.4 * (1 - days / (MATCH_WINDOW_DAYS + 1))) });
    }
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedManual = new Set<string>();
  const usedRows = new Set<number>();
  for (const p of pairs) {
    if (usedManual.has(p.c.transactionId) || usedRows.has(p.i)) continue;
    usedManual.add(p.c.transactionId);
    usedRows.add(p.i);
    out[p.i] = { ...out[p.i]!, status: 'match', transactionId: p.c.transactionId, score: p.score };
  }
  return out;
}

const round = (n: number) => Number(n.toFixed(4));
