/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

/** A minimal stand-in for the Kratos public API (whoami and session management). */
interface FakeSession {
  token: string;
  identityId: string;
  email: string;
  verified: boolean;
  aal: 'aal1' | 'aal2';
  authenticatedAt: Date;
  active: boolean;
}

let kratos: Server;
let h: Harness;
const sessions = new Map<string, FakeSession>();
let whoamiCalls = 0;
const HOOK_SECRET = 'test-hook-secret-0123456789abcdef0123';

const sessionJson = (s: FakeSession, id = `sess-${s.token}`) => ({
  id,
  active: s.active,
  authenticated_at: s.authenticatedAt.toISOString(),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  authenticator_assurance_level: s.aal,
  devices: [{ user_agent: 'vitest', ip_address: '127.0.0.1' }],
  identity: {
    id: s.identityId,
    traits: { email: s.email, name: { first: 'Kim', last: 'Lee' } },
    verifiable_addresses: [{ value: s.email, verified: s.verified, via: 'email' }],
  },
});

const add = (token: string, overrides: Partial<FakeSession> = {}) =>
  sessions.set(token, {
    token,
    identityId: `id-${token}`,
    email: `${token}@example.com`,
    verified: true,
    aal: 'aal2',
    authenticatedAt: new Date(),
    active: true,
    ...overrides,
  });

beforeAll(async () => {
  kratos = createServer((req, res) => {
    const token =
      (req.headers['x-session-token'] as string | undefined) ??
      /ory_kratos_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const s = token ? sessions.get(token) : undefined;
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (!s || !s.active) return send(401, { error: { code: 401 } });
    if (req.method === 'GET' && req.url === '/sessions/whoami') {
      whoamiCalls++;
      return send(200, sessionJson(s));
    }
    const siblings = [...sessions.values()].filter(
      (o) => o.identityId === s.identityId && o.token !== s.token && o.active,
    );
    if (req.method === 'GET' && req.url === '/sessions')
      return send(
        200,
        siblings.map((o) => sessionJson(o)),
      );
    if (req.method === 'DELETE' && req.url === '/sessions') {
      siblings.forEach((o) => (o.active = false));
      return send(200, { count: siblings.length });
    }
    const one = /^\/sessions\/sess-(.+)$/.exec(req.url ?? '');
    if (req.method === 'DELETE' && one) {
      const target = siblings.find((o) => o.token === one[1]);
      if (!target) return send(404, {});
      target.active = false;
      return send(204);
    }
    send(404, {});
  });
  await new Promise<void>((r) => kratos.listen(0, '127.0.0.1', r));
  const port = (kratos.address() as AddressInfo).port;
  h = await startHarness({
    AUTH_MODE: 'kratos',
    KRATOS_PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_CACHE_SECONDS: '60',
    KRATOS_WEBHOOK_SECRET: HOOK_SECRET,
  });
});

afterAll(async () => {
  await h.close();
  await new Promise((r) => kratos.close(r));
});

const call = async (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token?: string,
  body?: unknown,
  cookie = false,
) => {
  const headers: Record<string, string> = {};
  if (token) {
    if (cookie) headers.cookie = `theme=dark; ory_kratos_session=${token}`;
    else headers.authorization = `Bearer ${token}`;
  }
  const res = await h.app.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

describe('Ory Kratos sessions (AUTH-01..09)', () => {
  it('rejects missing, unknown and dev tokens', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', 'nope')).status).toBe(401);
    expect((await call('GET', '/v1/me', 'dev:alice@example.com')).status).toBe(401);
  });

  it('signs in with a session token or the web cookie and links the identity', async () => {
    add('kim');
    const me = await call('GET', '/v1/me', 'kim');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'kim@example.com', displayName: 'Kim Lee', emailVerified: true });
    const viaCookie = await call('GET', '/v1/me', 'kim', undefined, true);
    expect(viaCookie.body.id).toBe(me.body.id);
  });

  it('caches validated sessions', async () => {
    add('cache');
    const before = whoamiCalls;
    await call('GET', '/v1/me', 'cache');
    await call('GET', '/v1/me', 'cache');
    await call('GET', '/v1/workspaces', 'cache');
    expect(whoamiCalls - before).toBe(1);
  });

  it('blocks financial writes until the email is verified (AUTH-03)', async () => {
    add('unverified', { verified: false });
    const res = await call('POST', '/v1/workspaces', 'unverified', { name: 'Home', baseCurrency: 'USD' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('email.unverified');
    expect((await call('GET', '/v1/workspaces', 'unverified')).status).toBe(200);
  });

  it('requires a second factor for owners (AUTH-04)', async () => {
    add('owner-mfa', { identityId: 'id-owner', email: 'owner-mfa@example.com' });
    add('owner-aal1', { identityId: 'id-owner', email: 'owner-mfa@example.com', aal: 'aal1' });
    const ws = await call('POST', '/v1/workspaces', 'owner-mfa', { name: 'Home', baseCurrency: 'USD' });
    expect(ws.status).toBe(201);
    expect((await call('GET', `/v1/workspaces/${ws.body.id}/accounts`, 'owner-mfa')).status).toBe(200);
    const weak = await call('GET', `/v1/workspaces/${ws.body.id}/accounts`, 'owner-aal1');
    expect(weak.status).toBe(403);
    expect(weak.body.code).toBe('mfa.required');
  });

  it('requires recent authentication for sensitive actions (AUTH-09)', async () => {
    add('stale', { authenticatedAt: new Date(Date.now() - 30 * 60_000) });
    const ws = await call('POST', '/v1/workspaces', 'stale', {
      name: 'Home',
      baseCurrency: 'USD',
      template: 'freelancer',
    });
    const invite = await call('POST', `/v1/workspaces/${ws.body.id}/sharing/invites`, 'stale', {
      email: 'cpa@example.com',
      role: 'accountant',
    });
    expect(invite.status).toBe(403);
    expect(invite.body.code).toBe('reauth.required');
    // Partners don't need a fresh login.
    const partner = await call('POST', `/v1/workspaces/${ws.body.id}/sharing/invites`, 'stale', {
      email: 'p@example.com',
      role: 'partner',
    });
    expect(partner.status).toBe(201);
  });

  it('lists devices and signs out other sessions, effective immediately (AUTH-07)', async () => {
    add('laptop', { identityId: 'id-multi', email: 'multi@example.com' });
    add('phone', { identityId: 'id-multi', email: 'multi@example.com' });
    add('tablet', { identityId: 'id-multi', email: 'multi@example.com' });
    expect((await call('GET', '/v1/me', 'phone')).status).toBe(200); // cached now
    const list = await call('GET', '/v1/me/sessions', 'laptop');
    expect(list.body.data.map((s: any) => s.current)).toEqual([true, false, false]);

    expect((await call('DELETE', '/v1/me/sessions/sess-tablet', 'laptop')).body).toEqual({ revoked: true });
    expect((await call('GET', '/v1/me', 'tablet')).status).toBe(401);

    expect((await call('DELETE', '/v1/me/sessions', 'laptop')).body).toEqual({ revoked: 1 });
    // The phone's session was cached; revocation evicted it.
    expect((await call('GET', '/v1/me', 'phone')).status).toBe(401);
    expect((await call('GET', '/v1/me', 'laptop')).status).toBe(200);
  });

  it('evicts cached sessions when Kratos reports a recovery (AUTH-05)', async () => {
    add('reset', { identityId: 'id-reset', email: 'reset@example.com' });
    expect((await call('GET', '/v1/me', 'reset')).status).toBe(200);
    sessions.get('reset')!.active = false; // Kratos revoked it during recovery
    expect((await call('GET', '/v1/me', 'reset')).status).toBe(200); // still cached
    const bad = await h.app.inject({
      method: 'POST',
      url: '/internal/kratos/hooks',
      headers: { 'x-montra-hook-secret': 'wrong-secret-wrong-secret-wrong-secret' },
      payload: { event: 'recovery', identity_id: 'id-reset' },
    });
    expect(bad.statusCode).toBe(401);
    const hook = await h.app.inject({
      method: 'POST',
      url: '/internal/kratos/hooks',
      headers: { 'x-montra-hook-secret': HOOK_SECRET },
      payload: { event: 'recovery', identity_id: 'id-reset' },
    });
    expect(JSON.parse(hook.body)).toEqual({ evicted: 1 });
    expect((await call('GET', '/v1/me', 'reset')).status).toBe(401);
  });
});
