import { isoDayOfWeek, parts, type CalendarDate } from '@montra/domain';

/** User-selectable date formats (TZ-05); null means "locale default". */
export type DateFormat = 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'DD.MM.YYYY';

/**
 * Formats a calendar date without ever converting it through a time zone (TZ-02): the components are used
 * as-is, and Intl only supplies month names for the locale-default style.
 */
export function formatCalendarDate(
  date: CalendarDate,
  options: { format?: DateFormat | null; locale?: string; style?: 'short' | 'medium' | 'long' } = {},
): string {
  const { year, month, day } = parts(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (options.format) {
    case 'YYYY-MM-DD':
      return `${year}-${pad(month)}-${pad(day)}`;
    case 'MM/DD/YYYY':
      return `${pad(month)}/${pad(day)}/${year}`;
    case 'DD/MM/YYYY':
      return `${pad(day)}/${pad(month)}/${year}`;
    case 'DD.MM.YYYY':
      return `${pad(day)}.${pad(month)}.${year}`;
  }
  // Locale default: render the date at UTC noon so no time zone can move it to another day.
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  const style = options.style ?? 'medium';
  return new Intl.DateTimeFormat(options.locale ?? 'en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: style === 'short' ? '2-digit' : style === 'medium' ? 'short' : 'long',
    day: style === 'short' ? '2-digit' : 'numeric',
  }).format(instant);
}

/** Weekday name for a calendar date in the locale (TZ-05 week start is applied by callers). */
export function weekdayName(date: CalendarDate, locale = 'en-US', width: 'short' | 'long' = 'short'): string {
  const reference = new Date(Date.UTC(2024, 0, 1 + isoDayOfWeek(date), 12)); // 2024-01-01 was a Monday
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: width }).format(reference);
}
