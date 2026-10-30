import en from '../messages/en.json' with { type: 'json' };
import type { Catalog } from './messages.js';

export * from './messages.js';
export * from './dates.js';
export { formatMoney } from '@montra/domain';

/** Catalogs shipped with the app. English first (TZ-06); add locales as `messages/<locale>.json`. */
export const catalogs: Record<string, Catalog> = { en };
