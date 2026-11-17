/**
 * Tax forms the household receives (ADR-0052): the boxes kept per form kind, how they're stored and parsed, and the
 * yearly figures the checks need. Montra keeps the forms and checks them against the books; it doesn't calculate tax.
 *
 * Boxes are stored as one JSON document per form, where money is a string of integer minor units (`"8512034"`), since
 * JSON has no bigint. One Zod schema per kind describes them; `parseTaxFormBoxes` returns typed `bigint`s and refuses
 * anything else, unknown boxes included.
 */
import { z } from 'zod';

export const TAX_FORM_KINDS = ['w2', '1099_int', '1099_div', '1098'] as const;
export type TaxFormKind = (typeof TAX_FORM_KINDS)[number];

/** A box matches the books when they differ by at most $1.00 (ADR-0052 §5.1). */
export const TAX_FORM_TOLERANCE_MINOR = 100n;

/** Money in a form's JSON: whole minor units, never negative, up to 15 digits. */
export const TAX_FORM_MONEY_PATTERN = /^\d{1,15}$/;

/** W-2 box 12 codes, as printed (IRS General Instructions for Forms W-2 and W-3). */
export const W2_BOX12_CODES = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'V',
  'W',
  'Y',
  'Z',
  'AA',
  'BB',
  'DD',
  'EE',
  'FF',
  'GG',
  'HH',
  'II',
] as const;
export type W2Box12Code = (typeof W2_BOX12_CODES)[number];

const MoneyString = z.string().regex(TAX_FORM_MONEY_PATTERN, 'an amount in cents, as whole digits');
const MoneyBigint = MoneyString.transform((s) => BigInt(s));
const StateCode = z.string().regex(/^[A-Z]{2}$/, 'a two-letter state code');
const Label = (max: number) => z.string().trim().min(1).max(max);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');

/**
 * The schemas per kind, built once for the stored form (money as strings) and once for the parsed one (bigint), so the
 * two can't drift. Every money box is optional: a blank box on the form is left out. Objects are strict: a box that
 * isn't listed is refused, so a typo can't pass for a box.
 */
function boxSchemas<M extends z.ZodType>(money: M) {
  const box = money.optional();
  // Boxes 15–17 of a 1099-INT, 14–16 of a 1099-DIV: one row per state.
  const stateRow1099 = z.strictObject({
    state: StateCode,
    stateId: Label(30).optional(),
    stateTaxWithheld: box,
  });
  return {
    /** W-2 (§2). Not kept: d (control number), f (address), 9 (unused). */
    w2: z.strictObject({
      box1: box, // wages, tips, other compensation
      box2: box, // federal income tax withheld
      box3: box, // Social Security wages
      box4: box, // Social Security tax withheld
      box5: box, // Medicare wages and tips
      box6: box, // Medicare tax withheld
      box7: box, // Social Security tips
      box8: box, // allocated tips
      box10: box, // dependent care benefits
      box11: box, // nonqualified plans
      box12: z
        .array(z.strictObject({ code: z.enum(W2_BOX12_CODES), amount: money }))
        .max(4)
        .optional(),
      box13: z
        .strictObject({
          statutoryEmployee: z.boolean().optional(),
          retirementPlan: z.boolean().optional(),
          thirdPartySickPay: z.boolean().optional(),
        })
        .optional(),
      box14: z
        .array(z.strictObject({ label: Label(40), amount: money }))
        .max(8)
        .optional(),
      // Boxes 15–20: per state row.
      states: z
        .array(
          z.strictObject({
            state: StateCode,
            employerStateId: Label(30).optional(),
            box16: box, // state wages
            box17: box, // state income tax
            box18: box, // local wages
            box19: box, // local income tax
            box20: Label(40).optional(), // locality name
          }),
        )
        .max(4)
        .optional(),
    }),
    /** 1099-INT (§2). Not kept: the payer's RTN, box 14 (CUSIP), the FATCA box. */
    '1099_int': z.strictObject({
      box1: box, // interest income
      box2: box, // early withdrawal penalty
      box3: box, // interest on US savings bonds and Treasury obligations
      box4: box, // federal income tax withheld
      box5: box, // investment expenses
      box6: box, // foreign tax paid
      box7: Label(60).optional(), // foreign country or US possession
      box8: box, // tax-exempt interest
      box9: box, // specified private activity bond interest
      box10: box, // market discount
      box11: box, // bond premium
      box12: box, // bond premium on Treasury obligations
      box13: box, // bond premium on tax-exempt bonds
      states: z.array(stateRow1099).max(4).optional(),
    }),
    /** 1099-DIV (§2). Not kept: the FATCA box. */
    '1099_div': z.strictObject({
      box1a: box, // total ordinary dividends
      box1b: box, // qualified dividends
      box2a: box, // total capital gain distributions
      box2b: box, // unrecaptured section 1250 gain
      box2c: box, // section 1202 gain
      box2d: box, // collectibles (28%) gain
      box2e: box, // section 897 ordinary dividends
      box2f: box, // section 897 capital gain
      box3: box, // nondividend distributions
      box4: box, // federal income tax withheld
      box5: box, // section 199A dividends
      box6: box, // investment expenses
      box7: box, // foreign tax paid
      box8: Label(60).optional(), // foreign country or US possession
      box9: box, // cash liquidation distributions
      box10: box, // noncash liquidation distributions
      box12: box, // exempt-interest dividends
      box13: box, // specified private activity bond interest dividends
      states: z.array(stateRow1099).max(4).optional(),
    }),
    /** 1098 (§2). Not kept: box 8, the property's address. */
    '1098': z.strictObject({
      box1: box, // mortgage interest received from payer(s)/borrower(s)
      box2: box, // outstanding mortgage principal
      box3: IsoDate.optional(), // mortgage origination date
      box4: box, // refund of overpaid interest
      box5: box, // mortgage insurance premiums
      box6: box, // points paid on purchase of principal residence
      box7: z.boolean().optional(), // the property's address is the borrower's
      box9: z.number().int().min(0).max(99).optional(), // number of properties securing the mortgage
      box10: box, // other (usually property tax paid from escrow)
      box10Label: Label(60).optional(), // what box 10 says it is
      box11: IsoDate.optional(), // mortgage acquisition date
    }),
  };
}

/** The boxes as stored and sent: money as strings of minor units. */
export const TaxFormBoxesJsonSchemas = boxSchemas(MoneyString);
const ParsedSchemas = boxSchemas(MoneyBigint);

export type TaxFormBoxesJsonOf<K extends TaxFormKind> = z.input<(typeof TaxFormBoxesJsonSchemas)[K]>;
export type TaxFormBoxesOf<K extends TaxFormKind> = z.output<(typeof ParsedSchemas)[K]>;

export type W2FormBoxes = TaxFormBoxesOf<'w2'>;
export type Form1099IntBoxes = TaxFormBoxesOf<'1099_int'>;
export type Form1099DivBoxes = TaxFormBoxesOf<'1099_div'>;
export type Form1098Boxes = TaxFormBoxesOf<'1098'>;

/** A form's boxes with its kind: the discriminated union the checks work from. */
export type TaxFormBoxes =
  | { kind: 'w2'; boxes: W2FormBoxes }
  | { kind: '1099_int'; boxes: Form1099IntBoxes }
  | { kind: '1099_div'; boxes: Form1099DivBoxes }
  | { kind: '1098'; boxes: Form1098Boxes };

export class TaxFormBoxesError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'TaxFormBoxesError';
  }
}

export const isTaxFormKind = (v: unknown): v is TaxFormKind =>
  typeof v === 'string' && (TAX_FORM_KINDS as readonly string[]).includes(v);

/**
 * Checks a form's stored or submitted boxes against its kind's schema and returns them typed, money as `bigint`.
 * Throws `TaxFormBoxesError` naming the first box that's wrong.
 */
export function parseTaxFormBoxes(kind: TaxFormKind, json: unknown): TaxFormBoxes {
  if (!isTaxFormKind(kind)) throw new TaxFormBoxesError('kind', 'not a tax form kind');
  const result = ParsedSchemas[kind].safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = issue.path.map(String).join('.');
    throw new TaxFormBoxesError(path || 'boxes', issue.message);
  }
  return { kind, boxes: result.data } as TaxFormBoxes;
}

/** The JSON to store for parsed boxes: money back to strings of minor units, nothing else changed. */
export function taxFormBoxesJson(form: TaxFormBoxes): Record<string, unknown> {
  return toJson(form.boxes) as Record<string, unknown>;
}

function toJson(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(toJson);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, toJson(x)]),
    );
  }
  return v;
}

/** Stored boxes made canonical (leading zeros dropped, blank boxes left out). Throws as `parseTaxFormBoxes` does. */
export function normalizeTaxFormBoxes(kind: TaxFormKind, json: unknown): Record<string, unknown> {
  return taxFormBoxesJson(parseTaxFormBoxes(kind, json));
}

// ----- Identifiers (§8.1) ----------------------------------------------------------------------------------------------

/** An EIN as nine digits, from `12-3456789` or `123456789`; null for anything else. */
export function normalizeEin(text: string): string | null {
  const m = /^\s*(\d{2})-?(\d{7})\s*$/.exec(text);
  return m ? m[1]! + m[2]! : null;
}

// ----- Yearly figures (§5.2, §7.1) -------------------------------------------------------------------------------------

/**
 * The Social Security wage base (box 3's cap), by year, from the SSA's announcements. 2026's agrees with the payroll
 * tables (`payroll-tax-tables.ts`), which a test checks.
 */
const SS_WAGE_BASE: Readonly<Record<number, bigint>> = {
  2022: 14_700_000n,
  2023: 16_020_000n,
  2024: 16_860_000n,
  2025: 17_610_000n,
  2026: 18_450_000n,
};

/**
 * The IRS reporting thresholds that make a form expected (§7.1): a 1099-INT or 1099-DIV from $10, a 1098 from $600
 * of mortgage interest. Unchanged for years; kept by year because they could change, as the 1099-NEC's did.
 */
const EXPECTED_FROM: Readonly<Record<number, Readonly<Record<Exclude<TaxFormKind, 'w2'>, bigint>>>> = {
  2022: { '1099_int': 1_000n, '1099_div': 1_000n, '1098': 60_000n },
  2023: { '1099_int': 1_000n, '1099_div': 1_000n, '1098': 60_000n },
  2024: { '1099_int': 1_000n, '1099_div': 1_000n, '1098': 60_000n },
  2025: { '1099_int': 1_000n, '1099_div': 1_000n, '1098': 60_000n },
  2026: { '1099_int': 1_000n, '1099_div': 1_000n, '1098': 60_000n },
};

/** The figure for a year Montra knows, else the latest one before it (flagged as not known), else the earliest. */
function byYear<T>(table: Readonly<Record<number, T>>, year: number): { value: T; known: boolean } {
  if (table[year] !== undefined) return { value: table[year]!, known: true };
  const years = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  const before = years.filter((y) => y <= year);
  return { value: table[before.at(-1) ?? years[0]!]!, known: false };
}

/** The year's Social Security wage base in cents; `known: false` when the year isn't in the table yet. */
export function socialSecurityWageBase(year: number): { amount: bigint; known: boolean } {
  const { value, known } = byYear(SS_WAGE_BASE, year);
  return { amount: value, known };
}

/** The amount from which an issuer must send the form, in cents. A W-2 is expected whenever there was pay. */
export function taxFormThreshold(
  kind: Exclude<TaxFormKind, 'w2'>,
  year: number,
): { amount: bigint; known: boolean } {
  const { value, known } = byYear(EXPECTED_FROM, year);
  return { amount: value[kind], known };
}
