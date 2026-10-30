/**
 * Data minimization (AIA-03, 06 §4). Runs before every provider call:
 * - masks digit runs of 4+ (card and account numbers become "••••"), but keeps dates and decimal amounts;
 * - masks emails, phone numbers and street numbers;
 * - replaces family-member and tenant names with stable pseudonyms (MEMBER_1, TENANT_3), mapped back on
 *   the way in.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// 4111 1111 1111 1111, 3714-496353-98431 (masked before phone matching, which would also catch them)
const CARD = /\b\d{4}(?:[ -]\d{4,6}){2,3}\b/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// +1 (555) 123-4567, 555-123-4567, 555.123.4567, +44 20 7946 0958
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\b\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b(?![.,]\d)/g;
const STREET_SUFFIX =
  'St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle';
const STREET = new RegExp(
  `\\b\\d{1,6}[A-Z]?(\\s+(?:[NSEW]\\.?\\s+)?[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)?\\s+(?:${STREET_SUFFIX})\\b)`,
  'gi',
);

/**
 * Protected first (kept as-is): ISO and slashed dates, and amounts with a decimal part ("1,234.56", "12,50").
 * Then any remaining run of 4+ digits is masked.
 */
const DIGITS = new RegExp(
  [
    '(\\b\\d{4}-\\d{2}-\\d{2}\\b)', // 2026-10-30
    '(\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b)', // 10/30/2026, 30.10.26
    '(\\b\\d{1,3}(?:[,.\\s]\\d{3})*[.,]\\d{1,2}\\b)', // 1,234.56 · 1.234,56 · 12.50
    '(\\d{4,})', // to mask
  ].join('|'),
  'g',
);

export const MASK = '••••';

export interface MaskOptions {
  /** Keep all digits (quick add, where "1200 rent" is the amount). Emails, phones and streets are still masked. */
  keepDigits?: boolean;
}

export function maskText(text: string, opts: MaskOptions = {}): string {
  let s = text.replace(EMAIL, '[email]');
  if (!opts.keepDigits) s = s.replace(CARD, (m) => m.replace(/\d+/g, MASK));
  s = s.replace(PHONE, (m) => (/\d{3}/.test(m) ? '[phone]' : m));
  s = s.replace(STREET, (_m, rest: string) => `#${rest}`);
  if (!opts.keepDigits) {
    s = s.replace(DIGITS, (m, iso, slashed, amount, run) => (run ? MASK : (iso ?? slashed ?? amount ?? m)));
  }
  return s;
}

export interface Pseudonym {
  name: string;
  token: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces each name (whole word, case-insensitive) with its token; longer names first. */
export function pseudonymize(text: string, pseudonyms: readonly Pseudonym[] | undefined): string {
  if (!pseudonyms?.length) return text;
  let s = text;
  const sorted = [...pseudonyms].filter((p) => p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    s = s.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(p.name.trim())}(?![\\p{L}\\p{N}])`, 'giu'),
      p.token,
    );
  }
  return s;
}

/** Maps tokens back to names in model output. */
export function unpseudonymize(text: string, pseudonyms: readonly Pseudonym[] | undefined): string {
  if (!pseudonyms?.length) return text;
  let s = text;
  for (const p of [...pseudonyms].sort((a, b) => b.token.length - a.token.length)) {
    s = s.split(p.token).join(p.name);
  }
  return s;
}

/** Full text minimization: masking, then pseudonyms. */
export function minimizeText(
  text: string,
  pseudonyms?: readonly Pseudonym[],
  opts: MaskOptions = {},
): string {
  return pseudonymize(maskText(text, opts), pseudonyms);
}

/** A date reduced to month and weekday ("2026-10", "Fri"). */
export function minimizeDate(isoDate: string): { month: string; weekday: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return { month: '', weekday: '' };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return { month: `${m[1]}-${m[2]}`, weekday: WEEKDAYS[d.getUTCDay()]! };
}
