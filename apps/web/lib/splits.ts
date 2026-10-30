/**
 * Split editor logic (TXN-03). Lines are entered as positive major-unit amounts; the direction
 * (expense = money out, income = money in) applies to the whole transaction.
 */
import { parseAmountInput } from './money';

export type Direction = 'expense' | 'income';

export interface SplitLine {
  key: string;
  accountId: string;
  amount: string; // major units as typed
  memo?: string;
}

export interface SplitState {
  total: bigint | null;
  allocated: bigint;
  remaining: bigint | null;
  lineErrors: Record<string, string>;
  balanced: boolean;
}

/** Computes allocated/remaining and per-line errors. Balanced = every line valid and remaining = 0. */
export function evaluateSplits(totalInput: string, lines: SplitLine[], currency: string): SplitState {
  const totalParsed = parseAmountInput(totalInput, currency);
  const total = totalParsed.ok ? abs(totalParsed.minor) : null;
  const lineErrors: Record<string, string> = {};
  let allocated = 0n;
  for (const line of lines) {
    if (!line.accountId) lineErrors[line.key] = 'Choose a category';
    const p = parseAmountInput(line.amount, currency);
    if (!p.ok) {
      lineErrors[line.key] ??= p.error;
      continue;
    }
    if (p.minor <= 0n) {
      lineErrors[line.key] ??= 'Amount must be greater than zero';
      continue;
    }
    allocated += p.minor;
  }
  const remaining = total === null ? null : total - allocated;
  return {
    total,
    allocated,
    remaining,
    lineErrors,
    balanced:
      total !== null &&
      total > 0n &&
      remaining === 0n &&
      lines.length > 0 &&
      Object.keys(lineErrors).length === 0,
  };
}

/** Builds the API payload: amounts signed from the account's point of view (expense negative). */
export function toSplitPayload(lines: SplitLine[], currency: string, direction: Direction) {
  const sign = direction === 'expense' ? -1n : 1n;
  return lines.map((l) => {
    const p = parseAmountInput(l.amount, currency);
    if (!p.ok) throw new Error(p.error);
    return {
      accountId: l.accountId,
      amount: { amount: (abs(p.minor) * sign).toString(), currency },
      ...(l.memo ? { memo: l.memo } : {}),
    };
  });
}

export const signedTotal = (minor: bigint, direction: Direction): bigint =>
  direction === 'expense' ? -abs(minor) : abs(minor);

const abs = (n: bigint) => (n < 0n ? -n : n);
