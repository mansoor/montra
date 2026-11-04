/**
 * The search syntax (RPT-05): words, plus `>500`, `<20`, `=12.50`, `tag:travel`, and quoted phrases, in any order. One parser, used
 * by the transaction list and global search. Amounts stay decimal text until a currency says how many places they have, so no
 * floats. An operator that doesn't parse is treated as a word, so typing never fails.
 */

export type AmountOp = '>' | '>=' | '<' | '<=' | '=';

export interface AmountFilter {
  op: AmountOp;
  /** The amount as typed, without separators: `1500.50`. */
  value: string;
}

export interface SearchQuery {
  /** Words and phrases, all of which must match. */
  terms: string[];
  amounts: AmountFilter[];
  tags: string[];
}

const AMOUNT = /^(>=|<=|>|<|=)\s*\$?(\d[\d,]*(?:\.\d+)?)$/;
const MAX_TERMS = 10;

/** Splits on spaces, keeping quoted phrases whole and joining an operator to a number after it (`> 500`). */
function tokens(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1] !== undefined) {
      if (m[1].trim()) out.push(`"${m[1].trim()}`);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && /^(>=|<=|>|<|=)$/.test(prev)) out[out.length - 1] = `${prev}${m[2]}`;
    else out.push(m[2]!);
  }
  return out;
}

export function parseSearchQuery(input: string): SearchQuery {
  const query: SearchQuery = { terms: [], amounts: [], tags: [] };
  for (const token of tokens(input.slice(0, 500))) {
    if (token.startsWith('"')) {
      query.terms.push(token.slice(1));
      continue;
    }
    const amount = AMOUNT.exec(token);
    if (amount) {
      query.amounts.push({ op: amount[1] as AmountOp, value: amount[2]!.replace(/,/g, '') });
      continue;
    }
    const lower = token.toLowerCase();
    if (lower.startsWith('tag:') && token.length > 4) {
      query.tags.push(token.slice(4));
      continue;
    }
    query.terms.push(token);
  }
  query.terms = query.terms.slice(0, MAX_TERMS);
  return query;
}

/** Whether a piece of text, such as a decrypted note, holds every term. */
export function textMatchesTerms(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return terms.every((t) => haystack.includes(t.toLowerCase()));
}

/** Short text around the first term for showing a match, with the ends marked if it was cut. */
export function matchSnippet(text: string, terms: readonly string[], width = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${piece}${start + width < flat.length ? '…' : ''}`;
}
