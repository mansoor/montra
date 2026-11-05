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
  /** Fixed amounts to other accounts (ADR-0022). The rest of the net goes to `depositAccountId`. */
  otherDeposits?: readonly PayslipOtherDeposit[];
  lines: readonly PayslipPostingLine[];
}

export interface PayslipOtherDeposit {
  accountId: string;
  amount: bigint;
}

/**
 * Which earnings each other deposit is paid out of, and what's left of each earning. A deposit is income arriving somewhere, so it takes
 * its share of the income with it, biggest earning first, and income in total is exactly what it was. No clearing account is needed.
 */
function allocateEarnings(lines: readonly PayslipPostingLine[], deposits: readonly PayslipOtherDeposit[]) {
  const earnings = lines
    .filter((l) => l.section === 'earning' && l.amount > 0n)
    .map((line) => ({ line, left: line.amount }))
    .sort((a, b) => (a.left === b.left ? 0 : a.left > b.left ? -1 : 1));
  const portions = deposits.map((deposit) => {
    let due = deposit.amount;
    const taken: { line: PayslipPostingLine; amount: bigint }[] = [];
    for (const e of earnings) {
      if (due === 0n) break;
      const amount = e.left < due ? e.left : due;
      if (amount === 0n) continue;
      e.left -= amount;
      due -= amount;
      taken.push({ line: e.line, amount });
    }
    return { deposit, taken };
  });
  return { portions, left: new Map(earnings.map((e) => [e.line, e.left])) };
}

const sumDeposits = (deposits: readonly PayslipOtherDeposit[]) => deposits.reduce((t, d) => t + d.amount, 0n);

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
  const others = input.otherDeposits ?? [];
  const main = net - sumDeposits(others);
  if (others.length > 0 && main <= 0n) {
    throw new LedgerError('ledger.unbalanced', 'The split has to leave something for the main account');
  }
  const { left } = allocateEarnings(lines, others);
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
    ...(main > 0n ? [posting(input.depositAccountId, main, input.description, true)] : []),
    ...lines
      .map((l) => ({ l, amount: l.section === 'earning' ? -(left.get(l) ?? l.amount) : l.amount }))
      .filter(({ l, amount }) => l.section !== 'employer' && amount !== 0n)
      .map(({ l, amount }) => posting(l.accountId, amount, l.label, false)),
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

/**
 * The entries for a split's other accounts (ADR-0022), in the order given. Each is a deposit against the income it takes, restricted like the
 * main entry with only the deposit line showing, so anyone who can read that account sees the bank fact and nothing about the pay.
 */
export function buildPayslipDepositEntries(input: PayslipEntryInput): {
  accountId: string;
  amount: bigint;
  entry: JournalEntryDraft;
}[] {
  const { portions } = allocateEarnings(input.lines, input.otherDeposits ?? []);
  const posting = (accountId: string, amount: bigint, memo: string, publicLine: boolean) => ({
    accountId,
    accountEntityId: input.entityId,
    currency: input.currency,
    amount,
    functionalAmount: amount,
    fxRate: null,
    memberId: input.memberId,
    memo,
    publicLine,
  });
  return portions.map(({ deposit, taken }) => {
    const entry: JournalEntryDraft = {
      entityId: input.entityId,
      functionalCurrency: input.currency,
      entryDate: input.date,
      kind: 'standard',
      description: input.description,
      postings: [
        posting(deposit.accountId, deposit.amount, input.description, true),
        ...taken.map((t) => posting(t.line.accountId, -t.amount, t.line.label, false)),
      ].map((p, i) => ({ ...p, lineNo: i + 1 })),
      restricted: true,
      restrictedMemberId: input.memberId,
    };
    validateEntry(entry);
    return { accountId: deposit.accountId, amount: deposit.amount, entry };
  });
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

/**
 * Turns what someone picked per account into a confirm request's fields (PAY-04, ADR-0022). `otherAccountIds` are the split's accounts; any
 * other account is the main one. A null pick means none of the deposits offered.
 */
export function depositChoices(
  otherAccountIds: readonly string[],
  picks: Readonly<Record<string, string | null>>,
): {
  depositTransactionId?: string | null;
  otherDeposits?: { accountId: string; transactionId: string | null }[];
} {
  const others = new Set(otherAccountIds);
  const entries = Object.entries(picks);
  const main = entries.find(([accountId]) => !others.has(accountId));
  const rest = entries
    .filter(([accountId]) => others.has(accountId))
    .map(([accountId, transactionId]) => ({ accountId, transactionId }));
  return {
    ...(main ? { depositTransactionId: main[1] } : {}),
    ...(rest.length ? { otherDeposits: rest } : {}),
  };
}
