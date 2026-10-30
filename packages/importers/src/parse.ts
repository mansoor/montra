/**
 * Applies a column mapping to a sheet (design 04 §3.4). Every data row ends in exactly one state — parsed,
 * skipped (blank, footer, filtered) or error — so the import summary always adds up (UP-01).
 */
import { compareDates, type CalendarDate, type CurrencyCode } from '@montra/domain';
import { parseAmount } from './amounts.js';
import { parseDate } from './dates.js';
import { signedAmount } from './infer.js';
import type { ColumnMapping } from './mapping.js';
import type { Sheet } from './grid.js';
import { normalizeDescription } from './payees.js';

export interface ParsedRow {
  /** 1-based row number in the file, for messages and audit. */
  rowNo: number;
  date: CalendarDate;
  /** Signed minor units from the account's view: + money in, − money out. */
  amount: bigint;
  description: string;
  normalizedDescription: string;
  payee: string | null;
  balance: bigint | null;
  category: string | null;
  reference: string | null;
  raw: string[];
}

export interface RowError {
  rowNo: number;
  raw: string[];
  error: 'invalid_date' | 'invalid_amount' | 'missing_amount';
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: RowError[];
  /** Blank lines, footers and filtered rows: counted, never silently lost. */
  skipped: { rowNo: number; reason: 'blank' | 'footer' | 'filtered' }[];
  read: number;
  minDate: CalendarDate | null;
  maxDate: CalendarDate | null;
  /** Statement balances found in the file (summary rows or the running balance column). */
  opening: bigint | null;
  closing: bigint | null;
}

const FOOTER =
  /^(total|totals|summe|subtotal|opening balance|closing balance|beginning balance|ending balance|balance forward|previous balance|anfangssaldo|endsaldo|schlusssaldo)\b/i;
const OPENING =
  /^(opening balance|beginning balance|balance forward|previous balance|anfangssaldo|starting balance)/i;
const CLOSING = /^(closing balance|ending balance|new balance|endsaldo|schlusssaldo)/i;

export function applyMapping(sheet: Sheet, m: ColumnMapping, currency: CurrencyCode): ParseResult {
  const result: ParseResult = {
    rows: [],
    errors: [],
    skipped: [],
    read: 0,
    minDate: null,
    maxDate: null,
    opening: null,
    closing: null,
  };
  const filterValues = m.filter ? new Set(m.filter.values.map((v) => v.toLowerCase())) : null;
  const debitWords = m.direction ? new Set(m.direction.debitValues.map((v) => v.toLowerCase())) : null;

  for (let i = m.dataStart; i < sheet.rows.length; i++) {
    const r = sheet.rows[i]!;
    const rowNo = i + 1;
    if (r.every((c) => !c.trim())) {
      result.skipped.push({ rowNo, reason: 'blank' });
      continue;
    }
    result.read++;
    const first = (r.find((c) => c.trim()) ?? '').trim();
    // A row with a valid date is data even if it reads "Total Wine & More"; footers carry no transaction date.
    const isFooter =
      FOOTER.test(first) || m.skipPatterns?.some((p) => first.toLowerCase().startsWith(p.toLowerCase()));
    if (isFooter && !parseDate(r[m.date] ?? '', m.dateFormat)) {
      // Summary rows carry statement balances (IMP-05/08).
      const value =
        [...r]
          .reverse()
          .map((c) => parseAmount(c, currency, m.decimal))
          .find((v) => v !== null) ?? null;
      if (value !== null && OPENING.test(first)) result.opening = value;
      if (value !== null && CLOSING.test(first)) result.closing = value;
      result.skipped.push({ rowNo, reason: 'footer' });
      continue;
    }
    if (filterValues && m.filter && !filterValues.has((r[m.filter.column] ?? '').trim().toLowerCase())) {
      result.skipped.push({ rowNo, reason: 'filtered' });
      continue;
    }
    const date = parseDate(r[m.date] ?? '', m.dateFormat);
    if (!date) {
      result.errors.push({ rowNo, raw: r, error: 'invalid_date' });
      continue;
    }
    let amount = signedAmount(r, m, m.decimal, currency);
    // Inline balance rows ("Beginning balance as of 10/01") carry a date and a balance but no amount.
    const balanceText = r.find((c) => OPENING.test(c.trim()) || CLOSING.test(c.trim()));
    if (amount === null && balanceText) {
      const value = m.balance !== undefined ? parseAmount(r[m.balance] ?? '', currency, m.decimal) : null;
      if (value !== null && OPENING.test(balanceText.trim())) result.opening = value;
      if (value !== null && CLOSING.test(balanceText.trim())) result.closing = value;
      result.skipped.push({ rowNo, reason: 'footer' });
      continue;
    }
    if (amount === null) {
      const anyText =
        m.amount !== undefined
          ? (r[m.amount] ?? '').trim()
          : `${r[m.debit ?? -1] ?? ''}${r[m.credit ?? -1] ?? ''}`.trim();
      result.errors.push({ rowNo, raw: r, error: anyText ? 'invalid_amount' : 'missing_amount' });
      continue;
    }
    if (debitWords && m.direction) {
      const abs = amount < 0n ? -amount : amount;
      amount = debitWords.has((r[m.direction.column] ?? '').trim().toLowerCase()) ? -abs : abs;
    } else if (m.sign === 'inverted') {
      amount = -amount;
    }
    const description = m.description
      .map((c) => (r[c] ?? '').trim())
      .filter(Boolean)
      .join(' · ');
    const payee = m.payee !== undefined ? (r[m.payee] ?? '').trim() || null : null;
    const balance = m.balance !== undefined ? parseAmount(r[m.balance] ?? '', currency, m.decimal) : null;
    result.rows.push({
      rowNo,
      date,
      amount,
      description,
      normalizedDescription: normalizeDescription(payee ? `${payee} ${description}` : description),
      payee,
      balance,
      category: m.category !== undefined ? (r[m.category] ?? '').trim() || null : null,
      reference: m.reference !== undefined ? (r[m.reference] ?? '').trim() || null : null,
      raw: r,
    });
    if (!result.minDate || compareDates(date, result.minDate) < 0) result.minDate = date;
    if (!result.maxDate || compareDates(date, result.maxDate) > 0) result.maxDate = date;
  }

  // Derive statement balances from a running balance column when no summary rows gave them.
  const withBalance = result.rows.filter((r) => r.balance !== null);
  if (withBalance.length >= 2 && (result.opening === null || result.closing === null)) {
    const ascending = compareDates(withBalance[0]!.date, withBalance.at(-1)!.date) <= 0;
    const firstChrono = ascending ? withBalance[0]! : withBalance.at(-1)!;
    const lastChrono = ascending ? withBalance.at(-1)! : withBalance[0]!;
    result.opening ??= firstChrono.balance! - firstChrono.amount;
    result.closing ??= lastChrono.balance!;
  }
  return result;
}

export interface BalanceCheck {
  status: 'ok' | 'mismatch' | 'n_a';
  /** closing − (opening + Σ amounts); non-zero means rows are missing or extra. */
  gap: bigint | null;
}

/** Statement balance check (UP-01, IMP-05, IMP-08): opening + Σ amounts must equal closing. */
export function checkBalance(
  rows: { amount: bigint }[],
  opening: bigint | null,
  closing: bigint | null,
): BalanceCheck {
  if (opening === null || closing === null) return { status: 'n_a', gap: null };
  const total = rows.reduce((a, r) => a + r.amount, 0n);
  const gap = closing - (opening + total);
  return { status: gap === 0n ? 'ok' : 'mismatch', gap };
}
