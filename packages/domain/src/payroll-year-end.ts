/**
 * Year-end payroll forms (PRL-17..20; ADR-0034 §7b): the Form W-2 boxes from a year's paychecks, the 1099-NEC
 * threshold, and SSA's EFW2 wage file (Publication 42-007). Pure, so the file layout is tested byte by byte.
 */
import { fromParts, type CalendarDate } from './calendar-date.js';
import { nextBankingDay } from './payroll-deposits.js';

/** W-2s and 1099-NECs go to people and to SSA and the IRS by January 31, or the next banking day. */
export const yearEndDue = (year: number): CalendarDate => nextBankingDay(fromParts(year + 1, 1, 31));

/** The yearly 1099-NEC filing threshold: $600 through 2025, $2,000 for payments from 2026 (indexed from 2027). */
const NEC_THRESHOLD: Readonly<Record<number, bigint>> = { 2025: 60_000n, 2026: 200_000n };

/** The threshold for a year Montra knows, else the latest one it does (a later year is indexed upward, so this errs low). */
export function necThreshold(year: number): { amount: bigint; known: boolean } {
  if (NEC_THRESHOLD[year] !== undefined) return { amount: NEC_THRESHOLD[year]!, known: true };
  const years = Object.keys(NEC_THRESHOLD)
    .map(Number)
    .filter((y) => y <= year)
    .sort((a, b) => b - a);
  return { amount: NEC_THRESHOLD[years[0] ?? 2025]!, known: false };
}

/** What a W-2 reports, in cents. Box numbers as on the form. */
export interface W2Boxes {
  box1: bigint;
  box2: bigint;
  box3: bigint;
  box4: bigint;
  box5: bigint;
  box6: bigint;
  /** Box 12 code D: elective deferrals to a 401(k). */
  box12D: bigint;
  /** Box 13: retirement plan. */
  retirementPlan: boolean;
  /** Box 14: California SDI withheld, labelled CASDI. */
  caSdi: bigint;
  /** Boxes 16 and 17 for California, when the employee worked there. */
  caWages: bigint;
  caTax: bigint;
}

export interface Efw2Address {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface Efw2Input {
  year: number;
  submitter: {
    ein: string;
    /** BSO User ID: 8 characters. */
    userId: string;
    name: string;
    address: Efw2Address;
    contactName: string;
    contactPhone: string;
    contactEmail: string;
  };
  employer: { ein: string; name: string; address: Efw2Address };
  employees: {
    ssn: string;
    first: string;
    middle?: string | null;
    last: string;
    address: Efw2Address | null;
    boxes: W2Boxes;
  }[];
}

export interface Efw2Problem {
  /** Who it's about: 'submitter', 'employer' or the employee's index. */
  where: 'submitter' | 'employer' | number;
  message: string;
}

const RECORD = 512;

/** Upper-case, ASCII letters, digits and the punctuation SSA allows, left-justified and blank-filled. */
function alpha(s: string | null | undefined, length: number, keepCase = false): string {
  const clean = (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 &'\-.,#/@_+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (keepCase ? clean : clean.toUpperCase()).slice(0, length).padEnd(length, ' ');
}

/** Cents, right-justified and zero-filled; never negative. */
function money(n: bigint, length: number): string {
  const v = n < 0n ? 0n : n;
  const s = v.toString();
  if (s.length > length) throw new RangeError(`An amount is too large for EFW2: ${s}`);
  return s.padStart(length, '0');
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const blank = (n: number) => ' '.repeat(n);

/** Builds a record from [position, text] pairs (1-based positions, as the specification gives them). */
function record(fields: readonly (readonly [number, string])[]): string {
  const out = Array.from({ length: RECORD }, () => ' ');
  for (const [pos, text] of fields) {
    for (let i = 0; i < text.length; i++) out[pos - 1 + i] = text[i]!;
  }
  const r = out.join('');
  if (r.length !== RECORD) throw new Error('EFW2 record is not 512 bytes');
  return r;
}

function zip(a: Efw2Address | null | undefined): { zip: string; ext: string } {
  const z = digits(a?.zip);
  return { zip: z.slice(0, 5).padEnd(5, ' '), ext: z.length >= 9 ? z.slice(5, 9) : blank(4) };
}

/** What would make SSA reject the file, checked before it's written. */
export function efw2Problems(input: Efw2Input): Efw2Problem[] {
  const out: Efw2Problem[] = [];
  const ein = (v: string) =>
    /^\d{9}$/.test(digits(v)) && !/^(07|08|09|17|18|19|28|29|49|69|70|78|79|89)/.test(digits(v));
  if (!ein(input.submitter.ein))
    out.push({ where: 'submitter', message: 'The EIN must be nine digits and a valid prefix.' });
  if (!/^[A-Za-z0-9]{8}$/.test(input.submitter.userId)) {
    out.push({ where: 'submitter', message: 'The BSO User ID is eight letters or digits.' });
  }
  if (
    !input.submitter.contactName.trim() ||
    !digits(input.submitter.contactPhone) ||
    !input.submitter.contactEmail.includes('@')
  ) {
    out.push({ where: 'submitter', message: 'A contact name, phone and email are required.' });
  }
  if (
    !input.employer.address.line1.trim() ||
    !input.employer.address.city.trim() ||
    !/^[A-Z]{2}$/.test(input.employer.address.state) ||
    digits(input.employer.address.zip).length < 5
  ) {
    out.push({ where: 'employer', message: 'The employer’s street, city, state and ZIP code are required.' });
  }
  input.employees.forEach((e, i) => {
    const ssn = digits(e.ssn);
    if (!/^\d{9}$/.test(ssn)) out.push({ where: i, message: 'The SSN must be nine digits.' });
    else if (ssn.startsWith('9') || ssn.startsWith('666') || ssn.startsWith('000')) {
      out.push({
        where: i,
        message:
          'SSA doesn’t accept this SSN on a W-2: it starts with 9, 666 or 000 (an ITIN can’t be used).',
      });
    }
    if (!e.first.trim() || !e.last.trim())
      out.push({ where: i, message: 'The first and last name are required.' });
  });
  return out;
}

/** The EFW2 file: RA, RE, an RW per employee, RT and RF, each 512 bytes and ending CR LF. */
export function efw2File(input: Efw2Input): string {
  const s = input.submitter;
  const sz = zip(s.address);
  const ra = record([
    [1, 'RA'],
    [3, digits(s.ein)],
    [12, alpha(s.userId, 8)],
    [29, '0'],
    [36, '98'], // in-house program
    [38, alpha(s.name, 57)],
    [95, alpha(s.address.line2, 22)],
    [117, alpha(s.address.line1, 22)],
    [139, alpha(s.address.city, 22)],
    [161, alpha(s.address.state, 2)],
    [163, sz.zip],
    [168, sz.ext],
    [217, alpha(s.name, 57)],
    [274, alpha(s.address.line2, 22)],
    [296, alpha(s.address.line1, 22)],
    [318, alpha(s.address.city, 22)],
    [340, alpha(s.address.state, 2)],
    [342, sz.zip],
    [347, sz.ext],
    [396, alpha(s.contactName, 27)],
    [423, alpha(digits(s.contactPhone), 15)],
    [446, alpha(s.contactEmail, 40, true)],
    [500, 'L'], // self-prepared
  ]);
  const er = input.employer;
  const ez = zip(er.address);
  const re = record([
    [1, 'RE'],
    [3, String(input.year)],
    [8, digits(er.ein)],
    [26, '0'],
    [40, alpha(er.name, 57)],
    [97, alpha(er.address.line2, 22)],
    [119, alpha(er.address.line1, 22)],
    [141, alpha(er.address.city, 22)],
    [163, alpha(er.address.state, 2)],
    [165, ez.zip],
    [170, ez.ext],
    [174, 'N'], // none of the special kinds of employer apply
    [219, 'R'], // regular, Form 941
    [221, '0'],
    [222, alpha(s.contactName, 27)],
    [249, alpha(digits(s.contactPhone), 15)],
    [279, alpha(s.contactEmail, 40, true)],
  ]);
  const totals = { wages: 0n, fit: 0n, ssWages: 0n, ss: 0n, medWages: 0n, med: 0n, d: 0n };
  const rws = input.employees.map((e) => {
    const b = e.boxes;
    totals.wages += b.box1;
    totals.fit += b.box2;
    totals.ssWages += b.box3;
    totals.ss += b.box4;
    totals.medWages += b.box5;
    totals.med += b.box6;
    totals.d += b.box12D;
    const z = zip(e.address);
    return record([
      [1, 'RW'],
      [3, digits(e.ssn).padEnd(9, '0')],
      [12, alpha(e.first, 15)],
      [27, alpha(e.middle, 15)],
      [42, alpha(e.last, 20)],
      [66, alpha(e.address?.line2, 22)],
      [88, alpha(e.address?.line1, 22)],
      [110, alpha(e.address?.city, 22)],
      [132, alpha(e.address?.state, 2)],
      [134, z.zip],
      [139, z.ext],
      [188, money(b.box1, 11)],
      [199, money(b.box2, 11)],
      [210, money(b.box3, 11)],
      [221, money(b.box4, 11)],
      [232, money(b.box5, 11)],
      [243, money(b.box6, 11)],
      [254, money(0n, 11)],
      [276, money(0n, 11)],
      [287, money(b.box12D, 11)],
      ...[298, 309, 320, 331, 353, 364, 375, 386, 408, 419, 430, 441, 452, 463, 474].map(
        (p) => [p, money(0n, 11)] as const,
      ),
      [486, '0'],
      [488, b.retirementPlan ? '1' : '0'],
      [489, '0'],
    ]);
  });
  const rt = record([
    [1, 'RT'],
    [3, String(rws.length).padStart(7, '0')],
    [10, money(totals.wages, 15)],
    [25, money(totals.fit, 15)],
    [40, money(totals.ssWages, 15)],
    [55, money(totals.ss, 15)],
    [70, money(totals.medWages, 15)],
    [85, money(totals.med, 15)],
    [100, money(0n, 15)],
    [130, money(0n, 15)],
    [145, money(totals.d, 15)],
    ...[160, 175, 190, 205, 235, 250, 265, 280, 295, 310, 325, 340, 355, 370, 385, 400].map(
      (p) => [p, money(0n, 15)] as const,
    ),
  ]);
  const rf = record([
    [1, 'RF'],
    [8, String(rws.length).padStart(9, '0')],
  ]);
  return [ra, re, ...rws, rt, rf].map((r) => `${r}\r\n`).join('');
}
