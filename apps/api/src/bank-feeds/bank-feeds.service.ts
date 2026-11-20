/**
 * Bank feeds, connecting and linking (ADR-0055 §3, §4; FEED-01, FEED-02, FEED-05, FEED-09). An owner pastes a SimpleFIN
 * setup token; it is claimed once and the access it gives is sealed at once. The accounts the feed reports are then
 * linked to Montra accounts (by suggestion, learned like a statement's), created, or ignored. Nothing is imported here:
 * syncing is PR 3.
 *
 * The access never leaves this service unsealed except into the provider, and never reaches a DTO, a log line, an
 * error, the security log or an archive.
 */
import { createHash, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { accountProfile, addDays, todayIn, type CalendarDate, type CurrencyCode } from '@montra/domain';
import type { BankFeedAccountTable, BankFeedTable, Trx } from '@montra/db';
import { institutionKey } from '@montra/importers';
import type {
  BankFeedAccountDto,
  BankFeedDto,
  BankFeedStateDto,
  ConnectBankFeedRequest,
  UpdateBankFeedAccountRequest,
  UpdateBankFeedRequest,
} from '@montra/schemas';
import { AccountsService } from '../accounts/accounts.service.js';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { confirmMatch, forgetSignal, readMemory } from '../intakes/match-memory.js';
import {
  defaultStartDate,
  earliestStart,
  requestsLeft,
  simpleFinLimits,
  startDateProblem,
  nextSyncAt,
  syncNowAfter,
  utcDay,
  type SimpleFinLimits,
} from './limits.js';
import { BankFeedError, type BankFeedProvider, type FeedSnapshot } from './provider.js';

export const BANK_FEED_PROVIDER = Symbol('BANK_FEED_PROVIDER');

/** The column the access is sealed under (FieldCrypto binds it to the workspace and this name). */
export const FEED_SECRET_COLUMN = 'bank_feed.secret';
/** §3: a disconnected feed's links are kept this long for a reconnect. */
export const RELINK_DAYS = 30;

type Ctx = { workspaceId: string; userId: string };
type FeedRow = Selectable<BankFeedTable>;
type AccountRow = Selectable<BankFeedAccountTable>;
type AccountProblem = NonNullable<AccountRow['problem']>;
const ACCOUNT_PROBLEMS = new Set<string>(['reauth_needed', 'account_failed', 'missing_data']);

const ownerOnly = () => new AppError(403, 'bank_feed.owner_only', 'Only an owner can change the bank feed.');
const notFound = () => new AppError(404, 'bank_feed.not_found', 'No bank feed is connected.');
const stale = () =>
  new AppError(409, 'version.conflict', 'Someone changed this in the meantime. Reload and try again.');

/** §3, §7: a provider's failure in words a person can act on. The detail never reaches them. */
export function feedError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (!(e instanceof BankFeedError)) throw e;
  switch (e.code) {
    case 'invalid_token':
      return new AppError(
        422,
        'bank_feed.invalid_token',
        'That isn’t a SimpleFIN setup token. Copy it again from SimpleFIN Bridge.',
      );
    case 'not_allowed_host':
      return new AppError(
        422,
        'bank_feed.not_allowed_host',
        'That setup token points somewhere other than SimpleFIN Bridge, so Montra didn’t use it.',
      );
    case 'token_used':
      return new AppError(
        409,
        'bank_feed.token_used',
        'This setup token was already used or doesn’t exist. If you didn’t use it, disable it at SimpleFIN Bridge and make a new one.',
      );
    case 'revoked':
      return new AppError(
        409,
        'bank_feed.revoked',
        'SimpleFIN no longer accepts Montra’s access. Connect again with a new setup token.',
      );
    case 'payment_required':
      return new AppError(
        409,
        'bank_feed.payment_required',
        'Your SimpleFIN Bridge subscription needs attention.',
      );
    case 'over_budget':
      return new AppError(
        429,
        'bank_feed.daily_limit',
        'Montra has asked SimpleFIN as often as it may today. Try again tomorrow.',
      );
    case 'unreachable':
      return new AppError(
        502,
        'bank_feed.unreachable',
        'Montra couldn’t reach SimpleFIN Bridge. Try again in a few minutes.',
      );
    default:
      return new AppError(
        502,
        'bank_feed.bad_response',
        'SimpleFIN Bridge answered in a way Montra couldn’t read. Try again later.',
      );
  }
}

/** The words shown for a feed whose access stopped working (§7). */
const STATUS_WORDS: Partial<Record<FeedRow['status'], string>> = {
  revoked: 'SimpleFIN no longer accepts Montra’s access. Connect again with a new setup token.',
  payment_required: 'Your SimpleFIN Bridge subscription needs attention.',
};

/** §4: the signal a feed account is remembered by, as a statement's (ADR-0051): its id, hashed. */
export const feedSignal = (providerAccountId: string) =>
  `feed:simplefin:${createHash('sha256').update(providerAccountId).digest('hex').slice(0, 24)}`;

/** The last four digits a feed often puts in an account's name ("Checking …1234", "CARD x9876"). */
export function last4Of(name: string): string | null {
  const m = /(\d{4})\D*$/.exec(name);
  return m ? m[1]! : null;
}

interface Candidate {
  id: string;
  name: string;
  currency: string;
  last4: string | null;
  institution: string | null;
}

/**
 * §4: ADR-0051's tiers for a feed account: learned, then the last four digits (narrowed by institution), then, for a
 * name with no digits, the institution. One account or none.
 */
export function suggestAccount(
  account: { name: string; institutionName: string | null; currency: string | null },
  candidates: readonly Candidate[],
  learned: string | null,
): string | null {
  if (!account.currency) return null;
  const same = candidates.filter((c) => c.currency === account.currency);
  if (learned && same.some((c) => c.id === learned)) return learned;
  const inst = account.institutionName ? institutionKey(account.institutionName) : null;
  const byInst = (list: readonly Candidate[]) =>
    inst ? list.filter((c) => c.institution && institutionKey(c.institution) === inst) : [];
  const last4 = last4Of(account.name);
  if (last4) {
    const hits = same.filter((c) => c.last4 === last4);
    if (hits.length === 1) return hits[0]!.id;
    const narrowed = byInst(hits);
    if (narrowed.length === 1) return narrowed[0]!.id;
    // Digits that match no account (or several): another account at the same bank would be a wrong guess.
    return null;
  }
  const byInstitution = byInst(same);
  return byInstitution.length === 1 ? byInstitution[0]!.id : null;
}

@Injectable()
export class BankFeedsService {
  private readonly limits: SimpleFinLimits;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(BANK_FEED_PROVIDER) private readonly provider: BankFeedProvider,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.limits = simpleFinLimits(config);
  }

  // ----- Reading ---------------------------------------------------------------------------------------------------

  /** GET /bank-feeds: the live feed and its accounts, for those who may see it (RLS), else null. */
  state(ctx: Ctx): Promise<BankFeedStateDto> {
    return this.db.run(ctx, async (trx) => {
      const feed = await this.live(trx, ctx);
      return { feed: feed ? await this.dto(trx, ctx, feed) : null };
    });
  }

  // ----- Connecting (§3) -------------------------------------------------------------------------------------------

  /**
   * Claims the token once, seals the access before anything else can fail, then lists the accounts (one request). A
   * listing that fails leaves the feed connected with the problem shown; Refresh tries again.
   */
  async connect(ctx: Ctx, role: string, req: ConnectBankFeedRequest): Promise<BankFeedStateDto> {
    if (role !== 'owner') throw ownerOnly();
    const existing = await this.db.run(ctx, (trx) => this.live(trx, ctx));
    if (existing)
      throw new AppError(409, 'bank_feed.exists', 'A bank feed is already connected. Disconnect it first.');
    let claimed: { secret: string; host: string };
    try {
      claimed = await this.provider.connect({ setupToken: req.setupToken });
    } catch (e) {
      throw feedError(e);
    }
    const now = new Date();
    const feedId = await this.db.run(ctx, async (trx) => {
      const syncMinute = 120 + randomInt(0, 240);
      const row = await trx
        .insertInto('app.bank_feed')
        .values({
          workspace_id: ctx.workspaceId,
          provider: 'simplefin',
          secret_enc: (await this.crypto.encrypt(trx, ctx.workspaceId, FEED_SECRET_COLUMN, claimed.secret))!,
          host: claimed.host,
          label: req.label?.trim() || null,
          connected_by: ctx.userId,
          // §5: a random minute of the early morning, workspace time (the Bridge asks for random times).
          sync_minute: syncMinute,
          requests_day: utcDay(now),
          requests_today: 1,
          // §5: the first daily sync; linking an account brings it forward to now.
          next_sync_at: nextSyncAt(now, await this.timeZone(trx, ctx), syncMinute, this.limits),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.security(trx, ctx, 'bank_feed_connected', { provider: 'simplefin', host: claimed.host });
      return row.id;
    });
    await this.list(ctx, feedId, 'connect');
    return this.state(ctx);
  }

  /** POST /bank-feeds/:id/refresh: lists the accounts again (one request), for new or renamed accounts. */
  async refresh(ctx: Ctx, role: string, feedId: string): Promise<BankFeedStateDto> {
    if (role !== 'owner') throw ownerOnly();
    await this.list(ctx, feedId, 'manual');
    return this.state(ctx);
  }

  /** One listing: counts the request, records the run, stores the accounts, and says what went wrong in words. */
  private async list(ctx: Ctx, feedId: string, trigger: 'connect' | 'manual'): Promise<void> {
    const { secret } = await this.db.run(ctx, async (trx) => {
      const feed = await this.feed(trx, ctx, feedId);
      if (feed.status === 'disconnected' || !feed.secret_enc) throw notFound();
      // The connect claim already counted one request; this listing is the second.
      if (trigger !== 'connect' && requestsLeft(counter(feed), new Date(), this.limits) <= 0)
        throw feedError(new BankFeedError('over_budget'));
      await this.count(trx, ctx, feed, 1);
      const plain = await this.crypto.decrypt(trx, ctx.workspaceId, FEED_SECRET_COLUMN, feed.secret_enc);
      return { secret: plain ?? '' };
    });
    let snapshot: FeedSnapshot | null = null;
    let failure: AppError | null = null;
    let status: FeedRow['status'] | null = null;
    try {
      snapshot = await this.provider.listAccounts(secret);
    } catch (e) {
      failure = feedError(e);
      if (e instanceof BankFeedError && (e.code === 'revoked' || e.code === 'payment_required'))
        status = e.code;
    }
    await this.db.run(ctx, async (trx) => {
      await trx
        .insertInto('app.bank_feed_run')
        .values({
          workspace_id: ctx.workspaceId,
          bank_feed_id: feedId,
          trigger: trigger === 'connect' ? 'connect' : 'manual',
          finished_at: new Date(),
          outcome: failure ? 'failed' : 'ok',
          requests: trigger === 'connect' ? 2 : 1,
          accounts: snapshot?.accounts.length ?? 0,
          error: failure?.message ?? null,
        })
        .execute();
      if (snapshot) await this.store(trx, ctx, feedId, snapshot);
      await trx
        .updateTable('app.bank_feed')
        .set({
          last_error: failure?.message ?? null,
          ...(status ? { status } : {}),
          ...(!failure ? { last_success_at: new Date() } : {}),
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .execute();
    });
    // A refresh that failed says why; a connect that listed nothing still connected, and shows the problem.
    if (failure && trigger !== 'connect') throw failure;
  }

  /**
   * The accounts a listing reported: new ones added, known ones refreshed, gone ones marked (§7). A reconnect within
   * RELINK_DAYS takes over the links of the feed it replaces (§3).
   */
  async store(trx: Trx, ctx: Ctx, feedId: string, snap: FeedSnapshot): Promise<void> {
    const now = new Date();
    const institutions = new Map(snap.institutions.map((i) => [i.id, i.name]));
    const mine = await trx
      .selectFrom('app.bank_feed_account')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('bank_feed_id', '=', feedId)
      .execute();
    const previous = await trx
      .selectFrom('app.bank_feed_account as a')
      .innerJoin('app.bank_feed as f', (j) =>
        j.onRef('f.workspace_id', '=', 'a.workspace_id').onRef('f.id', '=', 'a.bank_feed_id'),
      )
      .selectAll('a')
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('f.status', '=', 'disconnected')
      .where('f.provider', '=', 'simplefin')
      .where('f.disconnected_at', '>', new Date(now.getTime() - RELINK_DAYS * 86_400_000))
      .execute();
    const problemFor = (accountId: string, institutionId: string | null) =>
      snap.problems.find(
        (p) => p.accountId === accountId || (p.institutionId !== null && p.institutionId === institutionId),
      ) ?? null;

    for (const a of snap.accounts) {
      const problem = problemFor(a.id, a.institutionId);
      const fields = {
        provider_institution_id: a.institutionId,
        name: a.name,
        institution_name: a.institutionId ? (institutions.get(a.institutionId) ?? null) : null,
        currency: a.currency,
        last_balance_minor: a.balance,
        last_available_minor: a.available,
        balance_date: a.balanceDate,
        problem: !problem
          ? null
          : ACCOUNT_PROBLEMS.has(problem.code)
            ? (problem.code as AccountProblem)
            : 'unknown',
        last_error: problem?.message || null,
        missing_since: null,
        last_seen_at: now,
        updated_at: now,
      } as const;
      const known = mine.find((m) => m.provider_account_id === a.id);
      if (known) {
        await trx
          .updateTable('app.bank_feed_account')
          .set({ ...fields, version: known.version + 1n })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', known.id)
          .execute();
        continue;
      }
      const old = previous.find((p) => p.provider_account_id === a.id);
      if (old) {
        await trx
          .updateTable('app.bank_feed_account')
          .set({ ...fields, bank_feed_id: feedId, version: old.version + 1n })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', old.id)
          .execute();
        continue;
      }
      await trx
        .insertInto('app.bank_feed_account')
        .values({ workspace_id: ctx.workspaceId, bank_feed_id: feedId, provider_account_id: a.id, ...fields })
        .execute();
    }
    const seen = new Set(snap.accounts.map((a) => a.id));
    const gone = mine
      .filter((m) => !seen.has(m.provider_account_id) && m.missing_since === null)
      .map((m) => m.id);
    if (gone.length)
      await trx
        .updateTable('app.bank_feed_account')
        .set({ missing_since: now, updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', gone)
        .execute();
  }

  // ----- Linking (§4) ----------------------------------------------------------------------------------------------

  /** PATCH /bank-feeds/:id/accounts/:accountId: link, create and link, ignore, or unlink. */
  async updateAccount(
    ctx: Ctx,
    role: string,
    feedId: string,
    accountId: string,
    req: UpdateBankFeedAccountRequest,
  ): Promise<BankFeedStateDto> {
    if (role !== 'owner') throw ownerOnly();
    // Creating needs the feed's transactions to work out the opening balance: asked before the transaction.
    const opening =
      req.action === 'create' ? await this.openingFor(ctx, feedId, accountId, req.startDate) : null;
    await this.db.run(ctx, async (trx) => {
      const feed = await this.feed(trx, ctx, feedId);
      if (feed.status === 'disconnected') throw notFound();
      const account = await trx
        .selectFrom('app.bank_feed_account')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('bank_feed_id', '=', feedId)
        .where('id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!account)
        throw new AppError(404, 'bank_feed.account_not_found', 'That account isn’t in the bank feed.');
      if (String(account.version) !== req.version) throw stale();
      const today = await this.today(trx, ctx);
      const signal = feedSignal(account.provider_account_id);
      let detail: Record<string, unknown>;

      if (req.action === 'ignore' || req.action === 'unlink') {
        if (account.state === 'linked' && account.ledger_account_id)
          await forgetSignal(trx, ctx, 'statement', signal);
        await this.setAccount(trx, ctx, account, {
          state: req.action === 'ignore' ? 'ignored' : 'new',
          ledger_account_id: null,
          start_date: null,
          synced_through: null,
        });
        detail = { action: req.action };
      } else {
        if (!account.currency)
          throw new AppError(
            422,
            'bank_feed.custom_currency',
            'This account isn’t in a currency Montra knows, so it can’t be linked.',
          );
        let ledgerId: string;
        if (req.action === 'create') {
          ledgerId = await this.accounts.createIn(trx, ctx, {
            name: req.name,
            kind: req.kind,
            currency: account.currency as CurrencyCode,
            ...(req.institution || account.institution_name
              ? { institution: req.institution || account.institution_name! }
              : {}),
            ...(last4Of(account.name) ? { last4: last4Of(account.name)! } : {}),
            ...(opening
              ? {
                  openingBalance: {
                    amount: String(
                      accountProfile(req.kind).side === 'liability' ? -opening.balance : opening.balance,
                    ),
                    currency: account.currency as CurrencyCode,
                  },
                  openingDate: addDays(opening.startDate, -1),
                }
              : {}),
          });
        } else {
          ledgerId = req.accountId;
          await this.assertLinkable(trx, ctx, ledgerId, account);
        }
        const start = req.action === 'create' && opening ? opening.startDate : (req.startDate ?? null);
        const startDate =
          start ?? defaultStartDate(await this.latest(trx, ctx, ledgerId), today, this.limits);
        const problem = startDateProblem(startDate, today, this.limits);
        if (problem)
          throw new AppError(
            422,
            'bank_feed.start_date',
            problem === 'in_future'
              ? 'The start date can’t be in the future.'
              : `The start date can be at most ${this.limits.maxWindowDays} days back. Older history comes from uploaded statements.`,
          );
        try {
          await this.setAccount(trx, ctx, account, {
            state: 'linked',
            ledger_account_id: ledgerId,
            start_date: startDate,
            synced_through: null,
          });
        } catch (e) {
          if (/bank_feed_account_ledger/.test(String((e as Error).message)))
            throw new AppError(409, 'bank_feed.already_linked', 'That account already has a bank feed.');
          throw e;
        }
        await confirmMatch(trx, ctx, 'statement', signal, ledgerId);
        // §5: the first sync for a newly linked account runs now, not at tomorrow's minute.
        await this.dueNow(trx, ctx, feedId);
        detail = { action: req.action, accountId: ledgerId, startDate };
      }
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: ctx.userId,
          action: `bank_feed.account_${req.action === 'create' ? 'linked' : req.action === 'link' ? 'linked' : req.action === 'ignore' ? 'ignored' : 'unlinked'}`,
          subject_type: 'bank_feed_account',
          subject_id: account.id,
          diff: JSON.stringify(detail),
        })
        .execute();
      await this.security(trx, ctx, 'bank_feed_changed', { account: account.id, ...detail });
    });
    return this.state(ctx);
  }

  /** A Montra account a feed account may import into: a bank, card or loan account in its currency, not archived. */
  private async assertLinkable(trx: Trx, ctx: Ctx, ledgerId: string, account: AccountRow): Promise<void> {
    const target = await trx
      .selectFrom('app.ledger_account as l')
      .innerJoin('app.bank_account as b', (j) =>
        j.onRef('b.workspace_id', '=', 'l.workspace_id').onRef('b.ledger_account_id', '=', 'l.id'),
      )
      .select(['l.currency', 'l.archived_at', 'b.kind'])
      .where('l.workspace_id', '=', ctx.workspaceId)
      .where('l.id', '=', ledgerId)
      .executeTakeFirst();
    if (!target || target.archived_at || !accountProfile(target.kind).imports)
      throw new AppError(422, 'bank_feed.not_linkable', 'Pick a bank, card or loan account that’s open.');
    if (target.currency !== account.currency)
      throw new AppError(
        422,
        'bank_feed.currency_mismatch',
        `That account is in ${target.currency}; the feed account is in ${account.currency}.`,
      );
  }

  /**
   * §4 Create account: the opening balance the day before the start date, so the transactions a first sync brings
   * aren't counted twice. The feed's balance less what it reports from the start date to the balance's date (one
   * request).
   */
  private async openingFor(
    ctx: Ctx,
    feedId: string,
    accountId: string,
    asked: CalendarDate | undefined,
  ): Promise<{ balance: bigint; startDate: CalendarDate } | null> {
    const { secret, account, today } = await this.db.run(ctx, async (trx) => {
      const feed = await this.feed(trx, ctx, feedId);
      if (feed.status === 'disconnected' || !feed.secret_enc) throw notFound();
      const account = await trx
        .selectFrom('app.bank_feed_account')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('bank_feed_id', '=', feedId)
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (!account)
        throw new AppError(404, 'bank_feed.account_not_found', 'That account isn’t in the bank feed.');
      if (requestsLeft(counter(feed), new Date(), this.limits) <= 0)
        throw feedError(new BankFeedError('over_budget'));
      await this.count(trx, ctx, feed, 1);
      const plain = await this.crypto.decrypt(trx, ctx.workspaceId, FEED_SECRET_COLUMN, feed.secret_enc);
      return { secret: plain ?? '', account, today: await this.today(trx, ctx) };
    });
    if (account.last_balance_minor === null || !account.balance_date) return null;
    const startDate = asked ?? earliestStart(today, this.limits);
    const problem = startDateProblem(startDate, today, this.limits);
    if (problem) return null;
    let snap: FeedSnapshot;
    try {
      snap = await this.provider.fetchTransactions(secret, { from: startDate, to: addDays(today, 1) });
    } catch (e) {
      throw feedError(e);
    }
    const reported = snap.accounts.find((a) => a.id === account.provider_account_id);
    const balance = reported?.balance ?? account.last_balance_minor;
    const balanceDate = reported?.balanceDate ?? (account.balance_date as CalendarDate);
    const after = (reported?.transactions ?? [])
      .filter((t) => t.date >= startDate && t.date <= balanceDate)
      .reduce((sum, t) => sum + t.amount, 0n);
    return { balance: balance - after, startDate };
  }

  // ----- The feed itself -------------------------------------------------------------------------------------------

  /** PATCH /bank-feeds/:id: rename, pause or resume (owner). */
  async update(
    ctx: Ctx,
    role: string,
    feedId: string,
    req: UpdateBankFeedRequest,
  ): Promise<BankFeedStateDto> {
    if (role !== 'owner') throw ownerOnly();
    await this.db.run(ctx, async (trx) => {
      const feed = await this.feed(trx, ctx, feedId);
      if (feed.status === 'disconnected') throw notFound();
      if (String(feed.version) !== req.version) throw stale();
      const status =
        req.paused === undefined
          ? feed.status
          : req.paused
            ? 'paused'
            : feed.status === 'paused'
              ? 'active'
              : feed.status;
      const resumed = feed.status === 'paused' && status === 'active';
      await trx
        .updateTable('app.bank_feed')
        .set({
          ...(req.label !== undefined ? { label: req.label?.trim() || null } : {}),
          status,
          ...(resumed
            ? {
                next_sync_at: nextSyncAt(
                  new Date(),
                  await this.timeZone(trx, ctx),
                  feed.sync_minute,
                  this.limits,
                ),
              }
            : {}),
          version: feed.version + 1n,
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .execute();
      await this.security(trx, ctx, 'bank_feed_changed', {
        ...(req.label !== undefined ? { label: true } : {}),
        ...(req.paused !== undefined ? { paused: req.paused } : {}),
      });
    });
    return this.state(ctx);
  }

  /**
   * §3: disconnecting wipes the access at once and stops the feed. Its accounts' links stay RELINK_DAYS for a
   * reconnect; imported transactions are ordinary ledger data and stay. The person removes Montra at the Bridge too.
   */
  async disconnect(ctx: Ctx, role: string, feedId: string, version: string): Promise<BankFeedStateDto> {
    if (role !== 'owner') throw ownerOnly();
    await this.db.run(ctx, async (trx) => {
      const feed = await this.feed(trx, ctx, feedId);
      if (feed.status === 'disconnected') throw notFound();
      if (String(feed.version) !== version) throw stale();
      await trx
        .updateTable('app.bank_feed')
        .set({
          status: 'disconnected',
          disconnected_at: new Date(),
          secret_enc: null,
          next_sync_at: null,
          version: feed.version + 1n,
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', feedId)
        .execute();
      await this.security(trx, ctx, 'bank_feed_disconnected', { provider: feed.provider, host: feed.host });
    });
    return this.state(ctx);
  }

  // ----- Inside ----------------------------------------------------------------------------------------------------

  private live(trx: Trx, ctx: Ctx): Promise<FeedRow | undefined> {
    return trx
      .selectFrom('app.bank_feed')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '<>', 'disconnected')
      .executeTakeFirst();
  }

  private async feed(trx: Trx, ctx: Ctx, feedId: string): Promise<FeedRow> {
    const feed = await trx
      .selectFrom('app.bank_feed')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', feedId)
      .forUpdate()
      .executeTakeFirst();
    if (!feed) throw notFound();
    return feed;
  }

  /** §5: one more request against today's (UTC) budget. */
  private async count(trx: Trx, ctx: Ctx, feed: FeedRow, n: number): Promise<void> {
    const day = utcDay(new Date());
    const today = feed.requests_day === day ? feed.requests_today : 0;
    await trx
      .updateTable('app.bank_feed')
      .set({ requests_day: day, requests_today: today + n })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', feed.id)
      .execute();
  }

  private async setAccount(
    trx: Trx,
    ctx: Ctx,
    account: AccountRow,
    set: Pick<AccountRow, 'state' | 'ledger_account_id' | 'start_date' | 'synced_through'>,
  ): Promise<void> {
    await trx
      .updateTable('app.bank_feed_account')
      .set({ ...set, version: account.version + 1n, updated_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', account.id)
      .execute();
  }

  /** The latest transaction already in a Montra account, for the default start date (§5). */
  private async latest(trx: Trx, ctx: Ctx, ledgerId: string): Promise<CalendarDate | null> {
    const row = await trx
      .selectFrom('app.posting')
      .select((eb) => eb.fn.max('entry_date').as('latest'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('ledger_account_id', '=', ledgerId)
      .executeTakeFirst();
    return (row?.latest as CalendarDate | null | undefined) ?? null;
  }

  private async today(trx: Trx, ctx: Ctx): Promise<CalendarDate> {
    return todayIn(await this.timeZone(trx, ctx));
  }

  private async timeZone(trx: Trx, ctx: Ctx): Promise<string> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('time_zone')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return ws.time_zone;
  }

  /** The feed is due now, and the sync job is woken for it. */
  private async dueNow(trx: Trx, ctx: Ctx, feedId: string): Promise<void> {
    await trx
      .updateTable('app.bank_feed')
      .set({ next_sync_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', feedId)
      .where('status', 'in', ['active', 'failing'])
      .execute();
    await sql`select app.schedule_system_job('schedule', 'bankfeed.sync', now())`.execute(trx);
  }

  /**
   * POST /bank-feeds/:id/sync (§5, D5): owners, admins and partners, at most once per SIMPLEFIN_SYNC_NOW_MINUTES. It
   * marks the feed due (through `app.bank_feed_sync_now`, as only owners write the feed) and wakes the job.
   */
  async syncNow(ctx: Ctx, role: string, feedId: string): Promise<BankFeedStateDto> {
    if (!['owner', 'admin', 'partner'].includes(role))
      throw new AppError(
        403,
        'bank_feed.not_allowed',
        'Only owners, admins and partners can sync the bank feed.',
      );
    const r = await this.db.run(ctx, async (trx) => {
      const { rows } = await sql<{ outcome: string; after: Date | null }>`
        select * from app.bank_feed_sync_now(${feedId}::uuid, ${this.limits.syncNowMinutes}::int)`.execute(
        trx,
      );
      if (rows[0]?.outcome === 'ok')
        await sql`select app.schedule_system_job('schedule', 'bankfeed.sync', now())`.execute(trx);
      return rows[0];
    });
    if (r?.outcome === 'not_found') throw notFound();
    if (r?.outcome === 'not_syncing')
      throw new AppError(
        409,
        'bank_feed.not_syncing',
        'The bank feed isn’t syncing now. Resume it or fix its problem first.',
      );
    if (r?.outcome === 'too_soon')
      throw new AppError(
        429,
        'bank_feed.sync_soon',
        `The bank feed was synced moments ago. You can sync again after ${new Date(r.after!).toISOString()}.`,
      );
    return this.state(ctx);
  }

  private async security(trx: Trx, ctx: Ctx, kind: string, detail: Record<string, unknown>): Promise<void> {
    await trx
      .insertInto('app.security_event')
      .values({ user_id: ctx.userId, workspace_id: ctx.workspaceId, kind, detail: JSON.stringify(detail) })
      .execute();
  }

  private async dto(trx: Trx, ctx: Ctx, feed: FeedRow): Promise<BankFeedDto> {
    const rows = await trx
      .selectFrom('app.bank_feed_account')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('bank_feed_id', '=', feed.id)
      .orderBy('institution_name')
      .orderBy('name')
      .execute();
    // Suggestions for accounts not decided yet (§4): bank, card and loan accounts not linked to a feed already.
    const undecided = rows.filter((r) => r.state === 'new');
    let candidates: Candidate[] = [];
    if (undecided.length) {
      const linked = new Set(rows.filter((r) => r.state === 'linked').map((r) => r.ledger_account_id));
      candidates = (
        await trx
          .selectFrom('app.ledger_account as l')
          .innerJoin('app.bank_account as b', (j) =>
            j.onRef('b.workspace_id', '=', 'l.workspace_id').onRef('b.ledger_account_id', '=', 'l.id'),
          )
          .select(['l.id', 'l.name', 'l.currency', 'b.last4', 'b.institution', 'b.kind'])
          .where('l.workspace_id', '=', ctx.workspaceId)
          .where('l.archived_at', 'is', null)
          .execute()
      ).filter((c) => accountProfile(c.kind).imports && !linked.has(c.id));
    }
    const accounts: BankFeedAccountDto[] = [];
    for (const r of rows) {
      let suggested: string | null = null;
      if (r.state === 'new') {
        const memory = await readMemory(trx, ctx, 'statement', feedSignal(r.provider_account_id));
        suggested = suggestAccount(
          { name: r.name, institutionName: r.institution_name, currency: r.currency },
          candidates,
          memory && memory.confirmations > 0 ? memory.target_id : null,
        );
      }
      accounts.push({
        id: r.id,
        name: r.name,
        institution: r.institution_name,
        currency: r.currency as CurrencyCode | null,
        state: r.state,
        accountId: r.state === 'linked' ? r.ledger_account_id : null,
        suggestedAccountId: suggested,
        startDate: r.start_date as CalendarDate | null,
        syncedThrough: r.synced_through as CalendarDate | null,
        balance:
          r.last_balance_minor !== null && r.balance_date
            ? {
                amount: String(r.last_balance_minor),
                available: r.last_available_minor === null ? null : String(r.last_available_minor),
                date: r.balance_date as CalendarDate,
              }
            : null,
        problem: r.problem ? { code: r.problem, message: r.last_error ?? '' } : null,
        missing: r.missing_since !== null,
        version: String(r.version),
      });
    }
    const now = new Date();
    const today = await this.today(trx, ctx);
    return {
      id: feed.id,
      provider: feed.provider,
      status: feed.status,
      host: feed.host,
      label: feed.label,
      connectedAt: feed.connected_at.toISOString(),
      lastSyncAt: feed.last_sync_at?.toISOString() ?? null,
      lastSuccessAt: feed.last_success_at?.toISOString() ?? null,
      nextSyncAt: feed.next_sync_at?.toISOString() ?? null,
      lastError: STATUS_WORDS[feed.status] ?? feed.last_error,
      accounts,
      requests: {
        today: feed.requests_day === utcDay(now) ? feed.requests_today : 0,
        perDay: this.limits.requestsPerDay,
      },
      earliestStartDate: earliestStart(today, this.limits),
      syncNowAfter: syncNowAfter(feed.last_manual_sync_at, now, this.limits)?.toISOString() ?? null,
      version: String(feed.version),
    };
  }
}

const counter = (feed: FeedRow) => ({
  requestsDay: (feed.requests_day as CalendarDate | null) ?? null,
  requestsToday: feed.requests_today,
});
