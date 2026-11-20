/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, todayIn, type CalendarDate } from '@montra/domain';
import { BankFeedSync, feedBatchName } from '../src/bank-feeds/bank-feeds.sync.js';
import { lastSyncDay, nextSyncAt, nextUtcDay, zonedInstant } from '../src/bank-feeds/limits.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import { ADMIN_URL } from './env.js';
import { startFakeSimpleFin, type FakeSimpleFin } from './fakes/simplefin.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Bank feeds, PR 3a: syncing into Review (ADR-0055 §5; FEED-03, FEED-04, FEED-05), against a synthetic SimpleFIN on
// this machine. Every batch waits in Review in this PR.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-feed-sync@example.com';
const PARTNER = 'partner-feed-sync@example.com';
const VIEWER = 'viewer-feed-sync@example.com';
const d = (s: string) => s as CalendarDate;

describe('when a feed syncs (ADR-0055 §5)', () => {
  it('runs at the feed’s minute of the workspace’s day, through daylight-saving changes', () => {
    expect(zonedInstant(d('2026-11-20'), 180, 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-20T11:00:00.000Z',
    );
    expect(zonedInstant(d('2026-11-20'), 180, 'UTC').toISOString()).toBe('2026-11-20T03:00:00.000Z');
    // 01:30 happens twice on 1 November: the first.
    expect(zonedInstant(d('2026-11-01'), 90, 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-01T08:30:00.000Z',
    );
    // 02:30 doesn't happen on 8 March: an hour away, never a day.
    const gap = zonedInstant(d('2026-03-08'), 150, 'America/Los_Angeles').toISOString();
    expect(['2026-03-08T09:30:00.000Z', '2026-03-08T10:30:00.000Z']).toContain(gap);
    const now = new Date('2026-11-20T12:00:00Z');
    expect(nextSyncAt(now, 'America/Los_Angeles', 180, { syncsPerDay: 1 }).toISOString()).toBe(
      '2026-11-21T11:00:00.000Z',
    );
    // SIMPLEFIN_SYNCS_PER_DAY=2: every twelve hours from the minute.
    expect(nextSyncAt(now, 'America/Los_Angeles', 180, { syncsPerDay: 2 }).toISOString()).toBe(
      '2026-11-20T23:00:00.000Z',
    );
    expect(nextUtcDay(now).toISOString()).toBe('2026-11-21T00:00:00.000Z');
    // Live run: SimpleFIN dates rows in UTC, already tomorrow in Los Angeles at 06:00 UTC; a sync takes them too.
    expect(lastSyncDay(new Date('2026-11-21T06:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-21');
    expect(lastSyncDay(new Date('2026-11-21T06:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-21');
    expect(lastSyncDay(new Date('2026-11-21T20:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-22');
    expect(feedBatchName('Checking …1234', d('2026-11-01'), d('2026-11-20'))).toBe(
      'SimpleFIN · Checking …1234 · 2026-11-01 to 2026-11-20',
    );
  });
});

describe('syncing (ADR-0055 §5; FEED-03, FEED-04, FEED-05)', () => {
  let h: Harness;
  let c: Client;
  let partner: Client;
  let viewer: Client;
  let db: pg.Client;
  let fake: FakeSimpleFin;
  let sync: BankFeedSync;
  let worker: Worker;
  let wsId: string;
  let ownerId: string;
  let url: (p: string) => string;
  let checking: string;
  let feedId: string;
  let today: CalendarDate;

  /** Epoch seconds at noon UTC, `back` days before today (UTC). */
  const posted = (back: number) => Date.parse(`${addDays(todayIn('UTC'), -back)}T12:00:00Z`) / 1000;
  const dateOf = (back: number) => addDays(todayIn('UTC'), -back);
  const ctx = () => ({ workspaceId: wsId, userId: ownerId });
  const feed = async () => (await c.get(url('/bank-feeds'))).body.feed;
  const feedRow = async () => (await db.query(`select * from app.bank_feed where id = $1`, [feedId])).rows[0];
  const account = (f: any, name: string) => f.accounts.find((a: any) => a.name === name);
  const batches = async () =>
    (
      await db.query(
        `select b.id, b.status, b.file_name, b.file_id, b.ledger_account_id, b.min_date, b.max_date,
                array_agg(r.external_id order by r.external_id) as ids
           from app.import_batch b join app.import_row r on r.import_batch_id = b.id and r.workspace_id = b.workspace_id
          where b.workspace_id = $1 and b.source = 'feed' group by b.workspace_id, b.id order by b.created_at, b.file_name`,
        [wsId],
      )
    ).rows;
  const accountsRequests = () =>
    fake.log.filter((r) => r.path.endsWith('/accounts') && !r.query['balances-only']);

  beforeAll(async () => {
    fake = await startFakeSimpleFin();
    fake.accounts[0]!.balanceDate = posted(1);
    fake.accounts[0]!.transactions = [
      { id: 'T-1', posted: posted(20), amount: '-40.00', description: 'Zelle Payment To SAM EXAMPLE' },
      { id: 'T-2', posted: posted(5), amount: '2500.00', description: 'ACME CORP PAYROLL', payee: 'ACME' },
      { id: 'T-P', posted: 0, amount: '-12.50', description: 'COFFEE (pending)', pending: true },
    ];
    fake.accounts[1]!.balance = '-500.00';
    fake.accounts[1]!.balanceDate = posted(1);
    fake.accounts[1]!.transactions = [
      { id: 'C-0', posted: posted(30), amount: '-99.00', description: 'Before the start date' },
      { id: 'C-1', posted: posted(10), amount: '-310.20', description: 'GROCERY MART', memo: 'Store 12' },
    ];
    h = await startHarness({
      AI_PROVIDER: 'fake',
      SIMPLEFIN_ALLOW_LOCAL_HTTP: 'on',
      SIMPLEFIN_REQUESTS_PER_DAY: '30',
    });
    sync = h.app.get(BankFeedSync);
    h.app.get(ImportJobs).register();
    worker = h.app.get(Worker);
    c = h.as(OWNER);
    partner = h.as(PARTNER);
    viewer = h.as(VIEWER);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    const ws = (
      await c.post('/v1/workspaces', { name: 'Feed sync', baseCurrency: 'USD', template: 'household' })
    ).body;
    wsId = ws.id;
    url = (p) => `/v1/workspaces/${wsId}${p}`;
    ownerId = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0].id;
    today = todayIn(
      (await db.query(`select time_zone from app.workspace where id = $1`, [wsId])).rows[0].time_zone,
    );
    for (const [who, email, role] of [
      [partner, PARTNER, 'partner'],
      [viewer, VIEWER, 'viewer'],
    ] as const) {
      const invite = await c.post(url('/sharing/invites'), { email, role });
      expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
    }
    checking = (
      await c.post(url('/accounts'), {
        name: 'Everyday',
        kind: 'checking',
        institution: 'Example Credit Union',
        last4: '1234',
        openingBalance: { amount: '0', currency: 'USD' },
        openingDate: addDays(today, -200),
      })
    ).body.id;
    const connected = (await c.post(url('/bank-feeds'), { setupToken: fake.newSetupToken() })).body.feed;
    feedId = connected.id;
    // Connecting schedules the first daily sync at the feed's minute, tomorrow or later today.
    expect(new Date(connected.nextSyncAt).getTime()).toBeGreaterThan(Date.now());
  });

  afterAll(async () => {
    await db?.query(`delete from app.bank_feed where workspace_id = $1`, [wsId]);
    // Nothing of ours may wake a worker in another test file.
    await db?.query(`delete from app.job where type = 'bankfeed.sync'`);
    await db?.end();
    await h?.close();
    await fake?.close();
  });

  it('brings the first sync forward to now when an account is linked, and wakes the job', async () => {
    let f = await feed();
    const chk = account(f, 'Checking …1234');
    f = (
      await c.patch(url(`/bank-feeds/${f.id}/accounts/${chk.id}`), {
        action: 'link',
        accountId: checking,
        version: chk.version,
      })
    ).body.feed;
    const card = account(f, 'Rewards Card …9876');
    f = (
      await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), {
        action: 'create',
        name: 'Rewards card',
        kind: 'credit_card',
        startDate: addDays(today, -15),
        version: card.version,
      })
    ).body.feed;
    expect(new Date((await feedRow()).next_sync_at).getTime()).toBeLessThanOrEqual(Date.now());
    const due = (
      await db.query(`select bank_feed_id from app.bank_feed_due() where workspace_id = $1`, [wsId])
    ).rows;
    expect(due).toEqual([{ bank_feed_id: feedId }]);
    const jobs = (await db.query(`select status from app.job where type = 'bankfeed.sync'`)).rows;
    expect(jobs).toEqual([{ status: 'queued' }]);
  });

  it('asks once for every linked account, and stages each account’s posted rows from its start date', async () => {
    const before = (await feedRow()).requests_today;
    fake.log = [];
    const result = await sync.sync(ctx(), feedId);
    expect(result).toMatchObject({ outcome: 'ok', batches: 2, rows: 3, committed: 2 });
    // One request, from the earliest start date (90 days back for an account with no history) to tomorrow.
    expect(accountsRequests()).toHaveLength(1);
    const q = accountsRequests()[0]!.query;
    expect(q['start-date']).toBe(String(Date.parse(`${addDays(today, -89)}T00:00:00Z`) / 1000));
    expect(q['end-date']).toBe(String(Date.parse(`${addDays(today, 1)}T00:00:00Z`) / 1000));
    expect(q.pending).toBeUndefined();
    expect((await feedRow()).requests_today).toBe(before + 1);

    // Nothing to decide in either: both import themselves (owner's answer 4), with Undo.
    let staged = await batches();
    expect(staged.map((b) => [b.status, b.file_id, b.ids])).toEqual(
      expect.arrayContaining([
        ['committing', null, ['T-1', 'T-2']],
        ['committing', null, ['C-1']],
      ]),
    );
    await worker.drain();
    staged = await batches();
    expect(staged.map((b) => b.status)).toEqual(['committed', 'committed']);
    const chkBatch = staged.find((b) => b.ledger_account_id === checking)!;
    expect(chkBatch.file_name).toBe(
      feedBatchName('Checking …1234', dateOf(20) as CalendarDate, dateOf(5) as CalendarDate),
    );
    const cardBatch = staged.find((b) => b.ids[0] === 'C-1')!;
    // Rows as a file's are staged: the provider's words, the memo after the description.
    const rows = (await c.get(url(`/imports/${cardBatch.id}/rows`))).body.data;
    expect(rows.map((r: any) => [r.description, r.amount.amount])).toEqual([
      ['GROCERY MART · Store 12', '-31020'],
    ]);
    const tx = (
      await db.query(
        `select t.source from app.transaction t join app.transaction_source s on s.transaction_id = t.id
          where s.import_batch_id = any($1::uuid[])`,
        [staged.map((b) => b.id)],
      )
    ).rows;
    expect(tx.map((r) => r.source)).toEqual(['feed', 'feed', 'feed']);

    // FEED-07: the card was opened from the feed's balance, so it matches; the checking account started at zero months
    // ago, so the institution's 1,520.75 doesn't match the 2,460.00 Montra holds.
    const card = (await c.get(url(`/imports/${cardBatch.id}`))).body;
    expect(card).toMatchObject({ balanceCheck: 'ok', balanceGap: null });
    const chk = (await c.get(url(`/imports/${chkBatch.id}`))).body;
    expect(chk).toMatchObject({ balanceCheck: 'mismatch', balanceGap: { amount: '93925', currency: 'USD' } });

    // Each account's cursor is where its rows reach; the feed is rescheduled for its daily minute.
    const f = await feed();
    expect(account(f, 'Checking …1234').syncedThrough).toBe(dateOf(5));
    expect(account(f, 'Rewards Card …9876').syncedThrough).toBe(dateOf(10));
    expect(new Date(f.nextSyncAt).getTime()).toBeGreaterThan(Date.now());
    expect(f).toMatchObject({ status: 'active', lastError: null });
    // Nothing waits in Review.
    expect((await c.get(url('/imports?waiting=feed'))).body.data).toEqual([]);
    // §6: the Statements screen knows which accounts have a feed, and through when (not for those who can't see it).
    const links = (await c.get(url('/bank-feeds/links'))).body.data;
    expect(links).toEqual(
      expect.arrayContaining([
        { accountId: checking, syncedThrough: dateOf(5) },
        { accountId: account(f, 'Rewards Card …9876').accountId, syncedThrough: dateOf(10) },
      ]),
    );
    expect((await viewer.get(url('/bank-feeds/links'))).body.data).toEqual([]);
  });

  it('never stages a row twice, and holds an account whose balance didn’t match for a person', async () => {
    expect((await sync.sync(ctx(), feedId)).batches).toBe(0);
    fake.accounts[0]!.transactions.push({
      id: 'T-3',
      posted: posted(1),
      amount: '-8.75',
      description: 'BAKERY',
    });
    // Clean, but the checking account's last automatic import missed the balance: it waits in Review.
    expect(await sync.sync(ctx(), feedId)).toMatchObject({
      outcome: 'ok',
      batches: 1,
      rows: 1,
      committed: 0,
    });
    const waiting = (await c.get(url('/imports?waiting=feed'))).body.data;
    expect(waiting.map((b: any) => [b.status, b.accountId])).toEqual([['preview', checking]]);
    // It went back over the last five days of each cursor (never before a start date), from the earliest need.
    const card = [addDays(dateOf(10) as CalendarDate, -5), addDays(today, -15)].sort().at(-1)!;
    const from = [card, addDays(dateOf(5) as CalendarDate, -5)].sort()[0]!;
    const q = accountsRequests().at(-1)!.query;
    expect(q['start-date']).toBe(String(Date.parse(`${from}T00:00:00Z`) / 1000));
  });

  it('lets an import by hand release the hold; Undo brings its rows back on the next sync', async () => {
    const t3 = (await batches()).find((b) => b.ids[0] === 'T-3')!;
    expect((await c.post(url(`/imports/${t3.id}/commit`))).status).toBe(202);
    await worker.drain();
    expect((await c.get(url(`/imports/${t3.id}`))).body.status).toBe('committed');
    // Someone looked: the next clean batch imports itself again.
    fake.accounts[0]!.transactions.push({
      id: 'T-4',
      posted: posted(1),
      amount: '-3.00',
      description: 'PARKING',
    });
    expect(await sync.sync(ctx(), feedId)).toMatchObject({ batches: 1, committed: 1 });
    await worker.drain();

    expect((await c.post(url(`/imports/${t3.id}/undo`))).status).toBe(202);
    await worker.drain();
    expect((await c.get(url(`/imports/${t3.id}`))).body.status).toBe('undone');
    expect(account(await feed(), 'Checking …1234').syncedThrough).toBe(
      addDays(dateOf(1) as CalendarDate, -1),
    );
    // The undone row comes back; T-4, imported, doesn't. The hold is back (the last automatic import missed).
    expect(await sync.sync(ctx(), feedId)).toMatchObject({ batches: 1, rows: 1, committed: 0 });
    const back = (await batches()).filter((b) => b.status === 'preview');
    expect(back.map((b) => b.ids)).toEqual([['T-3']]);
  });

  it('keeps a discarded batch’s rows out', async () => {
    const waiting = (await batches()).find((b) => b.status === 'preview')!;
    expect((await c.post(url(`/imports/${waiting.id}/discard`))).status).toBe(200);
    await db.query(`update app.bank_feed_account set synced_through = null where bank_feed_id = $1`, [
      feedId,
    ]);
    expect((await sync.sync(ctx(), feedId)).batches).toBe(0);
  });

  it('Sync now: owners, admins and partners, spaced; viewers can’t', async () => {
    await db.query(
      `update app.bank_feed set last_manual_sync_at = null, next_sync_at = now() + interval '1 day' where id = $1`,
      [feedId],
    );
    expect((await viewer.post(url(`/bank-feeds/${feedId}/sync`))).status).toBe(403);
    const first = await partner.post(url(`/bank-feeds/${feedId}/sync`));
    expect(first.status).toBe(200);
    expect(new Date((await feedRow()).next_sync_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(first.body.feed.syncNowAfter).not.toBeNull();
    const soon = await c.post(url(`/bank-feeds/${feedId}/sync`));
    expect([soon.status, soon.body.code]).toEqual([429, 'bank_feed.sync_soon']);
    // The job's pass picks it up, as a manual sync.
    expect(await sync.run()).toMatchObject({ synced: 1 });
    await worker.drain();
    const run = (
      await db.query(
        `select trigger, outcome from app.bank_feed_run where bank_feed_id = $1 order by started_at desc limit 1`,
        [feedId],
      )
    ).rows[0];
    expect(run).toEqual({ trigger: 'manual', outcome: 'ok' });
  });

  it('waits for the next UTC day at the daily limit, without asking or failing', async () => {
    await db.query(
      `update app.bank_feed set requests_day = (now() at time zone 'UTC')::date, requests_today = 30 where id = $1`,
      [feedId],
    );
    const asked = fake.log.length;
    expect(await sync.sync(ctx(), feedId)).toMatchObject({ outcome: 'held' });
    expect(fake.log.length).toBe(asked);
    const row = await feedRow();
    expect(new Date(row.next_sync_at).toISOString()).toBe(nextUtcDay(new Date()).toISOString());
    expect(row).toMatchObject({ status: 'active', attempts: 0 });
    await db.query(`update app.bank_feed set requests_today = 0 where id = $1`, [feedId]);
  });

  const told = async () =>
    (
      await db.query(
        `select u.email, n.body from app.notification n join app.app_user u on u.id = n.user_id
          where n.workspace_id = $1 and n.type = 'bank_feed_attention' order by n.created_at`,
        [wsId],
      )
    ).rows;

  it('tells owners once when a bank needs them to sign in again, and others keep syncing', async () => {
    fake.errlist = [{ code: 'con.auth', msg: 'Sign in again', conn_id: 'CONN-1' }];
    expect((await sync.sync(ctx(), feedId)).outcome).toBe('partial');
    expect(account(await feed(), 'Rewards Card …9876').problem).toEqual({
      code: 'reauth_needed',
      message: 'Sign in again',
    });
    await sync.sync(ctx(), feedId);
    expect(await told()).toEqual([
      {
        email: OWNER,
        body: 'Example Credit Union needs you to sign in again at SimpleFIN Bridge. Other banks keep syncing.',
      },
    ]);
    // Fixed at the Bridge: the next problem is told of again.
    fake.errlist = [];
    await sync.sync(ctx(), feedId);
    expect((await feedRow()).attention_notified_at).toBeNull();
    await db.query(`delete from app.notification where workspace_id = $1`, [wsId]);
  });

  it('backs off on failures, turns failing after five, and stops for a revoked access', async () => {
    fake.failWith = 500;
    for (let i = 1; i <= 5; i++) {
      expect((await sync.sync(ctx(), feedId)).outcome).toBe('failed');
      const row = await feedRow();
      expect(row.attempts).toBe(i);
      expect(row.status).toBe(i < 5 ? 'active' : 'failing');
      expect(new Date(row.next_sync_at).getTime()).toBeGreaterThan(Date.now());
    }
    expect((await feed()).lastError).toBe(
      'Montra couldn’t reach SimpleFIN Bridge. Try again in a few minutes.',
    );
    // Failing needs a person: owners are told once, and only owners.
    await sync.sync(ctx(), feedId);
    expect((await told()).map((r) => r.email)).toEqual([OWNER]);
    // A sync that works again clears it.
    fake.failWith = null;
    expect((await sync.sync(ctx(), feedId)).outcome).toBe('ok');
    expect(await feedRow()).toMatchObject({ status: 'active', attempts: 0, last_error: null });

    fake.failWith = 403;
    expect((await sync.sync(ctx(), feedId)).outcome).toBe('failed');
    expect(await feedRow()).toMatchObject({ status: 'revoked', next_sync_at: null });
    expect((await feed()).lastError).toBe(
      'SimpleFIN no longer accepts Montra’s access. Connect again with a new setup token.',
    );
    const due = (await db.query(`select 1 from app.bank_feed_due() where workspace_id = $1`, [wsId])).rows;
    expect(due).toEqual([]);
    // A new problem is told of, the same day.
    expect((await told()).map((r) => r.body)).toEqual([
      'Montra hasn’t been able to sync your bank feed for a while. See Settings → Bank feeds for what went wrong.',
      'SimpleFIN no longer accepts Montra’s access. Connect again with a new setup token in Settings → Bank feeds.',
    ]);
    fake.failWith = null;
  });
});
