/** Manual journal form logic (DE-07): every line is a debit or a credit, and the entry must balance. */
import { parseAmountInput } from './money';

export interface JournalLine {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  memo?: string;
}

export interface JournalState {
  totalDebit: bigint;
  totalCredit: bigint;
  /** totalDebit − totalCredit; zero when balanced. */
  difference: bigint;
  lineErrors: Record<string, string>;
  balanced: boolean;
}

function lineAmount(raw: string, currency: string): bigint | string | null {
  if (!raw.trim()) return null;
  const p = parseAmountInput(raw, currency);
  if (!p.ok) return p.error;
  if (p.minor <= 0n) return 'Use a positive amount';
  return p.minor;
}

export function evaluateJournal(lines: JournalLine[], currency: string): JournalState {
  let totalDebit = 0n;
  let totalCredit = 0n;
  const lineErrors: Record<string, string> = {};
  for (const l of lines) {
    const d = lineAmount(l.debit, currency);
    const c = lineAmount(l.credit, currency);
    if (typeof d === 'string') lineErrors[l.key] = d;
    else if (typeof c === 'string') lineErrors[l.key] = c;
    else if (d !== null && c !== null) lineErrors[l.key] = 'Enter a debit or a credit, not both';
    else if (d === null && c === null) lineErrors[l.key] = 'Enter a debit or a credit';
    else if (!l.accountId) lineErrors[l.key] = 'Choose an account';
    if (typeof d === 'bigint') totalDebit += d;
    if (typeof c === 'bigint') totalCredit += c;
  }
  const difference = totalDebit - totalCredit;
  return {
    totalDebit,
    totalCredit,
    difference,
    lineErrors,
    balanced:
      lines.length >= 2 && Object.keys(lineErrors).length === 0 && difference === 0n && totalDebit > 0n,
  };
}

/** API payload lines: minor units as strings, exactly one of debit/credit per line. */
export function toJournalLines(lines: JournalLine[], currency: string) {
  return lines.map((l) => {
    const d = lineAmount(l.debit, currency);
    const c = lineAmount(l.credit, currency);
    return {
      accountId: l.accountId,
      ...(typeof d === 'bigint' ? { debit: d.toString() } : {}),
      ...(typeof c === 'bigint' ? { credit: c.toString() } : {}),
      ...(l.memo ? { memo: l.memo } : {}),
    };
  });
}
