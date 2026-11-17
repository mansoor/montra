/**
 * Matching a tax form read from a file to its employer or account (ADR-0052 §4). Pure: the API gathers the
 * candidates (under the reader's row-level security), the issuer's match memory and the details the form gives, and
 * this decides.
 *
 * Tax forms come once a year, so ADR-0051's three confirmations would take three years. Two rules make it automatic:
 * 1. **Memory with an EIN**: a signal naming an EIN that was confirmed once before is matched (a name-only signal
 *    still needs `LEARN_AFTER`).
 * 2. **One clear candidate this year**: exactly one candidate fits every detail the form gives (the name, the last
 *    four digits, the person, and income or pay in the year).
 * Otherwise the best candidates are suggested and the form waits in Review. The reconciliation is the guard: a wrong
 * automatic match shows up as a difference.
 */
import { institutionKey, LEARN_AFTER, taxSignalHasEin, type MatchMemoryState } from './statement-match.js';

export interface TaxIssuerCandidate {
  id: string;
  name: string;
  /** An employer's member, or an account's default member; null when the account is shared. */
  memberId: string | null;
  /** An account's last four digits. */
  last4: string | null;
  /** An account's institution ("First Example Bank"). */
  institution: string | null;
  /** Pay (a W-2), interest, dividends or mortgage interest in the form's year. */
  active: boolean;
}

export interface TaxFormMatchInput {
  kind: 'w2' | '1099_int' | '1099_div' | '1098';
  year: number;
  issuerName: string | null;
  accountLast4: string | null;
  /** The person the form is for, when known before the match (the token, or the learned last four). */
  personId: string | null;
  /** The person's name, for the reason in words. */
  personName: string | null;
  candidates: readonly TaxIssuerCandidate[];
  signal: string | null;
  memory: MatchMemoryState | null;
}

export interface TaxFormMatchSuggestion {
  id: string;
  name: string;
  reason: string;
}

export type TaxFormMatchDecision =
  | { automatic: true; targetId: string; reason: string; candidates: TaxFormMatchSuggestion[] }
  | { automatic: false; targetId: null; reason: null; candidates: TaxFormMatchSuggestion[] };

/** Two names share a meaningful word ("ACME WIDGETS INC" and "Acme Widgets"); "Bank", "Inc" and the like don't count. */
export function issuerNamesAgree(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const generic = new Set([
    'inc',
    'corp',
    'co',
    'llc',
    'ltd',
    'na',
    'n',
    'a',
    'the',
    'of',
    'and',
    'bank',
    'company',
    'corporation',
    'financial',
    'services',
    'group',
    'trust',
  ]);
  const words = (s: string) =>
    institutionKey(s)
      .split(' ')
      .filter((w) => w.length > 1 && !generic.has(w));
  const other = new Set(words(b));
  return words(a).some((w) => other.has(w));
}

const WHAT: Record<TaxFormMatchInput['kind'], string> = {
  w2: 'pay',
  '1099_int': 'interest',
  '1099_div': 'dividends',
  '1098': 'mortgage interest',
};

/** How well a candidate fits the form, and which details it fits, for suggestions and the reason in words. */
function fit(input: TaxFormMatchInput, c: TaxIssuerCandidate) {
  const name = input.issuerName
    ? issuerNamesAgree(input.issuerName, c.name) || issuerNamesAgree(input.issuerName, c.institution)
    : null;
  const last4 = input.kind !== 'w2' && input.accountLast4 ? c.last4 === input.accountLast4 : null;
  const person = input.personId && c.memberId ? c.memberId === input.personId : null;
  // Every detail the form gives agrees, and it had pay or income in the year.
  const all = name !== false && last4 !== false && person !== false && c.active && (name || last4) !== null;
  const score = (name ? 4 : 0) + (last4 ? 8 : 0) + (person ? 2 : 0) + (c.active ? 1 : 0);
  return { name, last4, all, score };
}

function words(input: TaxFormMatchInput, c: TaxIssuerCandidate, f: ReturnType<typeof fit>): string {
  const parts: string[] = [];
  if (f.last4) parts.push(`ends ${c.last4}`);
  if (f.name && input.kind !== 'w2' && c.institution) parts.push(`is at ${c.institution}`);
  if (c.active) parts.push(`had ${WHAT[input.kind]} in ${input.year}`);
  if (!parts.length) return 'A possible match';
  const s = parts.join(', ');
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Decides a form's issuer match (ADR-0052 §4). */
export function decideTaxFormMatch(input: TaxFormMatchInput): TaxFormMatchDecision {
  const known = new Map(input.candidates.map((c) => [c.id, c]));
  const scored = input.candidates
    .map((c) => ({ c, f: fit(input, c) }))
    .filter((x) => x.f.score > 1 || x.f.all)
    .sort((a, b) => b.f.score - a.f.score || a.c.name.localeCompare(b.c.name));
  const candidates = scored
    .slice(0, 5)
    .map((x) => ({ id: x.c.id, name: x.c.name, reason: words(input, x.c, x.f) }));

  // 1. The memory: one confirmation is enough when the signal names an EIN; a name needs LEARN_AFTER.
  const m = input.memory;
  if (m && input.signal && known.has(m.targetId)) {
    const needed = taxSignalHasEin(input.signal) ? 1 : LEARN_AFTER;
    if (m.confirmations >= needed) {
      const target = known.get(m.targetId)!;
      return {
        automatic: true,
        targetId: target.id,
        reason: `Matched as before: forms from this issuer went to ${target.name}`,
        candidates,
      };
    }
  }

  // 2. Exactly one candidate fits every detail the form gives.
  const fits = scored.filter((x) => x.f.all);
  if (fits.length === 1) {
    const { c, f } = fits[0]!;
    const who = input.personName ? `${input.personName}’s` : 'the';
    let reason: string;
    if (input.kind === 'w2')
      reason = `Matched: ${c.name} is ${who} only employer with payslips in ${input.year}`;
    else if (f.last4)
      reason = `Matched: ${c.name} is the only account ending ${c.last4} with ${WHAT[input.kind]} in ${input.year}`;
    else
      reason = `Matched: ${c.name} is the only account at ${c.institution ?? input.issuerName} with ${
        WHAT[input.kind]
      } in ${input.year}`;
    return { automatic: true, targetId: c.id, reason, candidates };
  }
  return { automatic: false, targetId: null, reason: null, candidates };
}
