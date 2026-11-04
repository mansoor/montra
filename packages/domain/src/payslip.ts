/**
 * Payslip arithmetic and posting (PAY-02, PAY-05, PAY-06; design 04 §14, ADR-0016). Pure and exact: amounts are
 * positive bigint minor units in the payslip's currency.
 */
import type { CalendarDate } from './calendar-date.js';
import type { CurrencyCode } from './currency.js';
import { divRound } from './rounding.js';
import { LedgerError, validateEntry } from './ledger/validate.js';
import type { JournalEntryDraft, PostingDraft } from './ledger/types.js';

export const PAYSLIP_SECTIONS = ['earning', 'pre_tax', 'tax', 'post_tax', 'employer'] as const;
export type PayslipSection = (typeof PAYSLIP_SECTIONS)[number];

export interface PayslipLineAmount {
  section: PayslipSection;
  code: string;
  amount: bigint;
}

export interface PayslipTotals {
  gross: bigint;
  preTax: bigint;
  taxes: bigint;
  postTax: bigint;
  /** Paid by the employer on top of pay (match, HSA); never part of net pay. */
  employer: bigint;
  /** gross − pre-tax − taxes − post-tax. */
  computedNet: bigint;
}

export function payslipTotals(lines: readonly PayslipLineAmount[]): PayslipTotals {
  const sum = (s: PayslipSection) => lines.filter((l) => l.section === s).reduce((t, l) => t + l.amount, 0n);
  const gross = sum('earning');
  const preTax = sum('pre_tax');
  const taxes = sum('tax');
  const postTax = sum('post_tax');
  return {
    gross,
    preTax,
    taxes,
    postTax,
    employer: sum('employer'),
    computedNet: gross - preTax - taxes - postTax,
  };
}

/** computedNet − printed net: 0 means the payslip adds up. A confirmed payslip must have no gap. */
export const payslipGap = (lines: readonly PayslipLineAmount[], net: bigint): bigint =>
  payslipTotals(lines).computedNet - net;

/** The line codes that build up an asset rather than being spent (retirement and health savings). */
export const SAVINGS_CODES: ReadonlySet<string> = new Set([
  '401k',
  'roth_401k',
  'ira',
  'hsa',
  'fsa',
  'pension',
  'espp',
]);

export interface PayslipPostingLine extends PayslipLineAmount {
  /** Where the line posts: an income category, an expense category or an asset account. */
  accountId: string;
  /** Short text kept on the posting. */
  label: string;
}

export interface PayslipEntryInput {
  entityId: string;
  currency: CurrencyCode;
  date: CalendarDate;
  description: string;
  memberId: string;
  depositAccountId: string;
  net: bigint;
  lines: readonly PayslipPostingLine[];
}

/**
 * PAY-05: one journal entry, tagged to the member. Earnings are credits; net pay, taxes and deductions are debits,
 * and they balance exactly because a confirmed payslip has no gap. Employer contributions aren't money the member
 * received or paid, so they stay on the payslip (memo only). The entry is restricted to the member (PAY-09), except
 * the net-pay line, which is a public bank fact (ADR-0016 §2).
 */
export function buildPayslipEntry(input: PayslipEntryInput): JournalEntryDraft {
  const { net, lines } = input;
  const gap = payslipGap(lines, net);
  if (gap !== 0n) {
    throw new LedgerError(
      'ledger.unbalanced',
      `The payslip doesn't add up: pay less deductions differs from net pay by ${gap} minor units`,
    );
  }
  if (net < 0n) throw new LedgerError('ledger.unbalanced', 'Net pay cannot be negative');
  const posting = (
    accountId: string,
    amount: bigint,
    label: string,
    publicLine: boolean,
  ): Omit<PostingDraft, 'lineNo'> => ({
    accountId,
    accountEntityId: input.entityId,
    currency: input.currency,
    amount,
    functionalAmount: amount,
    fxRate: null,
    memberId: input.memberId,
    memo: label,
    publicLine,
  });
  const postings = [
    ...(net > 0n ? [posting(input.depositAccountId, net, input.description, true)] : []),
    ...lines
      .filter((l) => l.section !== 'employer' && l.amount !== 0n)
      .map((l) => posting(l.accountId, l.section === 'earning' ? -l.amount : l.amount, l.label, false)),
  ].map((p, i) => ({ ...p, lineNo: i + 1 }));
  const entry: JournalEntryDraft = {
    entityId: input.entityId,
    functionalCurrency: input.currency,
    entryDate: input.date,
    kind: 'standard',
    description: input.description,
    postings,
    restricted: true,
    restrictedMemberId: input.memberId,
  };
  validateEntry(entry);
  return entry;
}

export interface WithholdingSummary extends PayslipTotals {
  net: bigint;
  /** Retirement and health savings among the deductions (PAY-06). */
  retirement: bigint;
  /** Taxes ÷ gross, in basis points, rounded half up; null without pay (PAY-06). */
  effectiveRateBps: number | null;
}

/** Totals over a set of payslips for the per-member report (PAY-06). */
export function withholdingSummary(
  slips: readonly { net: bigint; lines: readonly PayslipLineAmount[] }[],
): WithholdingSummary {
  const lines = slips.flatMap((s) => s.lines);
  const totals = payslipTotals(lines);
  const retirement = lines
    .filter((l) => (l.section === 'pre_tax' || l.section === 'post_tax') && SAVINGS_CODES.has(l.code))
    .reduce((t, l) => t + l.amount, 0n);
  return {
    ...totals,
    net: slips.reduce((t, s) => t + s.net, 0n),
    retirement,
    effectiveRateBps: totals.gross > 0n ? Number(divRound(totals.taxes * 10_000n, totals.gross)) : null,
  };
}
