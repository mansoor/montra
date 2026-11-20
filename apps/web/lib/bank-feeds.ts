/**
 * Bank feeds in Settings (ADR-0055 §3, §4): who sees the card, the feed's status in words, and which Montra accounts a
 * feed account may be linked to. Pure, so it is tested without a page.
 */
import type { AccountDto, BankFeedAccountDto, BankFeedDto } from '@montra/api-client';

/** Owners, admins and partners see the feed (D5), when the plan has bank feeds. */
export function canSeeBankFeeds(role: string, features: readonly string[]): boolean {
  return ['owner', 'admin', 'partner'].includes(role) && features.includes('bankFeeds');
}

/** Only an owner connects, links and disconnects (D5). */
export const canManageBankFeeds = (role: string) => role === 'owner';

export type Tone = 'good' | 'bad' | 'muted';

/** The status chip: a key in `bank_feeds.status.*` and its tone. */
export function bankFeedStatus(feed: Pick<BankFeedDto, 'status'>): { key: string; tone: Tone } {
  const key = `bank_feeds.status.${feed.status}`;
  if (feed.status === 'active') return { key, tone: 'good' };
  if (feed.status === 'paused') return { key, tone: 'muted' };
  return { key, tone: 'bad' };
}

/**
 * Montra accounts a feed account may import into: open bank, card and loan accounts in its currency, not linked to
 * another feed account already. The suggestion, when there is one, comes first.
 */
export function linkTargets(
  accounts: readonly Pick<AccountDto, 'id' | 'name' | 'kind' | 'currency' | 'archived'>[],
  account: Pick<BankFeedAccountDto, 'currency' | 'suggestedAccountId' | 'accountId'>,
  feed: Pick<BankFeedDto, 'accounts'>,
): Pick<AccountDto, 'id' | 'name' | 'kind' | 'currency' | 'archived'>[] {
  if (!account.currency) return [];
  const taken = new Set(
    feed.accounts
      .filter((a) => a.state === 'linked' && a.accountId !== account.accountId)
      .map((a) => a.accountId),
  );
  const list = accounts.filter(
    (a) => !a.archived && a.kind !== 'cash' && a.currency === account.currency && !taken.has(a.id),
  );
  return [...list].sort(
    (a, b) => Number(b.id === account.suggestedAccountId) - Number(a.id === account.suggestedAccountId),
  );
}

/** "Create account": a card or loan when the institution reports money owed, else a checking account. */
export function guessKind(
  account: Pick<BankFeedAccountDto, 'balance' | 'name'>,
): 'checking' | 'credit_card' | 'savings' {
  if (/saving/i.test(account.name)) return 'savings';
  if (account.balance && BigInt(account.balance.amount) < 0n) return 'credit_card';
  return 'checking';
}

/** What was pasted, if it can be a setup token (SimpleFIN shows Base64): trimmed, or null. */
export function setupTokenInput(text: string): string | null {
  const t = text.replace(/\s+/g, '');
  return t.length >= 16 && /^[A-Za-z0-9+/_=-]+$/.test(t) ? t : null;
}
