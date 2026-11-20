import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CalendarDate } from '@montra/domain';
import { loadConfig } from '../src/config.js';
import {
  defaultStartDate,
  earliestStart,
  requestsLeft,
  simpleFinLimits,
  startDateProblem,
  syncNowAfter,
  syncWindow,
} from '../src/bank-feeds/limits.js';
import { BankFeedError } from '../src/bank-feeds/provider.js';
import {
  accountsQuery,
  decodeSetupToken,
  fromEpoch,
  parseAccessUrl,
  parseAccounts,
  readAmount,
  sanitize,
  toEpoch,
  urlProblem,
} from '../src/bank-feeds/simplefin.js';
import { startFakeSimpleFin, type FakeSimpleFin } from './fakes/simplefin.js';

// Bank feeds through SimpleFIN Bridge, PR 1 (ADR-0055 §1, §5, §9, §12): its limits as settings, and reading the
// protocol, as pure functions and against a synthetic stand-in. Nothing here reaches the real service.
const d = (s: string) => s as CalendarDate;
const bridge = { allowedHosts: ['bridge.simplefin.org', 'beta-bridge.simplefin.org'], allowLocalHttp: false };
const local = { ...bridge, allowLocalHttp: true };
const token = (url: string) => Buffer.from(url).toString('base64');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof BankFeedError ? e.code : `not a BankFeedError: ${String(e)}`;
  }
  return 'no error';
};

describe('SimpleFIN limits are settings (ADR-0055 §5)', () => {
  it('defaults to SimpleFIN’s published limits, with Montra at half the daily requests', () => {
    expect(simpleFinLimits(loadConfig({}))).toEqual({
      allowedHosts: ['bridge.simplefin.org', 'beta-bridge.simplefin.org'],
      allowLocalHttp: false,
      requestsPerDay: 12,
      maxWindowDays: 90,
      overlapDays: 5,
      syncsPerDay: 1,
      syncNowMinutes: 60,
      timeoutMs: 60_000,
      maxResponseBytes: 32 * 1024 * 1024,
    });
  });

  it('takes new values without a code change', () => {
    const l = simpleFinLimits(
      loadConfig({
        SIMPLEFIN_ALLOWED_HOSTS: ' Bridge.SimpleFIN.org , other.example ',
        SIMPLEFIN_REQUESTS_PER_DAY: '20',
        SIMPLEFIN_MAX_WINDOW_DAYS: '60',
        SIMPLEFIN_OVERLAP_DAYS: '3',
        SIMPLEFIN_SYNCS_PER_DAY: '2',
        SIMPLEFIN_SYNC_NOW_MINUTES: '30',
        SIMPLEFIN_TIMEOUT_SECONDS: '20',
      }),
    );
    expect(l).toMatchObject({
      allowedHosts: ['bridge.simplefin.org', 'other.example'],
      requestsPerDay: 20,
      maxWindowDays: 60,
      overlapDays: 3,
      syncsPerDay: 2,
      syncNowMinutes: 30,
      timeoutMs: 20_000,
    });
    // The rules read them: a 60-day window starts 59 days back.
    expect(earliestStart(d('2026-11-20'), l)).toBe('2026-09-22');
  });

  it('refuses settings that would break the rules, and the local switch in production', () => {
    expect(() => loadConfig({ SIMPLEFIN_OVERLAP_DAYS: '10', SIMPLEFIN_MAX_WINDOW_DAYS: '10' })).toThrow(
      /SIMPLEFIN_OVERLAP_DAYS/,
    );
    expect(() => loadConfig({ SIMPLEFIN_SYNCS_PER_DAY: '12' })).toThrow(/SIMPLEFIN_SYNCS_PER_DAY/);
    expect(() => loadConfig({ SIMPLEFIN_REQUESTS_PER_DAY: '0' })).toThrow();
    expect(() => loadConfig({ SIMPLEFIN_ALLOWED_HOSTS: 'https://bridge.simplefin.org' })).toThrow();
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SIMPLEFIN_ALLOW_LOCAL_HTTP: 'on',
        KMS_MODE: 'aws',
        AWS_KMS_KEY_ID: 'key',
        AUTH_MODE: 'kratos',
        KRATOS_PUBLIC_URL: 'https://auth.example.test',
        ADMIN_DATABASE_URL: 'postgres://a',
        SUPPORT_DATABASE_URL: 'postgres://s',
      }),
    ).toThrow(/SIMPLEFIN_ALLOW_LOCAL_HTTP/);
    expect(loadConfig({ SIMPLEFIN_ALLOW_LOCAL_HTTP: 'on' }).SIMPLEFIN_ALLOW_LOCAL_HTTP).toBe(true);
  });
});

describe('where Montra may connect (ADR-0055 §9)', () => {
  it('reads a setup token for an allowed host, and refuses anything else before sending', () => {
    expect(decodeSetupToken(token('https://bridge.simplefin.org/simplefin/claim/abc'), bridge).href).toBe(
      'https://bridge.simplefin.org/simplefin/claim/abc',
    );
    // base64url and line breaks, as a copy from an email may have.
    const url = 'https://beta-bridge.simplefin.org/simplefin/claim/DEMO?x=1';
    const urlSafe = token(url).replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeSetupToken(`${urlSafe.slice(0, 10)}\n${urlSafe.slice(10)}`, bridge).href).toBe(url);

    expect(code(() => decodeSetupToken(token('http://bridge.simplefin.org/claim/abc'), bridge))).toBe(
      'not_allowed_host',
    );
    expect(code(() => decodeSetupToken(token('https://evil.example/claim/abc'), bridge))).toBe(
      'not_allowed_host',
    );
    expect(code(() => decodeSetupToken(token('https://bridge.simplefin.org:8443/claim'), bridge))).toBe(
      'not_allowed_host',
    );
    expect(code(() => decodeSetupToken(token('https://127.0.0.1/claim'), bridge))).toBe('not_allowed_host');
    expect(code(() => decodeSetupToken(token('https://u:p@bridge.simplefin.org/claim'), bridge))).toBe(
      'invalid_token',
    );
    expect(code(() => decodeSetupToken('not a token!', bridge))).toBe('invalid_token');
    expect(code(() => decodeSetupToken(token('just words'), bridge))).toBe('invalid_token');
  });

  it('allows a stand-in on this machine only with the local switch', () => {
    const fakeUrl = new URL('http://127.0.0.1:5555/simplefin/claim/abc');
    expect(urlProblem(fakeUrl, bridge)).toBe('not https');
    expect(urlProblem(fakeUrl, local)).toBeNull();
    expect(urlProblem(new URL('http://10.0.0.5/claim'), local)).toBe('not https');
  });

  it('splits the access URL so the credentials never travel in it', () => {
    const access = parseAccessUrl('https://user1:p%40ss@bridge.simplefin.org/simplefin/', bridge);
    expect(access).toEqual({
      base: 'https://bridge.simplefin.org/simplefin',
      host: 'bridge.simplefin.org',
      username: 'user1',
      password: 'p@ss',
    });
    expect(code(() => parseAccessUrl('https://bridge.simplefin.org/simplefin', bridge))).toBe('bad_response');
    expect(code(() => parseAccessUrl('https://u:p@evil.example/simplefin', bridge))).toBe('not_allowed_host');
    expect(code(() => parseAccessUrl('nonsense', bridge))).toBe('bad_response');
    // The error never carries what was given.
    try {
      parseAccessUrl('https://u:secretpass@evil.example/simplefin', bridge);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secretpass');
    }
  });
});

describe('the protocol, read strictly (ADR-0055 §1)', () => {
  it('asks for a window in epoch seconds, end exclusive, and never for pending rows', () => {
    expect(toEpoch(d('2026-11-01'))).toBe(Date.UTC(2026, 10, 1) / 1000);
    expect(fromEpoch(Date.UTC(2026, 10, 19, 23, 59) / 1000)).toBe('2026-11-19');
    expect(fromEpoch(0)).toBeNull();
    expect(fromEpoch('1700000000')).toBeNull();
    const q = new URLSearchParams(accountsQuery({ from: d('2026-11-01'), to: d('2026-11-21') }));
    expect(Object.fromEntries(q)).toEqual({
      version: '2',
      'start-date': String(Date.UTC(2026, 10, 1) / 1000),
      'end-date': String(Date.UTC(2026, 10, 21) / 1000),
    });
    expect(accountsQuery({ balancesOnly: true })).toBe('version=2&balances-only=1');
  });

  it('reads amounts exactly in the account’s currency, and refuses rounding', () => {
    expect(readAmount('-40.00', 'USD')).toBe(-4000n);
    expect(readAmount('2500', 'USD')).toBe(250000n);
    expect(readAmount('+1.50', 'USD')).toBe(150n);
    expect(readAmount('12.340', 'USD')).toBe(1234n);
    expect(readAmount('1.005', 'USD')).toBeNull();
    expect(readAmount('100.5', 'JPY')).toBeNull();
    expect(readAmount('1.234', 'KWD')).toBe(1234n);
    for (const bad of ['1,000.00', '1e3', '', 'NaN', null, undefined, {}])
      expect(readAmount(bad, 'USD')).toBeNull();
  });

  it('shows the provider’s words as plain text', () => {
    expect(sanitize('<b>Sign in</b> again\u0007 at\u202e https://u:p@bridge.example/x')).toBe(
      'Sign in again at https://bridge.example/x',
    );
    expect(sanitize('x'.repeat(400))).toHaveLength(300);
    expect(sanitize(42)).toBe('');
  });

  it('reads v2: connections, problems per institution and account, pending dropped, odd rows skipped', () => {
    const snap = parseAccounts({
      errlist: [
        { code: 'con.auth', msg: 'Sign in to <i>Example CU</i> again', conn_id: 'C1' },
        { code: 'act.missingdata', msg: 'No balance', account_id: 'A2' },
        { code: 'act.failed', msg: 'Failed', account_id: 'A2' },
        { code: 'gen.other', msg: 'Something' },
      ],
      errors: ['You are over your daily quota'],
      connections: [{ conn_id: 'C1', name: 'Example CU', org_id: 'O1', org_url: 'https://cu.example.test' }],
      accounts: [
        {
          id: 'A1',
          conn_id: 'C1',
          name: 'Checking',
          currency: 'usd',
          balance: '100.25',
          'available-balance': '90.00',
          'balance-date': Date.UTC(2026, 10, 19) / 1000,
          transactions: [
            {
              id: 'T1',
              posted: Date.UTC(2026, 10, 2) / 1000,
              amount: '-40.00',
              description: 'Zelle',
              payee: 'Sam',
            },
            { id: 'T2', posted: 0, amount: '-5.00', description: 'pending, no date' },
            {
              id: 'T3',
              posted: Date.UTC(2026, 10, 3) / 1000,
              amount: '-5.00',
              description: 'x',
              pending: true,
            },
            { id: 'T4', posted: Date.UTC(2026, 10, 4) / 1000, amount: '1.005', description: 'too precise' },
            { posted: Date.UTC(2026, 10, 4) / 1000, amount: '1.00', description: 'no id' },
          ],
        },
        // A custom currency: kept, never linkable, its amounts not read.
        { id: 'A2', conn_id: 'C1', name: 'Points', currency: 'https://example.test/points', balance: '500' },
        { name: 'no id' },
      ],
    });
    expect(snap.institutions).toEqual([{ id: 'C1', name: 'Example CU', url: 'https://cu.example.test' }]);
    expect(snap.problems.map((p) => [p.code, p.institutionId, p.accountId])).toEqual([
      ['reauth_needed', 'C1', null],
      ['missing_data', null, 'A2'],
      ['account_failed', null, 'A2'],
      ['unknown', null, null],
      ['quota_warning', null, null],
    ]);
    expect(snap.problems[0]!.message).toBe('Sign in to Example CU again');
    expect(snap.droppedPending).toBe(2);
    expect(snap.accounts).toHaveLength(2);
    const [a1, a2] = snap.accounts;
    expect(a1).toMatchObject({
      id: 'A1',
      institutionId: 'C1',
      currency: 'USD',
      balance: 10025n,
      available: 9000n,
      balanceDate: '2026-11-19',
      rowErrors: 2,
    });
    expect(a1!.transactions).toEqual([
      { id: 'T1', date: '2026-11-02', amount: -4000n, description: 'Zelle', payee: 'Sam', memo: null },
    ]);
    expect(a2).toMatchObject({ id: 'A2', currency: null, balance: null, transactions: [] });
  });

  it('tolerates v1’s org per account, and refuses an answer that isn’t accounts', () => {
    const snap = parseAccounts({
      errors: [],
      accounts: [
        {
          id: 'A1',
          org: { domain: 'cu.example.test', name: 'Example CU', 'sfin-url': 'https://x', url: 'https://cu' },
          name: 'Savings',
          currency: 'USD',
          balance: '5.00',
          'balance-date': Date.UTC(2026, 10, 19) / 1000,
          transactions: [],
        },
      ],
    });
    expect(snap.institutions).toEqual([{ id: 'cu.example.test', name: 'Example CU', url: 'https://cu' }]);
    expect(snap.accounts[0]!.institutionId).toBe('cu.example.test');
    for (const bad of [null, [], 'text', { accounts: 'x' }, {}])
      expect(code(() => parseAccounts(bad))).toBe('bad_response');
  });
});

describe('start dates, windows and the daily budget (ADR-0055 §5)', () => {
  const limits = { maxWindowDays: 90, overlapDays: 5, requestsPerDay: 12, syncNowMinutes: 60 };
  const today = d('2026-11-20');

  it('starts the day after the account’s latest transaction, at most 90 days back, never later than today', () => {
    expect(earliestStart(today, limits)).toBe('2026-08-23');
    expect(defaultStartDate(null, today, limits)).toBe('2026-08-23');
    expect(defaultStartDate(d('2026-11-10'), today, limits)).toBe('2026-11-11');
    expect(defaultStartDate(d('2026-01-31'), today, limits)).toBe('2026-08-23');
    expect(defaultStartDate(d('2026-11-20'), today, limits)).toBe('2026-11-20');
    expect(startDateProblem(d('2026-08-23'), today, limits)).toBeNull();
    expect(startDateProblem(d('2026-08-22'), today, limits)).toBe('too_early');
    expect(startDateProblem(d('2026-11-21'), today, limits)).toBe('in_future');
  });

  it('asks once for every linked account, from the earliest need less the overlap, to tomorrow', () => {
    expect(syncWindow([], today, limits)).toBeNull();
    // First sync: from the start date.
    expect(syncWindow([{ startDate: d('2026-11-01'), syncedThrough: null }], today, limits)).toEqual({
      from: '2026-11-01',
      to: '2026-11-21',
      gap: false,
    });
    // Later syncs go back over the last five days, never before the start date, and the earliest account rules.
    expect(
      syncWindow(
        [
          { startDate: d('2026-11-01'), syncedThrough: d('2026-11-18') },
          { startDate: d('2026-11-15'), syncedThrough: d('2026-11-17') },
        ],
        today,
        limits,
      ),
    ).toEqual({ from: '2026-11-13', to: '2026-11-21', gap: false });
    expect(
      syncWindow([{ startDate: d('2026-11-16'), syncedThrough: d('2026-11-18') }], today, limits),
    ).toEqual({
      from: '2026-11-16',
      to: '2026-11-21',
      gap: false,
    });
    // Paused for months: one request reaches back 90 days, and the days before are a gap for an upload.
    expect(
      syncWindow([{ startDate: d('2026-01-01'), syncedThrough: d('2026-03-01') }], today, limits),
    ).toEqual({
      from: '2026-08-23',
      to: '2026-11-21',
      gap: true,
    });
    // Only the overlap reaching past the window is no gap.
    expect(
      syncWindow([{ startDate: d('2026-08-20'), syncedThrough: d('2026-08-24') }], today, limits)!.gap,
    ).toBe(false);
    // An account whose start date is still ahead isn't asked for.
    expect(syncWindow([{ startDate: d('2026-11-25'), syncedThrough: null }], today, limits)).toBeNull();
  });

  it('counts requests per UTC day, and spaces Sync now', () => {
    const now = new Date('2026-11-20T15:00:00Z');
    expect(requestsLeft({ requestsDay: d('2026-11-20'), requestsToday: 5 }, now, limits)).toBe(7);
    expect(requestsLeft({ requestsDay: d('2026-11-20'), requestsToday: 15 }, now, limits)).toBe(0);
    expect(requestsLeft({ requestsDay: d('2026-11-19'), requestsToday: 12 }, now, limits)).toBe(12);
    expect(requestsLeft({ requestsDay: null, requestsToday: 0 }, now, limits)).toBe(12);
    expect(syncNowAfter(null, now, limits)).toBeNull();
    expect(syncNowAfter(new Date('2026-11-20T14:30:00Z'), now, limits)).toEqual(
      new Date('2026-11-20T15:30:00Z'),
    );
    expect(syncNowAfter(new Date('2026-11-20T13:30:00Z'), now, limits)).toBeNull();
  });
});

describe('against a SimpleFIN stand-in (ADR-0055 §12)', () => {
  let fake: FakeSimpleFin;
  beforeAll(async () => {
    fake = await startFakeSimpleFin();
  });
  afterAll(async () => {
    await fake?.close();
  });

  const claim = (setupToken: string) =>
    fetch(decodeSetupToken(setupToken, local), { method: 'POST', redirect: 'manual' });
  const accounts = async (access: ReturnType<typeof parseAccessUrl>, query: string) => {
    const res = await fetch(`${access.base}/accounts?${query}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}`,
      },
    });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  it('claims a token once, then reads accounts and posted rows in the window', async () => {
    const setup = fake.newSetupToken();
    const first = await claim(setup);
    expect(first.status).toBe(200);
    const access = parseAccessUrl(await first.text(), local);
    expect(access.base).toBe(`${fake.url}/simplefin`);
    expect((await claim(setup)).status).toBe(403);

    const balances = await accounts(access, accountsQuery({ balancesOnly: true }));
    const listed = parseAccounts(balances.body);
    expect(listed.accounts.map((a) => [a.id, a.name, a.balance, a.transactions.length])).toEqual([
      ['ACT-CHK', 'Checking …1234', 152075n, 0],
      ['ACT-CARD', 'Rewards Card …9876', -31020n, 0],
    ]);
    expect(listed.institutions.map((i) => i.name)).toEqual(['Example Credit Union']);

    const window = await accounts(access, accountsQuery({ from: d('2026-11-10'), to: d('2026-11-21') }));
    const snap = parseAccounts(window.body);
    expect(snap.accounts.map((a) => a.transactions.map((t) => [t.id, t.date, t.amount]))).toEqual([
      [['T-2', '2026-11-15', 250000n]],
      [['C-1', '2026-11-10', -31020n]],
    ]);
    // The pending row arrives without a date and is dropped.
    expect(snap.droppedPending).toBe(1);
    // What the stand-in saw: the right credentials, and never `pending`.
    expect(
      fake.log.filter((r) => r.path.endsWith('/accounts')).every((r) => r.authorized && !r.query.pending),
    ).toBe(true);
  });

  it('answers the old shape, wrong credentials and the Bridge’s failures as the protocol says', async () => {
    const access = parseAccessUrl(await (await claim(fake.newSetupToken())).text(), local);
    fake.shape = 'v1';
    fake.errors = ['Daily quota exceeded'];
    const v1 = parseAccounts((await accounts(access, accountsQuery({ balancesOnly: true }))).body);
    expect(v1.institutions.map((i) => i.id)).toEqual(['ORG-1']);
    expect(v1.problems.map((p) => p.code)).toEqual(['quota_warning']);
    fake.shape = 'v2';
    fake.errors = [];

    expect((await accounts({ ...access, password: 'wrong' }, accountsQuery({}))).status).toBe(403);
    fake.failWith = 402;
    expect((await accounts(access, accountsQuery({}))).status).toBe(402);
    fake.failWith = null;
  });
});
