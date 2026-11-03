/**
 * Receipt screens' pure helpers (RCP-01..06): file checks, editable rows ↔ the API's minor units, and the
 * update request the review screen sends. No float math: amounts go through @montra/domain.
 */
import { asCurrencyCode, isCurrencyCode, minorUnits, toDecimalString } from '@montra/domain';
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

/** Chip class per status (globals.css chips). */
export const STATUS_CHIP: Record<ReceiptDto['status'], string> = {
  processing: 'chip chip-muted',
  inbox: 'chip chip-muted',
  needs_review: 'chip chip-warn',
  matched: 'chip chip-good',
  rejected: 'chip chip-bad',
};

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
