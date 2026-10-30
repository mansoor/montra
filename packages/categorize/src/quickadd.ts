/**
 * Heuristic natural-language quick add (TXN-06). It is the fallback when AI is off, and the instant first pass
 * while the AI parse runs. Example: "lunch 18.50 amex client meeting" gives payee "lunch", amount 18.50,
 * account Amex and memo "client meeting".
 */
import { addDays, compareDates, fromParts, isoDayOfWeek, parts, type CalendarDate } from '@montra/domain';

export type QuickAddField = 'amount' | 'date' | 'payee' | 'account' | 'category' | 'member' | 'memo' | 'tag';

export interface QuickAddHeuristicContext {
  today: CalendarDate;
  accounts: ReadonlyArray<{ id: string; label: string }>;
  categories: ReadonlyArray<{ id: string; name: string }>;
  members: ReadonlyArray<{ id: string; name: string }>;
}

export interface QuickAddHeuristicResult {
  date: CalendarDate;
  amount: string | null;
  direction: 'out' | 'in';
  payee: string | null;
  accountId: string | null;
  categoryId: string | null;
  memberId: string | null;
  memo: string | null;
  tags: string[];
  confidence: number;
  spans: Array<{ field: QuickAddField; text: string }>;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
// ISO order: 0 = Monday.
const WEEKDAYS: Array<readonly string[]> = [
  ['mon', 'monday'],
  ['tue', 'tues', 'tuesday'],
  ['wed', 'weds', 'wednesday'],
  ['thu', 'thur', 'thurs', 'thursday'],
  ['fri', 'friday'],
  ['sat', 'saturday'],
  ['sun', 'sunday'],
];
const INCOME_WORDS = new Set([
  'received',
  'refund',
  'refunded',
  'income',
  'deposit',
  'salary',
  'reimbursement',
  'paycheck',
]);
const FILLERS = new Set(['on', 'at', 'with', 'via', 'using', 'for', 'from', 'to', 'in']);
const AMOUNT_RE = /^([+-]?)[$€£]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/;

interface Token {
  raw: string;
  /** Lower-cased, trailing punctuation removed. */
  word: string;
  used: boolean;
}

const clean = (s: string) => s.toLowerCase().replace(/^[("']+|[)"',.;:!?]+$/g, '');

/** "mar", "march", "sept" → 2, 2, 8; -1 when not a month. */
function monthIndex(word: string): number {
  return word.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(word)) : -1;
}

function validDate(y: number, m: number, d: number): CalendarDate | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  try {
    const date = fromParts(y, m, d);
    return parts(date).day === d ? date : null;
  } catch {
    return null;
  }
}

/** A date without a year is the most recent one not after today. */
function noYear(today: CalendarDate, m: number, d: number): CalendarDate | null {
  const y = parts(today).year;
  const date = validDate(y, m, d);
  if (!date) return null;
  return compareDates(date, today) > 0 ? validDate(y - 1, m, d) : date;
}

/** Tries to read a date at token i; returns the date and how many tokens it used. */
function readDate(tokens: Token[], i: number, today: CalendarDate): { date: CalendarDate; n: number } | null {
  const w = tokens[i]!.word;
  if (w === 'today') return { date: today, n: 1 };
  if (w === 'yesterday') return { date: addDays(today, -1), n: 1 };
  const dow = WEEKDAYS.findIndex((names) => names.includes(w));
  if (dow >= 0) {
    const back = (isoDayOfWeek(today) - dow + 7) % 7;
    return { date: addDays(today, -back), n: 1 };
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (m) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return date ? { date, n: 1 } : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(w);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const date = validDate(y, month, day);
      return date ? { date, n: 1 } : null;
    }
    const date = noYear(today, month, day);
    return date ? { date, n: 1 } : null;
  }
  const next = tokens[i + 1]?.word;
  // "14 mar" / "mar 14"
  if (/^\d{1,2}$/.test(w) && next && monthIndex(next) >= 0) {
    const date = noYear(today, monthIndex(next) + 1, Number(w));
    return date ? { date, n: 2 } : null;
  }
  if (monthIndex(w) >= 0 && next && /^\d{1,2}(st|nd|rd|th)?$/.test(next)) {
    const date = noYear(today, monthIndex(w) + 1, parseInt(next, 10));
    return date ? { date, n: 2 } : null;
  }
  return null;
}

/** Longest run of tokens starting at i whose words equal `name`'s words. */
function matchPhrase(tokens: Token[], i: number, name: string): number {
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  for (let k = 0; k < words.length; k++) {
    const t = tokens[i + k];
    if (!t || t.used || t.word !== words[k]) return 0;
  }
  return words.length;
}

const singular = (w: string) =>
  w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') ? w.slice(0, -1) : w;

export function parseQuickAddHeuristic(text: string, ctx: QuickAddHeuristicContext): QuickAddHeuristicResult {
  const tokens: Token[] = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, word: clean(raw), used: false }));
  const spans: QuickAddHeuristicResult['spans'] = [];
  const tags: string[] = [];
  let direction: 'out' | 'in' = 'out';

  // Tags
  for (const t of tokens)
    if (/^#[\w-]{1,50}$/.test(t.raw)) {
      t.used = true;
      tags.push(t.raw.slice(1));
      spans.push({ field: 'tag', text: t.raw });
    }

  // Dates first, so "3/14" or "14 mar" isn't read as an amount.
  let date: CalendarDate | null = null;
  for (let i = 0; i < tokens.length && !date; i++) {
    if (tokens[i]!.used) continue;
    const d = readDate(tokens, i, ctx.today);
    if (!d) continue;
    date = d.date;
    const run = tokens.slice(i, i + d.n);
    run.forEach((t) => (t.used = true));
    spans.push({ field: 'date', text: run.map((t) => t.raw).join(' ') });
    if (i > 0 && FILLERS.has(tokens[i - 1]!.word) && !tokens[i - 1]!.used) tokens[i - 1]!.used = true;
  }

  // Amount: prefer a token with decimals or a currency sign, then any plain number.
  let amount: string | null = null;
  const amountText = (t: Token) => t.raw.replace(/[,;:!?]+$/, '');
  const isAmount = (t: Token) => !t.used && AMOUNT_RE.test(amountText(t));
  const strong = tokens.findIndex((t) => isAmount(t) && /[.$€£]/.test(amountText(t)));
  let amountIndex = strong >= 0 ? strong : tokens.findIndex((t) => isAmount(t) && !/^\d{4}$/.test(t.raw));
  if (amountIndex < 0) amountIndex = tokens.findIndex(isAmount);
  if (amountIndex >= 0) {
    const t = tokens[amountIndex]!;
    const m = AMOUNT_RE.exec(amountText(t))!;
    if (m[1] === '+') direction = 'in';
    amount = `${m[2]!.replace(/,/g, '')}${m[3] ?? ''}`;
    t.used = true;
    spans.push({ field: 'amount', text: t.raw });
  }
  if (tokens.some((t) => INCOME_WORDS.has(t.word))) direction = 'in';

  // Accounts: full label, then the label's first word when it's unambiguous.
  let accountId: string | null = null;
  for (let i = 0; i < tokens.length && !accountId; i++) {
    if (tokens[i]!.used) continue;
    let best: { id: string; n: number } | null = null;
    for (const a of ctx.accounts) {
      const n = matchPhrase(tokens, i, a.label);
      if (n > (best?.n ?? 0)) best = { id: a.id, n };
    }
    if (!best) {
      const firstWord = ctx.accounts.filter((a) => a.label.toLowerCase().split(/\s+/)[0] === tokens[i]!.word);
      if (firstWord.length === 1) best = { id: firstWord[0]!.id, n: 1 };
    }
    if (best) {
      accountId = best.id;
      const run = tokens.slice(i, i + best.n);
      run.forEach((t) => (t.used = true));
      spans.push({ field: 'account', text: run.map((t) => t.raw).join(' ') });
      if (i > 0 && FILLERS.has(tokens[i - 1]!.word) && !tokens[i - 1]!.used) tokens[i - 1]!.used = true;
    }
  }

  // Members by first name ("for Sam").
  let memberId: string | null = null;
  for (let i = 0; i < tokens.length && !memberId; i++) {
    const t = tokens[i]!;
    if (t.used) continue;
    const m = ctx.members.find((x) => x.name.toLowerCase().split(/\s+/)[0] === t.word);
    if (m) {
      memberId = m.id;
      t.used = true;
      spans.push({ field: 'member', text: t.raw });
      if (i > 0 && FILLERS.has(tokens[i - 1]!.word) && !tokens[i - 1]!.used) tokens[i - 1]!.used = true;
    }
  }

  // Categories by full name or simple plural.
  let categoryId: string | null = null;
  for (let i = 0; i < tokens.length && !categoryId; i++) {
    if (tokens[i]!.used) continue;
    let best: { id: string; n: number } | null = null;
    for (const c of ctx.categories) {
      const n = matchPhrase(tokens, i, c.name);
      if (n > (best?.n ?? 0)) best = { id: c.id, n };
    }
    if (!best) {
      const w = singular(tokens[i]!.word);
      const c = ctx.categories.find((x) => !/\s/.test(x.name.trim()) && singular(x.name.toLowerCase()) === w);
      if (c) best = { id: c.id, n: 1 };
    }
    if (best) {
      categoryId = best.id;
      const run = tokens.slice(i, i + best.n);
      run.forEach((t) => (t.used = true));
      spans.push({ field: 'category', text: run.map((t) => t.raw).join(' ') });
    }
  }

  // Remaining words: before the amount → payee; after → memo. With nothing before, the first word after is
  // the payee.
  const rest = (from: number, to: number) => tokens.slice(from, to).filter((t) => !t.used);
  const stripLead = (ts: Token[]) => {
    while (ts.length && FILLERS.has(ts[0]!.word)) ts.shift();
    return ts;
  };
  let before = stripLead(rest(0, amountIndex >= 0 ? amountIndex : tokens.length));
  let after = stripLead(amountIndex >= 0 ? rest(amountIndex + 1, tokens.length) : []);
  if (before.length === 0 && after.length > 0) {
    before = [after[0]!];
    after = stripLead(after.slice(1));
  }
  const payee = before.length ? before.map((t) => t.raw).join(' ') : null;
  const memo = after.length ? after.map((t) => t.raw).join(' ') : null;
  if (payee) spans.push({ field: 'payee', text: payee });
  if (memo) spans.push({ field: 'memo', text: memo });

  const resolved = [payee, accountId, categoryId, memberId, date].filter((v) => v !== null).length;
  const confidence = amount === null ? 0 : Math.min(0.9, 0.6 + 0.1 * resolved);
  return {
    date: date ?? ctx.today,
    amount,
    direction,
    payee,
    accountId,
    categoryId,
    memberId,
    memo,
    tags,
    confidence: Number(confidence.toFixed(2)),
    spans,
  };
}
