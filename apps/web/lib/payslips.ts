/**
 * Payslip screens' pure helpers (PAY-02, PAY-03): editable rows ↔ the API's minor units, the live totals on the
 * review screen and the update request it sends. No float math: amounts go through @montra/domain.
 */
import { payslipTotals, type PayslipSection, type PayslipTotals } from '@montra/domain';
import type { PayslipDto, UpdatePayslipInput } from '@montra/api-client';
import { minorToInput, parseAmountInput } from './money';
import { staticT } from './i18n-static';
import { amountToInput } from './receipts';

type T = (key: string, values?: Record<string, string | number>) => string;

export const SECTIONS: readonly PayslipSection[] = ['earning', 'pre_tax', 'tax', 'post_tax', 'employer'];

/** The codes offered per section; AI may read others, which keep their own label (design 04 §14). */
export const LINE_CODES: Record<PayslipSection, readonly string[]> = {
  earning: ['salary', 'overtime', 'bonus', 'commission', 'other'],
  pre_tax: ['401k', 'hsa', 'fsa', 'health', 'other'],
  tax: ['fed_tax', 'state_tax', 'local_tax', 'social_security', 'medicare', 'other'],
  post_tax: ['roth_401k', 'loan', 'union_dues', 'other'],
  employer: ['match', 'hsa', 'other'],
};

export const STATUS_CHIP: Record<PayslipDto['status'], string> = {
  processing: 'chip',
  needs_review: 'chip chip-warn',
  posted: 'chip chip-good',
  rejected: 'chip chip-bad',
};

export interface PayslipRow {
  /** Stable React key: rows are added and removed while editing. */
  key: string;
  section: PayslipSection;
  code: string;
  label: string;
  amount: string;
  ytd: string;
  accountId: string | null;
}

export interface PayslipFields {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  net: string;
}

export function rowsOf(p: PayslipDto): { fields: PayslipFields; rows: PayslipRow[] } {
  return {
    fields: {
      payDate: p.payDate ?? '',
      periodStart: p.periodStart ?? '',
      periodEnd: p.periodEnd ?? '',
      net: amountToInput(p.net, p.currency),
    },
    rows: [...p.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        key: l.id,
        section: l.section,
        code: l.code,
        label: l.label,
        amount: amountToInput(l.amount, p.currency),
        ytd: amountToInput(l.ytd, p.currency),
        accountId: l.accountId,
      })),
  };
}

/** The totals as typed so far: an amount that doesn't parse yet counts as nothing, and is flagged on save. */
export function liveTotals(
  rows: readonly PayslipRow[],
  net: string,
  currency: string,
  locale?: string,
): PayslipTotals & { net: bigint; gap: bigint } {
  const minor = (s: string) => {
    if (!s.trim()) return 0n;
    const r = parseAmountInput(s, currency, locale);
    return r.ok ? r.minor : 0n;
  };
  const totals = payslipTotals(
    rows.map((r) => ({ section: r.section, code: r.code, amount: minor(r.amount) })),
  );
  const printed = minor(net);
  return { ...totals, net: printed, gap: totals.computedNet - printed };
}

export type BuildResult =
  { ok: true; input: UpdatePayslipInput } | { ok: false; errors: Record<string, string> };

/** The PATCH a save sends. Errors are keyed `payDate`, `net`, `lines`, `line.<key>.amount`, `line.<key>.ytd`. */
export function buildUpdate(
  version: number,
  fields: PayslipFields,
  rows: readonly PayslipRow[],
  currency: string,
  locale?: string,
  t: T = staticT,
): BuildResult {
  const errors: Record<string, string> = {};
  const parse = (input: string, key: string): string | null => {
    const r = parseAmountInput(input, currency, locale, t);
    if (!r.ok) {
      errors[key] = r.error;
      return null;
    }
    if (r.minor < 0n) {
      errors[key] = t('payslips.not_negative');
      return null;
    }
    return String(r.minor);
  };
  if (!fields.payDate) errors.payDate = t('payslips.pay_date_required');
  const net = parse(fields.net, 'net');
  if (rows.length === 0) errors.lines = t('payslips.lines_required');
  const lines = rows.map((r) => {
    if (!r.label.trim()) errors[`line.${r.key}.label`] = t('payslips.label_required');
    return {
      section: r.section,
      code: r.code,
      label: r.label.trim(),
      amount: parse(r.amount, `line.${r.key}.amount`) ?? '0',
      ytd: r.ytd.trim() ? parse(r.ytd, `line.${r.key}.ytd`) : null,
      ...(r.accountId ? { accountId: r.accountId } : {}),
    };
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      version,
      payDate: fields.payDate,
      periodStart: fields.periodStart || null,
      periodEnd: fields.periodEnd || null,
      net: net!,
      lines,
    },
  };
}

/** The default label of a new line: what the code means, so typical payslips need no typing. */
export function codeLabel(section: PayslipSection, code: string, t: T = staticT): string {
  return code === 'other' ? t(`payslips.section.${section}`) : t(`payslips.code.${code}`);
}

// ----- Splitting pay across accounts (ADR-0022) --------------------------------------------------------

export interface DepositRow {
  key: string;
  accountId: string;
  amount: string;
}

export function depositRowsOf(
  deposits: readonly { accountId: string; amount: string }[],
  currency: string,
): DepositRow[] {
  return deposits.map((d) => ({
    key: d.accountId,
    accountId: d.accountId,
    amount: minorToInput(BigInt(d.amount), currency),
  }));
}

/** What's on screen as a request's `deposits`, or what's wrong with it. */
export function depositsInput(
  rows: readonly DepositRow[],
  currency: string,
  locale?: string,
  t: T = staticT,
): { ok: true; deposits: { accountId: string; amount: string }[] } | { ok: false; error: string } {
  const deposits: { accountId: string; amount: string }[] = [];
  for (const r of rows) {
    const p = parseAmountInput(r.amount, currency, locale, t);
    if (!p.ok) return { ok: false, error: p.error };
    if (p.minor <= 0n) return { ok: false, error: t('deposits.more_than_zero') };
    deposits.push({ accountId: r.accountId, amount: p.minor.toString() });
  }
  return { ok: true, deposits };
}

/** What the main account gets, from what's typed so far. An amount that doesn't parse yet counts as nothing. */
export function depositRest(
  net: string,
  rows: readonly DepositRow[],
  currency: string,
  locale?: string,
): bigint {
  const n = parseAmountInput(net, currency, locale);
  let rest = n.ok ? n.minor : 0n;
  for (const r of rows) {
    const p = parseAmountInput(r.amount, currency, locale);
    if (p.ok) rest -= p.minor;
  }
  return rest;
}
