import 'server-only';
import { cache } from 'react';
import { catalogs, createTranslator } from '@montra/i18n';
import { makeFormatters } from './format';
import { load } from './server-api';

/** The signed-in user's translator and formatters for server components, loaded once per request. */
export const getI18n = cache(async () => {
  const me = await load((api) => api.getMe());
  const translator = createTranslator(me.locale, catalogs);
  return { me, t: translator.t, ...makeFormatters(me.locale, me.dateFormat) };
});
