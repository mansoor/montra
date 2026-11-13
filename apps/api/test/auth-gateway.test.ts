/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthGateway, TOO_MANY_ATTEMPTS_ID } from '../src/auth-gateway/gateway.js';
import {
  afterFailure,
  delayFor,
  keyOf,
  liveFailures,
  lockedFor,
  RULES,
  ThrottleStore,
  type Bucket,
  type Rule,
} from '../src/auth-gateway/throttle.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { MemoryMail } from '../src/mail/mail.service.js';
import { ADMIN_URL, APP_URL } from './env.js';

// The auth gateway in front of Kratos (AUTH-08, ADR-0042): counts failed attempts, slows them down, pauses them.
const SECRET = 'test-auth-gateway-secret-0123456789abcdef';
const WEB = 'http://web.example.test';
const EMAIL = 'gateway-owner@example.test';
const t0 = new Date('2026-11-13T10:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

describe('counting failures', () => {
  const rule = RULES.account;

  it('locks at the limit, and only the failure that crosses it says so', () => {
    let b: Bucket | undefined;
    for (let i = 1; i < rule.maxFailures; i++) {
      const r = afterFailure(b, rule, t0);
      expect(r.locked).toBe(false);
      b = r.bucket;
    }
    const r = afterFailure(b, rule, t0);
    expect(r.locked).toBe(true);
    expect(lockedFor(r.bucket, t0)).toBe(rule.lockMs / 1000);
    expect(afterFailure(r.bucket, rule, t0).locked).toBe(false);
    expect(lockedFor(r.bucket, later(rule.lockMs))).toBe(0);
  });

  it('forgets failures once the window has passed', () => {
    const b = afterFailure(afterFailure(undefined, rule, t0).bucket, rule, t0).bucket;
    expect(liveFailures(b, rule, later(rule.windowMs - 1))).toBe(2);
    expect(liveFailures(b, rule, later(rule.windowMs))).toBe(0);
    expect(afterFailure(b, rule, later(rule.windowMs)).bucket).toMatchObject({
      failures: 1,
      windowStarted: later(rule.windowMs),
    });
  });

  it('waits a second after the free failures, doubling to at most 8', () => {
    expect(delayFor(rule.delayAfter - 1, rule)).toBe(0);
    expect(delayFor(rule.delayAfter, rule)).toBe(1000);
    expect(delayFor(rule.delayAfter + 2, rule)).toBe(4000);
    expect(delayFor(rule.delayAfter + 10, rule)).toBe(8000);
  });

  it('keys are keyed hashes, different per rule and per secret', () => {
    const k = keyOf(SECRET, 'account', EMAIL);
    expect(k.startsWith('account:')).toBe(true);
    expect(k).not.toContain('example');
    expect(keyOf(SECRET, 'address', EMAIL)).not.toBe(k.replace('account:', 'address:'));
    expect(keyOf(`${SECRET}x`, 'account', EMAIL)).not.toBe(k);
  });
});

/** The counters in memory, with the same rules as the Postgres store. */
class MemoryStore {
  buckets = new Map<string, Bucket>();
  lockouts: Array<{ email: string; detail: Record<string, unknown> }> = [];
  async get(keys: string[]) {
    return new Map(keys.filter((k) => this.buckets.has(k)).map((k) => [k, this.buckets.get(k)!]));
  }
  async fail(key: string, rule: Rule, now: Date) {
    const r = afterFailure(this.buckets.get(key), rule, now);
    this.buckets.set(key, r.bucket);
    return r;
  }
  async clear(keys: string[]) {
    for (const k of keys) this.buckets.delete(k);
  }
  async noteLockout(email: string, detail: Record<string, unknown>) {
    this.lockouts.push({ email, detail });
    return email === EMAIL;
  }
}

/** Just enough of Kratos's public API: login (password, TOTP), recovery and verification. */
function fakeKratos() {
  const app = Fastify();
  const hits: string[] = [];
  const flows = new Map<string, { state: string; error: boolean }>();
  const flowOf = (id: string) =>
    flows.get(id) ?? flows.set(id, { state: 'choose_method', error: false }).get(id)!;
  const flowBody = (id: string) => {
    const f = flowOf(id);
    return {
      id,
      state: f.state,
      ui: {
        action: `http://kratos/self-service/login?flow=${id}`,
        messages: f.error
          ? [{ id: 4000006, type: 'error', text: 'The provided credentials are invalid.' }]
          : [],
        nodes: [],
      },
    };
  };
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.addHook('onRequest', async (req) => {
    hits.push(`${req.method} ${req.url.split('?')[0]}`);
  });
  app.get('/echo', async (req, reply) => {
    void reply.header('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    return { headers: req.headers };
  });
  for (const kind of ['login', 'recovery', 'verification']) {
    app.get(`/self-service/${kind}/flows`, async (req) => flowBody((req.query as any).id));
  }
  const browser = (req: any) => !String(req.headers['content-type']).includes('json');
  app.post('/self-service/login', async (req, reply) => {
    const id = (req.query as any).flow as string;
    const b = req.body as any;
    const ok =
      (b.method === 'password' && b.password === 'right password') ||
      (b.method === 'totp' && b.totp_code === '123456');
    flowOf(id).error = !ok;
    if (browser(req)) {
      if (ok)
        return reply
          .code(303)
          .header('set-cookie', 'ory_kratos_session=s3ss; Path=/; HttpOnly')
          .header('location', WEB)
          .send();
      return reply.code(303).header('location', `${WEB}/sign-in?flow=${id}`).send();
    }
    return ok ? { session_token: 'tok', session: { id: 's' } } : reply.code(400).send(flowBody(id));
  });
  for (const kind of ['recovery', 'verification']) {
    app.post(`/self-service/${kind}`, async (req, reply) => {
      const id = (req.query as any).flow as string;
      const b = req.body as any;
      const f = flowOf(id);
      if (b.code !== undefined) {
        f.error = b.code !== '654321';
        if (!f.error) f.state = 'passed_challenge';
      } else f.state = 'sent_email';
      if (browser(req)) return reply.code(303).header('location', `${WEB}/auth/${kind}?flow=${id}`).send();
      return reply.code(f.error ? 400 : 200).send(flowBody(id));
    });
  }
  return { app, hits, flows };
}

describe('the gateway', () => {
  let kratos: ReturnType<typeof fakeKratos>;
  let gateway: FastifyInstance;
  let store: MemoryStore;
  let mail: MemoryMail;
  let waits: number[];
  let clock: Date;

  beforeAll(async () => {
    kratos = fakeKratos();
    await kratos.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await kratos.app.close();
  });
  beforeEach(async () => {
    await gateway?.close();
    store = new MemoryStore();
    mail = new MemoryMail();
    waits = [];
    clock = t0;
    kratos.hits.length = 0;
    const address = kratos.app.server.address() as { port: number };
    gateway = buildAuthGateway({
      kratosUrl: `http://127.0.0.1:${address.port}`,
      webUrl: WEB,
      secret: SECRET,
      store,
      mail,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
  });

  const nativeLogin = (password: string, opts: { flow?: string; ip?: string; email?: string } = {}) =>
    gateway.inject({
      method: 'POST',
      url: `/self-service/login?flow=${opts.flow ?? 'f1'}`,
      remoteAddress: opts.ip ?? '203.0.113.7',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      payload: { method: 'password', identifier: opts.email ?? EMAIL, password },
    });
  const browserLogin = (password: string) =>
    gateway.inject({
      method: 'POST',
      url: '/self-service/login?flow=b1',
      remoteAddress: '203.0.113.8',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      payload: new URLSearchParams({
        method: 'password',
        identifier: EMAIL,
        password,
        csrf_token: 'x',
      }).toString(),
    });

  it('passes other requests through unchanged, with the client’s address', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/echo', remoteAddress: '198.51.100.4' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    const seen = res.json().headers;
    expect(seen['x-forwarded-for']).toBe('198.51.100.4');
    expect(seen['accept-encoding']).toBe('identity');
    expect(store.buckets.size).toBe(0);
  });

  it('slows wrong passwords down, then pauses the account and tells its owner', async () => {
    for (let i = 1; i <= 5; i++) expect((await nativeLogin('wrong')).statusCode).toBe(400);
    expect(waits).toEqual([]);
    expect((await nativeLogin('wrong')).statusCode).toBe(400);
    expect(waits).toEqual([1000]);
    for (let i = 7; i <= 10; i++) await nativeLogin('wrong');
    await new Promise((r) => setTimeout(r, 10));
    expect(store.lockouts).toEqual([
      { email: EMAIL, detail: expect.objectContaining({ ip: '203.0.113.7', until: expect.any(String) }) },
    ]);
    expect(mail.outbox.map((m) => [m.to, m.subject])).toEqual([
      [EMAIL, 'Sign-in to your Montra account was paused'],
    ]);

    // Even the right password waits now, and Kratos never sees it.
    const before = kratos.hits.filter((h) => h === 'POST /self-service/login').length;
    const paused = await nativeLogin('right password', { ip: '192.0.2.50' });
    expect(paused.statusCode).toBe(429);
    expect(Number(paused.headers['retry-after'])).toBe(900);
    expect(paused.json()).toMatchObject({
      id: 'f1',
      ui: {
        messages: [{ id: TOO_MANY_ATTEMPTS_ID, type: 'error', text: expect.stringContaining('15 minutes') }],
      },
    });
    expect(kratos.hits.filter((h) => h === 'POST /self-service/login').length).toBe(before);
    // Another account from the same address is not paused.
    expect((await nativeLogin('right password', { email: 'someone@example.test' })).statusCode).toBe(200);

    clock = later(RULES.account.lockMs);
    expect((await nativeLogin('right password')).statusCode).toBe(200);
  });

  it('forgets an account’s failures when it signs in', async () => {
    for (let i = 0; i < 4; i++) await nativeLogin('wrong');
    expect((await nativeLogin('right password')).statusCode).toBe(200);
    expect(store.buckets.get(keyOf(SECRET, 'account', EMAIL))).toBeUndefined();
    // The address keeps its count: it may be trying many accounts.
    expect(store.buckets.get(keyOf(SECRET, 'address', '203.0.113.7'))?.failures).toBe(4);
  });

  it('pauses guessing from one address across many accounts', async () => {
    for (let i = 0; i < RULES.address.maxFailures; i++)
      await nativeLogin('wrong', { email: `user${i}@example.test` });
    expect((await nativeLogin('right password', { email: 'fresh@example.test' })).statusCode).toBe(429);
    expect(
      (await nativeLogin('right password', { email: 'fresh@example.test', ip: '192.0.2.9' })).statusCode,
    ).toBe(200);
  });

  it('sends a paused browser back to the form with a notice', async () => {
    const wrong = await browserLogin('wrong');
    expect(wrong.statusCode).toBe(303);
    expect(wrong.headers.location).toBe(`${WEB}/sign-in?flow=b1`);
    for (let i = 2; i <= RULES.account.maxFailures; i++) await browserLogin('wrong');
    const paused = await browserLogin('right password');
    expect(paused.statusCode).toBe(303);
    const to = new URL(paused.headers.location as string);
    expect(`${to.origin}${to.pathname}`).toBe(`${WEB}/sign-in`);
    expect(Object.fromEntries(to.searchParams)).toEqual({
      notice: 'too_many_attempts',
      retry: '900',
      flow: 'b1',
    });
  });

  it('counts a browser sign-in that sets the session cookie as a success', async () => {
    await browserLogin('wrong');
    const ok = await browserLogin('right password');
    expect(ok.headers['set-cookie']).toContain('ory_kratos_session=s3ss; Path=/; HttpOnly');
    expect(store.buckets.get(keyOf(SECRET, 'account', EMAIL))).toBeUndefined();
  });

  it('allows five wrong authenticator codes per session', async () => {
    const totp = (code: string, token = 'session-a') =>
      gateway.inject({
        method: 'POST',
        url: '/self-service/login?flow=t1',
        headers: { 'content-type': 'application/json', 'x-session-token': token },
        payload: { method: 'totp', totp_code: code },
      });
    for (let i = 0; i < RULES.second_factor.maxFailures; i++)
      expect((await totp('000000')).statusCode).toBe(400);
    expect((await totp('123456')).statusCode).toBe(429);
    expect((await totp('123456', 'session-b')).statusCode).toBe(200);
  });

  it('counts a verified email code as done, not as a failure', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/self-service/verification?flow=v1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'method=code&code=654321&csrf_token=x',
    });
    expect(res.statusCode).toBe(303);
    expect(store.buckets.size).toBe(0);
    await gateway.inject({
      method: 'POST',
      url: '/self-service/verification?flow=v2',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'method=code&code=111111&csrf_token=x',
    });
    expect([...store.buckets.values()].map((b) => b.failures)).toEqual([1, 1]);
  });

  it('limits how many recovery emails one address can ask for', async () => {
    const ask = () =>
      gateway.inject({
        method: 'POST',
        url: '/self-service/recovery?flow=r1',
        headers: { 'content-type': 'application/json' },
        payload: { method: 'code', email: EMAIL },
      });
    for (let i = 0; i < RULES.email_send.maxFailures; i++) expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(429);
  });

  it('answers 502 when Kratos is down', async () => {
    const down = buildAuthGateway({
      kratosUrl: 'http://127.0.0.1:9',
      webUrl: WEB,
      secret: SECRET,
      store,
      mail,
    });
    const res = await down.inject({ method: 'GET', url: '/sessions/whoami' });
    expect(res.statusCode).toBe(502);
    await down.close();
  });
});

describe('the counters in Postgres', () => {
  let db: Db;
  let admin: pg.Client;
  let store: ThrottleStore;

  beforeAll(async () => {
    db = new Db(loadConfig({ DATABASE_URL: APP_URL }));
    store = new ThrottleStore(db);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`insert into app.app_user (email) values ($1) on conflict (email) do nothing`, [EMAIL]);
  });
  afterAll(async () => {
    await admin.end();
    await db.onApplicationShutdown();
  });

  it('counts, locks, clears and prunes, holding no email in the table', async () => {
    const key = keyOf(SECRET, 'account', `pg-${Date.now()}@example.test`);
    let last;
    for (let i = 0; i < RULES.account.maxFailures; i++) last = await store.fail(key, RULES.account, t0);
    expect(last!.locked).toBe(true);
    expect(lockedFor((await store.get([key])).get(key), t0)).toBe(900);
    const rows = (await admin.query(`select key from app.auth_throttle where key = $1`, [key])).rows;
    expect(rows[0].key).not.toContain('@');
    // Ten concurrent failures on a fresh key all count.
    const busy = keyOf(SECRET, 'address', `busy-${Date.now()}`);
    await Promise.all(Array.from({ length: 10 }, () => store.fail(busy, RULES.address, t0)));
    expect((await store.get([busy])).get(busy)?.failures).toBe(10);
    await store.clear([key]);
    expect((await store.get([key])).size).toBe(0);
    expect(await store.prune(new Date(t0.getTime() + 4 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect((await store.get([busy])).size).toBe(0);
  });

  it('notes a lockout on an account that exists, and only then', async () => {
    expect(await store.noteLockout(EMAIL.toUpperCase(), { ip: '203.0.113.7' })).toBe(true);
    expect(await store.noteLockout('nobody-here@example.test', {})).toBe(false);
    const events = (
      await admin.query(
        `select e.kind, e.detail from app.security_event e join app.app_user u on u.id = e.user_id where u.email = $1`,
        [EMAIL],
      )
    ).rows;
    expect(events).toEqual([{ kind: 'sign_in_locked', detail: { ip: '203.0.113.7' } }]);
  });
});

describe('the gateway’s configuration', () => {
  const prod = {
    NODE_ENV: 'production',
    AUTH_MODE: 'kratos',
    KRATOS_PUBLIC_URL: 'http://kratos.internal:4433',
    MAIL_MODE: 'smtp',
    MAIL_URL: 'smtp://mail.example.test:587',
  };

  it('needs its HMAC key in production, but not the API’s data key or staff connections', () => {
    expect(() => loadConfig(prod, { process: 'auth-gateway' })).toThrow(/AUTH_GATEWAY_SECRET/);
    const ok = loadConfig({ ...prod, AUTH_GATEWAY_SECRET: SECRET }, { process: 'auth-gateway' });
    expect(ok.AUTH_GATEWAY_PORT).toBe(4455);
    expect(() => loadConfig({ ...prod, AUTH_GATEWAY_SECRET: SECRET })).toThrow();
  });
});
