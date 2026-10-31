/**
 * Quick add in ≤ 3 taps (TXN-01, 08 §3): amount (keypad) → payee (suggested from local history) → confirm with a
 * suggested category. Pure model; Capture screen renders it. Amounts never touch floating point (NFR-09).
 */
import type { CreateTransactionRequest } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | 'back' | 'clear';

const MAX_DIGITS = 12;

/** Cash-register entry: digits fill from the right, so "1850" is 18.50 in a 2-decimal currency. */
export function pressKey(digits: string, key: KeypadKey): string {
  if (key === 'clear') return '';
  if (key === 'back') return digits.slice(0, -1);
  const next = (digits + key).replace(/^0+/, '');
  return next.length > MAX_DIGITS ? digits : next;
}

export const digitsToMinor = (digits: string): bigint => (digits ? BigInt(digits) : 0n);

/** "1850", 2 → "18.50"; "5", 2 → "0.05"; exponent 0 → "1850". */
export function digitsToDisplay(digits: string, exponent: number): string {
  const d = (digits || '0').padStart(exponent + 1, '0');
  if (exponent === 0) return d;
  const whole = d.slice(0, -exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${d.slice(-exponent)}`;
}

export interface PayeeSuggestion {
  payee: string;
  count: number;
  lastDate: string;
  categoryId: string | null;
}

/**
 * Payees from local history ranked by use, then recency; `query` filters by prefix first, then substring.
 * Each carries the category last used with that payee (the offline fallback for the confirm step).
 */
export function payeeSuggestions(
  history: readonly LocalTransaction[],
  query: string,
  limit = 6,
): PayeeSuggestion[] {
  const byKey = new Map<string, PayeeSuggestion>();
  for (const t of history) {
    const name = (t.merchantName ?? t.payee ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const s = byKey.get(key) ?? { payee: name, count: 0, lastDate: '', categoryId: null };
    s.count++;
    if (t.date >= s.lastDate) {
      s.lastDate = t.date;
      if (t.categoryId) s.categoryId = t.categoryId;
    } else if (!s.categoryId && t.categoryId) s.categoryId = t.categoryId;
    byKey.set(key, s);
  }
  const q = query.trim().toLowerCase();
  const all = [...byKey.values()].filter((s) => !q || s.payee.toLowerCase().includes(q));
  const rank = (s: PayeeSuggestion) => (q && s.payee.toLowerCase().startsWith(q) ? 0 : 1);
  return all
    .sort(
      (a, b) =>
        rank(a) - rank(b) || b.count - a.count || (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0),
    )
    .slice(0, limit);
}

export interface QuickAddInput {
  accountId: string;
  currency: string;
  digits: string;
  direction: 'expense' | 'income';
  payee: string;
  categoryId: string | null;
  date: string;
  memo?: string;
}

/** The create request the outbox sends; with no category the pipeline categorizes it server-side. */
export function buildCreateRequest(i: QuickAddInput): CreateTransactionRequest {
  const minor = digitsToMinor(i.digits);
  if (minor <= 0n) throw new Error('Enter an amount');
  if (!i.accountId) throw new Error('Choose an account');
  const signed = i.direction === 'expense' ? -minor : minor;
  return {
    date: i.date,
    accountId: i.accountId,
    amount: { amount: signed.toString(), currency: i.currency },
    payee: i.payee.trim() || undefined,
    ...(i.categoryId ? { categoryId: i.categoryId } : {}),
    ...(i.memo ? { memo: i.memo } : {}),
  } as CreateTransactionRequest;
}
