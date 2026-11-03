import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  asCurrencyCode,
  buildPayslipEntry,
  calendarDate,
  payslipGap,
  payslipTotals,
  withholdingSummary,
  type JournalEntryDraft,
  type PayslipPostingLine,
} from '../src/index.js';

// The worked example in design 04 §14.
const sum = (e: JournalEntryDraft) => e.postings.reduce((t, p) => t + p.amount, 0n);

const LINES: PayslipPostingLine[] = [
  { section: 'earning', code: 'salary', amount: 500000n, accountId: 'salary', label: 'Salary' },
  { section: 'pre_tax', code: '401k', amount: 30000n, accountId: '401k', label: '401(k)' },
  { section: 'pre_tax', code: 'health', amount: 7500n, accountId: 'health', label: 'Health insurance' },
  { section: 'tax', code: 'fed_tax', amount: 62000n, accountId: 'fed', label: 'Federal income tax' },
  { section: 'tax', code: 'state_tax', amount: 21000n, accountId: 'state', label: 'State income tax' },
  { section: 'tax', code: 'fica', amount: 38250n, accountId: 'fica', label: 'Social Security and Medicare' },
  { section: 'employer', code: 'match', amount: 15000n, accountId: 'none', label: 'Employer match' },
];
const input = {
  entityId: 'e1',
  currency: asCurrencyCode('USD'),
  date: calendarDate('2026-10-15'),
  description: 'ACME payroll',
  memberId: 'm1',
  depositAccountId: 'checking',
  net: 341250n,
  lines: LINES,
};

describe('payslip totals (PAY-02)', () => {
  it('adds up the worked example', () => {
    expect(payslipTotals(LINES)).toEqual({
      gross: 500000n,
      preTax: 37500n,
      taxes: 121250n,
      postTax: 0n,
      employer: 15000n,
      computedNet: 341250n,
    });
    expect(payslipGap(LINES, 341250n)).toBe(0n);
    expect(payslipGap(LINES, 341000n)).toBe(250n);
  });
});

describe('buildPayslipEntry (PAY-05)', () => {
  it('posts one balanced entry, tagged to the member and restricted', () => {
    const e = buildPayslipEntry(input);
    expect(sum(e)).toBe(0n);
    expect(e).toMatchObject({ restricted: true, restrictedMemberId: 'm1', kind: 'standard' });
    expect(e.postings.map((p) => [p.accountId, p.amount])).toEqual([
      ['checking', 341250n],
      ['salary', -500000n],
      ['401k', 30000n],
      ['health', 7500n],
      ['fed', 62000n],
      ['state', 21000n],
      ['fica', 38250n],
    ]);
    expect(e.postings.every((p) => p.memberId === 'm1')).toBe(true);
  });

  it('keeps only the net-pay line public (PAY-09, ADR-0016)', () => {
    const e = buildPayslipEntry(input);
    expect(e.postings.filter((p) => p.publicLine).map((p) => p.accountId)).toEqual(['checking']);
  });

  it('leaves employer contributions out of the ledger', () => {
    expect(buildPayslipEntry(input).postings.some((p) => p.accountId === 'none')).toBe(false);
  });

  it('refuses a payslip that does not add up', () => {
    expect(() => buildPayslipEntry({ ...input, net: 341000n })).toThrow(/doesn't add up/);
  });

  it('always balances, whatever the amounts', () => {
    const amount = fc.bigInt({ min: 0n, max: 10n ** 9n });
    fc.assert(
      fc.property(amount, amount, amount, amount, (salary, bonus, tax, deduction) => {
        fc.pre(salary + bonus > 0n && tax + deduction <= salary + bonus);
        const lines: PayslipPostingLine[] = [
          { section: 'earning', code: 'salary', amount: salary, accountId: 'a', label: 'a' },
          { section: 'earning', code: 'bonus', amount: bonus, accountId: 'b', label: 'b' },
          { section: 'tax', code: 'fed_tax', amount: tax, accountId: 'c', label: 'c' },
          { section: 'post_tax', code: 'dues', amount: deduction, accountId: 'd', label: 'd' },
        ];
        const net = salary + bonus - tax - deduction;
        expect(sum(buildPayslipEntry({ ...input, net, lines }))).toBe(0n);
      }),
    );
  });
});

describe('withholdingSummary (PAY-06)', () => {
  it('totals gross, net, taxes and retirement, with the effective rate', () => {
    const s = withholdingSummary([
      { net: 341250n, lines: LINES },
      { net: 341250n, lines: LINES },
    ]);
    expect(s).toMatchObject({
      gross: 1000000n,
      net: 682500n,
      taxes: 242500n,
      retirement: 60000n,
      employer: 30000n,
    });
    expect(s.effectiveRateBps).toBe(2425);
    expect(withholdingSummary([]).effectiveRateBps).toBeNull();
  });
});
