/**
 * A small ICU-style message formatter (TZ-06): `{name}` placeholders and
 * `{count, plural, =0 {none} one {# item} other {# items}}` using Intl.PluralRules. All interface text lives
 * in catalogs keyed by stable ids; English ships first, other locales fall back to it key by key.
 */

export type Catalog = Record<string, string>;
export type Values = Record<string, string | number | bigint>;

export interface Translator {
  readonly locale: string;
  t(key: string, values?: Values): string;
  has(key: string): boolean;
}

export function createTranslator(
  locale: string,
  catalogs: Record<string, Catalog>,
  fallback = 'en',
): Translator {
  const chain = [locale, locale.split('-')[0]!, fallback].filter((l, i, a) => a.indexOf(l) === i);
  const plural = new Intl.PluralRules(locale);
  const lookup = (key: string) => {
    for (const l of chain) {
      const m = catalogs[l]?.[key];
      if (m !== undefined) return m;
    }
    return undefined;
  };
  return {
    locale,
    has: (key) => lookup(key) !== undefined,
    t(key, values = {}) {
      const message = lookup(key);
      if (message === undefined) return key; // visible but harmless; a lint test catches missing keys
      return format(message, values, plural, locale);
    },
  };
}

function format(message: string, values: Values, plural: Intl.PluralRules, locale: string): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    const ch = message[i]!;
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    const end = matchingBrace(message, i);
    const body = message.slice(i + 1, end);
    out += renderArgument(body, values, plural, locale);
    i = end + 1;
  }
  return out;
}

function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j;
  }
  throw new SyntaxError(`Unbalanced braces in message: ${s}`);
}

function renderArgument(body: string, values: Values, plural: Intl.PluralRules, locale: string): string {
  const [name = '', kind, ...rest] = splitTopLevel(body);
  const value = values[name.trim()];
  if (kind === undefined) return value === undefined ? `{${name}}` : String(value);
  if (kind.trim() !== 'plural') throw new SyntaxError(`Unsupported argument type: ${kind}`);
  const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  const options = parseOptions(rest.join(','));
  const chosen = options.get(`=${n}`) ?? options.get(plural.select(n)) ?? options.get('other') ?? '';
  return format(chosen, values, plural, locale).replace(/#/g, new Intl.NumberFormat(locale).format(n));
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0 && parts.length < 2) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function parseOptions(s: string): Map<string, string> {
  const options = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const start = i;
    while (i < s.length && s[i] !== '{' && !/\s/.test(s[i]!)) i++;
    const selector = s.slice(start, i);
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] !== '{') break;
    const end = matchingBrace(s, i);
    options.set(selector, s.slice(i + 1, end));
    i = end + 1;
  }
  return options;
}
