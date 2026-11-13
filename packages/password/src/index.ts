import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary as common } from '@zxcvbn-ts/language-common';
import { dictionary as english, translations } from '@zxcvbn-ts/language-en';

/**
 * Password strength and policy (AUTH-02, ADR-0043). One scorer for the auth gateway, which enforces the policy, and
 * for the web and the phone, which show it as people type. The score is zxcvbn's 0–4 estimate of how hard the
 * password is to guess, so a long but common password ("password1234") scores low.
 */

export type Score = 0 | 1 | 2 | 3 | 4;

/** What the admin console sets for the whole service. */
export interface PasswordPolicy {
  minLength: number;
  minScore: Score;
}

/** Kratos's own floor (`min_password_length: 12`, NIST SP 800-63B): the policy can only raise it. */
export const MIN_LENGTH_FLOOR = 12;
export const MIN_LENGTH_CEILING = 64;
export const DEFAULT_POLICY: PasswordPolicy = { minLength: MIN_LENGTH_FLOOR, minScore: 3 };

/** Keeps a stored policy inside what makes sense, whatever was saved. */
export function normalizePolicy(p: Partial<Record<keyof PasswordPolicy, unknown>>): PasswordPolicy {
  const int = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    minLength: int(p.minLength, MIN_LENGTH_FLOOR, MIN_LENGTH_CEILING, DEFAULT_POLICY.minLength),
    minScore: int(p.minScore, 0, 4, DEFAULT_POLICY.minScore) as Score,
  };
}

let factory: ZxcvbnFactory | undefined;
const scorer = () =>
  (factory ??= new ZxcvbnFactory({
    dictionary: { ...common, ...english },
    graphs: adjacencyGraphs,
    translations,
    // Near-misses of dictionary words: costs ~0.7 s on some short passwords for little gain over the l33t and
    // reversed-word matching that stays on.
    useLevenshteinDistance: false,
  }));

/** Words a password shouldn't be built from: the person's email and name, and the service's own name. */
export function personalWords(args: { email?: string | null; name?: string | null }): string[] {
  const words = new Set<string>(['montra']);
  const email = args.email?.trim().toLowerCase();
  if (email) {
    words.add(email);
    const [local = '', domain = ''] = email.split('@');
    for (const w of [local, ...local.split(/[._+-]+/), domain.split('.')[0] ?? ''])
      if (w.length >= 3) words.add(w);
  }
  for (const w of (args.name ?? '').toLowerCase().split(/\s+/)) if (w.length >= 3) words.add(w);
  return [...words];
}

export interface Strength {
  score: Score;
  /** Why it's weak, in English (zxcvbn's wording), or null. */
  warning: string | null;
  suggestions: string[];
}

/**
 * Scores at most the first 64 characters (the longest minimum the policy allows). Scoring time grows quickly with
 * length on repetitive input (about half a second at 64), and the gateway runs it off the main thread.
 */
export const SCORED_LENGTH = 64;

export function strengthOf(password: string, words: string[] = []): Strength {
  const r = scorer().check([...password].slice(0, SCORED_LENGTH).join(''), words);
  return { score: r.score as Score, warning: r.feedback.warning, suggestions: r.feedback.suggestions };
}

export type PasswordProblem = 'too_short' | 'too_weak';

export interface PasswordCheck {
  ok: boolean;
  problems: PasswordProblem[];
  strength: Strength;
  /** Characters, counted as people see them (code points). */
  length: number;
}

export function checkPassword(password: string, policy: PasswordPolicy, words: string[] = []): PasswordCheck {
  return judgePassword(password, policy, strengthOf(password, words));
}

/** The same check with a strength worked out elsewhere (the gateway scores on a worker thread). */
export function judgePassword(password: string, policy: PasswordPolicy, strength: Strength): PasswordCheck {
  const length = [...password].length;
  const problems: PasswordProblem[] = [];
  if (length < policy.minLength) problems.push('too_short');
  if (strength.score < policy.minScore) problems.push('too_weak');
  return { ok: problems.length === 0, problems, strength, length };
}
