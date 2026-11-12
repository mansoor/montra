/**
 * Business screens' pure helpers (BIZ-05..10): editable invoice rows ↔ the API's minor units, and report date ranges. No
 * float math: amounts go through @montra/domain, and quantities and rates are checked as text.
 */
import {
  addDays,
  fiscalYearOf,
  fiscalYearRange,
  invoiceTotals,
  startOfMonth,
  type CalendarDate,
  type InvoiceTotals,
} from '@montra/domain';
import type { BillDto, CreateInvoiceInput, InvoiceDto } from '@montra/api-client';
import { parseAmountInput } from './money';
import { staticT } from './i18n-static';
import { amountToInput } from './receipts';

type T = (key: string, values?: Record<string, string | number>) => string;

export const INVOICE_CHIP: Record<InvoiceDto['status'], string> = {
  draft: 'chip',
  sent: 'chip',
  partial: 'chip',
  paid: 'chip chip-good',
  overdue: 'chip chip-bad',
  void: 'chip',
};

export const BILL_CHIP: Record<BillDto['status'], string> = {
  open: 'chip',
  overdue: 'chip chip-bad',
  paid: 'chip chip-good',
  void: 'chip',
};

export interface InvoiceRow {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  /** As typed: "8.25". */
  taxRate: string;
  incomeAccountId: string;
}

export const emptyRow = (key: string, incomeAccountId: string): InvoiceRow => ({
  key,
  description: '',
  quantity: '1',
  unitPrice: '',
  taxRate: '',
  incomeAccountId,
});

/** "8.25" → 825 basis points; null when it isn't a percentage up to 100 with at most two decimals. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  const bps = Number(whole + frac.padEnd(2, '0'));
  return bps > 10000 ? null : bps;
}

/** 825 → "8.25"; 0 → "". */
export function bpsToPercent(bps: number): string {
  if (!bps) return '';
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

const QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;
const quantityMilli = (q: string): bigint | null => {
  const t = q.trim();
  if (!QUANTITY.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  return BigInt(whole + frac.padEnd(3, '0'));
};

export function rowsOf(i: InvoiceDto): InvoiceRow[] {
  return i.lines.map((l) => ({
    key: l.id,
    description: l.description,
    quantity: l.quantity,
    unitPrice: amountToInput(l.unitPrice, i.currency),
    taxRate: bpsToPercent(l.taxRateBps),
    incomeAccountId: l.incomeAccountId,
  }));
}

/** The totals as typed so far: a row that doesn't parse yet counts as nothing, and is flagged on save. */
export function liveTotals(rows: readonly InvoiceRow[], currency: string, locale?: string): InvoiceTotals {
  const inputs = rows.flatMap((r) => {
    const q = quantityMilli(r.quantity);
    const p = parseAmountInput(r.unitPrice, currency, locale);
    const bps = percentToBps(r.taxRate);
    return q !== null && p.ok && bps !== null
      ? [{ quantityMilli: q, unitPrice: p.minor, taxRateBps: bps }]
      : [];
  });
  return invoiceTotals(inputs);
}

export type BuildLines =
  { ok: true; lines: CreateInvoiceInput['lines'] } | { ok: false; errors: Record<string, string> };

/** The lines a save sends. Errors are keyed `<key>.description`, `.quantity`, `.unitPrice`, `.taxRate`. */
export function buildLines(
  rows: readonly InvoiceRow[],
  currency: string,
  locale?: string,
  t: T = staticT,
): BuildLines {
  const errors: Record<string, string> = {};
  const lines = rows.map((r) => {
    if (!r.description.trim()) errors[`${r.key}.description`] = t('invoices.description_required');
    const q = quantityMilli(r.quantity);
    if (q === null || q === 0n) errors[`${r.key}.quantity`] = t('invoices.quantity_invalid');
    const price = parseAmountInput(r.unitPrice, currency, locale, t);
    if (!price.ok) errors[`${r.key}.unitPrice`] = price.error;
    else if (price.minor < 0n) errors[`${r.key}.unitPrice`] = t('invoices.price_negative');
    const bps = percentToBps(r.taxRate);
    if (bps === null) errors[`${r.key}.taxRate`] = t('invoices.tax_invalid');
    return {
      description: r.description.trim(),
      quantity: r.quantity.trim(),
      unitPrice: price.ok ? String(price.minor) : '0',
      taxRateBps: bps ?? 0,
      ...(r.incomeAccountId ? { incomeAccountId: r.incomeAccountId } : {}),
    };
  });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, lines };
}

export const REPORT_RANGES = ['month', 'quarter', 'ytd', 'last_year'] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];

/**
 * BIZ-10: this month, the last three whole months plus this one, this year and last year. "This year" and "last year"
 * are the business's fiscal years (ADR-0037 §2); with a January start they're calendar years.
 */
export function rangeOf(
  range: ReportRange,
  today: CalendarDate,
  fiscalStartMonth = 1,
): { from: CalendarDate; to: CalendarDate } {
  const year = Number(today.slice(0, 4));
  const fiscal = fiscalYearOf(today, fiscalStartMonth);
  switch (range) {
    case 'month':
      return { from: startOfMonth(today), to: today };
    case 'quarter': {
      const month = Number(today.slice(5, 7));
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      return { from: `${year}-${String(first).padStart(2, '0')}-01` as CalendarDate, to: today };
    }
    case 'ytd':
      return { from: fiscalYearRange(fiscal, fiscalStartMonth).from, to: today };
    case 'last_year':
      return fiscalYearRange(fiscal - 1, fiscalStartMonth);
  }
}

/** The default due date shown while drafting. */
export const dueFrom = (issue: CalendarDate, terms: number): CalendarDate => addDays(issue, terms);
