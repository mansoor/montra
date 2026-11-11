/**
 * Payroll helpers for the web (PRL-01..05, ADR-0034): what's left to do for each person, and form choices. Pure, so
 * they're unit-tested.
 */
import type { PayrollPersonDto } from '@montra/api-client';

export type OnboardingStep = 'details' | 'w4' | 'i9_section1' | 'i9_section2' | 'w9';

/** What an employee or contractor still needs, in the order it's usually done. */
export function missingSteps(p: PayrollPersonDto): OnboardingStep[] {
  // A contractor's W-9 carries their name, address and TIN, so it covers the details too.
  if (p.kind === 'contractor') return p.onboarding.w9 ? [] : ['w9'];
  const out: OnboardingStep[] = [];
  if (!p.tinMasked || !p.address.line1) out.push('details');
  if (!p.onboarding.w4) out.push('w4');
  if (!p.onboarding.i9?.section1) out.push('i9_section1');
  if (!p.onboarding.i9?.section2) out.push('i9_section2');
  return out;
}

/** Section 2 is late when its due date has passed without it. */
export const i9Overdue = (p: PayrollPersonDto, today: string): boolean =>
  p.kind === 'employee' &&
  !p.onboarding.i9?.section2 &&
  !!p.onboarding.i9?.section2Due &&
  p.onboarding.i9.section2Due < today;

/** The documents people most often show, by list (Form I-9 Lists of Acceptable Documents). */
export const I9_DOCUMENTS: Record<'A' | 'B' | 'C', string[]> = {
  A: [
    'U.S. Passport',
    'U.S. Passport Card',
    'Permanent Resident Card (Form I-551)',
    'Employment Authorization Document (Form I-766)',
    'Foreign passport with Form I-94',
  ],
  B: [
    'Driver’s license',
    'State ID card',
    'School ID card with a photograph',
    'Voter’s registration card',
    'U.S. Military card or draft record',
  ],
  C: [
    'Social Security card (unrestricted)',
    'Birth certificate',
    'Certification of report of birth (Form DS-1350, FS-545 or FS-240)',
    'U.S. Citizen ID card (Form I-197)',
    'Employment authorization document issued by DHS',
  ],
};

/** "Avery Testperson" → "AT", for an avatar. */
export const initials = (p: Pick<PayrollPersonDto, 'firstName' | 'lastName'>): string =>
  `${p.firstName.charAt(0)}${p.lastName.charAt(0)}`.toUpperCase();

/** Digits only, for a tax ID or bank number typed with dashes or spaces. */
export const digitsOnly = (s: string): string => s.replace(/[^\d]/g, '');

/** What can be typed into a tax ID field: "900-12-3456" while typing an SSN, "98-7654321" for an EIN. */
export function formatTinInput(type: 'ssn' | 'itin' | 'ein', text: string): string {
  const d = digitsOnly(text).slice(0, 9);
  if (type === 'ein') return d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d;
  if (d.length > 5) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  if (d.length > 3) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return d;
}

// ----- Pay runs (PRL-07) ---------------------------------------------------------------------------------------------

/** The order a paycheck reads in. */
export const PAYCHECK_SECTIONS = [
  'earning',
  'pre_tax_deduction',
  'employee_tax',
  'post_tax_deduction',
  'reimbursement',
  'employer_tax',
] as const;

/** What can be typed in on a draft paycheck (reimbursements come from approved requests). */
export type EditableKind =
  'earning' | 'pre_tax_deduction' | 'employee_tax' | 'post_tax_deduction' | 'employer_tax';

/** "37500" thousandths of an hour → "37.5". */
export function hoursText(milli: string): string {
  const n = BigInt(milli);
  const whole = n / 1000n;
  const frac = (n % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "37.5" → "37500"; undefined when it isn't a number of hours with at most three decimals. */
export function parseHours(text: string): string | undefined {
  const m = text.trim().match(/^(\d{1,6})(?:[.,](\d{1,3}))?$/);
  if (!m) return undefined;
  return String(BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0') || '0'));
}
