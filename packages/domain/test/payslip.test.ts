import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  asCurrencyCode,
  buildPayslipDepositEntries,
  depositChoices,
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

describe('splitting pay across accounts (ADR-0022)', () => {
  const lines: PayslipPostingLine[] = [
    { section: 'earning', code: 'salary', amount: 500000n, accountId: 'salary', label: 'Salary' },
    { section: 'earning', code: 'bonus', amount: 100000n, accountId: 'bonus', label: 'Bonus' },
    { section: 'tax', code: 'federal', amount: 100000n, accountId: 'tax', label: 'Federal tax' },
  ];
  const input = {
    entityId: 'e',
    currency: asCurrencyCode('USD'),
    date: calendarDate('2026-10-15'),
    description: 'Acme',
    memberId: 'm',
    depositAccountId: 'checking',
    net: 500000n,
    lines,
  };
  const others = [
    { accountId: 'college', amount: 20000n },
    { accountId: 'vacation', amount: 10000n },
  ];
  const posted = (accountId: string, entries: JournalEntryDraft[]) =>
    entries
      .flatMap((e) => e.postings)
      .filter((p) => p.accountId === accountId)
      .reduce((t, p) => t + p.amount, 0n);
  const all = (o = others) => [
    buildPayslipEntry({ ...input, otherDeposits: o }),
    ...buildPayslipDepositEntries({ ...input, otherDeposits: o }).map((d) => d.entry),
  ];

  it('sends the rest to the main account, and each amount to its own', () => {
    const entries = all();
    expect(posted('checking', entries)).toBe(470000n);
    expect(posted('college', entries)).toBe(20000n);
    expect(posted('vacation', entries)).toBe(10000n);
  });

  it('balances every entry, and keeps income, tax and the total exactly as they were', () => {
    const entries = all();
    for (const e of entries) expect(sum(e)).toBe(0n);
    const whole = [buildPayslipEntry(input)];
    for (const account of ['salary', 'bonus', 'tax']) {
      expect(posted(account, entries)).toBe(posted(account, whole));
    }
  });

  it('is the same as no split at all when nothing is split off', () => {
    expect(buildPayslipEntry({ ...input, otherDeposits: [] })).toEqual(buildPayslipEntry(input));
    expect(buildPayslipDepositEntries(input)).toEqual([]);
  });

  it('takes from the biggest earning first, and spills over when that runs out', () => {
    const big = [{ accountId: 'college', amount: 450000n }];
    const small = buildPayslipEntry({
      ...input,
      lines: [
        { section: 'earning', code: 'salary', amount: 300000n, accountId: 'salary', label: 'Salary' },
        { section: 'earning', code: 'bonus', amount: 300000n, accountId: 'bonus', label: 'Bonus' },
        lines[2]!,
      ],
      otherDeposits: big,
    });
    expect(sum(small)).toBe(0n);
    const [deposit] = buildPayslipDepositEntries({
      ...input,
      lines: [
        { section: 'earning', code: 'salary', amount: 300000n, accountId: 'salary', label: 'Salary' },
        { section: 'earning', code: 'bonus', amount: 300000n, accountId: 'bonus', label: 'Bonus' },
        lines[2]!,
      ],
      otherDeposits: big,
    });
    expect(deposit!.entry.postings.map((p) => [p.accountId, p.amount])).toEqual([
      ['college', 450000n],
      ['salary', -300000n],
      ['bonus', -150000n],
    ]);
  });

  it('shows only the deposit line of each, like the main entry (PAY-09)', () => {
    const [deposit] = buildPayslipDepositEntries({ ...input, otherDeposits: others });
    expect(deposit!.entry.restricted).toBe(true);
    expect(deposit!.entry.restrictedMemberId).toBe('m');
    expect(deposit!.entry.postings.map((p) => p.publicLine)).toEqual([true, false]);
    expect(deposit!.entry.postings.every((p) => p.memberId === 'm')).toBe(true);
  });

  it('has to leave something for the main account', () => {
    expect(() =>
      buildPayslipEntry({ ...input, otherDeposits: [{ accountId: 'college', amount: 500000n }] }),
    ).toThrow(/main account/);
    expect(() =>
      buildPayslipEntry({ ...input, otherDeposits: [{ accountId: 'college', amount: 600000n }] }),
    ).toThrow(/main account/);
  });

  it('holds for any split that leaves something', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 100000n }), { minLength: 1, maxLength: 4 }),
        (amounts) => {
          const split = amounts.map((amount, i) => ({ accountId: `goal${i}`, amount }));
          const entries = all(split);
          for (const e of entries) expect(sum(e)).toBe(0n);
          const total = amounts.reduce((t, a) => t + a, 0n);
          expect(posted('checking', entries)).toBe(500000n - total);
          expect(posted('salary', entries) + posted('bonus', entries)).toBe(-600000n);
        },
      ),
    );
  });
});

describe('depositChoices', () => {
  it('sends the main account’s pick and the others’ separately', () => {
    expect(depositChoices(['college'], { checking: 't1', college: 't2' })).toEqual({
      depositTransactionId: 't1',
      otherDeposits: [{ accountId: 'college', transactionId: 't2' }],
    });
  });

  it('sends only what was asked about', () => {
    expect(depositChoices(['college'], { college: null })).toEqual({
      otherDeposits: [{ accountId: 'college', transactionId: null }],
    });
    expect(depositChoices([], { checking: null })).toEqual({ depositTransactionId: null });
    expect(depositChoices(['college'], {})).toEqual({});
  });
});
