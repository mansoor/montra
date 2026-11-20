/**
 * Receipt screens' pure helpers (RCP-01..06): file checks, editable rows ↔ the API's minor units, and the
 * update request the review screen sends. No float math: amounts go through @montra/domain.
 */
import {
  addMonths,
  asCurrencyCode,
  isCurrencyCode,
  lineQuantity,
  minorUnits,
  mulRound,
  parseDecimal,
  toDecimalString,
  type CalendarDate,
} from '@montra/domain';
import type { ReceiptDto, UpdateReceiptInput } from '@montra/api-client';
import { parseAmountInput } from './money';
import { staticT } from './i18n-static';

type T = (key: string, values?: Record<string, string | number>) => string;

export const RECEIPT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'pdf'] as const;
export const RECEIPT_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
export const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;

/** Why a picked file can't be a receipt page, or null when it can (the API sniffs the content again). */
export function receiptFileProblem(
  file: { name: string; size: number; type?: string },
  t: T = staticT,
): string | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!(RECEIPT_EXTENSIONS as readonly string[]).includes(ext)) return t('receipts.file_type');
  if (file.size === 0) return t('receipts.file_empty');
  if (file.size > MAX_RECEIPT_BYTES) return t('receipts.file_too_large');
  return null;
}

/** Minor units → what an amount input shows ("12.88", "-14.99", "728"); empty for null. */
export function amountToInput(minor: string | null, currency: string): string {
  if (minor === null) return '';
  if (!isCurrencyCode(currency)) return minor;
  return toDecimalString({ amount: BigInt(minor), currency: asCurrencyCode(currency) });
}

export interface LineRow {
  id?: string;
  rawText: string;
  expandedName: string;
  /** Quantity as typed ("2", "0.452"); empty when not known. */
  qty: string;
  /** Unit price as an amount input; empty when not known (a weighed item that doesn't divide evenly). */
  unitPrice: string;
  lineTotal: string;
  discount: string;
  taxable: boolean;
  categoryId: string;
  memberId: string;
}

export interface HeaderFields {
  merchant: string;
  receiptDate: string;
  localTime: string;
  currency: string;
  tax: string;
  taxIncluded: boolean;
  discount: string;
  fees: string;
  tip: string;
  total: string;
}

export function rowsOf(r: ReceiptDto): { header: HeaderFields; lines: LineRow[] } {
  const currency = r.currency ?? '';
  return {
    header: {
      merchant: r.merchant ?? '',
      receiptDate: r.receiptDate ?? '',
      localTime: r.localTime ?? '',
      currency,
      tax: amountToInput(r.tax, currency),
      taxIncluded: r.taxIncluded,
      discount: amountToInput(r.discount, currency),
      fees: amountToInput(r.fees, currency),
      tip: amountToInput(r.tip, currency),
      total: amountToInput(r.total, currency),
    },
    lines: r.lines.map((l) => ({
      id: l.id,
      rawText: l.rawText,
      expandedName: l.expandedName ?? '',
      qty: l.qty ?? '',
      unitPrice: amountToInput(l.unitPrice, currency),
      lineTotal: amountToInput(l.lineTotal, currency),
      discount: amountToInput(l.discount, currency),
      taxable: l.taxable,
      categoryId: l.categoryId ?? '',
      memberId: l.memberId ?? '',
    })),
  };
}

export type BuildResult =
  { ok: true; input: UpdateReceiptInput } | { ok: false; errors: Record<string, string> };

/**
 * The PATCH body for the review screen. `field.N` errors point at line N; empty optional amounts are 0. The
 * category the user leaves is sent as-is, so the API learns only from lines the user changed (RCP-06).
 */
export function buildUpdate(
  version: string,
  header: HeaderFields,
  lines: LineRow[],
  locale = 'en-US',
  t: T = staticT,
): BuildResult {
  const errors: Record<string, string> = {};
  const currency = header.currency.trim().toUpperCase();
  if (!isCurrencyCode(currency)) {
    errors.currency = t('money.unknown_currency', { currency: header.currency || '?' });
    return { ok: false, errors };
  }
  const amount = (key: string, value: string, required: boolean): string | undefined => {
    if (!value.trim()) {
      if (required) errors[key] = t('money.enter_amount');
      return required ? undefined : '0';
    }
    const p = parseAmountInput(value, currency, locale, t);
    if (!p.ok) {
      errors[key] = p.error;
      return undefined;
    }
    return p.minor.toString();
  };
  const lineQty = (value: string, i: number): string | null => {
    const q = value.trim().replace(',', '.');
    if (!q) return null;
    if (!QTY_RE.test(q)) {
      errors[`qty.${i}`] = t('receipts.qty_invalid');
      return null;
    }
    return q;
  };
  const out: UpdateReceiptInput = {
    version,
    merchant: header.merchant.trim() || null,
    receiptDate: header.receiptDate || null,
    localTime: header.localTime || null,
    currency,
    tax: amount('tax', header.tax, false),
    taxIncluded: header.taxIncluded,
    discount: amount('discount', header.discount, false),
    fees: amount('fees', header.fees, false),
    tip: amount('tip', header.tip, false),
    total: header.total.trim() ? amount('total', header.total, true) : null,
    lines: lines.map((l, i) => {
      if (!l.rawText.trim()) errors[`rawText.${i}`] = t('receipts.line_text_required');
      return {
        ...(l.id ? { id: l.id } : {}),
        rawText: l.rawText.trim() || '?',
        expandedName: l.expandedName.trim() || null,
        qty: lineQty(l.qty, i),
        unitPrice: l.unitPrice.trim() ? (amount(`unitPrice.${i}`, l.unitPrice, true) ?? null) : null,
        lineTotal: amount(`lineTotal.${i}`, l.lineTotal, true) ?? '0',
        discount: amount(`discount.${i}`, l.discount, false) ?? '0',
        taxable: l.taxable,
        categoryId: l.categoryId || null,
        memberId: l.memberId || null,
      };
    }),
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input: out };
}

/** A quantity the API takes: up to three decimals. */
const QTY_RE = /^\d{1,9}(\.\d{1,3})?$/;

/**
 * Keeps a line's quantity × unit price = total as one of them is edited (owner, 2026-11-18). A new quantity or unit
 * price sets the total (rounded half up, as prices on receipts are); a new total sets the unit price when the quantity
 * divides it exactly, else leaves it empty rather than guess. What can't be read yet is left as typed.
 */
export function recalcLine(
  row: LineRow,
  changed: 'qty' | 'unitPrice' | 'lineTotal',
  currency: string,
  locale = 'en-US',
): LineRow {
  const qtyText = row.qty.trim().replace(',', '.');
  const qty = QTY_RE.test(qtyText) ? parseDecimal(qtyText) : null;
  const read = (v: string) => {
    if (!v.trim()) return null;
    const p = parseAmountInput(v, currency, locale);
    return p.ok ? p.minor : null;
  };
  if (changed === 'lineTotal') {
    const total = read(row.lineTotal);
    if (total === null || qty === null) return row;
    const unit = lineQuantity(qtyText, null, total).unitPrice;
    return { ...row, unitPrice: unit === null ? '' : amountToInput(unit.toString(), currency) };
  }
  const unit = read(row.unitPrice);
  if (unit === null || qty === null) return row;
  return { ...row, lineTotal: amountToInput(mulRound(unit, qty).toString(), currency) };
}

/** Chip class per status (globals.css chips). */
export const STATUS_CHIP: Record<ReceiptDto['status'], string> = {
  processing: 'chip chip-muted',
  inbox: 'chip chip-muted',
  needs_review: 'chip chip-warn',
  matched: 'chip chip-good',
  rejected: 'chip chip-bad',
};

/**
 * The different reasons nothing is reading these receipts (`documents_waiting`, `jobs_failed`, …), once each,
 * for the banner over the receipts being read. Message keys are `receipts.stalled.<reason>`.
 */
export function stalledReasons(receipts: Pick<ReceiptDto, 'status' | 'stalled'>[]): string[] {
  const out = new Set<string>();
  for (const r of receipts)
    if (r.status === 'processing' && r.stalled) out.add(`${r.stalled.worker}_${r.stalled.reason}`);
  return [...out];
}

/** The receipt's printed total in the user's currency format, for list rows. */
export function receiptTotal(
  r: Pick<ReceiptDto, 'total' | 'currency'>,
): { amount: bigint; currency: string } | null {
  if (r.total === null || !r.currency) return null;
  return { amount: BigInt(r.total), currency: r.currency };
}

/** Exponent-aware placeholder for amount inputs ("0.00", "0", "0.000"). */
export const amountPlaceholder = (currency: string) =>
  isCurrencyCode(currency) ? (0).toFixed(minorUnits(asCurrencyCode(currency))) : '0.00';

/** Item search periods (RCP-09): three months first, then wider, up to every receipt. */
export const ITEM_PERIODS = ['3m', '6m', '1y', '2y', 'all'] as const;
export type ItemPeriod = (typeof ITEM_PERIODS)[number];
const ITEM_MONTHS: Record<ItemPeriod, number | null> = { '3m': 3, '6m': 6, '1y': 12, '2y': 24, all: null };

export const asItemPeriod = (p: string | undefined): ItemPeriod =>
  (ITEM_PERIODS as readonly string[]).includes(p ?? '') ? (p as ItemPeriod) : '3m';

/** The first day a period covers, ending `today`; "all" reaches back before any receipt. */
export function itemPeriodFrom(today: CalendarDate, period: ItemPeriod): string {
  const months = ITEM_MONTHS[period];
  return months === null ? '1970-01-01' : addMonths(today, -months);
}

/** The next longer period, or null at "all". */
export const widerItemPeriod = (p: ItemPeriod): ItemPeriod | null =>
  ITEM_PERIODS[ITEM_PERIODS.indexOf(p) + 1] ?? null;
