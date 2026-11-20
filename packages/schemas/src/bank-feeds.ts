import { z } from 'zod';
import { BankAccountKind } from './accounts.js';
import { MinorDto } from './budgets.js';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';

// ----- Bank feeds (FEED-01..10, ADR-0055) ------------------------------------------------------------------------
// A workspace connects SimpleFIN Bridge once; each account it reports is linked to a Montra account, created, or
// ignored, and linked accounts sync daily through the import pipeline. The access SimpleFIN gives is sealed and never
// leaves the API: no DTO carries it, only that it is set.

export const BANK_FEED_PROVIDERS = ['simplefin'] as const;
export const BankFeedProviderDto = z.enum(BANK_FEED_PROVIDERS);

/**
 * `active` syncs; `needs_attention` waits for a person (an institution to sign in to again); `revoked` and
 * `payment_required` are SimpleFIN's 403 and 402 (§7); `paused` by an owner or a plan without the feature; `failing`
 * after five failed syncs in a row; `disconnected` once an owner disconnects (the secret is wiped).
 */
export const BANK_FEED_STATUSES = [
  'active',
  'needs_attention',
  'revoked',
  'payment_required',
  'paused',
  'failing',
  'disconnected',
] as const;
export const BankFeedStatusDto = z.enum(BANK_FEED_STATUSES);
export type BankFeedStatus = z.infer<typeof BankFeedStatusDto>;

/** What went wrong for one institution or account (§7). The words come from the provider, sanitized. */
export const BANK_FEED_PROBLEMS = ['reauth_needed', 'account_failed', 'missing_data', 'unknown'] as const;
export const BankFeedProblemDto = z.object({
  code: z.enum(BANK_FEED_PROBLEMS),
  message: z.string(),
});

/** `new` until an owner decides; `linked` imports into `accountId`; `ignored` is never imported. */
export const BANK_FEED_ACCOUNT_STATES = ['new', 'linked', 'ignored'] as const;

export const BankFeedAccountDto = z.object({
  id: Id,
  name: z.string(),
  institution: z.string().nullable(),
  /** ISO 4217, or null for a custom currency, which can't be linked. */
  currency: CurrencyCodeDto.nullable(),
  state: z.enum(BANK_FEED_ACCOUNT_STATES),
  /** The Montra account it imports into, when linked. */
  accountId: Id.nullable(),
  /** The Montra account Montra suggests for a `new` one (ADR-0051 matching), or null. */
  suggestedAccountId: Id.nullable(),
  /** The first date the feed imports, and through when it has (§5). */
  startDate: CalendarDateDto.nullable(),
  syncedThrough: CalendarDateDto.nullable(),
  /** The balance the institution last reported, and its date. */
  balance: z.object({ amount: MinorDto, available: MinorDto.nullable(), date: CalendarDateDto }).nullable(),
  problem: BankFeedProblemDto.nullable(),
  /** "No longer in your SimpleFIN Bridge": stays linked, not fetched. */
  missing: z.boolean(),
  version: z.string(),
});
export type BankFeedAccountDto = z.infer<typeof BankFeedAccountDto>;

export const BankFeedDto = z.object({
  id: Id,
  provider: BankFeedProviderDto,
  status: BankFeedStatusDto,
  /** The host Montra fetches from (not secret). The access itself is never returned. */
  host: z.string().nullable(),
  label: z.string().nullable(),
  connectedAt: z.string(),
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextSyncAt: z.string().nullable(),
  /** The last problem with the whole feed, in words. */
  lastError: z.string().nullable(),
  accounts: z.array(BankFeedAccountDto),
  /** Requests made today (UTC) against the daily limit Montra keeps (SIMPLEFIN_REQUESTS_PER_DAY). */
  requests: z.object({ today: z.number().int(), perDay: z.number().int() }),
  /** The earliest start date a link may choose today (SIMPLEFIN_MAX_WINDOW_DAYS back). */
  earliestStartDate: CalendarDateDto,
  /** When Sync now may be pressed again; null when it may now (or the feed can't sync). */
  syncNowAfter: z.string().nullable(),
  version: z.string(),
});
export type BankFeedDto = z.infer<typeof BankFeedDto>;

/**
 * GET /bank-feeds/links: the Montra accounts a live feed imports into, and through when (§6), so the Statements screen
 * can say a statement for one will meet the feed's rows as likely duplicates.
 */
export const BankFeedLinkDto = z.object({ accountId: Id, syncedThrough: CalendarDateDto.nullable() });
export type BankFeedLinkDto = z.infer<typeof BankFeedLinkDto>;

/** GET /bank-feeds: the workspace's live feed, or null when none is connected. */
export const BankFeedStateDto = z.object({ feed: BankFeedDto.nullable() });
export type BankFeedStateDto = z.infer<typeof BankFeedStateDto>;

/**
 * POST /bank-feeds: an owner, with a recent sign-in, pastes the setup token SimpleFIN Bridge showed them. It is
 * claimed once and never stored.
 */
export const ConnectBankFeedRequest = z.object({
  setupToken: z.string().trim().min(1).max(4000),
  label: z.string().trim().max(100).optional(),
});
export type ConnectBankFeedRequest = z.infer<typeof ConnectBankFeedRequest>;

/**
 * PATCH /bank-feeds/:id/accounts/:accountId: link to an account, create one to link, or ignore (§4). Without a start
 * date, the feed starts the day after the account's latest transaction, at most SIMPLEFIN_MAX_WINDOW_DAYS back (§5).
 */
export const UpdateBankFeedAccountRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('link'),
    accountId: Id,
    startDate: CalendarDateDto.optional(),
    version: z.string(),
  }),
  z.object({
    action: z.literal('create'),
    name: z.string().trim().min(1).max(100),
    kind: BankAccountKind,
    institution: z.string().trim().max(100).optional(),
    startDate: CalendarDateDto.optional(),
    version: z.string(),
  }),
  z.object({ action: z.literal('ignore'), version: z.string() }),
  /** Back to `new`: not imported until linked again. */
  z.object({ action: z.literal('unlink'), version: z.string() }),
]);
export type UpdateBankFeedAccountRequest = z.infer<typeof UpdateBankFeedAccountRequest>;

/** PATCH /bank-feeds/:id: an owner renames or pauses the feed. */
export const UpdateBankFeedRequest = z.object({
  label: z.string().trim().max(100).nullable().optional(),
  paused: z.boolean().optional(),
  version: z.string(),
});
export type UpdateBankFeedRequest = z.infer<typeof UpdateBankFeedRequest>;
