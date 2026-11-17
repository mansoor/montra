/**
 * Checking a tax form against the books (ADR-0052 §5), and the forms a year should bring (§7.1). Pure: the API gathers
 * the figures under the reader's row-level security and these rules turn them into one check per box. Nothing is
 * stored: a payslip added later fixes the result the next time it's shown. Only acceptances are stored (§5.6).
 *
 * Amounts are bigint minor units (cents). A box matches when it is within `TAX_FORM_TOLERANCE_MINOR` ($1.00) of the
 * books; a `check` box that differs puts the form in Review, an `info` box never does by itself.
 */
import { addDays, compareDates, diffDays, type CalendarDate } from './calendar-date.js';
import { formatMoney } from './money.js';
import { abs, divRound } from './rounding.js';
import {
  socialSecurityWageBase,
  TAX_FORM_TOLERANCE_MINOR,
  taxFormThreshold,
  type Form1098Boxes,
  type Form1099DivBoxes,
  type Form1099IntBoxes,
  type TaxFormKind,
  type W2FormBoxes,
} from './tax-forms.js';

// ----- Checks ----------------------------------------------------------------------------------------------------------

export type TaxCheckKind = 'check' | 'info';

export const TAX_CHECK_STATUSES = [
  'matches',
  'explained',
  'differs',
  'accepted',
  'check_reading',
  'not_tracked',
  'info',
] as const;
export type TaxCheckStatus = (typeof TAX_CHECK_STATUSES)[number];

/** What was summed for a figure, for the drill-down (RPT-03). */
export interface TaxCheckSources {
  payslipIds: string[];
  transactionIds: string[];
  loanPaymentIds: string[];
  /** Entries with no transaction behind them, such as one recorded from the form (§5.6). */
  journalEntryIds: string[];
}

export interface TaxFormCheck {
  /** The box as printed: `1`, `12D`, `1a`, `1+3+8`, `16 CA`. */
  box: string;
  kind: TaxCheckKind;
  form: bigint | null;
  books: bigint | null;
  /** Form minus books; null where the books hold no figure. */
  difference: bigint | null;
  status: TaxCheckStatus;
  /** How the books' figure was worked out, in words. */
  rule: string;
  /** The known explanation that made it match, or what a difference probably means. */
  explanation: string | null;
  /** The note of an accepted difference. */
  acceptedNote: string | null;
  sources: TaxCheckSources;
}

/** A difference a person accepted (§5.6): it holds while the form and the books still say the same. */
export interface TaxFormAcceptance {
  form: bigint;
  books: bigint;
  note: string;
}
export type TaxFormAcceptances = Readonly<Record<string, TaxFormAcceptance>>;

export const noSources = (): TaxCheckSources => ({
  payslipIds: [],
  transactionIds: [],
  loanPaymentIds: [],
  journalEntryIds: [],
});

/** Whether two amounts agree within the tolerance ($1.00 matches, $1.01 doesn't). */
export const withinTolerance = (a: bigint, b: bigint): boolean => abs(a - b) <= TAX_FORM_TOLERANCE_MINOR;

const usd = (minor: bigint) => formatMoney({ amount: minor, currency: 'USD' });

const longDate = (d: CalendarDate) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${day} ${months[m - 1]} ${y}`;
};

/** A known explanation: when the difference (form − books) equals `amount` within the tolerance, the box matches. */
interface Explanation {
  amount: bigint;
  text: string;
}

interface CompareInput {
  box: string;
  form: bigint | undefined | null;
  books: bigint;
  rule: string;
  sources: TaxCheckSources;
  explanations?: Explanation[];
  /** A reading check on the form alone failed for this box: a difference is a misread before it's the books. */
  suspect?: string | null;
  /** What a difference probably means, when nothing explains it (the year-to-date cross-check). */
  hint?: (difference: bigint) => string | null;
  accepted: TaxFormAcceptances;
}

/** One `check` box: the form against the books, then the known explanations, an acceptance, the reading checks. */
function compare(c: CompareInput): TaxFormCheck {
  const form = c.form ?? 0n;
  const difference = form - c.books;
  const base = {
    box: c.box,
    kind: 'check' as const,
    form: c.form ?? null,
    books: c.books,
    difference,
    rule: c.rule,
    acceptedNote: null,
    sources: c.sources,
  };
  if (abs(difference) <= TAX_FORM_TOLERANCE_MINOR) return { ...base, status: 'matches', explanation: null };
  const known = (c.explanations ?? []).find((e) => e.amount !== 0n && withinTolerance(difference, e.amount));
  if (known) return { ...base, status: 'explained', explanation: known.text };
  const acceptance = c.accepted[c.box];
  if (acceptance && acceptance.form === form && acceptance.books === c.books) {
    return { ...base, status: 'accepted', explanation: null, acceptedNote: acceptance.note };
  }
  if (c.suspect) return { ...base, status: 'check_reading', explanation: c.suspect };
  return { ...base, status: 'differs', explanation: c.hint?.(difference) ?? null };
}

/** A `check` box the books can't speak to (no payslips, no postings): kept and shown, never a Review item. */
function notTracked(box: string, form: bigint | undefined | null, rule: string): TaxFormCheck {
  return {
    box,
    kind: 'check',
    form: form ?? null,
    books: null,
    difference: null,
    status: 'not_tracked',
    rule,
    explanation: null,
    acceptedNote: null,
    sources: noSources(),
  };
}

/** An `info` box: shown with the books' figure beside it when there is one. */
function info(
  box: string,
  form: bigint | undefined | null,
  rule: string,
  books: { amount: bigint; sources: TaxCheckSources } | null = null,
  explanation: string | null = null,
  suspect: string | null = null,
): TaxFormCheck {
  return {
    box,
    kind: 'info',
    form: form ?? null,
    books: books?.amount ?? null,
    difference: books && form !== undefined && form !== null ? form - books.amount : null,
    status: suspect ? 'check_reading' : 'info',
    rule,
    explanation: suspect ?? explanation,
    acceptedNote: null,
    sources: books?.sources ?? noSources(),
  };
}

// ----- The year boundary (§5.1) ---------------------------------------------------------------------------------------

/** A posting of the box's kind near 1 January, on either side of the tax year. */
export interface BoundaryPosting {
  date: CalendarDate;
  amount: bigint;
}

/** Postings within this many days of 1 January (27–31 December, 1–5 January) can be on the wrong side of it. */
export const YEAR_BOUNDARY_DAYS = 5;

const yearStart = (year: number) => `${year}-01-01` as CalendarDate;
const yearEnd = (year: number) => `${year}-12-31` as CalendarDate;

/** The dates to gather boundary postings over: 27 December of the year before to 5 January of the year after. */
export function boundaryWindow(year: number): {
  before: [CalendarDate, CalendarDate];
  after: [CalendarDate, CalendarDate];
} {
  return {
    before: [addDays(yearStart(year), -YEAR_BOUNDARY_DAYS), addDays(yearStart(year), YEAR_BOUNDARY_DAYS - 1)],
    after: [
      addDays(yearStart(year + 1), -YEAR_BOUNDARY_DAYS),
      addDays(yearStart(year + 1), YEAR_BOUNDARY_DAYS - 1),
    ],
  };
}

const nearBoundary = (year: number, d: CalendarDate) =>
  [yearStart(year), yearStart(year + 1)].some((b) => {
    const days = diffDays(d, b);
    return days >= -YEAR_BOUNDARY_DAYS && days < YEAR_BOUNDARY_DAYS;
  });

const inYear = (year: number, d: CalendarDate) =>
  compareDates(d, yearStart(year)) >= 0 && compareDates(d, yearEnd(year)) <= 0;

/**
 * The year-boundary explanations for a box: the books are short by a posting just outside the year (the issuer counted
 * it in the year, the books on the other side of 1 January), or over by one just inside it.
 */
function boundaryExplanations(
  year: number,
  postings: readonly BoundaryPosting[],
  what: string,
): Explanation[] {
  return postings
    .filter((p) => p.amount > 0n && nearBoundary(year, p.date))
    .map((p) =>
      inYear(year, p.date)
        ? {
            amount: -p.amount,
            text: `${usd(p.amount)} of ${what} posted on ${longDate(p.date)}, which the issuer counted in the year next to it`,
          }
        : {
            amount: p.amount,
            text: `${usd(p.amount)} of ${what} posted on ${longDate(p.date)}, on the other side of 1 January`,
          },
    );
}

// ----- W-2 (§5.2) -----------------------------------------------------------------------------------------------------

/** The payslip sums of §5.2 for one employer, person and year (what `app.tax_form_payslip_totals` returns). */
export interface W2PayslipSums {
  /** E: the earning lines. */
  earnings: bigint;
  /** P: all pre-tax lines. */
  preTax: bigint;
  /** K: pre-tax lines coded 401k. */
  preTax401k: bigint;
  /** H: pre-tax and employer lines coded hsa. */
  hsa: bigint;
  roth401k: bigint;
  fedTax: bigint;
  socialSecurity: bigint;
  medicare: bigint;
  stateTax: bigint;
}

export interface W2Books {
  /** Posted payslips paid in the tax year; none means the form isn't tracked in the books. */
  payslips: number;
  sums: W2PayslipSums;
  /** The year-to-date figures on the year's last payslip, when it carries them. */
  ytd: { sums: W2PayslipSums; payDate: CalendarDate } | null;
  /** Pay dates in the year, for the gap a missing payslip leaves. Empty for an accountant. */
  payDates: CalendarDate[];
  /** Labels of pre-tax lines coded `other`: counted out of box 1, ambiguous for boxes 3 and 5. */
  otherPreTax: string[];
  /** Empty for an accountant, who gets the totals without the payslips (§8.4). */
  payslipIds: string[];
}

/** Social Security tax: 6.2% (§5.2 reading checks). */
const SS_RATE = { num: 62n, den: 1000n };
/** Medicare: 1.45%, plus 0.9% on wages above $200,000. */
const MEDICARE_RATE = { num: 145n, den: 10000n };
const ADDITIONAL_MEDICARE = { num: 9n, den: 1000n, above: 20_000_000n };

/**
 * The reading checks on a W-2 alone (§5.2), to catch a misread before blaming the books: box 4 is 6.2% of boxes 3 and 7;
 * box 6 is 1.45% of box 5 plus 0.9% above $200,000; box 3 is at most the wage base; box 5 is at least box 3. Returns
 * what's wrong per box.
 */
export function w2ReadingIssues(year: number, b: W2FormBoxes): Map<string, string> {
  const issues = new Map<string, string>();
  const flag = (boxes: string[], text: string) => {
    for (const box of boxes) if (!issues.has(box)) issues.set(box, text);
  };
  const ssWages = (b.box3 ?? 0n) + (b.box7 ?? 0n);
  if (b.box4 !== undefined && (b.box3 !== undefined || b.box7 !== undefined)) {
    const expected = divRound(ssWages * SS_RATE.num, SS_RATE.den);
    if (!withinTolerance(b.box4, expected))
      flag(['4', '3'], `Check the reading: box 4 should be 6.2% of box 3 (${usd(expected)})`);
  }
  if (b.box6 !== undefined && b.box5 !== undefined) {
    const above = b.box5 > ADDITIONAL_MEDICARE.above ? b.box5 - ADDITIONAL_MEDICARE.above : 0n;
    const expected =
      divRound(b.box5 * MEDICARE_RATE.num, MEDICARE_RATE.den) +
      divRound(above * ADDITIONAL_MEDICARE.num, ADDITIONAL_MEDICARE.den);
    if (!withinTolerance(b.box6, expected))
      flag(['6', '5'], `Check the reading: box 6 should be 1.45% of box 5 (${usd(expected)})`);
  }
  const base = socialSecurityWageBase(year).amount;
  if (b.box3 !== undefined && b.box3 > base)
    flag(['3'], `Check the reading: box 3 is more than ${year}'s Social Security wage base (${usd(base)})`);
  if (b.box3 !== undefined && b.box5 !== undefined && b.box5 < b.box3)
    flag(
      ['5', '3'],
      'Check the reading: box 5 (Medicare wages) is less than box 3, and Medicare wages have no cap',
    );
  return issues;
}

/**
 * The longest stretch with no pay before the year's last payslip: where a missing payslip most likely is. Null with
 * fewer than one pay date.
 */
export function payGap(
  year: number,
  payDates: readonly CalendarDate[],
): { from: CalendarDate; to: CalendarDate } | null {
  const dates = [...payDates].filter((d) => inYear(year, d)).sort(compareDates);
  if (dates.length === 0) return null;
  let best = { from: yearStart(year), to: dates[0]!, days: diffDays(dates[0]!, yearStart(year)) };
  for (let i = 1; i < dates.length; i++) {
    const days = diffDays(dates[i]!, dates[i - 1]!);
    if (days > best.days) best = { from: dates[i - 1]!, to: dates[i]!, days };
  }
  return { from: best.from, to: best.to };
}

/** The books' figures per W-2 box from payslip sums. */
function w2Figures(year: number, s: W2PayslipSums) {
  const ficaWages = s.earnings - (s.preTax - s.preTax401k);
  const base = socialSecurityWageBase(year).amount;
  return {
    '1': s.earnings - s.preTax,
    '2': s.fedTax,
    '3': ficaWages > base ? base : ficaWages,
    '4': s.socialSecurity,
    '5': ficaWages,
    '6': s.medicare,
    '12D': s.preTax401k,
    '12AA': s.roth401k,
    '12W': s.hsa,
    '17': s.stateTax,
  } as const;
}

const box12 = (b: W2FormBoxes, code: string): bigint | undefined =>
  b.box12
    ?.filter((e) => e.code === code)
    .reduce<bigint | undefined>((t, e) => (t ?? 0n) + e.amount, undefined);

/** Checks a W-2 against the person's payslips from the matched employer in the tax year (§5.2). */
export function reconcileW2(
  year: number,
  b: W2FormBoxes,
  books: W2Books,
  accepted: TaxFormAcceptances = {},
): TaxFormCheck[] {
  const checks: TaxFormCheck[] = [];
  const figures = w2Figures(year, books.sums);
  const ytd = books.ytd ? w2Figures(year, books.ytd.sums) : null;
  const tracked = books.payslips > 0;
  const issues = w2ReadingIssues(year, b);
  const sources = (): TaxCheckSources => ({ ...noSources(), payslipIds: [...books.payslipIds] });
  const groupTermLife = box12(b, 'C');
  const c12 = groupTermLife
    ? [
        {
          amount: groupTermLife,
          text: `Box 12 C: ${usd(groupTermLife)} of group-term life insurance over $50,000 is added to wages`,
        },
      ]
    : [];
  const others = books.otherPreTax.length
    ? ` Pre-tax lines coded “other” (${books.otherPreTax.join(', ')}) are counted out; check whether they are FICA wages.`
    : '';
  const base = socialSecurityWageBase(year);
  const gap = payGap(year, books.payDates);
  const hint = (box: keyof typeof figures, form: bigint | undefined) => (): string | null => {
    if (!ytd || form === undefined || !withinTolerance(form, ytd[box])) return null;
    const where = gap ? ` (no pay between ${longDate(gap.from)} and ${longDate(gap.to)})` : '';
    return `The last payslip's year-to-date figure (${longDate(books.ytd!.payDate)}) matches the form: a payslip seems to be missing${where}`;
  };

  const rules: Record<keyof typeof figures, string> = {
    '1': 'Earnings on the year’s payslips, less every pre-tax deduction',
    '2': 'Federal income tax withheld on the year’s payslips',
    '3': `Earnings less pre-tax deductions other than 401(k), capped at ${year}'s wage base (${usd(base.amount)}${base.known ? '' : ', the latest known'}).${others}`,
    '4': 'Social Security tax withheld on the year’s payslips',
    '5': `Earnings less pre-tax deductions other than 401(k).${others}`,
    '6': 'Medicare tax withheld on the year’s payslips',
    '12D': '401(k) deferrals on the year’s payslips',
    '12AA': 'Roth 401(k) deductions on the year’s payslips',
    '12W': 'HSA contributions on the year’s payslips, yours and the employer’s',
    '17': 'State income tax withheld on the year’s payslips',
  };
  const form: Record<keyof typeof figures, bigint | undefined> = {
    '1': b.box1,
    '2': b.box2,
    '3': b.box3,
    '4': b.box4,
    '5': b.box5,
    '6': b.box6,
    '12D': box12(b, 'D'),
    '12AA': box12(b, 'AA'),
    '12W': box12(b, 'W'),
    '17': b.states?.length === 1 ? b.states[0]!.box17 : undefined,
  };
  const states = b.states ?? [];
  const boxes: (keyof typeof figures)[] = ['1', '2', '3', '4', '5', '6'];
  // Box 12's codes are checked when the form or the books have them.
  for (const code of ['12D', '12AA', '12W'] as const) {
    if (form[code] !== undefined || figures[code] !== 0n) boxes.push(code);
  }
  if (states.length === 1 && (form['17'] !== undefined || figures['17'] !== 0n)) boxes.push('17');
  for (const box of boxes) {
    if (!tracked) {
      checks.push(
        notTracked(
          box,
          form[box],
          'No payslips from this employer in the year: the pay is in the books as deposits only',
        ),
      );
      continue;
    }
    checks.push(
      compare({
        box,
        form: form[box],
        books: figures[box],
        rule: rules[box],
        sources: sources(),
        explanations: box === '1' || box === '3' || box === '5' ? c12 : [],
        suspect: issues.get(box) ?? null,
        hint: hint(box, form[box]),
        accepted,
      }),
    );
  }

  // Shown only.
  const stateWages = tracked ? { amount: figures['1'], sources: sources() } : null;
  for (const s of states) {
    const tag = states.length > 1 ? ` ${s.state}` : '';
    checks.push(
      info(
        `16${tag}`,
        s.box16,
        `State wages (${s.state}); the books' earnings less pre-tax deductions beside it`,
        stateWages,
        'States differ: California, for one, taxes HSA contributions',
      ),
    );
    if (states.length > 1 && s.box17 !== undefined)
      checks.push(info(`17${tag}`, s.box17, `State income tax (${s.state})`));
    if (s.box18 !== undefined) checks.push(info(`18${tag}`, s.box18, 'Local wages'));
    if (s.box19 !== undefined)
      checks.push(info(`19${tag}`, s.box19, `Local income tax${s.box20 ? ` (${s.box20})` : ''}`));
  }
  for (const e of b.box14 ?? []) checks.push(info(`14 ${e.label}`, e.amount, 'As printed in box 14'));
  const shown: [string, bigint | undefined, string][] = [
    ['7', b.box7, 'Social Security tips'],
    ['8', b.box8, 'Allocated tips'],
    ['10', b.box10, 'Dependent care benefits'],
    ['11', b.box11, 'Nonqualified plans'],
  ];
  for (const [box, amount, rule] of shown) if (amount !== undefined) checks.push(info(box, amount, rule));
  for (const e of b.box12 ?? []) {
    if (!['D', 'AA', 'W'].includes(e.code))
      checks.push(info(`12${e.code}`, e.amount, `Box 12, code ${e.code}`));
  }
  return checks;
}

// ----- 1099-INT and 1099-DIV (§5.3, §5.4) -------------------------------------------------------------------------------

/** A sum of postings and what it's made of. */
export interface PostingSum {
  total: bigint;
  transactionIds: string[];
  journalEntryIds: string[];
}

export const emptySum = (): PostingSum => ({ total: 0n, transactionIds: [], journalEntryIds: [] });

const sumSources = (s: PostingSum): TaxCheckSources => ({
  ...noSources(),
  transactionIds: [...s.transactionIds],
  journalEntryIds: [...s.journalEntryIds],
});

/** The books for a 1099's matched account(s) in the tax year. */
export interface AccountIncomeBooks {
  /** Interest (1099-INT) or dividends (1099-DIV) credited to the account(s) in the year. */
  income: PostingSum;
  /** The same kind of income posted near 1 January on either side of the year (§5.1). */
  boundary: BoundaryPosting[];
  /**
   * Whether the account(s) itemize this income. False for an account valued rather than itemized (an investment
   * account) that posted none: the form is then not tracked, and can be recorded from the form (§5.6).
   */
  tracked: boolean;
  federalTax: PostingSum;
  foreignTax: PostingSum;
  penalties: PostingSum;
}

const sumOf = (...xs: (bigint | undefined)[]): bigint | undefined =>
  xs.every((x) => x === undefined) ? undefined : xs.reduce<bigint>((t, x) => t + (x ?? 0n), 0n);

/** Checks a 1099-INT against the interest on its account(s) in the tax year (§5.3). */
export function reconcile1099Int(
  year: number,
  b: Form1099IntBoxes,
  books: AccountIncomeBooks,
  accepted: TaxFormAcceptances = {},
): TaxFormCheck[] {
  const checks: TaxFormCheck[] = [];
  const interest = sumOf(b.box1, b.box3, b.box8);
  const rule =
    'Interest credited to the account(s) in the year (categories on Schedule B part I, or named “interest”). Boxes 1, 3 and 8 are compared as one total: the books don’t tell taxable, Treasury and tax-exempt interest apart';
  if (!books.tracked)
    checks.push(
      notTracked('1+3+8', interest, 'The account is valued, not itemized: no interest was posted to it'),
    );
  else
    checks.push(
      compare({
        box: '1+3+8',
        form: interest,
        books: books.income.total,
        rule,
        sources: sumSources(books.income),
        explanations: boundaryExplanations(year, books.boundary, 'interest'),
        accepted,
      }),
    );
  if (b.box4 !== undefined && b.box4 !== 0n) {
    checks.push(
      compare({
        box: '4',
        form: b.box4,
        books: books.federalTax.total,
        rule: 'Federal tax withheld from the account(s) in the year (categories named for withholding or income tax)',
        sources: sumSources(books.federalTax),
        accepted,
      }),
    );
  }
  for (const [box, amount, what] of [
    ['1', b.box1, 'Interest income'],
    ['3', b.box3, 'Interest on US savings bonds and Treasury obligations'],
    ['8', b.box8, 'Tax-exempt interest'],
  ] as const) {
    if (amount !== undefined) checks.push(info(box, amount, `${what}: part of the total above`));
  }
  if (b.box2 !== undefined)
    checks.push(
      info('2', b.box2, 'Early withdrawal penalty; penalties and fees taken from the account(s) beside it', {
        amount: books.penalties.total,
        sources: sumSources(books.penalties),
      }),
    );
  const shown: [string, bigint | undefined, string][] = [
    ['5', b.box5, 'Investment expenses'],
    ['6', b.box6, 'Foreign tax paid'],
    ['9', b.box9, 'Specified private activity bond interest'],
    ['10', b.box10, 'Market discount'],
    ['11', b.box11, 'Bond premium'],
    ['12', b.box12, 'Bond premium on Treasury obligations'],
    ['13', b.box13, 'Bond premium on tax-exempt bonds'],
  ];
  for (const [box, amount, r] of shown) if (amount !== undefined) checks.push(info(box, amount, r));
  for (const s of b.states ?? [])
    if (s.stateTaxWithheld !== undefined)
      checks.push(info(`17 ${s.state}`, s.stateTaxWithheld, 'State tax withheld'));
  return checks;
}

/** Checks a 1099-DIV against the dividends on its account(s) in the tax year (§5.4). */
export function reconcile1099Div(
  year: number,
  b: Form1099DivBoxes,
  books: AccountIncomeBooks,
  accepted: TaxFormAcceptances = {},
): TaxFormCheck[] {
  const checks: TaxFormCheck[] = [];
  const rule =
    'Dividends credited to the account(s) in the year (categories on Schedule B part II, or named “dividend”)';
  if (!books.tracked)
    checks.push(
      notTracked('1a', b.box1a, 'The account is valued, not itemized: no dividends were posted to it'),
    );
  else {
    const capGains = b.box2a
      ? [
          {
            amount: -b.box2a,
            text: `Box 2a: ${usd(b.box2a)} of capital gain distributions booked as dividends`,
          },
        ]
      : [];
    checks.push(
      compare({
        box: '1a',
        form: b.box1a,
        books: books.income.total,
        rule,
        sources: sumSources(books.income),
        explanations: [...capGains, ...boundaryExplanations(year, books.boundary, 'dividends')],
        accepted,
      }),
    );
  }
  if (b.box4 !== undefined && b.box4 !== 0n)
    checks.push(
      compare({
        box: '4',
        form: b.box4,
        books: books.federalTax.total,
        rule: 'Federal tax withheld from the account(s) in the year',
        sources: sumSources(books.federalTax),
        accepted,
      }),
    );
  if (b.box7 !== undefined && b.box7 !== 0n)
    checks.push(
      compare({
        box: '7',
        form: b.box7,
        books: books.foreignTax.total,
        rule: 'Foreign tax taken from the account(s) in the year (categories named “foreign tax”)',
        sources: sumSources(books.foreignTax),
        accepted,
      }),
    );
  if (b.box1b !== undefined) {
    const over = b.box1a !== undefined && b.box1b > b.box1a;
    checks.push(
      info(
        '1b',
        b.box1b,
        'Qualified dividends: the books have no qualified/ordinary split',
        null,
        null,
        over ? 'Check the reading: qualified dividends (1b) are part of box 1a, so can’t be more' : null,
      ),
    );
  }
  const shown: [string, bigint | undefined, string][] = [
    ['2a', b.box2a, 'Total capital gain distributions'],
    ['2b', b.box2b, 'Unrecaptured section 1250 gain'],
    ['2c', b.box2c, 'Section 1202 gain'],
    ['2d', b.box2d, 'Collectibles (28%) gain'],
    ['2e', b.box2e, 'Section 897 ordinary dividends'],
    ['2f', b.box2f, 'Section 897 capital gain'],
    ['3', b.box3, 'Nondividend distributions'],
    ['5', b.box5, 'Section 199A dividends'],
    ['6', b.box6, 'Investment expenses'],
    ['9', b.box9, 'Cash liquidation distributions'],
    ['10', b.box10, 'Noncash liquidation distributions'],
    ['12', b.box12, 'Exempt-interest dividends'],
    ['13', b.box13, 'Specified private activity bond interest dividends'],
  ];
  for (const [box, amount, r] of shown) if (amount !== undefined) checks.push(info(box, amount, r));
  for (const s of b.states ?? [])
    if (s.stateTaxWithheld !== undefined)
      checks.push(info(`16 ${s.state}`, s.stateTaxWithheld, 'State tax withheld'));
  return checks;
}

// ----- 1098 (§5.5) -----------------------------------------------------------------------------------------------------

/** One recorded mortgage payment and its interest. */
export interface MortgagePayment {
  date: CalendarDate;
  interest: bigint;
  loanPaymentId: string;
  transactionId: string;
}

export interface MortgageBooks {
  /** The account carries a loan schedule with payments recorded. False: the form isn't tracked. */
  tracked: boolean;
  /** Payments whose transaction is in the tax year. */
  payments: MortgagePayment[];
  /** Payments near 1 January on either side of the year (§5.1). */
  boundary: MortgagePayment[];
  /** The loan's balance on `principalDate(year, boxes)`; null when the books have none. */
  principal: { amount: bigint; date: CalendarDate; journalEntryIds: string[] } | null;
  /** `loan_schedule.start_date`. */
  startDate: CalendarDate | null;
  /** Property tax posted from this loan's escrow in the year. */
  escrowTaxes: PostingSum;
  /** Mortgage insurance posted from this loan's payments, when a category holds it. */
  mortgageInsurance: PostingSum | null;
}

/**
 * The day box 2's principal is compared on: the start of 1 January (the balance after 31 December), or the
 * origination date (box 3) when it's later in the tax year.
 */
export function principalDate(year: number, b: Form1098Boxes): CalendarDate {
  if (b.box3 && inYear(year, b.box3 as CalendarDate) && b.box3 !== yearStart(year))
    return b.box3 as CalendarDate;
  return yearEnd(year - 1);
}

/** Checks a 1098 against the matched mortgage's payments and balance (§5.5). */
export function reconcile1098(
  year: number,
  b: Form1098Boxes,
  books: MortgageBooks,
  accepted: TaxFormAcceptances = {},
): TaxFormCheck[] {
  const checks: TaxFormCheck[] = [];
  const interestRule = 'Interest in the loan’s payments whose transaction is in the year';
  if (!books.tracked) checks.push(notTracked('1', b.box1, 'No payments recorded on this loan in the year'));
  else {
    const total = books.payments.reduce((t, p) => t + p.interest, 0n);
    const explanations: Explanation[] = [];
    if (b.box4)
      explanations.push(
        { amount: -b.box4, text: `Box 4: ${usd(b.box4)} of overpaid interest refunded` },
        { amount: b.box4, text: `Box 4: ${usd(b.box4)} of overpaid interest refunded` },
      );
    explanations.push(
      ...boundaryExplanations(
        year,
        books.boundary.map((p) => ({ date: p.date, amount: p.interest })),
        'interest, in a payment',
      ),
    );
    const origination = (b.box3 ?? books.startDate) as CalendarDate | null;
    const largest = books.payments.reduce((m, p) => (p.interest > m ? p.interest : m), 0n);
    const closing = (d: bigint) =>
      origination && inYear(year, origination) && d > 0n && d <= largest + TAX_FORM_TOLERANCE_MINOR
        ? `The loan began on ${longDate(origination)}: interest paid at closing isn’t in the loan’s payments`
        : null;
    const check = compare({
      box: '1',
      form: b.box1,
      books: total,
      rule: interestRule,
      sources: {
        ...noSources(),
        loanPaymentIds: books.payments.map((p) => p.loanPaymentId),
        transactionIds: books.payments.map((p) => p.transactionId),
      },
      explanations,
      accepted,
    });
    const atClosing =
      check.status === 'differs' && check.difference !== null ? closing(check.difference) : null;
    checks.push(atClosing ? { ...check, status: 'explained', explanation: atClosing } : check);
  }
  if (books.principal === null) {
    checks.push(notTracked('2', b.box2, 'The loan account has no balance in the books on that date'));
  } else {
    checks.push(
      compare({
        box: '2',
        form: b.box2,
        books: books.principal.amount,
        rule: `The loan account’s balance at the end of ${longDate(books.principal.date)}`,
        sources: { ...noSources(), journalEntryIds: [...books.principal.journalEntryIds] },
        accepted,
      }),
    );
  }
  checks.push(
    info(
      '10',
      b.box10,
      `${b.box10Label ? `${b.box10Label}: ` : ''}what escrow paid out; the property tax paid into escrow in the year beside it`,
      { amount: books.escrowTaxes.total, sources: sumSources(books.escrowTaxes) },
      'Escrow pays the county on its own schedule, and Montra books the tax as it’s paid into escrow',
    ),
  );
  if (b.box5 !== undefined || books.mortgageInsurance)
    checks.push(
      info(
        '5',
        b.box5,
        'Mortgage insurance premiums; any posted from the loan’s payments beside it',
        books.mortgageInsurance
          ? { amount: books.mortgageInsurance.total, sources: sumSources(books.mortgageInsurance) }
          : null,
      ),
    );
  if (b.box3 !== undefined || books.startDate)
    checks.push(
      info(
        '3',
        null,
        `Origination date: ${b.box3 ? longDate(b.box3 as CalendarDate) : 'not printed'}; the loan’s schedule starts ${books.startDate ? longDate(books.startDate) : 'on no date'}`,
      ),
    );
  if (b.box4 !== undefined) checks.push(info('4', b.box4, 'Refund of overpaid interest'));
  if (b.box6 !== undefined) checks.push(info('6', b.box6, 'Points paid on purchase of principal residence'));
  return checks;
}

// ----- A form's result (§5.6, §7.1) -----------------------------------------------------------------------------------

export type TaxCheckOutcome = 'matches' | 'differs' | 'accepted' | 'not_tracked' | 'check_reading';

/**
 * What a form's checks add up to: it differs when any `check` box does (and isn't accepted), by the largest difference;
 * a misread comes next; then not tracked when no `check` box could be checked; accepted when a difference was; else it
 * matches.
 */
export function checksOutcome(checks: readonly TaxFormCheck[]): {
  outcome: TaxCheckOutcome;
  difference: bigint | null;
} {
  const boxes = checks.filter((c) => c.kind === 'check');
  const differing = boxes.filter((c) => c.status === 'differs');
  if (differing.length) {
    const largest = differing.reduce((m, c) => (abs(c.difference!) > abs(m.difference!) ? c : m));
    return { outcome: 'differs', difference: largest.difference };
  }
  if (boxes.some((c) => c.status === 'check_reading')) return { outcome: 'check_reading', difference: null };
  if (boxes.length > 0 && boxes.every((c) => c.status === 'not_tracked'))
    return { outcome: 'not_tracked', difference: null };
  if (boxes.some((c) => c.status === 'accepted')) return { outcome: 'accepted', difference: null };
  return { outcome: 'matches', difference: null };
}

// ----- Expected forms (§7.1) --------------------------------------------------------------------------------------------

/** Plans whose accounts don't get a 1099-INT or 1099-DIV for what they earn inside the plan. */
export const RETIREMENT_PLAN_TYPES: ReadonlySet<string> = new Set([
  '401k',
  'roth_401k',
  '403b',
  'ira',
  'roth_ira',
  'hsa',
  '529',
  'pension',
]);

export interface ExpectedFromEmployer {
  id: string;
  name: string;
  memberId: string;
  entityId: string;
  /** `employer`, or another income source (which sends no W-2). */
  type: string;
  /** Posted payslips paid in the year. */
  payslips: number;
  earnings: bigint;
}

export interface ExpectedFromAccount {
  id: string;
  name: string;
  entityId: string;
  /** The account's default member, the person a form for it is most likely for. */
  personMemberId: string | null;
  planType: string | null;
  interest: bigint;
  dividends: bigint;
  /** Interest in the mortgage's payments in the year; null for an account that isn't a mortgage with a schedule. */
  mortgageInterest: bigint | null;
}

export interface ExpectedTaxForm {
  kind: TaxFormKind;
  employerId: string | null;
  accountId: string | null;
  personMemberId: string | null;
  entityId: string;
  name: string;
  /** The books' figure that makes it expected: pay, interest, dividends or mortgage interest. */
  amount: bigint;
}

/**
 * The forms a year should bring (§7.1), inferred, never stored: a W-2 per employer with payslips paid in the year; a
 * 1099-INT or 1099-DIV per account outside a retirement plan with at least the IRS's threshold ($10) of interest or
 * dividends; a 1098 per mortgage with at least $600 of interest.
 */
export function expectedTaxForms(
  year: number,
  employers: readonly ExpectedFromEmployer[],
  accounts: readonly ExpectedFromAccount[],
): ExpectedTaxForm[] {
  const out: ExpectedTaxForm[] = [];
  for (const e of employers) {
    if (e.type !== 'employer' || e.payslips === 0) continue;
    out.push({
      kind: 'w2',
      employerId: e.id,
      accountId: null,
      personMemberId: e.memberId,
      entityId: e.entityId,
      name: e.name,
      amount: e.earnings,
    });
  }
  const from = (kind: '1099_int' | '1099_div' | '1098', a: ExpectedFromAccount, amount: bigint) => {
    if (amount >= taxFormThreshold(kind, year).amount)
      out.push({
        kind,
        employerId: null,
        accountId: a.id,
        personMemberId: a.personMemberId,
        entityId: a.entityId,
        name: a.name,
        amount,
      });
  };
  for (const a of accounts) {
    if (a.mortgageInterest !== null) from('1098', a, a.mortgageInterest);
    if (a.planType && RETIREMENT_PLAN_TYPES.has(a.planType)) continue;
    from('1099_int', a, a.interest);
    from('1099_div', a, a.dividends);
  }
  return out;
}

/** A received form as the expected list sees it. */
export interface ReceivedTaxForm {
  id: string;
  kind: TaxFormKind;
  /** Superseded and dismissed forms don't count as received. */
  status: string;
  targets: readonly { employerId: string | null; accountId: string | null }[];
}

export interface TaxFormWaiverRef {
  id: string;
  kind: TaxFormKind;
  employerId: string | null;
  accountId: string | null;
}

export type ExpectedState = 'received' | 'waived' | 'missing';

/**
 * Expected against received (§7.1): each expected form is received (a form of its kind matched to its employer or
 * account), waived, or missing; received forms that match nothing expected are listed apart.
 */
export function expectedAgainstReceived(
  expected: readonly ExpectedTaxForm[],
  forms: readonly ReceivedTaxForm[],
  waivers: readonly TaxFormWaiverRef[],
): {
  expected: (ExpectedTaxForm & { state: ExpectedState; formId: string | null; waiverId: string | null })[];
  unexpectedFormIds: string[];
} {
  const live = forms.filter((f) => f.status !== 'superseded' && f.status !== 'dismissed');
  const used = new Set<string>();
  const rows = expected.map((e) => {
    const form = live.find(
      (f) =>
        f.kind === e.kind &&
        f.targets.some((t) => (e.employerId ? t.employerId === e.employerId : t.accountId === e.accountId)),
    );
    if (form) {
      used.add(form.id);
      return { ...e, state: 'received' as const, formId: form.id, waiverId: null };
    }
    const waiver = waivers.find(
      (w) =>
        w.kind === e.kind && (e.employerId ? w.employerId === e.employerId : w.accountId === e.accountId),
    );
    if (waiver) return { ...e, state: 'waived' as const, formId: null, waiverId: waiver.id };
    return { ...e, state: 'missing' as const, formId: null, waiverId: null };
  });
  return { expected: rows, unexpectedFormIds: live.filter((f) => !used.has(f.id)).map((f) => f.id) };
}
