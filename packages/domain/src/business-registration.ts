/**
 * A business's legal and tax setup (BIZ-21..26; ADR-0037): which federal return its entity type files, how its owners
 * are paid, its fiscal year, and when a registration needs renewing. Pure; dates are `CalendarDate` strings.
 */
import { addDays, addMonths, type CalendarDate } from './calendar-date.js';

/**
 * Entity types. An LLC's tax treatment is part of its type (ADR-0037 §1). `llc` (members unknown) and `other` are
 * from before the owner could choose; they stay valid so a business keeps its type until the owner picks one.
 */
export const BUSINESS_TYPES = [
  'sole_prop',
  'single_member_llc',
  'single_member_llc_s_corp',
  'multi_member_llc',
  'multi_member_llc_s_corp',
  'partnership',
  's_corp',
  'c_corp',
] as const;
export const LEGACY_BUSINESS_TYPES = ['llc', 'other'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number] | (typeof LEGACY_BUSINESS_TYPES)[number];

/** How the IRS taxes the business. */
export type TaxTreatment = 'sole_prop' | 'partnership' | 's_corp' | 'c_corp';

/** The federal income tax return it files. */
export type ReturnForm = 'schedule_c' | 'form_1065' | 'form_1120s' | 'form_1120';

/** How an owner who works in the business is paid. */
export type OwnerPay = 'draws' | 'guaranteed_payments' | 'reasonable_salary' | 'salary';

const TREATMENT: Record<string, TaxTreatment> = {
  sole_prop: 'sole_prop',
  single_member_llc: 'sole_prop',
  single_member_llc_s_corp: 's_corp',
  multi_member_llc: 'partnership',
  multi_member_llc_s_corp: 's_corp',
  partnership: 'partnership',
  s_corp: 's_corp',
  c_corp: 'c_corp',
};

const FORM: Record<TaxTreatment, ReturnForm> = {
  sole_prop: 'schedule_c',
  partnership: 'form_1065',
  s_corp: 'form_1120s',
  c_corp: 'form_1120',
};

const PAY: Record<TaxTreatment, OwnerPay> = {
  sole_prop: 'draws',
  partnership: 'guaranteed_payments',
  s_corp: 'reasonable_salary',
  c_corp: 'salary',
};

/** Null when the type isn't known, or is a legacy one that doesn't say. */
export const taxTreatmentOf = (type: string | null | undefined): TaxTreatment | null =>
  (type && TREATMENT[type]) || null;

/** The return the business files, or null when its type doesn't say (then Montra assumes Schedule C, as before). */
export const returnFormOf = (type: string | null | undefined): ReturnForm | null => {
  const t = taxTreatmentOf(type);
  return t ? FORM[t] : null;
};

/** Schedule C is the business's own return only for a sole proprietor or a single-member LLC taxed as one. */
export const filesScheduleC = (type: string | null | undefined): boolean => {
  const f = returnFormOf(type);
  return f === null || f === 'schedule_c';
};

/** How an owner is paid for their work, or null when the type isn't known. */
export const ownerPayOf = (type: string | null | undefined): OwnerPay | null => {
  const t = taxTreatmentOf(type);
  return t ? PAY[t] : null;
};

/** The types that elect S-corp treatment on Form 2553, so an election date applies. */
export const electsSCorp = (type: string | null | undefined): boolean => taxTreatmentOf(type) === 's_corp';

/**
 * What to tell the owner when they add themselves to payroll as an employee (BIZ-25). A sole proprietor (or a
 * single-member LLC taxed as one) can't be their own W-2 employee; a partner isn't one either and takes guaranteed
 * payments; an S-corp owner who works in the business must be paid a reasonable salary through payroll. A C-corp's
 * owner-employee is an ordinary employee. Null: nothing to say.
 */
export type OwnerEmployeeNote = 'not_an_employee_draws' | 'not_an_employee_partner' | 'reasonable_salary';
export function ownerEmployeeNote(type: string | null | undefined): OwnerEmployeeNote | null {
  switch (ownerPayOf(type)) {
    case 'draws':
      return 'not_an_employee_draws';
    case 'guaranteed_payments':
      return 'not_an_employee_partner';
    case 'reasonable_salary':
      return 'reasonable_salary';
    default:
      return null;
  }
}

// ----- Fiscal year (BIZ-21) -----------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The fiscal year named `year` runs from the first of `startMonth` in `year` to the day before that month a year
 * later; with January it's the calendar year. Named by the year it begins in, as on Forms 1065, 1120-S and 1120
 * ("tax year beginning …").
 */
export function fiscalYearRange(year: number, startMonth: number): { from: CalendarDate; to: CalendarDate } {
  const from = `${year}-${pad(startMonth)}-01` as CalendarDate;
  return { from, to: addDays(addMonths(from, 12), -1) };
}

/** The fiscal year a date falls in, by the year it began. */
export function fiscalYearOf(date: CalendarDate, startMonth: number): number {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= startMonth ? year : year - 1;
}

// ----- Renewals (BIZ-24) ----------------------------------------------------------------------------------------

/** A "renew by" reminder goes out this many days before a registration expires. */
export const RENEW_REMINDER_DAYS = 30;

/** True once a registration expiring on `expiresOn` is within the reminder window (or past it). */
export const renewalDue = (expiresOn: CalendarDate, today: CalendarDate): boolean =>
  addDays(expiresOn, -RENEW_REMINDER_DAYS) <= today;

/** "••-•••6789" for an EIN, "••••5678" for anything else: only the last four show. */
export function maskId(value: string | null | undefined, kind: 'ein' | 'other' = 'other'): string | null {
  if (!value) return null;
  const last4 = value.slice(-4);
  return kind === 'ein' ? `••-•••${last4}` : `${'•'.repeat(Math.max(value.length - 4, 2))}${last4}`;
}
