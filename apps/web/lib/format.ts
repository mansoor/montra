/**
 * Locale-aware formatters shared by server and client components (CUR-10, TZ-05): dates use the user's
 * chosen format (or the locale default), money uses the user's locale. Dates never pass through a time zone.
 */
import { asCurrencyCode, isCalendarDate, type CalendarDate } from '@montra/domain';
import { formatCalendarDate, formatMoney, type DateFormat } from '@montra/i18n';

export interface Formatters {
  locale: string;
  dateFormat: DateFormat | null;
  date(value: string): string;
  money(amount: bigint | string, currency: string, options?: { accounting?: boolean }): string;
}

export function makeFormatters(locale = 'en-US', dateFormat: string | null = null): Formatters {
  const format = (isDateFormat(dateFormat) ? dateFormat : null) as DateFormat | null;
  return {
    locale,
    dateFormat: format,
    date: (value) =>
      isCalendarDate(value) ? formatCalendarDate(value as CalendarDate, { format, locale }) : value,
    money: (amount, currency, options = {}) =>
      formatMoney(
        { amount: typeof amount === 'string' ? BigInt(amount) : amount, currency: asCurrencyCode(currency) },
        { locale, style: options.accounting ? 'accounting' : 'standard' },
      ),
  };
}

const DATE_FORMATS = new Set(['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY']);
const isDateFormat = (f: string | null): f is DateFormat => f !== null && DATE_FORMATS.has(f);
