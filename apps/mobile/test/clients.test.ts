import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/api/client';
import { KratosClient, devToken } from '../src/auth/kratos';
import { RealtimeClient, reconnectDelay, wsUrl, type SocketLike } from '../src/sync/realtime';

type Call = { url: string; init: RequestInit };
const fakeFetch = (respond: (c: Call) => { status: number; body?: unknown }) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c = { url, init };
    calls.push(c);
    const r = respond(c);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('API client', () => {
  it('sends the bearer token and maps problem responses', async () => {
    const { f, calls } = fakeFetch((c) =>
      c.url.endsWith('/v1/workspaces')
        ? { status: 200, body: { data: [{ id: 'w1' }] } }
        : { status: 422, body: { code: 'account.not_found', title: 'Bad', detail: 'No such account' } },
    );
    const api = createApi({ baseUrl: 'http://api', token: async () => 'dev:a@b.co', fetch: f });
    expect(await api.workspaces()).toEqual([{ id: 'w1' }]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer dev:a@b.co');
    const err = await api.suggest('w1', {} as never).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'account.not_found', message: 'No such account' });
  });

  it('reports network failures as offline', async () => {
    const api = createApi({
      baseUrl: 'http://api',
      token: async () => null,
      fetch: (async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
    });
    const err = (await api.me().catch((e) => e)) as ApiError;
    expect(err.offline).toBe(true);
  });
});

describe('sign-in', () => {
  it('builds dev tokens', () => {
    expect(devToken(' Ana@Example.com ')).toBe('dev:ana@example.com');
    expect(() => devToken('nope')).toThrow();
  });

  it('runs the Kratos native login, asking for TOTP when AAL2 is required', async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/self-service/login/api')) return { status: 200, body: { id: 'flow1' } };
      if (c.url.includes('/self-service/login?flow=flow1')) return { status: 200, body: { session_token: 'tok' } };
      if (c.url.endsWith('/sessions/whoami'))
        return { status: 403, body: { error: { id: 'session_aal2_required' } } };
      if (c.url.endsWith('/self-service/login/api?aal=aal2')) return { status: 200, body: { id: 'flow2' } };
      if (c.url.includes('flow=flow2')) return { status: 200, body: { session_token: 'tok2' } };
      return { status: 404 };
    });
    const k = new KratosClient('http://kratos', f);
    const step1 = await k.login('a@b.co', 'pw');
    expect(step1).toEqual({ kind: 'needs_totp', token: 'tok', flowId: 'flow2' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ method: 'password', identifier: 'a@b.co', password: 'pw' });
    expect(await k.totp('tok', 'flow2', '123 456')).toEqual({ kind: 'signed_in', token: 'tok2' });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ method: 'totp', totp_code: '123456' });
  });

  it('surfaces Kratos error messages', async () => {
    const { f } = fakeFetch((c) =>
      c.url.endsWith('/login/api')
        ? { status: 200, body: { id: 'f' } }
        : { status: 400, body: { ui: { messages: [{ type: 'error', text: 'The provided credentials are invalid.' }] } } },
    );
    expect(await new KratosClient('http://k', f).login('a@b.co', 'x')).toEqual({
      kind: 'error',
      message: 'The provided credentials are invalid.',
    });
  });
});

describe('realtime', () => {
  it('subscribes with the token, reacts to changes and reconnects with backoff', async () => {
    const sockets: Array<SocketLike & { sent: string[] }> = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let changes = 0;
    const rt = new RealtimeClient({
      url: wsUrl('https://api.montra.app/'),
      workspaceId: 'w1',
      token: async () => 'tok',
      onChanges: () => changes++,
      createSocket: (url) => {
        expect(url).toBe('wss://api.montra.app/v1/ws');
        const s = { sent: [] as string[], onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as SocketLike & {
          sent: string[];
        };
        s.send = (d: string) => void s.sent.push(d);
        s.close = () => s.onclose?.();
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => undefined,
    });
    rt.start();
    sockets[0]!.onopen!();
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'subscribe', workspaceId: 'w1', token: 'tok' });
    sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'changes', workspaceId: 'w1', seq: '9' }) });
    sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'changes', workspaceId: 'other' }) });
    sockets[0]!.onmessage!({ data: 'not json' });
    expect(changes).toBe(1);
    sockets[0]!.onclose!();
    expect(timers[0]!.ms).toBe(1000);
    timers[0]!.fn();
    expect(sockets).toHaveLength(2);
    rt.stop();
    expect(reconnectDelay(10)).toBe(30_000);
  });
});
