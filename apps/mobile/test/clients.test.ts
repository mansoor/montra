/* eslint-disable @typescript-eslint/no-explicit-any -- fake Kratos bodies are untyped JSON */
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
  it('uploads device files natively, and FormData only for other URIs', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, body: { fileId: 'via-fetch' } }));
    const sent: Array<{ url: string; name: string; headers: Record<string, string> }> = [];
    let next: 'ok' | 'reject' | 'fail' = 'ok';
    const api = createApi({
      baseUrl: 'http://api',
      token: async () => 'dev:a@b.co',
      fetch: f,
      uploadFile: async (url, file, headers) => {
        sent.push({ url, name: file.name, headers });
        if (next === 'fail') throw new Error('Socket closed');
        return next === 'ok'
          ? { status: 201, body: JSON.stringify({ fileId: 'f1' }) }
          : {
              status: 415,
              body: JSON.stringify({ code: 'receipt.unsupported_type', detail: 'Upload a JPEG' }),
            };
      },
    });
    const page = { uri: 'file:///data/receipts/r1/page-01.jpg', name: 'page-01.jpg', type: 'image/jpeg' };
    expect(await api.uploadReceiptFile('w1', page)).toEqual({ fileId: 'f1' });
    expect(sent[0]).toMatchObject({ url: 'http://api/v1/workspaces/w1/receipts/files', name: 'page-01.jpg' });
    expect(sent[0]!.headers.authorization).toBe('Bearer dev:a@b.co');

    next = 'reject';
    await expect(api.uploadPayslipFile('w1', page)).rejects.toMatchObject({
      status: 415,
      code: 'receipt.unsupported_type',
      message: 'Upload a JPEG',
    });
    next = 'fail';
    await expect(api.uploadReceiptFile('w1', page)).rejects.toMatchObject({
      status: 0,
      message: 'Socket closed',
    });

    // Statements keep FormData, which sends their own name, as does a content: URI from another app.
    expect(await api.upload('w1', { ...page, name: 'statement.csv' })).toEqual({ fileId: 'via-fetch' });
    expect(await api.uploadReceiptFile('w1', { ...page, uri: 'content://docs/scan.jpg' })).toEqual({
      fileId: 'via-fetch',
    });
    expect(calls.map((c) => c.url)).toEqual([
      'http://api/v1/workspaces/w1/uploads',
      'http://api/v1/workspaces/w1/receipts/files',
    ]);
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect(sent).toHaveLength(3);
  });

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

  it('edits a goal with its version, and reports a stale one as a conflict', async () => {
    const { f, calls } = fakeFetch(() => ({
      status: 409,
      body: { code: 'version.conflict', title: 'Conflict', detail: 'The goal was changed by someone else' },
    }));
    const api = createApi({ baseUrl: 'http://api', token: async () => 'dev:a@b.co', fetch: f });
    const err = await api.updateGoal('w1', 'g1', { archived: true, version: 4 }).catch((e) => e);
    expect(calls[0]!.url).toBe('http://api/v1/workspaces/w1/goals/g1');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ archived: true, version: 4 });
    expect(err).toMatchObject({ status: 409, code: 'version.conflict' });
  });

  it('says which app this is, and tells when it’s too old (OPS-04)', async () => {
    const { f, calls } = fakeFetch(() => ({
      status: 426,
      body: { code: 'app.update_required', title: 'Upgrade required' },
    }));
    let told = 0;
    const api = createApi({
      baseUrl: 'http://api',
      token: async () => null,
      fetch: f,
      app: { version: '1.2.3', platform: 'ios' },
      onUpdateRequired: () => told++,
    });
    const err = await api.workspaces().catch((e) => e);
    expect(err).toMatchObject({ status: 426, code: 'app.update_required' });
    expect(told).toBe(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-app-version']).toBe('1.2.3');
    expect(headers['x-app-platform']).toBe('ios');
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
      if (c.url.includes('/self-service/login?flow=flow1'))
        return { status: 200, body: { session_token: 'tok' } };
      if (c.url.endsWith('/self-service/login/api?aal=aal2'))
        return { status: 200, body: { id: 'flow2', ui: { nodes: [{ attributes: { name: 'totp_code' } }] } } };
      if (c.url.includes('flow=flow2')) return { status: 200, body: { session_token: 'tok2' } };
      return { status: 404 };
    });
    const k = new KratosClient('http://kratos', f);
    const step1 = await k.login('a@b.co', 'pw');
    expect(step1).toEqual({ kind: 'needs_totp', token: 'tok', flowId: 'flow2' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      method: 'password',
      identifier: 'a@b.co',
      password: 'pw',
    });
    expect(await k.totp('tok', 'flow2', '123 456')).toEqual({ kind: 'signed_in', token: 'tok2' });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ method: 'totp', totp_code: '123456' });
  });

  it('surfaces Kratos error messages', async () => {
    const { f } = fakeFetch((c) =>
      c.url.endsWith('/login/api')
        ? { status: 200, body: { id: 'f' } }
        : {
            status: 400,
            body: { ui: { messages: [{ type: 'error', text: 'The provided credentials are invalid.' }] } },
          },
    );
    expect(await new KratosClient('http://k', f).login('a@b.co', 'x')).toEqual({
      kind: 'error',
      message: 'The provided credentials are invalid.',
    });
  });
});

describe('account flows on the phone (AUTH-01..06, ADR-0046)', () => {
  /** Answers by URL path and query, with the JSON body each request sent. */
  const kratos = (
    routes: Record<
      string,
      (body: any, headers: Record<string, string>) => { status: number; body?: unknown }
    >,
  ) => {
    const { f, calls } = fakeFetch((c) => {
      const key = `${c.init.method ?? 'GET'} ${c.url.replace('http://k', '')}`;
      const route = routes[key];
      if (!route) return { status: 404, body: { error: { message: key } } };
      return route(
        c.init.body ? JSON.parse(String(c.init.body)) : undefined,
        (c.init.headers ?? {}) as Record<string, string>,
      );
    });
    return { k: new KratosClient('http://k', f), calls };
  };
  const twoStepNodes = {
    ui: { nodes: [{ attributes: { name: 'totp_code' } }, { attributes: { name: 'lookup_secret' } }] },
  };

  it('asks for the second step only when the account offers one', async () => {
    const withFactor = kratos({
      'GET /self-service/login/api': () => ({ status: 200, body: { id: 'l1' } }),
      'POST /self-service/login?flow=l1': () => ({ status: 200, body: { session_token: 't' } }),
      'GET /self-service/login/api?aal=aal2': () => ({ status: 200, body: { id: 'l2', ...twoStepNodes } }),
      'POST /self-service/login?flow=l2': (b) =>
        b.lookup_secret === 'abcd1234'
          ? { status: 200, body: { session_token: 't' } }
          : { status: 400, body: {} },
    });
    const step = await withFactor.k.login('a@b.co', 'pw');
    expect(step).toEqual({ kind: 'needs_totp', token: 't', flowId: 'l2' });
    expect(await withFactor.k.recoveryCode('t', 'l2', ' abcd1234 ')).toEqual({
      kind: 'signed_in',
      token: 't',
    });
    const without = kratos({
      'GET /self-service/login/api': () => ({ status: 200, body: { id: 'l1' } }),
      'POST /self-service/login?flow=l1': () => ({ status: 200, body: { session_token: 't' } }),
      'GET /self-service/login/api?aal=aal2': () => ({ status: 200, body: { id: 'l2', ui: { nodes: [] } } }),
    });
    expect(await without.k.login('a@b.co', 'pw')).toEqual({ kind: 'signed_in', token: 't' });
  });

  it('signs up with a name and password, then confirms the email with the code', async () => {
    const { k, calls } = kratos({
      'GET /self-service/registration/api': () => ({ status: 200, body: { id: 'r1' } }),
      'POST /self-service/registration?flow=r1': (b) =>
        b.password === 'weak'
          ? {
              status: 400,
              body: {
                ui: {
                  messages: [{ id: 4000901, type: 'error', text: 'This password is too easy to guess.' }],
                },
              },
            }
          : {
              status: 200,
              body: {
                session_token: 'new',
                continue_with: [{ action: 'show_verification_ui', flow: { id: 'v1' } }],
              },
            },
      'POST /self-service/verification?flow=v1': (b) =>
        b.code === '123456'
          ? { status: 200, body: { state: 'passed_challenge' } }
          : { status: 400, body: { ui: { messages: [{ type: 'error', text: 'The code is invalid.' }] } } },
    });
    // The gateway's refusal reads like Kratos's own.
    expect(await k.signUp({ email: 'a@b.co', first: 'A', last: 'B', password: 'weak' })).toEqual({
      kind: 'error',
      message: 'This password is too easy to guess.',
    });
    expect(
      await k.signUp({ email: ' a@b.co ', first: ' Ann ', last: 'Bee', password: 'long and strong' }),
    ).toEqual({
      kind: 'signed_up',
      token: 'new',
      verificationFlowId: 'v1',
    });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({
      method: 'password',
      password: 'long and strong',
      traits: { email: 'a@b.co', name: { first: 'Ann', last: 'Bee' } },
    });
    expect(await k.verifyEmail('v1', '000000')).toEqual({ kind: 'error', message: 'The code is invalid.' });
    expect(await k.verifyEmail('v1', '123 456')).toEqual({ kind: 'ok' });
  });

  it('resets a password, asking for the second factor first when the account has one', async () => {
    const { k } = kratos({
      'GET /self-service/recovery/api': () => ({ status: 200, body: { id: 'c1' } }),
      'POST /self-service/recovery?flow=c1': (b) =>
        b.email
          ? { status: 200, body: { state: 'sent_email' } }
          : {
              status: 200,
              body: {
                continue_with: [
                  { action: 'set_ory_session_token', ory_session_token: 'rec' },
                  { action: 'show_settings_ui', flow: { id: 's1' } },
                ],
              },
            },
      'GET /self-service/login/api?aal=aal2': () => ({ status: 200, body: { id: 'l2', ...twoStepNodes } }),
      'GET /self-service/settings/api': () => ({ status: 200, body: { id: 's2' } }),
      'POST /self-service/settings?flow=s2': (b, h) =>
        h['x-session-token'] === 'rec' && b.password
          ? { status: 200, body: { state: 'success' } }
          : { status: 400, body: {} },
    });
    expect(await k.startRecovery('a@b.co')).toEqual({ kind: 'sent', flowId: 'c1' });
    // The settings flow from before the second factor isn't used after it.
    expect(await k.finishRecovery('c1', '111111')).toEqual({
      kind: 'recovered',
      token: 'rec',
      settingsFlowId: null,
      secondStepFlowId: 'l2',
    });
    expect(await k.setPassword('rec', 'a new one', null)).toEqual({ kind: 'ok' });
  });

  it('sets up an authenticator and recovery codes, asking for the password when the session is old', async () => {
    let fresh = false;
    const settingsNodes = {
      ui: {
        nodes: [
          { attributes: { id: 'totp_secret_key', text: { context: { secret: 'ABCDEF' } } } },
          { attributes: { id: 'totp_qr', src: 'data:image/png;base64,xx' } },
        ],
      },
    };
    const { k } = kratos({
      'GET /self-service/settings/api': () =>
        fresh
          ? { status: 200, body: { id: 's1', ...settingsNodes } }
          : { status: 403, body: { error: { id: 'session_refresh_required' } } },
      'GET /self-service/login/api?refresh=true': () => ({ status: 200, body: { id: 'l9' } }),
      'POST /self-service/login?flow=l9': (b) => {
        fresh = b.password === 'right';
        return fresh
          ? { status: 200, body: {} }
          : { status: 400, body: { ui: { messages: [{ type: 'error', text: 'Wrong password.' }] } } };
      },
      'POST /self-service/settings?flow=s1': (b) =>
        b.method === 'totp'
          ? { status: 200, body: { state: 'success' } }
          : b.lookup_secret_regenerate
            ? {
                status: 200,
                body: {
                  id: 's1',
                  ui: {
                    nodes: [
                      {
                        attributes: {
                          id: 'lookup_secret_codes',
                          text: { context: { secrets: [{ text: 'aaaa1111' }, { text: 'bbbb2222' }] } },
                        },
                      },
                    ],
                  },
                },
              }
            : { status: 200, body: { state: 'success' } },
    });
    expect(await k.startAuthenticator('t')).toEqual({ kind: 'reauth' });
    expect(await k.reauthenticate('t', 'a@b.co', 'wrong')).toEqual({
      kind: 'error',
      message: 'Wrong password.',
    });
    expect(await k.reauthenticate('t', 'a@b.co', 'right')).toEqual({ kind: 'ok' });
    expect(await k.startAuthenticator('t')).toEqual({
      kind: 'setup',
      flowId: 's1',
      secret: 'ABCDEF',
      qr: 'data:image/png;base64,xx',
    });
    expect(await k.confirmAuthenticator('t', 's1', '123 456')).toEqual({ kind: 'ok' });
    expect(await k.newRecoveryCodes('t')).toEqual({
      kind: 'codes',
      flowId: 's1',
      codes: ['aaaa1111', 'bbbb2222'],
    });
    expect(await k.confirmRecoveryCodes('t', 's1')).toEqual({ kind: 'ok' });
  });
});

describe('two-step required by the workspace (ADR-0044)', () => {
  it('tells the app when the server asks for two-step verification', async () => {
    let asked = 0;
    const { f } = fakeFetch(() => ({
      status: 403,
      body: { code: 'mfa.setup_required', detail: 'Set it up' },
    }));
    const api = createApi({
      baseUrl: 'http://api',
      token: async () => 't',
      fetch: f,
      onTwoStepRequired: () => asked++,
    });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(asked).toBe(1);
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
        const s = {
          sent: [] as string[],
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        } as unknown as SocketLike & {
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
