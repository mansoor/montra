/**
 * Payroll onboarding rules that don't need the database (PRL-04, PRL-05; ADR-0032). Pure, so clients and tests share them.
 */
import { addDays, addMonths, isoDayOfWeek, type CalendarDate } from './calendar-date.js';

export type TaxIdType = 'ssn' | 'itin' | 'ein';

/** "•••-••-1234" for an SSN or ITIN, "••-•••1234" for an EIN; null when there's nothing to show. */
export function maskTin(type: TaxIdType | null, last4: string | null): string | null {
  if (!last4) return null;
  return type === 'ein' ? `••-•••${last4}` : `•••-••-${last4}`;
}

/** "•••• 6789": the end of an account or document number. */
export const maskTail = (last4: string | null): string | null => (last4 ? `•••• ${last4}` : null);

/** The last four characters kept in the clear for a masked display. */
export const lastFour = (value: string): string => value.slice(-4);

/**
 * How long an I-9 and its copies must be kept: the later of 3 years after the hire date and 1 year after employment
 * ends. While someone is still employed there is no date yet, because it depends on when they leave.
 */
export function i9RetainUntil(
  hireDate: CalendarDate | null,
  endDate: CalendarDate | null,
): CalendarDate | null {
  if (!endDate) return null;
  const afterEnd = addMonths(endDate, 12);
  if (!hireDate) return afterEnd;
  const afterHire = addMonths(hireDate, 36);
  return afterHire > afterEnd ? afterHire : afterEnd;
}

/** True once the retention date has passed. */
export const i9MayDestroy = (retainUntil: CalendarDate | null, today: CalendarDate): boolean =>
  retainUntil !== null && today > retainUntil;

/**
 * Section 2 is due within 3 business days of the first day of work: started Monday, due Thursday. Weekends are skipped;
 * federal holidays are not, so the date shown is never later than the real one.
 */
export function i9Section2Due(firstDay: CalendarDate): CalendarDate {
  let d = firstDay;
  let left = 3;
  while (left > 0) {
    d = addDays(d, 1);
    if (isoDayOfWeek(d) < 5) left--;
  }
  return d;
}

/** Employed on a day: hired on or before it and not yet ended. */
export function employmentStatus(
  hireDate: CalendarDate | null,
  endDate: CalendarDate | null,
  today: CalendarDate,
): 'active' | 'starting' | 'ended' {
  if (endDate && endDate < today) return 'ended';
  if (hireDate && hireDate > today) return 'starting';
  return 'active';
}
