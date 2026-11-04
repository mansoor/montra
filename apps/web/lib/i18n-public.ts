import 'server-only';
import { catalogs, createTranslator } from '@montra/i18n';
import { makeFormatters } from './format';

/** For pages that open without a session, such as a link from an email, where there's no profile to read the language from. */
export function getPublicI18n() {
  const locale = 'en';
  const translator = createTranslator(locale, catalogs);
  return { t: translator.t, ...makeFormatters(locale, null) };
}
