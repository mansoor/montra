import { describe, expect, it } from 'vitest';
import {
  checksOutcome,
  emptySum,
  expectedAgainstReceived,
  expectedTaxForms,
  parseTaxFormBoxes,
  payGap,
  principalDate,
  reconcile1098,
  reconcile1099Div,
  reconcile1099Int,
  reconcileW2,
  w2ReadingIssues,
  withinTolerance,
  type AccountIncomeBooks,
  type CalendarDate,
  type Form1098Boxes,
  type Form1099DivBoxes,
  type Form1099IntBoxes,
  type MortgageBooks,
  type TaxFormCheck,
  type W2Books,
  type W2FormBoxes,
  type W2PayslipSums,
} from '../src/index.js';

const d = (s: string) => s as CalendarDate;
const w2 = (json: unknown) => parseTaxFormBoxes('w2', json).boxes as W2FormBoxes;
const int = (json: unknown) => parseTaxFormBoxes('1099_int', json).boxes as Form1099IntBoxes;
const div = (json: unknown) => parseTaxFormBoxes('1099_div', json).boxes as Form1099DivBoxes;
const f1098 = (json: unknown) => parseTaxFormBoxes('1098', json).boxes as Form1098Boxes;
const box = (checks: TaxFormCheck[], b: string) => {
  const c = checks.find((x) => x.box === b);
  if (!c) throw new Error(`no check for box ${b}: ${checks.map((x) => x.box).join(', ')}`);
  return c;
};

// A year of pay: $90,000 earned; $6,000 to the 401(k), $1,200 to an HSA, $800 of cafeteria (other) pre-tax.
const SUMS: W2PayslipSums = {
  earnings: 9_000_000n,
  preTax: 800_000n,
  preTax401k: 600_000n,
  hsa: 120_000n,
  roth401k: 0n,
  fedTax: 1_204_500n,
  socialSecurity: 545_600n,
  medicare: 127_600n,
  stateTax: 512_300n,
};
// E − P = 82,000.00; E − (P − K) = 88,000.00.
const BOOKS: W2Books = {
  payslips: 12,
  sums: SUMS,
  ytd: null,
  payDates: Array.from({ length: 12 }, (_, i) => d(`2025-${String(i + 1).padStart(2, '0')}-25`)),
  otherPreTax: [],
  payslipIds: ['p1', 'p2'],
};
const W2 = {
  box1: '8200000',
  box2: '1204500',
  box3: '8800000',
  box4: '545600',
  box5: '8800000',
  box6: '127600',
  box12: [
    { code: 'D', amount: '600000' },
    { code: 'W', amount: '120000' },
  ],
  states: [{ state: 'CA', box16: '8200000', box17: '512300' }],
};

describe('tolerance (§5.1)', () => {
  it.each([
    [0n, true],
    [100n, true],
    [-100n, true],
    [101n, false],
    [-101n, false],
  ])('a difference of %s cents is within $1.00: %s', (diff, ok) => {
    expect(withinTolerance(1_000_000n + diff, 1_000_000n)).toBe(ok);
  });

  it('a box $1.00 off matches, $1.01 off differs', () => {
    const at = reconcileW2(2025, w2({ ...W2, box2: '1204600' }), BOOKS);
    expect(box(at, '2')).toMatchObject({ status: 'matches', difference: 100n });
    const over = reconcileW2(2025, w2({ ...W2, box2: '1204601' }), BOOKS);
    expect(box(over, '2')).toMatchObject({ status: 'differs', difference: 101n });
  });
});

describe('reconcileW2 (§5.2)', () => {
  it('matches complete payslips box by box', () => {
    const checks = reconcileW2(2025, w2(W2), BOOKS);
    expect(checks.filter((c) => c.kind === 'check').map((c) => [c.box, c.books, c.status])).toEqual([
      ['1', 8_200_000n, 'matches'],
      ['2', 1_204_500n, 'matches'],
      ['3', 8_800_000n, 'matches'],
      ['4', 545_600n, 'matches'],
      ['5', 8_800_000n, 'matches'],
      ['6', 127_600n, 'matches'],
      ['12D', 600_000n, 'matches'],
      ['12W', 120_000n, 'matches'],
      ['17', 512_300n, 'matches'],
    ]);
    expect(box(checks, '1').sources.payslipIds).toEqual(['p1', 'p2']);
    expect(box(checks, '16')).toMatchObject({
      kind: 'info',
      status: 'info',
      books: 8_200_000n,
      difference: 0n,
    });
    expect(checksOutcome(checks)).toEqual({ outcome: 'matches', difference: null });
  });

  // One row per check box: the box changed on the form by +$50.00, and what that box's check says.
  it.each([
    ['box1', '1'],
    ['box2', '2'],
    ['box5', '5'],
    ['box6', '6'],
  ])('a W-2 whose %s is $50.00 more than the books differs on box %s', (key, b) => {
    const value = BigInt((W2 as Record<string, unknown>)[key] as string) + 5_000n;
    const checks = reconcileW2(2025, w2({ ...W2, [key]: String(value) }), BOOKS);
    expect(box(checks, b)).toMatchObject({
      status: expect.stringMatching(/differs|check_reading/),
      difference: 5_000n,
    });
    expect(checksOutcome(checks).outcome).toMatch(/differs|check_reading/);
  });

  it('caps box 3 at the wage base', () => {
    const rich = { ...SUMS, earnings: 30_000_000n, preTax: 0n, preTax401k: 0n, hsa: 0n };
    const checks = reconcileW2(
      2025,
      w2({ box1: '30000000', box3: '17610000', box4: '1091820', box5: '30000000' }),
      { ...BOOKS, sums: rich },
    );
    expect(box(checks, '3')).toMatchObject({ books: 17_610_000n, status: 'matches' });
    expect(box(checks, '5')).toMatchObject({ books: 30_000_000n, status: 'matches' });
  });

  it('explains box 1, 3 and 5 by box 12 C', () => {
    const checks = reconcileW2(
      2025,
      w2({
        ...W2,
        box1: '8231000',
        box3: '8831000',
        box4: '547522',
        box5: '8831000',
        box6: '128050',
        box12: [...W2.box12, { code: 'C', amount: '31000' }],
      }),
      BOOKS,
    );
    for (const b of ['1', '3', '5']) {
      expect(box(checks, b)).toMatchObject({ status: 'explained', difference: 31_000n });
      expect(box(checks, b).explanation).toMatch(/group-term life/);
    }
    expect(box(checks, '12C')).toMatchObject({ kind: 'info' });
  });

  it('checks 12 AA when either side has it, and lists “other” pre-tax lines under 3 and 5', () => {
    const checks = reconcileW2(2025, w2(W2), {
      ...BOOKS,
      sums: { ...SUMS, roth401k: 100_000n },
      otherPreTax: ['Commuter'],
    });
    expect(box(checks, '12AA')).toMatchObject({ form: null, books: 100_000n, status: 'differs' });
    expect(box(checks, '3').rule).toMatch(/Commuter/);
    expect(box(checks, '5').rule).toMatch(/Commuter/);
  });

  it('cross-checks the last payslip’s year-to-date figures: a payslip seems to be missing', () => {
    // March's payslip was never entered: the sums are short by one month's pay; the year-to-date figures aren't.
    const short = {
      ...SUMS,
      earnings: 8_250_000n,
      preTax: 733_333n,
      preTax401k: 550_000n,
    };
    const checks = reconcileW2(2025, w2(W2), {
      ...BOOKS,
      sums: short,
      ytd: { sums: SUMS, payDate: d('2025-12-25') },
      payDates: BOOKS.payDates.filter((x) => x !== '2025-03-25'),
    });
    const one = box(checks, '1');
    expect(one.status).toBe('differs');
    expect(one.explanation).toMatch(/a payslip seems to be missing/);
    expect(one.explanation).toMatch(/between 25 February 2025 and 25 April 2025/);
    // Federal tax was complete in both: nothing to explain.
    expect(box(checks, '2')).toMatchObject({ status: 'matches', explanation: null });
  });

  it('is not tracked when there are no payslips', () => {
    const checks = reconcileW2(2025, w2(W2), { ...BOOKS, payslips: 0, sums: { ...SUMS, earnings: 0n } });
    expect(checks.filter((c) => c.kind === 'check').every((c) => c.status === 'not_tracked')).toBe(true);
    expect(box(checks, '1')).toMatchObject({ books: null, difference: null });
    expect(checksOutcome(checks).outcome).toBe('not_tracked');
  });

  it('holds an accepted difference while it stays the same', () => {
    const form = w2({ ...W2, box2: '1254500' });
    const accepted = { '2': { form: 1_254_500n, books: 1_204_500n, note: 'Bonus paid as a gift card' } };
    const checks = reconcileW2(2025, form, BOOKS, accepted);
    expect(box(checks, '2')).toMatchObject({ status: 'accepted', acceptedNote: 'Bonus paid as a gift card' });
    expect(checksOutcome(checks).outcome).toBe('accepted');
    // The books changed: the acceptance no longer holds.
    const moved = reconcileW2(2025, form, { ...BOOKS, sums: { ...SUMS, fedTax: 1_100_000n } }, accepted);
    expect(box(moved, '2').status).toBe('differs');
  });
});

describe('W-2 reading checks (§5.2)', () => {
  it.each([
    ['box 4 is 6.2% of box 3', { box3: '8800000', box4: '545600' }, []],
    ['box 4 isn’t', { box3: '8800000', box4: '645600' }, ['4', '3']],
    ['box 6 is 1.45% of box 5', { box5: '8800000', box6: '127600' }, []],
    ['box 6 adds 0.9% above $200,000', { box5: '25000000', box6: '407500' }, []],
    ['box 6 isn’t', { box5: '8800000', box6: '27600' }, ['6', '5']],
    ['box 3 over the wage base', { box3: '18000000' }, ['3']],
    ['box 5 under box 3', { box3: '8800000', box5: '8000000' }, ['5', '3']],
  ])('%s', (_, boxes, flagged) => {
    expect([...w2ReadingIssues(2025, w2(boxes)).keys()].sort()).toEqual([...flagged].sort());
  });

  it('marks a differing box as a misread when its reading check fails', () => {
    const checks = reconcileW2(2025, w2({ ...W2, box4: '645600' }), BOOKS);
    expect(box(checks, '4')).toMatchObject({ status: 'check_reading', difference: 100_000n });
    expect(checksOutcome(checks).outcome).toBe('check_reading');
    // Box 3 still matches the books, so its reading check doesn't make it a difference.
    expect(box(checks, '3').status).toBe('matches');
  });
});

describe('payGap', () => {
  it('finds the longest stretch with no pay before the last payslip', () => {
    expect(payGap(2025, [d('2025-01-31'), d('2025-02-28'), d('2025-05-31')])).toEqual({
      from: d('2025-02-28'),
      to: d('2025-05-31'),
    });
    expect(payGap(2025, [d('2025-06-30')])).toEqual({ from: d('2025-01-01'), to: d('2025-06-30') });
    expect(payGap(2025, [])).toBeNull();
  });
});

const income = (total: bigint, ids: string[] = ['t1']): AccountIncomeBooks['income'] => ({
  total,
  transactionIds: ids,
  journalEntryIds: [],
});
const ACCOUNT_BOOKS: AccountIncomeBooks = {
  income: income(41_07n * 10n),
  boundary: [],
  tracked: true,
  federalTax: emptySum(),
  foreignTax: emptySum(),
  penalties: emptySum(),
};

describe('reconcile1099Int (§5.3)', () => {
  it('compares boxes 1, 3 and 8 as one total and shows each', () => {
    const checks = reconcile1099Int(2025, int({ box1: '30000', box3: '7000', box8: '4070' }), ACCOUNT_BOOKS);
    expect(box(checks, '1+3+8')).toMatchObject({
      kind: 'check',
      form: 41_070n,
      books: 41_070n,
      status: 'matches',
    });
    expect(box(checks, '1+3+8').sources.transactionIds).toEqual(['t1']);
    expect(['1', '3', '8'].map((b) => box(checks, b).kind)).toEqual(['info', 'info', 'info']);
  });

  it.each([
    // [what, form box 1, books, boundary posting, status]
    ['matches to the cent', '41070', 41_070n, null, 'matches'],
    ['matches within $1.00', '41170', 41_070n, null, 'matches'],
    ['differs at $1.01', '41171', 41_070n, null, 'differs'],
    [
      'interest credited 31 December, posted 2 January',
      '45177',
      41_070n,
      { date: '2026-01-02', amount: 4_107n },
      'explained',
    ],
    [
      'interest posted 30 December the year before, counted this year',
      '45177',
      41_070n,
      { date: '2024-12-30', amount: 4_107n },
      'explained',
    ],
    [
      'interest posted 3 January, counted the year before',
      '36963',
      41_070n,
      { date: '2025-01-03', amount: 4_107n },
      'explained',
    ],
    [
      'a posting a week into January is not the boundary',
      '45177',
      41_070n,
      { date: '2026-01-08', amount: 4_107n },
      'differs',
    ],
    [
      'a boundary posting of another amount',
      '45177',
      41_070n,
      { date: '2026-01-02', amount: 2_000n },
      'differs',
    ],
  ])('%s', (_, box1, books, boundary, status) => {
    const checks = reconcile1099Int(2025, int({ box1 }), {
      ...ACCOUNT_BOOKS,
      income: income(books),
      boundary: boundary ? [{ date: d(boundary.date), amount: boundary.amount }] : [],
    });
    expect(box(checks, '1+3+8').status).toBe(status);
    if (status === 'explained')
      expect(box(checks, '1+3+8').explanation).toMatch(/\$41\.07 of interest posted on/);
  });

  it('checks box 4 only when it isn’t zero, and shows box 2 beside penalties', () => {
    expect(
      reconcile1099Int(2025, int({ box1: '41070', box4: '0' }), ACCOUNT_BOOKS).some((c) => c.box === '4'),
    ).toBe(false);
    const checks = reconcile1099Int(2025, int({ box1: '41070', box2: '2500', box4: '9856' }), {
      ...ACCOUNT_BOOKS,
      penalties: { total: 2_500n, transactionIds: ['t9'], journalEntryIds: [] },
    });
    expect(box(checks, '4')).toMatchObject({ kind: 'check', books: 0n, status: 'differs' });
    expect(box(checks, '2')).toMatchObject({ kind: 'info', books: 2_500n, difference: 0n });
  });

  it('is not tracked on an account that is valued, not itemized', () => {
    const checks = reconcile1099Int(2025, int({ box1: '41070' }), {
      ...ACCOUNT_BOOKS,
      income: income(0n, []),
      tracked: false,
    });
    expect(box(checks, '1+3+8')).toMatchObject({ status: 'not_tracked', books: null });
    expect(checksOutcome(checks).outcome).toBe('not_tracked');
  });
});

describe('reconcile1099Div (§5.4)', () => {
  it.each([
    ['matches', { box1a: '125000' }, 125_000n, 'matches'],
    [
      'capital gain distributions booked as dividends (box 2a)',
      { box1a: '125000', box2a: '30000' },
      155_000n,
      'explained',
    ],
    ['differs', { box1a: '125000' }, 100_000n, 'differs'],
  ])('box 1a %s', (_, boxes, books, status) => {
    const checks = reconcile1099Div(2025, div(boxes), { ...ACCOUNT_BOOKS, income: income(books) });
    expect(box(checks, '1a').status).toBe(status);
  });

  it('checks foreign tax when the box isn’t zero, and reads 1b against 1a', () => {
    const checks = reconcile1099Div(2025, div({ box1a: '125000', box1b: '130000', box7: '1500' }), {
      ...ACCOUNT_BOOKS,
      income: income(125_000n),
      foreignTax: { total: 1_500n, transactionIds: ['t2'], journalEntryIds: [] },
    });
    expect(box(checks, '7')).toMatchObject({ kind: 'check', status: 'matches' });
    expect(box(checks, '1b')).toMatchObject({ kind: 'info', status: 'check_reading' });
    // An info box never makes the form differ by itself.
    expect(checksOutcome(checks).outcome).toBe('matches');
  });

  it('is not tracked on a valued account', () => {
    const checks = reconcile1099Div(2025, div({ box1a: '125000' }), {
      ...ACCOUNT_BOOKS,
      income: income(0n, []),
      tracked: false,
    });
    expect(checksOutcome(checks).outcome).toBe('not_tracked');
  });
});

const payment = (date: string, interest: bigint, n: number) => ({
  date: d(date),
  interest,
  loanPaymentId: `lp${n}`,
  transactionId: `t${n}`,
});
const MORTGAGE: MortgageBooks = {
  tracked: true,
  payments: Array.from({ length: 12 }, (_, i) =>
    payment(`2025-${String(i + 1).padStart(2, '0')}-01`, 100_000n, i + 1),
  ),
  boundary: [],
  principal: { amount: 30_000_000n, date: d('2024-12-31'), journalEntryIds: ['j1'] },
  startDate: d('2021-06-15'),
  escrowTaxes: { total: 600_000n, transactionIds: [], journalEntryIds: [] },
  mortgageInsurance: null,
};

describe('reconcile1098 (§5.5)', () => {
  it('checks interest and principal, and shows escrow’s property tax as information', () => {
    const checks = reconcile1098(
      2025,
      f1098({ box1: '1200000', box2: '30000000', box10: '650000' }),
      MORTGAGE,
    );
    expect(box(checks, '1')).toMatchObject({ status: 'matches', books: 1_200_000n });
    expect(box(checks, '1').sources.loanPaymentIds).toHaveLength(12);
    expect(box(checks, '2')).toMatchObject({ status: 'matches' });
    expect(box(checks, '2').rule).toMatch(/31 December 2024/);
    // Box 10 differs by design and is never a Review item.
    expect(box(checks, '10')).toMatchObject({ kind: 'info', books: 600_000n, difference: 50_000n });
    expect(checksOutcome(checks).outcome).toBe('matches');
  });

  it.each([
    ['a refund of overpaid interest (box 4)', { box1: '1150000', box4: '50000' }, MORTGAGE, 'explained'],
    [
      'a January payment the lender credited in December',
      { box1: '1300000' },
      { ...MORTGAGE, boundary: [payment('2026-01-01', 100_000n, 13)] },
      'explained',
    ],
    [
      'interest paid at closing in the origination year',
      { box1: '1250000', box3: '2025-01-10' },
      MORTGAGE,
      'explained',
    ],
    ['a missing payment', { box1: '1300000' }, MORTGAGE, 'differs'],
  ])('box 1: %s', (_, boxes, books, status) => {
    expect(box(reconcile1098(2025, f1098(boxes), books), '1').status).toBe(status);
  });

  it('compares principal on the origination date when the loan began in the year', () => {
    expect(principalDate(2025, f1098({ box3: '2025-03-14' }))).toBe('2025-03-14');
    expect(principalDate(2025, f1098({ box3: '2021-06-15' }))).toBe('2024-12-31');
    expect(principalDate(2025, f1098({}))).toBe('2024-12-31');
  });

  it('is not tracked without recorded payments or a balance', () => {
    const checks = reconcile1098(2025, f1098({ box1: '1200000', box2: '30000000' }), {
      ...MORTGAGE,
      tracked: false,
      payments: [],
      principal: null,
    });
    expect(checksOutcome(checks).outcome).toBe('not_tracked');
  });
});

describe('checksOutcome', () => {
  it('reports the largest difference', () => {
    const checks = reconcileW2(2025, w2({ ...W2, box1: '8210000', box2: '1104500' }), BOOKS);
    expect(checksOutcome(checks)).toEqual({ outcome: 'differs', difference: -100_000n });
  });
});

describe('expected forms (§7.1)', () => {
  const employers = [
    {
      id: 'e1',
      name: 'Acme',
      memberId: 'm1',
      entityId: 'p',
      type: 'employer',
      payslips: 12,
      earnings: 9_000_000n,
    },
    { id: 'e2', name: 'Old job', memberId: 'm1', entityId: 'p', type: 'employer', payslips: 0, earnings: 0n },
    {
      id: 'e3',
      name: 'Pension',
      memberId: 'm2',
      entityId: 'p',
      type: 'other',
      payslips: 12,
      earnings: 100_000n,
    },
  ];
  const account = {
    entityId: 'p',
    personMemberId: 'm1',
    planType: null,
    interest: 0n,
    dividends: 0n,
    mortgageInterest: null,
  };
  const accounts = [
    { ...account, id: 'a1', name: 'Savings', interest: 1_000n },
    { ...account, id: 'a2', name: 'Checking', interest: 999n },
    { ...account, id: 'a3', name: 'Brokerage', planType: 'brokerage', dividends: 125_000n, interest: 2_000n },
    { ...account, id: 'a4', name: '401(k)', planType: '401k', dividends: 500_000n },
    { ...account, id: 'a5', name: 'Mortgage', mortgageInterest: 1_200_000n },
    { ...account, id: 'a6', name: 'Car loan', mortgageInterest: 59_999n },
  ];

  it('infers a W-2 per employer with payslips and 1099s and 1098s from the thresholds', () => {
    expect(
      expectedTaxForms(2025, employers, accounts).map((e) => [e.kind, e.employerId ?? e.accountId]),
    ).toEqual([
      ['w2', 'e1'],
      ['1099_int', 'a1'],
      ['1099_int', 'a3'],
      ['1099_div', 'a3'],
      ['1098', 'a5'],
    ]);
  });

  it('marks each expected form received, waived or missing, and lists the unexpected', () => {
    const expected = expectedTaxForms(2025, employers, accounts);
    const r = expectedAgainstReceived(
      expected,
      [
        { id: 'f1', kind: 'w2', status: 'confirmed', targets: [{ employerId: 'e1', accountId: null }] },
        // One bank form covering two accounts.
        {
          id: 'f2',
          kind: '1099_int',
          status: 'review',
          targets: [
            { employerId: null, accountId: 'a1' },
            { employerId: null, accountId: 'a3' },
          ],
        },
        {
          id: 'f3',
          kind: '1099_div',
          status: 'superseded',
          targets: [{ employerId: null, accountId: 'a3' }],
        },
        { id: 'f4', kind: '1099_int', status: 'confirmed', targets: [{ employerId: null, accountId: 'a2' }] },
      ],
      [{ id: 'w1', kind: '1098', employerId: null, accountId: 'a5' }],
    );
    expect(r.expected.map((e) => [e.kind, e.state, e.formId ?? e.waiverId])).toEqual([
      ['w2', 'received', 'f1'],
      ['1099_int', 'received', 'f2'],
      ['1099_int', 'received', 'f2'],
      ['1099_div', 'missing', null],
      ['1098', 'waived', 'w1'],
    ]);
    expect(r.unexpectedFormIds).toEqual(['f4']);
  });
});
