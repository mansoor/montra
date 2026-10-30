/**
 * Payee normalization (IMP-10, design 04 §4): "SQ *BLUE BOTTLE 0423 SF" → key "BLUE BOTTLE", display
 * "Blue Bottle". The raw text is always kept on the transaction; this only drives matching and display.
 */

const PROCESSOR_PREFIXES = [
  /^(SQ|SQU|SQUARE)\s*\*\s*/,
  /^TST\s*\*\s*/,
  /^PAYPAL\s*\*\s*/,
  /^PP\s*\*\s*/,
  /^SP\s*\*\s*/,
  /^(POS|DEBIT CARD|CHECK CARD|VISA|MC|MASTERCARD) (PURCHASE|DEBIT)?\s*-?\s*/,
  /^(DEBIT CARD PURCHASE|PURCHASE AUTHORIZED ON \d{2}\/\d{2})\s*/,
  /^(ACH|ACH DEBIT|ACH CREDIT|ELECTRONIC|ONLINE|RECURRING|PREAUTHORIZED) (PAYMENT|DEBIT|CREDIT|TRANSFER|PMT)?\s*-?\s*/,
  /^GOOGLE\s*\*\s*/,
  /^(LASTSCHRIFT|KARTENZAHLUNG|GUTSCHRIFT|ÜBERWEISUNG|UEBERWEISUNG|DAUERAUFTRAG)\s*/,
];

/** Processor strings that stand for a merchant: replaced by its name, not removed. */
const SYNONYMS: [RegExp, string][] = [
  [/^(AMZN MKTP( US)?|AMAZON MKTPLACE( PMTS)?|AMAZON\.COM|AMZN\.COM\/BILL)\b\S*/, 'AMAZON'],
  [/^(APPLE\.COM\/BILL|APL\*\s*APPLE|APL\s*\*\s*ITUNES\S*)/, 'APPLE'],
];

const STATE_LIST =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const STATE_SET = new Set(STATE_LIST.split('|'));

/** Upper-case matching key without processor prefixes, store numbers, dates, ids or trailing locations. */
export function normalizeDescription(raw: string): string {
  let s = raw.toUpperCase().normalize('NFKC');
  s = s
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, name] of SYNONYMS) s = s.replace(pattern, name);
  for (let pass = 0; pass < 2; pass++) for (const p of PROCESSOR_PREFIXES) s = s.replace(p, '');
  s = s
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // dates
    .replace(/\b(X{2,}|\*{2,})\d{2,}\b/g, ' ') // masked card numbers
    .replace(/#\s*\d+/g, ' ') // store numbers
    .replace(/\b[A-Z]*\d[A-Z\d-]{4,}\b/g, ' ') // reference ids
    .replace(/\b\d+\b/g, ' ') // stray numbers
    .replace(/\b(\+?1?[ -]?\(?\d{3}\)?[ -]?\d{3}-?\d{4})\b/g, ' ') // phone numbers
    .replace(/https?:\/\/\S+|WWW\.\S+/g, ' ')
    .replace(/[^\p{L}\p{N}&+ ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Trailing noise words, then "CITY ST": drop a US state code and up to two city words, always keeping at
  // least two words of merchant name ("SAN FRANCISCO CA" goes, "BLUE BOTTLE" stays).
  const tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1 && /^(CARD|PURCHASE|POS|DEBIT|CREDIT|PMT|PAYMENT)$/.test(tokens.at(-1)!))
    tokens.pop();
  if (tokens.length >= 2 && STATE_SET.has(tokens.at(-1)!)) {
    tokens.pop();
    for (let i = 0; i < 2 && tokens.length > 2; i++) tokens.pop();
  }
  if (tokens.length >= 2 && /^(US|USA|GB|UK|DE|FR|IE)$/.test(tokens.at(-1)!)) tokens.pop();
  return tokens.slice(0, 6).join(' ');
}

const SMALL = new Set(['and', 'of', 'the', 'de', 'la', 'du', 'und']);

/** Display name from a normalized key: "BLUE BOTTLE" → "Blue Bottle", "BED BATH & BEYOND" → "Bed Bath & Beyond". */
export function displayName(key: string): string {
  return key
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Trigram set similarity (Jaccard), the same measure Postgres pg_trgm uses, for fuzzy payee matching. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const out = new Set<string>();
    for (const word of s.toLowerCase().split(/\s+/).filter(Boolean)) {
      const w = `  ${word} `;
      for (let i = 0; i < w.length - 2; i++) out.add(w.slice(i, i + 3));
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  return common / (ga.size + gb.size - common);
}

export interface MerchantRef {
  id: string;
  displayName: string;
  matchKey: string;
  categoryHint?: string | null;
}

/** Best reference merchant for a normalized key: prefix match first, then trigram ≥ 0.6 (design 04 §3.4). */
export function matchMerchant(key: string, merchants: readonly MerchantRef[]): MerchantRef | null {
  if (!key) return null;
  const prefix = merchants
    .filter((m) => key === m.matchKey || key.startsWith(`${m.matchKey} `))
    .sort((a, b) => b.matchKey.length - a.matchKey.length)[0];
  if (prefix) return prefix;
  let best: MerchantRef | null = null;
  let bestScore = 0.6;
  for (const m of merchants) {
    const s = similarity(key, m.matchKey);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}
