/** Manual journal form logic (DE-07): every line is a debit or a credit, and the entry must balance. */
import type { LedgerAccountDto } from '@montra/api-client';
import { parseAmountInput } from './money';
import { staticT } from './i18n-static';

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

type T = (key: string, values?: Record<string, string | number>) => string;

function lineAmount(raw: string, currency: string, locale = 'en-US', t: T = staticT): bigint | string | null {
  if (!raw.trim()) return null;
  const p = parseAmountInput(raw, currency, locale, t);
  if (!p.ok) return p.error;
  if (p.minor <= 0n) return t('money.positive');
  return p.minor;
}

export function evaluateJournal(
  lines: JournalLine[],
  currency: string,
  locale = 'en-US',
  t: T = staticT,
): JournalState {
  let totalDebit = 0n;
  let totalCredit = 0n;
  const lineErrors: Record<string, string> = {};
  for (const l of lines) {
    const d = lineAmount(l.debit, currency, locale, t);
    const c = lineAmount(l.credit, currency, locale, t);
    if (typeof d === 'string') lineErrors[l.key] = d;
    else if (typeof c === 'string') lineErrors[l.key] = c;
    else if (d !== null && c !== null) lineErrors[l.key] = t('journal.error.both');
    else if (d === null && c === null) lineErrors[l.key] = t('journal.error.neither');
    else if (!l.accountId) lineErrors[l.key] = t('journal.error.account');
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

const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

/** Chart of accounts for one entity and currency, grouped by type in balance-sheet order (DE-02). */
export function groupLedgerAccounts(accounts: LedgerAccountDto[], entityId: string, currency: string) {
  const usable = accounts.filter((a) => a.entityId === entityId && a.currency === currency && !a.archived);
  return TYPE_ORDER.map((type) => ({
    type,
    accounts: usable.filter((a) => a.type === type).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.accounts.length > 0);
}
