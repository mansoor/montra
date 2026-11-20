import { describe, expect, it } from 'vitest';
import { catalogs, createTranslator } from '@montra/i18n';
import type { BankFeedDto, ImportBatchDto } from '@montra/schemas';
import {
  accountFeedLine,
  bankFeedCard,
  canSyncNow,
  feedImportEntries,
  showsBankFeed,
  showsFeedImports,
} from '../src/features/bank-feeds';
import { reviewBadge } from '../src/features/tax-forms';

// Bank feeds on the phone (ADR-0055 §10; FEED-10): read only, with Sync now.
const t = createTranslator('en-US', catalogs).t;
const now = new Date('2026-11-20T12:00:00Z');

const account = (over: Partial<BankFeedDto['accounts'][number]>) =>
  ({
    id: 'fa',
    name: 'Checking …1234',
    institution: 'Example CU',
    currency: 'USD',
    state: 'linked',
    accountId: 'acct-1',
    suggestedAccountId: null,
    startDate: '2026-11-01',
    syncedThrough: '2026-11-18',
    balance: null,
    problem: null,
    missing: false,
    version: '1',
    ...over,
  }) as BankFeedDto['accounts'][number];

const feed = (over: Partial<BankFeedDto> = {}): BankFeedDto =>
  ({
    id: 'feed',
    provider: 'simplefin',
    status: 'active',
    host: 'bridge.simplefin.org',
    label: null,
    connectedAt: '2026-11-01T10:00:00Z',
    lastSyncAt: '2026-11-20T10:00:00Z',
    lastSuccessAt: '2026-11-20T10:00:00Z',
    nextSyncAt: '2026-11-21T10:00:00Z',
    lastError: null,
    accounts: [account({})],
    requests: { today: 2, perDay: 12 },
    earliestStartDate: '2026-08-23',
    syncNowAfter: null,
    version: '3',
    ...over,
  }) as BankFeedDto;

describe('bank feeds on the phone', () => {
  it('shows the feed to owners, admins and partners, and what waits to whoever imports', () => {
    expect(['owner', 'admin', 'partner'].every((r) => showsBankFeed(r as never))).toBe(true);
    expect(showsBankFeed('viewer')).toBe(false);
    expect(showsBankFeed('accountant')).toBe(false);
    expect(showsFeedImports('accountant')).toBe(true);
    expect(showsFeedImports('viewer')).toBe(false);
  });

  it('builds the Your data card: status, each linked account, problems in words, what isn’t linked', () => {
    const card = bankFeedCard(
      feed({
        accounts: [
          account({}),
          account({ id: 'fb', name: 'Card …9876', accountId: 'acct-2', syncedThrough: null }),
          account({
            id: 'fc',
            name: 'Savings',
            accountId: 'acct-3',
            problem: { code: 'reauth_needed', message: 'Sign in again' },
            missing: true,
          }),
          account({ id: 'fd', name: 'Brokerage', state: 'new', accountId: null }),
        ],
      }),
      'partner',
      new Map([['acct-1', 'Everyday']]),
      now,
    )!;
    expect(t(card.status.key)).toBe('Connected');
    expect(card.status.tone).toBe('good');
    expect(card.lines.map((l) => (l.key ? t(l.key, l.values) : l.text))).toEqual([
      'Last synced 2026-11-20',
      'Everyday: synced through 2026-11-18',
      'Card …9876: not synced yet',
      'Savings: synced through 2026-11-18',
      'Savings: Sign in again',
      'Savings is no longer in your SimpleFIN Bridge.',
      '1 account isn’t linked yet: link them on the web.',
    ]);
    expect(card.canSync).toBe(true);
    expect(t(card.web.key)).toContain('on the web');
    expect(bankFeedCard(null, 'owner', new Map(), now)).toBeNull();
    expect(bankFeedCard(feed(), 'viewer', new Map(), now)).toBeNull();
  });

  it('says a feed that needs a person in its words, and offers Sync now only while it syncs, spaced', () => {
    const revoked = bankFeedCard(
      feed({ status: 'revoked', lastError: 'SimpleFIN no longer accepts Montra’s access.' }),
      'owner',
      new Map(),
      now,
    )!;
    expect(revoked.status.tone).toBe('bad');
    expect(revoked.lines[0]).toEqual({ text: 'SimpleFIN no longer accepts Montra’s access.', tone: 'bad' });
    expect(revoked.canSync).toBe(false);
    expect(canSyncNow(feed({ syncNowAfter: '2026-11-20T12:30:00Z' }), 'owner', now)).toBe(false);
    expect(canSyncNow(feed({ status: 'failing', syncNowAfter: '2026-11-20T11:00:00Z' }), 'admin', now)).toBe(
      true,
    );
    expect(canSyncNow(feed(), 'viewer', now)).toBe(false);
  });

  it('says on an account’s screen how far its feed has synced', () => {
    const links = [
      { accountId: 'acct-1', syncedThrough: '2026-11-18' as never },
      { accountId: 'acct-2', syncedThrough: null },
    ];
    expect(accountFeedLine(links, 'acct-1')).toEqual({
      key: 'mobile.bank_feeds.account_synced',
      values: { date: '2026-11-18' },
    });
    expect(t(accountFeedLine(links, 'acct-2')!.key)).toBe('Bank feed, not synced yet');
    expect(accountFeedLine(links, 'acct-9')).toBeNull();
  });

  it('lists what waits in Review, and counts it in the badge', () => {
    const batch = (over: Partial<ImportBatchDto>) =>
      ({
        id: 'b',
        source: 'feed',
        status: 'preview',
        fileName: 'SimpleFIN · Checking',
        counts: { read: 3 },
        ...over,
      }) as never;
    expect(
      feedImportEntries([
        batch({}),
        batch({ id: 'c', status: 'committed' }),
        batch({ id: 'd', source: 'file' }),
      ]),
    ).toEqual([{ id: 'b', title: 'SimpleFIN · Checking', count: 3 }]);
    expect(reviewBadge(3, 2, 4, 1)).toBe(10);
    expect(reviewBadge(3, null, null, null)).toBe(3);
  });
});
