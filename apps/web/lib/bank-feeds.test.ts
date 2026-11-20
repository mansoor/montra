import { describe, expect, it } from 'vitest';
import {
  bankFeedStatus,
  canManageBankFeeds,
  canSeeBankFeeds,
  dayIn,
  guessKind,
  linkTargets,
  setupTokenInput,
} from './bank-feeds';

// Bank feeds in Settings (ADR-0055 §3, §4, D5).
describe('bank feeds in Settings', () => {
  it('shows the card to owners, admins and partners whose plan has it; only owners change it', () => {
    expect(canSeeBankFeeds('owner', ['bankFeeds'])).toBe(true);
    expect(canSeeBankFeeds('partner', ['bankFeeds'])).toBe(true);
    expect(canSeeBankFeeds('owner', ['ownStorage'])).toBe(false);
    for (const role of ['member', 'viewer', 'accountant'])
      expect(canSeeBankFeeds(role, ['bankFeeds']), role).toBe(false);
    expect(canManageBankFeeds('owner')).toBe(true);
    expect(canManageBankFeeds('admin')).toBe(false);
  });

  it('says the status in words, with a tone', () => {
    expect(bankFeedStatus({ status: 'active' })).toEqual({ key: 'bank_feeds.status.active', tone: 'good' });
    expect(bankFeedStatus({ status: 'paused' }).tone).toBe('muted');
    expect(bankFeedStatus({ status: 'revoked' })).toEqual({ key: 'bank_feeds.status.revoked', tone: 'bad' });
  });

  it('offers open accounts in the same currency, not linked elsewhere, the suggestion first', () => {
    const accounts = [
      { id: 'a', name: 'Everyday', kind: 'checking', currency: 'USD', archived: false },
      { id: 'b', name: 'Card', kind: 'credit_card', currency: 'USD', archived: false },
      { id: 'c', name: 'Old', kind: 'checking', currency: 'USD', archived: true },
      { id: 'd', name: 'Euro', kind: 'checking', currency: 'EUR', archived: false },
      { id: 'e', name: 'Wallet', kind: 'cash', currency: 'USD', archived: false },
      { id: 'f', name: 'Linked', kind: 'savings', currency: 'USD', archived: false },
    ] as const;
    const feed = { accounts: [{ state: 'linked', accountId: 'f' }] } as never;
    expect(
      linkTargets(accounts as never, { currency: 'USD', suggestedAccountId: 'b', accountId: null }, feed).map(
        (a) => a.id,
      ),
    ).toEqual(['b', 'a']);
    // The account it's linked to stays on its own list.
    expect(
      linkTargets(accounts as never, { currency: 'USD', suggestedAccountId: null, accountId: 'f' }, feed).map(
        (a) => a.id,
      ),
    ).toEqual(['a', 'b', 'f']);
    expect(
      linkTargets(accounts as never, { currency: null, suggestedAccountId: null, accountId: null }, feed),
    ).toEqual([]);
  });

  it('guesses a new account’s kind, and reads a pasted setup token', () => {
    expect(
      guessKind({
        name: 'Rewards Card',
        balance: { amount: '-50000', available: null, date: '2026-11-19' as never },
      }),
    ).toBe('credit_card');
    expect(guessKind({ name: 'High Yield Savings', balance: null })).toBe('savings');
    expect(
      guessKind({
        name: 'Checking',
        balance: { amount: '100', available: null, date: '2026-11-19' as never },
      }),
    ).toBe('checking');
    expect(setupTokenInput('  aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9jbGFpbS9hYmM=\n')).toBe(
      'aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9jbGFpbS9hYmM=',
    );
    expect(setupTokenInput('short')).toBeNull();
    // An instant shown as the workspace's day: 02:30 UTC is still the day before in Los Angeles.
    expect(dayIn('2026-11-21T02:30:00Z', 'America/Los_Angeles')).toBe('2026-11-20');
    expect(dayIn('2026-11-21T02:30:00Z', 'UTC')).toBe('2026-11-21');
    expect(setupTokenInput('https://bridge.simplefin.org/claim/abc')).toBeNull();
  });
});
