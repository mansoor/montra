/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { NOT_EXPORTED } from '../src/data/catalog.js';
import { feedSignal, last4Of, suggestAccount } from '../src/bank-feeds/bank-feeds.service.js';
import { guardedFeedTransport } from '../src/bank-feeds/transport.js';
import { ADMIN_URL } from './env.js';
import { startFakeSimpleFin, type FakeSimpleFin } from './fakes/simplefin.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Bank feeds, PR 2: connecting and linking (ADR-0055 §3, §4, §9; FEED-01, FEED-02, FEED-05, FEED-09), against a
// synthetic SimpleFIN on this machine (SIMPLEFIN_ALLOW_LOCAL_HTTP=on). Nothing reaches the real service, and nothing
// is imported yet.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-feeds@example.com';
const PARTNER = 'partner-feeds@example.com';
const VIEWER = 'viewer-feeds@example.com';

let h: Harness;
let c: Client;
let partner: Client;
let viewer: Client;
let db: pg.Client;
let fake: FakeSimpleFin;
let wsId: string;
let url: (p: string) => string;
let checking: string;
/** Today where the workspace is: the server's start dates count from it. */
let wsToday: string;

const today = todayIn('UTC');
const epoch = (daysBack: number) => Date.parse(`${addDays(today, -daysBack)}T12:00:00Z`) / 1000;
const feed = async () => (await c.get(url('/bank-feeds'))).body.feed;
const feedRow = async () =>
  (await db.query(`select * from app.bank_feed where workspace_id = $1 and status <> 'disconnected'`, [wsId]))
    .rows[0];
const events = async (kind: string) =>
  (
    await db.query(`select detail from app.security_event where workspace_id = $1 and kind = $2`, [
      wsId,
      kind,
    ])
  ).rows.map((r) => r.detail);
const account = (f: any, providerName: string) => f.accounts.find((a: any) => a.name === providerName);

async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

async function output(fn: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    written.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return written.join('');
}

beforeAll(async () => {
  fake = await startFakeSimpleFin();
  // Dates relative to today, so the 90-day window always holds them.
  fake.accounts[0]!.balanceDate = epoch(1);
  fake.accounts[0]!.transactions = [
    { id: 'T-1', posted: epoch(20), amount: '-40.00', description: 'Zelle Payment To SAM EXAMPLE' },
    { id: 'T-2', posted: epoch(5), amount: '2500.00', description: 'ACME CORP PAYROLL' },
  ];
  fake.accounts[1]!.balance = '-500.00';
  fake.accounts[1]!.balanceDate = epoch(1);
  fake.accounts[1]!.transactions = [
    { id: 'C-1', posted: epoch(10), amount: '-310.20', description: 'GROCERY MART' },
    { id: 'C-2', posted: epoch(0), amount: '-9.99', description: 'After the balance date' },
  ];
  h = await startHarness({
    AI_PROVIDER: 'fake',
    SIMPLEFIN_ALLOW_LOCAL_HTTP: 'on',
    SIMPLEFIN_REQUESTS_PER_DAY: '8',
  });
  c = h.as(OWNER);
  partner = h.as(PARTNER);
  viewer = h.as(VIEWER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Feeds', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  const tz = (await db.query(`select time_zone from app.workspace where id = $1`, [wsId])).rows[0].time_zone;
  wsToday = todayIn(tz);
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
});

afterAll(async () => {
  await db?.query(`delete from app.bank_feed where workspace_id = $1`, [wsId]);
  await db?.end();
  await h?.close();
  await fake?.close();
});

describe('suggesting a Montra account (ADR-0055 §4)', () => {
  const candidates = [
    { id: 'a', name: 'Everyday', currency: 'USD', last4: '1234', institution: 'Example Credit Union' },
    { id: 'b', name: 'Other 1234', currency: 'USD', last4: '1234', institution: 'Other Bank' },
    { id: 'c', name: 'Savings', currency: 'USD', last4: null, institution: 'Example Credit Union' },
    { id: 'd', name: 'Euro', currency: 'EUR', last4: '5555', institution: null },
  ];
  it('learned first, then the last four digits (narrowed by institution), then the institution', () => {
    expect(last4Of('Checking …1234')).toBe('1234');
    expect(last4Of('CARD x9876 ')).toBe('9876');
    expect(last4Of('Checking')).toBeNull();
    const acct = (name: string, inst: string | null, ccy: string | null = 'USD') => ({
      name,
      institutionName: inst,
      currency: ccy,
    });
    expect(suggestAccount(acct('Checking …1234', 'EXAMPLE credit-union'), candidates, null)).toBe('a');
    expect(suggestAccount(acct('Checking …1234', null), candidates, null)).toBeNull();
    expect(suggestAccount(acct('Checking …1234', null), candidates, 'b')).toBe('b');
    expect(suggestAccount(acct('Card …5555', null), candidates, null)).toBeNull();
    expect(suggestAccount(acct('Card …5555', null, 'EUR'), candidates, null)).toBe('d');
    expect(suggestAccount(acct('Joint', 'Other Bank'), candidates, null)).toBe('b');
    expect(suggestAccount(acct('Points', null, null), candidates, 'a')).toBeNull();
    expect(feedSignal('ACT-1')).toMatch(/^feed:simplefin:[0-9a-f]{24}$/);
  });
});

describe('connecting (ADR-0055 §3, FEED-01)', () => {
  it('lets only an owner with a recent sign-in connect', async () => {
    const token = fake.newSetupToken();
    expect((await partner.post(url('/bank-feeds'), { setupToken: token })).body.code).toBe(
      'bank_feed.owner_only',
    );
    expect((await stale(() => c.post(url('/bank-feeds'), { setupToken: token }))).body.code).toBe(
      'reauth.required',
    );
    // Neither claimed the token.
    expect(fake.log.filter((r) => r.path.includes('/claim/'))).toEqual([]);
  });

  it('refuses a token that isn’t one, or points anywhere but SimpleFIN, without sending anything', async () => {
    const r1 = await c.post(url('/bank-feeds'), { setupToken: 'not a token!' });
    expect([r1.status, r1.body.code]).toEqual([422, 'bank_feed.invalid_token']);
    const elsewhere = Buffer.from('http://10.0.0.5/simplefin/claim/abc').toString('base64');
    const r2 = await c.post(url('/bank-feeds'), { setupToken: elsewhere });
    expect([r2.status, r2.body.code]).toEqual([422, 'bank_feed.not_allowed_host']);
    expect(fake.log).toEqual([]);
  });

  it('claims once, seals the access, lists the accounts and says nothing secret', async () => {
    const token = fake.newSetupToken();
    let res: any;
    const written = await output(async () => {
      res = await c.post(url('/bank-feeds'), { setupToken: token, label: 'Credit union' });
    });
    expect(res.status).toBe(201);
    const f = res.body.feed;
    expect(f).toMatchObject({
      provider: 'simplefin',
      status: 'active',
      host: '127.0.0.1',
      label: 'Credit union',
      lastError: null,
      requests: { today: 2, perDay: 8 },
      earliestStartDate: addDays(wsToday as never, -89),
    });
    expect(
      f.accounts.map((a: any) => [a.name, a.institution, a.currency, a.state, a.balance?.amount]),
    ).toEqual([
      ['Checking …1234', 'Example Credit Union', 'USD', 'new', '152075'],
      ['Rewards Card …9876', 'Example Credit Union', 'USD', 'new', '-50000'],
    ]);
    // ADR-0051's matching suggests the checking account by its last four digits and institution.
    expect(account(f, 'Checking …1234').suggestedAccountId).toBe(checking);
    expect(account(f, 'Rewards Card …9876').suggestedAccountId).toBeNull();
    // One claim, one balances-only listing; never the transactions.
    expect(fake.log.map((r) => [r.method, r.path, r.query['balances-only'] ?? null])).toEqual([
      ['POST', expect.stringMatching(/^\/simplefin\/claim\//), null],
      ['GET', '/simplefin/accounts', '1'],
    ]);

    // The access is sealed: not in the answer, the process's output, the security log or any table's text.
    const secretBits = [fake.password, `${fake.username}:${fake.password}`];
    const everything = JSON.stringify([res.body, await events('bank_feed_connected')]) + written;
    for (const s of secretBits) expect(everything).not.toContain(s);
    const tables = (
      await db.query(
        `select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name as string);
    for (const t of tables) {
      const { rows } = await db.query(`select count(*)::int as n from app."${t}" x where x::text like $1`, [
        `%${fake.password}%`,
      ]);
      expect(rows[0].n, t).toBe(0);
    }
    expect((await feedRow()).secret_enc).toBeInstanceOf(Buffer);
    expect(await events('bank_feed_connected')).toEqual([{ provider: 'simplefin', host: '127.0.0.1' }]);
    for (const table of ['bank_feed', 'bank_feed_account', 'bank_feed_run'])
      expect(NOT_EXPORTED[table]).toBeTruthy();
  });

  it('won’t connect twice, and shows the feed to partners but not viewers', async () => {
    const again = await c.post(url('/bank-feeds'), { setupToken: fake.newSetupToken() });
    expect([again.status, again.body.code]).toEqual([409, 'bank_feed.exists']);
    expect((await partner.get(url('/bank-feeds'))).body.feed.status).toBe('active');
    expect((await viewer.get(url('/bank-feeds'))).body.feed).toBeNull();
  });
});

describe('linking accounts (ADR-0055 §4, §5; FEED-02, FEED-05)', () => {
  it('links to the suggestion, from the day after its latest transaction by default, and learns it', async () => {
    let f = await feed();
    const chk = account(f, 'Checking …1234');
    expect(
      (
        await partner.patch(url(`/bank-feeds/${f.id}/accounts/${chk.id}`), {
          action: 'link',
          accountId: checking,
          version: chk.version,
        })
      ).body.code,
    ).toBe('bank_feed.owner_only');
    // A transaction already in the account, 30 days back: the feed starts the day after.
    await c.post(url('/transactions'), {
      date: addDays(today, -30),
      accountId: checking,
      amount: { amount: '-1000', currency: 'USD' },
      payee: 'Already here',
    });
    const res = await c.patch(url(`/bank-feeds/${f.id}/accounts/${chk.id}`), {
      action: 'link',
      accountId: checking,
      version: chk.version,
    });
    expect(res.status).toBe(200);
    f = res.body.feed;
    expect(account(f, 'Checking …1234')).toMatchObject({
      state: 'linked',
      accountId: checking,
      startDate: addDays(today, -29),
      suggestedAccountId: null,
    });
    const memory = (
      await db.query(
        `select target_id, confirmations from app.match_memory where workspace_id = $1 and signal = $2`,
        [wsId, feedSignal('ACT-CHK')],
      )
    ).rows;
    expect(memory).toEqual([{ target_id: checking, confirmations: 1 }]);
    expect(
      (
        await db.query(
          `select action, diff from app.audit_log where workspace_id = $1 and subject_type = 'bank_feed_account'`,
          [wsId],
        )
      ).rows,
    ).toEqual([
      {
        action: 'bank_feed.account_linked',
        diff: { action: 'link', accountId: checking, startDate: addDays(today, -29) },
      },
    ]);
  });

  it('refuses a second feed account on the same Montra account, a stale version and a start date out of range', async () => {
    const f = await feed();
    const card = account(f, 'Rewards Card …9876');
    const dup = await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), {
      action: 'link',
      accountId: checking,
      version: card.version,
    });
    expect([dup.status, dup.body.code]).toEqual([409, 'bank_feed.already_linked']);
    expect(
      (await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), { action: 'ignore', version: '999' }))
        .body.code,
    ).toBe('version.conflict');
    const other = (
      await c.post(url('/accounts'), {
        name: 'Old card',
        kind: 'credit_card',
        openingDate: addDays(today, -400),
      })
    ).body.id;
    const early = await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), {
      action: 'link',
      accountId: other,
      startDate: addDays(today, -120),
      version: card.version,
    });
    expect([early.status, early.body.code]).toEqual([422, 'bank_feed.start_date']);
  });

  it('creates an account with the opening balance the day before the start, so a first sync won’t count twice', async () => {
    const f = await feed();
    const card = account(f, 'Rewards Card …9876');
    const before = (await feedRow()).requests_today;
    const start = addDays(today, -15);
    const res = await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), {
      action: 'create',
      name: 'Rewards card',
      kind: 'credit_card',
      startDate: start,
      version: card.version,
    });
    expect(res.status).toBe(200);
    const linked = account(res.body.feed, 'Rewards Card …9876');
    expect(linked).toMatchObject({ state: 'linked', startDate: start });
    // One request for the window; the balance (−500.00, the day before yesterday's close) less what was posted from
    // the start to the balance's date (−310.20) leaves 189.80 owed the day before the start.
    expect((await feedRow()).requests_today).toBe(before + 1);
    const created = (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === linked.accountId);
    expect(created).toMatchObject({ name: 'Rewards card', kind: 'credit_card', currency: 'USD' });
    const bank = (
      await db.query(
        `select opening_balance_minor, opening_date, institution, last4 from app.bank_account where ledger_account_id = $1`,
        [linked.accountId],
      )
    ).rows[0];
    expect(bank).toMatchObject({
      opening_balance_minor: 18980n,
      institution: 'Example Credit Union',
      last4: '9876',
    });
    expect(bank.opening_date.toISOString?.().slice(0, 10) ?? bank.opening_date).toBe(addDays(start, -1));
  });

  it('ignores and unlinks, forgetting what it learned', async () => {
    const f = await feed();
    const card = account(f, 'Rewards Card …9876');
    let res = await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), {
      action: 'unlink',
      version: card.version,
    });
    expect(account(res.body.feed, 'Rewards Card …9876')).toMatchObject({
      state: 'new',
      accountId: null,
      startDate: null,
    });
    res = await c.patch(url(`/bank-feeds/${f.id}/accounts/${card.id}`), {
      action: 'ignore',
      version: account(res.body.feed, 'Rewards Card …9876').version,
    });
    expect(account(res.body.feed, 'Rewards Card …9876').state).toBe('ignored');
    const memory = (
      await db.query(`select confirmations from app.match_memory where workspace_id = $1 and signal = $2`, [
        wsId,
        feedSignal('ACT-CARD'),
      ])
    ).rows;
    expect(memory).toEqual([{ confirmations: 0 }]);
    expect((await events('bank_feed_changed')).map((d: any) => d.action)).toEqual([
      'link',
      'create',
      'unlink',
      'ignore',
    ]);
  });
});

describe('refreshing, limits and problems (ADR-0055 §5, §7)', () => {
  it('picks up renamed and gone accounts', async () => {
    const f = await feed();
    fake.accounts[0]!.name = 'Everyday Checking …1234';
    const gone = fake.accounts.pop()!;
    const res = await c.post(url(`/bank-feeds/${f.id}/refresh`));
    expect(res.status).toBe(200);
    expect(res.body.feed.accounts.map((a: any) => [a.name, a.missing, a.state])).toEqual([
      ['Everyday Checking …1234', false, 'linked'],
      ['Rewards Card …9876', true, 'ignored'],
    ]);
    fake.accounts.push(gone);
  });

  it('says a revoked access or a subscription problem in words, and keeps the feed', async () => {
    const f = await feed();
    fake.failWith = 402;
    const paid = await c.post(url(`/bank-feeds/${f.id}/refresh`));
    expect([paid.status, paid.body.code]).toEqual([409, 'bank_feed.payment_required']);
    expect(await feed()).toMatchObject({
      status: 'payment_required',
      lastError: 'Your SimpleFIN Bridge subscription needs attention.',
    });
    fake.failWith = null;
    await db.query(
      `update app.bank_feed set status = 'active' where workspace_id = $1 and status <> 'disconnected'`,
      [wsId],
    );
  });

  it('stops at the day’s limit (SIMPLEFIN_REQUESTS_PER_DAY) without asking SimpleFIN', async () => {
    const f = await feed();
    await db.query(`update app.bank_feed set requests_today = 8 where id = $1`, [f.id]);
    const asked = fake.log.length;
    const res = await c.post(url(`/bank-feeds/${f.id}/refresh`));
    expect([res.status, res.body.code]).toEqual([429, 'bank_feed.daily_limit']);
    expect(fake.log.length).toBe(asked);
    // A new UTC day starts again.
    await db.query(`update app.bank_feed set requests_day = requests_day - 1 where id = $1`, [f.id]);
    expect((await c.post(url(`/bank-feeds/${f.id}/refresh`))).status).toBe(200);
    expect((await feed()).requests.today).toBe(1);
  });

  it('pauses and resumes for an owner only', async () => {
    let f = await feed();
    expect(
      (await partner.patch(url(`/bank-feeds/${f.id}`), { paused: true, version: f.version })).status,
    ).toBe(403);
    f = (await c.patch(url(`/bank-feeds/${f.id}`), { paused: true, version: f.version })).body.feed;
    expect(f.status).toBe('paused');
    f = (await c.patch(url(`/bank-feeds/${f.id}`), { paused: false, label: 'Mine', version: f.version })).body
      .feed;
    expect(f).toMatchObject({ status: 'active', label: 'Mine' });
  });
});

describe('disconnecting and connecting again (ADR-0055 §3, FEED-09)', () => {
  it('needs a recent sign-in, wipes the access at once, and a reconnect keeps the links', async () => {
    const f = await feed();
    expect(
      (await stale(() => c.post(url(`/bank-feeds/${f.id}/disconnect`), { version: f.version }))).body.code,
    ).toBe('reauth.required');
    const res = await c.post(url(`/bank-feeds/${f.id}/disconnect`), { version: f.version });
    expect(res.status).toBe(200);
    expect(res.body.feed).toBeNull();
    const row = (await db.query(`select status, secret_enc from app.bank_feed where id = $1`, [f.id]))
      .rows[0];
    expect(row).toEqual({ status: 'disconnected', secret_enc: null });
    expect(await events('bank_feed_disconnected')).toEqual([{ provider: 'simplefin', host: '127.0.0.1' }]);

    // A used token says so, and a new one connects with the checking account still linked.
    const used = fake.newSetupToken();
    await fetch(Buffer.from(used, 'base64').toString(), { method: 'POST' });
    const again = await c.post(url('/bank-feeds'), { setupToken: used });
    expect([again.status, again.body.code]).toEqual([409, 'bank_feed.token_used']);
    const back = await c.post(url('/bank-feeds'), { setupToken: fake.newSetupToken() });
    expect(back.status).toBe(201);
    expect(account(back.body.feed, 'Everyday Checking …1234')).toMatchObject({
      state: 'linked',
      accountId: checking,
      startDate: addDays(today, -29),
    });
  });
});

describe('the transport (ADR-0055 §9)', () => {
  it('refuses http, other hosts, credentials in the URL, and a stand-in on this machine without the switch', async () => {
    const t = guardedFeedTransport({
      allowedHosts: ['bridge.simplefin.org', 'localhost.example.test'],
      allowLocalHttp: false,
      timeoutMs: 5000,
      maxResponseBytes: 1024,
    });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'sent',
        (e) => e.code,
      );
    expect(await code(t.send({ method: 'GET', url: new URL('http://bridge.simplefin.org/x') }))).toBe(
      'not_allowed_host',
    );
    expect(await code(t.send({ method: 'GET', url: new URL('https://evil.example/x') }))).toBe(
      'not_allowed_host',
    );
    expect(await code(t.send({ method: 'GET', url: new URL('https://u:p@bridge.simplefin.org/x') }))).toBe(
      'not_allowed_host',
    );
    // A loopback stand-in is reachable only with the local switch.
    expect(await code(t.send({ method: 'GET', url: new URL(`${fake.url}/simplefin/accounts`) }))).toBe(
      'not_allowed_host',
    );
  });

  it('caps the answer’s size and time', async () => {
    const t = guardedFeedTransport({
      allowedHosts: [],
      allowLocalHttp: true,
      timeoutMs: 300,
      maxResponseBytes: 2048,
    });
    const auth = {
      authorization: `Basic ${Buffer.from(`${fake.username}:${fake.password}`).toString('base64')}`,
    };
    fake.padTo = 10_000;
    await expect(
      t.send({ method: 'GET', url: new URL(`${fake.url}/simplefin/accounts`), headers: auth }),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    fake.padTo = 0;
    fake.delayMs = 1000;
    await expect(
      t.send({ method: 'GET', url: new URL(`${fake.url}/simplefin/accounts`), headers: auth }),
    ).rejects.toMatchObject({
      code: 'unreachable',
      detail: 'TIMEOUT',
    });
    fake.delayMs = 0;
  });
});
