/**
 * Calendar dates without a time zone (TZ-02): "2026-10-29". A transaction dated on a statement must never
 * shift a day when viewed from another time zone, so business dates are plain strings, not Date objects.
 */

export type CalendarDate = string & { readonly __brand: 'CalendarDate' };

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): value is CalendarDate {
  const m = RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function calendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) throw new RangeError(`Invalid calendar date: "${value}"`);
  return value;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function parts(date: CalendarDate): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { year: y, month: m, day: d };
}

export function fromParts(year: number, month: number, day: number): CalendarDate {
  const s = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return calendarDate(s);
}

/** Days since 1970-01-01 (proleptic Gregorian), computed with integer math only. */
export function toEpochDay(date: CalendarDate): number {
  const { year, month, day } = parts(date);
  // Howard Hinnant's days_from_civil.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromEpochDay(epochDay: number): CalendarDate {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return fromParts(year, month, day);
}

export const addDays = (date: CalendarDate, days: number): CalendarDate =>
  fromEpochDay(toEpochDay(date) + days);
export const diffDays = (a: CalendarDate, b: CalendarDate): number => toEpochDay(a) - toEpochDay(b);
export const compareDates = (a: CalendarDate, b: CalendarDate): number => (a < b ? -1 : a > b ? 1 : 0);

/** Adds months, clamping the day to the target month's length (Jan 31 + 1 month → Feb 28/29). */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const { year, month, day } = parts(date);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return fromParts(y, m, Math.min(day, daysInMonth(y, m)));
}

export const startOfMonth = (date: CalendarDate): CalendarDate => {
  const { year, month } = parts(date);
  return fromParts(year, month, 1);
};

export const endOfMonth = (date: CalendarDate): CalendarDate => {
  const { year, month } = parts(date);
  return fromParts(year, month, daysInMonth(year, month));
};

/** 0 = Monday … 6 = Sunday (ISO). */
export const isoDayOfWeek = (date: CalendarDate): number => (((toEpochDay(date) + 3) % 7) + 7) % 7;

/** Today's calendar date in an IANA time zone (TZ-01): period boundaries use the workspace time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): CalendarDate {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return calendarDate(fmt.format(now));
}
