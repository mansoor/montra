import { catalogs, createTranslator } from '@montra/i18n';

/** English translator for screens shown before we know the user's locale (sign-in, errors). */
export const staticT = createTranslator('en-US', catalogs).t;
