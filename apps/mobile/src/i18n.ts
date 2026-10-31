/** Strings and formatting from @montra/i18n (TZ-06), and money via @montra/domain (NFR-09, CUR-10). */
import { catalogs, createTranslator, formatCalendarDate, type Values } from '@montra/i18n';
import { calendarDate, formatMoney, money } from '@montra/domain';

const locale = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
})();

const translator = createTranslator(locale, catalogs);

export const t = (key: string, values?: Values): string => translator.t(key, values);
export const currentLocale = locale;
/** Day-first locales read 03/04 as 3 April (import mapping default). */
export const prefersDayFirst = !/^en-(US|PH)|^en$/.test(locale);

export function fmtMoney(
  amountMinor: string | bigint | null | undefined,
  currency: string | null | undefined,
): string {
  if (amountMinor === null || amountMinor === undefined || !currency) return '';
  return formatMoney(money(BigInt(amountMinor), currency), { locale });
}

export function fmtDate(date: string): string {
  try {
    return formatCalendarDate(calendarDate(date), { locale, style: 'medium' });
  } catch {
    return date;
  }
}
