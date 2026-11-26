/**
 * Which account a question means (RPT-06, ADR-0058). The AI hands back the account as the question names it ("skylark home
 * loan") and never sees an account name; this matches that phrase to the workspace's accounts on the server.
 *
 * Case and punctuation don't matter. Filler ("my", "the", "account") is dropped. Words that describe a kind of account
 * ("loan", "mortgage", "home", "card", "checking") are weak: they only break ties, and they also point at kinds, so "my
 * mortgage" finds the one mortgage. The other words are strong and decide the match: an account is a candidate only if it
 * shares one, so "Skylark loan" never answers for "Car loan". An exact name wins; otherwise the most strong words, then the
 * most weak words and kind hints. Accounts that tie at the top are all returned, for the asker to pick from.
 */
import type { AccountKind } from './account-types.js';

export interface MatchableAccount {
  id: string;
  name: string;
  kind: string;
  /** The bank or lender: "chase checking" finds the account named "Checking" at Chase. */
  institution?: string | null;
}

export type AccountMatch<T> =
  { status: 'one'; account: T } | { status: 'several'; accounts: T[] } | { status: 'none' };

/** Words that say nothing about which account is meant. */
const FILLER = new Set([
  'a',
  'acct',
  'account',
  'an',
  'and',
  'at',
  'for',
  'from',
  'her',
  'his',
  'i',
  'in',
  'it',
  'me',
  'mine',
  'my',
  'number',
  'of',
  'on',
  'our',
  'that',
  'the',
  'their',
  'this',
  'to',
  'us',
  'we',
  'with',
  'your',
]);

/** Words that describe a kind of account rather than name one, and the kinds each points at (after stemming). */
const KIND_WORDS: ReadonlyMap<string, readonly AccountKind[]> = new Map(
  Object.entries({
    loan: ['loan', 'mortgage', 'line_of_credit'],
    lender: ['loan', 'mortgage'],
    mortgage: ['mortgage'],
    home: ['mortgage'],
    house: ['mortgage'],
    heloc: ['line_of_credit', 'mortgage'],
    car: ['loan'],
    auto: ['loan'],
    vehicle: ['loan'],
    student: ['loan'],
    personal: ['loan'],
    debt: ['loan', 'mortgage', 'credit_card', 'liability'],
    card: ['credit_card'],
    credit: ['credit_card', 'line_of_credit'],
    visa: ['credit_card'],
    mastercard: ['credit_card'],
    amex: ['credit_card'],
    line: ['line_of_credit'],
    bank: ['checking', 'savings'],
    checking: ['checking'],
    current: ['checking'],
    saving: ['savings'],
    cash: ['cash'],
    wallet: ['cash'],
    investment: ['investment'],
    brokerage: ['investment'],
    retirement: ['investment'],
    '401k': ['investment'],
    ira: ['investment'],
    roth: ['investment'],
    pension: ['investment'],
    stock: ['investment'],
    iou: ['liability'],
  } satisfies Record<string, readonly AccountKind[]>),
);

/** Lower case, accents and punctuation gone, possessives and plurals reduced: "Sam's Savings" → ["sam", "saving"]. */
export function accountWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/['’().]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

interface Words {
  /** Everything but filler, in order: what an exact match compares. */
  content: string[];
  strong: Set<string>;
  weak: Set<string>;
}

function split(text: string): Words {
  const content = accountWords(text).filter((w) => !FILLER.has(w));
  return {
    content,
    strong: new Set(content.filter((w) => !KIND_WORDS.has(w))),
    weak: new Set(content.filter((w) => KIND_WORDS.has(w))),
  };
}

const overlap = (a: Set<string>, b: Set<string>): number => [...a].filter((w) => b.has(w)).length;

/** Matches the phrase a question used to the accounts it can mean. */
export function matchAccount<T extends MatchableAccount>(
  phrase: string,
  accounts: readonly T[],
): AccountMatch<T> {
  const p = split(phrase);
  if (p.content.length === 0) return { status: 'none' };
  const hinted = new Set([...p.weak].flatMap((w) => KIND_WORDS.get(w) ?? []));
  const said = p.content.join(' ');

  const exact = accounts.filter((a) => split(a.name).content.join(' ') === said);
  if (exact.length === 1) return { status: 'one', account: exact[0]! };
  if (exact.length > 1) return { status: 'several', accounts: byName(exact) };

  const scored = accounts.map((a) => {
    const name = split(`${a.name} ${a.institution ?? ''}`);
    return {
      account: a,
      strong: overlap(p.strong, name.strong),
      weak: overlap(p.weak, name.weak) + (hinted.has(a.kind as AccountKind) ? 1 : 0),
    };
  });
  // With a strong word said, only accounts that share one can be meant; with none, the kind words decide.
  const candidates = scored.filter((s) => (p.strong.size > 0 ? s.strong > 0 : s.weak > 0));
  if (candidates.length === 0) return { status: 'none' };
  candidates.sort((x, y) => y.strong - x.strong || y.weak - x.weak);
  const top = candidates[0]!;
  const tied = candidates.filter((s) => s.strong === top.strong && s.weak === top.weak).map((s) => s.account);
  return tied.length === 1
    ? { status: 'one', account: tied[0]! }
    : { status: 'several', accounts: byName(tied) };
}

const byName = <T extends MatchableAccount>(list: T[]): T[] =>
  [...list].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
