/**
 * Bank feeds on the phone (ADR-0055 §10; FEED-10): read only, with Sync now. Connecting means pasting a setup token,
 * and linking means choosing among accounts, so both stay on the web. The phone shows:
 *
 * - the feed's status in Your data, for owners, admins and partners, with how far each linked account has synced and
 *   any problem in the provider's (sanitized) words;
 * - Sync now, for the same people, when the feed syncs and the spacing allows;
 * - "Bank feed, synced through …" on an account's screen;
 * - what a sync brought that waits in Review, one import per account, opening the phone's own import preview.
 *
 * Pure, so each is tested without a device. The server decides everything.
 */
import type { BankFeedDto, BankFeedLinkDto, ImportBatchDto, MemberRole } from '@montra/schemas';
import { TaxFormsToCheck } from './tax-forms';

export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

export type FeedTone = 'good' | 'warn' | 'bad' | 'muted';

export interface FeedLine extends Partial<Message> {
  /** Words from the server (the provider's, sanitized), shown as they are. */
  text?: string;
  tone?: FeedTone;
}

/** Owners, admins and partners see the feed and may sync it (D5); the API refuses anyone else. */
export const showsBankFeed = (role: MemberRole): boolean =>
  role === 'owner' || role === 'admin' || role === 'partner';

/** The day of an instant, as the API gives it (an ISO timestamp), for the phone's date format. */
export const isoDay = (iso: string): string => iso.slice(0, 10);

/** Sync now is offered while the feed syncs, once the spacing (SIMPLEFIN_SYNC_NOW_MINUTES) allows. */
export function canSyncNow(
  feed: Pick<BankFeedDto, 'status' | 'syncNowAfter'>,
  role: MemberRole,
  now: Date = new Date(),
): boolean {
  if (!showsBankFeed(role)) return false;
  if (feed.status !== 'active' && feed.status !== 'failing') return false;
  return !feed.syncNowAfter || new Date(feed.syncNowAfter) <= now;
}

const TONE: Record<BankFeedDto['status'], FeedTone> = {
  active: 'good',
  paused: 'muted',
  needs_attention: 'warn',
  failing: 'bad',
  revoked: 'bad',
  payment_required: 'bad',
  disconnected: 'bad',
};

export interface FeedCard {
  status: Message & { tone: FeedTone };
  lines: FeedLine[];
  canSync: boolean;
  /** Where to change it. */
  web: Message;
}

/** Your data → Bank feed: the web's card, read only. Null for someone who can't see it, or with no feed. */
export function bankFeedCard(
  feed: BankFeedDto | null,
  role: MemberRole,
  names: ReadonlyMap<string, string>,
  now: Date = new Date(),
): FeedCard | null {
  if (!feed || !showsBankFeed(role)) return null;
  const lines: FeedLine[] = [];
  if (feed.lastError) lines.push({ text: feed.lastError, tone: 'bad' });
  lines.push(
    feed.lastSuccessAt
      ? { key: 'mobile.bank_feeds.last_sync', values: { date: isoDay(feed.lastSuccessAt) } }
      : { key: 'bank_feeds.never_synced' },
  );
  for (const a of feed.accounts) {
    if (a.state !== 'linked') continue;
    const name = (a.accountId && names.get(a.accountId)) || a.name;
    lines.push(
      a.syncedThrough
        ? { key: 'mobile.bank_feeds.account_through', values: { name, date: a.syncedThrough } }
        : { key: 'mobile.bank_feeds.account_waiting', values: { name } },
    );
    if (a.problem) lines.push({ text: `${a.name}: ${a.problem.message}`, tone: 'bad' });
    if (a.missing)
      lines.push({ key: 'mobile.bank_feeds.account_missing', values: { name: a.name }, tone: 'warn' });
  }
  const notLinked = feed.accounts.filter((a) => a.state === 'new').length;
  if (notLinked)
    lines.push({ key: 'mobile.bank_feeds.not_linked', values: { count: notLinked }, tone: 'warn' });
  return {
    status: { key: `bank_feeds.status.${feed.status}`, tone: TONE[feed.status] },
    lines,
    canSync: canSyncNow(feed, role, now),
    web: { key: 'mobile.bank_feeds.on_web' },
  };
}

/** An account's screen: "Bank feed, synced through …", or null for an account without one. */
export function accountFeedLine(links: readonly BankFeedLinkDto[], accountId: string): Message | null {
  const link = links.find((l) => l.accountId === accountId);
  if (!link) return null;
  return link.syncedThrough
    ? { key: 'mobile.bank_feeds.account_synced', values: { date: link.syncedThrough } }
    : { key: 'mobile.bank_feeds.account_linked' };
}

/** Review: one entry per import a sync brought that waits for a look. */
export function feedImportEntries(
  batches: readonly ImportBatchDto[],
): { id: string; title: string; count: number }[] {
  return batches
    .filter((b) => b.source === 'feed' && b.status === 'preview')
    .map((b) => ({ id: b.id, title: b.fileName, count: b.counts.read }));
}

/** Who sees what waits from the feed: whoever may import (not viewers). */
export const showsFeedImports = (role: MemberRole): boolean => role !== 'viewer';

const counters = new Map<string, TaxFormsToCheck>();

/** The count behind the Review badge, one per workspace and login, as the other Review counts. */
export function feedImportsFor(key: string): TaxFormsToCheck {
  let c = counters.get(key);
  if (!c) counters.set(key, (c = new TaxFormsToCheck()));
  return c;
}
