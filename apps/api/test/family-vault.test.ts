/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NetworkError } from '@fdv/client';
import { NOT_EXPORTED } from '../src/data/catalog.js';
import { VaultError } from '../src/storage/destinations/vault.js';
import { asVaultError, readConnectionString, VaultConnection } from '../src/storage/vault/connection.js';
import type { FakeVaultHandle, FakeVaultKey } from '../src/storage/vault/fake.js';
import { VaultSecret } from '../src/storage/vault/keys.js';
import {
  assertVaultAddress,
  guardedVaultTransport,
  VAULT_TRANSPORT,
  type VaultTransport,
} from '../src/storage/vault/transport.js';
import { VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { expiresSoon, VAULT_FAILING_AFTER } from '../src/storage/vault/vault.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Connecting the workspace to the household's Family Document Vault (ADR-0054 §2, §7, §8; PR 2, and the vault's API
// keys from 0.9.0-dev.63), against the vault's own fake from `@fdv/client/testing`, in this process. No real vault is
// ever reached. The fake generates keys as the vault does, after its owner's second step.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault@example.com';
const ADMIN = 'admin-vault@example.com';
const PARTNER = 'partner-vault@example.com';
/** A secret in the vault's shape that no key has. */
const WRONG_SECRET = `fdvs_${'A'.repeat(43)}`;

let h: Harness;
let c: Client;
let adminUser: Client;
let partner: Client;
let db: pg.Client;
let transport: VaultTransport & { fake: FakeVaultHandle };
let fake: FakeVaultHandle;
let wsId: string;
let url: (p: string) => string;
/** The key the workspace is connected with now. */
let current: FakeVaultKey;

const vaultRow = async () =>
  (await db.query(`select * from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [wsId]))
    .rows[0];
const state = async () =>
  (await db.query(`select * from app.vault_connection_state where workspace_id = $1`, [wsId])).rows[0];
const events = async (kind: string) =>
  (
    await db.query(`select detail from app.security_event where workspace_id = $1 and kind = $2`, [
      wsId,
      kind,
    ])
  ).rows.map((r) => r.detail);
const get = async () => (await c.get(url('/family-vault'))).body.connection;
const fakeApp = (appId: string) => fake.vault.state.connectedApps!.find((a) => a.id === appId)!;
const connect = (body: Record<string, unknown>, who: Client = c) => who.post(url('/family-vault'), body);

/** A connection string as the vault writes one, changed: what a person might paste from elsewhere. */
function changed(code: string, more: Record<string, unknown>): string {
  const json = JSON.parse(Buffer.from(code.slice('fdvapp2.'.length), 'base64url').toString('utf8'));
  return `fdvapp2.${Buffer.from(JSON.stringify({ ...json, ...more })).toString('base64url')}`;
}

/** Runs `fn` as if the person signed in more than ten minutes ago (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const later = Date.now() + 30 * 60_000;
  const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** Everything the process writes while `fn` runs. */
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
  h = await startHarness({ AI_PROVIDER: 'fake', FAMILY_VAULT_FAKE: 'on' });
  transport = h.app.get(VAULT_TRANSPORT);
  fake = transport.fake;
  c = h.as(OWNER);
  adminUser = h.as(ADMIN);
  partner = h.as(PARTNER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Vault test', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  for (const [who, email, role] of [
    [adminUser, ADMIN, 'admin'],
    [partner, PARTNER, 'partner'],
  ] as const) {
    const invite = await c.post(url('/sharing/invites'), { email, role });
    expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  }
});

afterAll(async () => {
  await db.query(`delete from app.storage_destination where workspace_id = $1`, [wsId]);
  // Connecting and "Check again" wake the vault's job (PR 3): nothing of ours may wake a worker in another test file.
  await db.query(`delete from app.job where type = 'storage.vault'`);
  await db.end();
  await h.close();
});

describe('the address guard (ADR-0054 §8, D6)', () => {
  it('takes public https only, with no loopback exception, whatever STORAGE_DESTINATIONS_PRIVATE says', () => {
    expect(assertVaultAddress('https://vault.example.com').origin).toBe('https://vault.example.com');
    expect(assertVaultAddress('https://vault.example.com:8443').origin).toBe(
      'https://vault.example.com:8443',
    );
    for (const bad of [
      'http://vault.example.com',
      'http://localhost:8091',
      'http://127.0.0.1:8091',
      'https://localhost',
      'https://vault.localhost',
      'https://nas.local',
      'https://vault',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://192.168.1.20',
      'https://172.16.4.4',
      'https://100.101.102.103',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[::ffff:10.0.0.1]',
      'https://vault.example.com/some/path',
      'https://user:pass@vault.example.com',
      'ftp://vault.example.com',
      'not a url',
    ]) {
      expect(() => assertVaultAddress(bad), bad).toThrow(VaultError);
    }
  });

  it('refuses a private address before any socket, and says so in words, not as "offline"', async () => {
    const t = guardedVaultTransport();
    await expect(
      t.fetch('https://10.1.2.3/api/v1/capabilities', { method: 'GET', headers: {} }),
    ).rejects.toThrow(VaultError);
    expect(t.refused()?.code).toBe('not_allowed_host');
    expect(asVaultError(new NetworkError('offline'), t).code).toBe('not_allowed_host');
  });

  describe('at the socket', () => {
    let server: Server;
    let base: string;
    afterEach(() => server?.close());
    const listen = async (handler: Parameters<typeof createServer>[1]) => {
      server = createServer(handler);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    it('never follows a redirect', async () => {
      let followed = false;
      await listen((req, res) => {
        if (req.url === '/elsewhere') followed = true;
        res.writeHead(302, { location: '/elsewhere' }).end();
      });
      const t = guardedVaultTransport({ insecureLoopbackForTests: true });
      const res = await t.fetch(`${base}/start`, { method: 'GET', headers: {} });
      expect(res.status).toBe(302);
      expect(res.ok).toBe(false);
      expect(followed).toBe(false);
    });

    it('refuses an answer larger than its limit', async () => {
      await listen((_req, res) => res.end(Buffer.alloc(64 * 1024, 120)));
      const t = guardedVaultTransport({ insecureLoopbackForTests: true, maxBytes: 1024 });
      await expect(t.fetch(`${base}/big`, { method: 'GET', headers: {} })).rejects.toThrow();
    });

    it('gives up on an answer that doesn’t come', async () => {
      await listen(() => undefined);
      const t = guardedVaultTransport({
        insecureLoopbackForTests: true,
        totalTimeoutMs: 300,
        connectTimeoutMs: 300,
      });
      const started = Date.now();
      await expect(t.fetch(`${base}/slow`, { method: 'GET', headers: {} })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });
});

describe('the vault’s failures, in Montra’s words (ADR-0054 §12)', () => {
  const answer = (status: number, code: string, message = 'The vault’s words.', retry?: number) =>
    new ApiRequestError(
      status,
      code,
      message,
      undefined,
      retry === undefined ? {} : { retryAfterSeconds: retry },
    );

  it('stops the connection for a problem with the app in the vault, showing the vault’s own words', () => {
    for (const code of ['app_revoked', 'app_paused', 'app_not_approved']) {
      const e = asVaultError(answer(401, code, 'Words for people.'));
      expect(e.code, code).toBe('connection');
      expect(e.stopsConnection).toBe(true);
      expect(e.shown).toBe('Words for people.');
      expect(e.keyProblem).toBeNull();
    }
  });

  it('says a key the vault refuses in Montra’s words, as needing a new key, and stops the connection', () => {
    const cases: [string, string, string][] = [
      ['app_key_revoked', 'revoked', 'The vault key was revoked. An owner needs to paste a new key.'],
      ['app_key_expired', 'expired', 'The vault key has expired. An owner needs to paste a new key.'],
      ['app_key_invalid', 'invalid', 'The vault key isn’t valid. An owner needs to paste a new key.'],
      ['app_key_required', 'invalid', 'The vault key isn’t valid. An owner needs to paste a new key.'],
    ];
    for (const [code, problem, words] of cases) {
      const e = asVaultError(answer(401, code, 'The vault’s own words.'));
      expect(e.keyProblem, code).toBe(problem);
      expect(e.shown, code).toBe(words);
      expect(e.stopsConnection, code).toBe(true);
    }
  });

  it('says which permission a key lacks, per action, and stops the connection only for sending', () => {
    const forbidden = answer(403, 'scope_not_granted', 'Not allowed.');
    const send = asVaultError(forbidden, undefined, Date.now(), 'documents.send');
    expect(send.code).toBe('not_permitted');
    expect(send.shown).toBe(
      'The vault key doesn’t allow sending documents. An owner needs to paste a key that does.',
    );
    expect(send.stopsConnection).toBe(true);
    const del = asVaultError(forbidden, undefined, Date.now(), 'documents.delete');
    expect(del.shown).toBe(
      'The vault key doesn’t allow deleting documents. An owner can paste a key that does.',
    );
    expect(del.stopsConnection).toBe(false);
    expect(asVaultError(forbidden, undefined, Date.now(), 'documents.read').shown).toMatch(
      /doesn’t allow reading/,
    );
  });

  it('holds for the daily caps, waits when asked (busy, rate limited), retries server failures, and refuses the rest', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const cap = asVaultError(answer(429, 'app_day_full', 'x', 3600), undefined, now);
    expect(cap.code).toBe('send_cap');
    expect(cap.countsAsFailure).toBe(false);
    expect(cap.opts.heldUntil?.toISOString()).toBe('2026-11-17T13:00:00.000Z');
    expect(asVaultError(answer(429, 'app_read_day_full', 'x', 60), undefined, now).code).toBe('read_cap');
    const wait = asVaultError(answer(429, 'rate_limited', 'x', 30), undefined, now);
    expect(wait.code).toBe('retry_later');
    expect(wait.opts.retryAfter?.toISOString()).toBe('2026-11-17T12:00:30.000Z');
    expect(asVaultError(answer(503, 'busy', 'x', 5), undefined, now).code).toBe('retry_later');
    expect(asVaultError(answer(500, 'internal')).code).toBe('failed');
    expect(asVaultError(answer(400, 'validation_failed')).code).toBe('refused');
    expect(asVaultError(new NetworkError('timeout')).code).toBe('unreachable');
    // The detail is codes only: never the vault's body, never a header.
    expect(asVaultError(answer(400, 'validation_failed', 'secret words')).opts.detail).toBe(
      '400 validation_failed',
    );
  });

  it('reads a connection string strictly through the package, and says one from before API keys is old', () => {
    const code = (o: object) => `fdvapp2.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
    const clientId = `fdvc_${'b'.repeat(22)}`;
    const secret = `fdvs_${'c'.repeat(43)}`;
    expect(
      readConnectionString(
        code({ url: 'https://vault.example.com', client_id: clientId, instance_id: null }),
      ),
    ).toEqual({ address: 'https://vault.example.com', clientId, identity: null, secret: null });
    expect(
      readConnectionString(
        code({ url: 'https://vault.example.com', client_id: clientId, instance_id: 'i-1', secret }),
      ),
    ).toMatchObject({ secret, identity: 'i-1' });
    const codeOf = (text: string) => {
      try {
        readConnectionString(text);
        return null;
      } catch (e) {
        return (e as VaultError).code;
      }
    };
    expect(codeOf('hello')).toBe('invalid_code');
    expect(codeOf('fdvapp2.!!!')).toBe('invalid_code');
    expect(codeOf(code({ url: 'https://vault.example.com', client_id: 'nope', instance_id: null }))).toBe(
      'invalid_code',
    );
    expect(codeOf('fdvapp1.e30')).toBe('old_code');
  });

  it('never hands a key that isn’t in the vault’s shape to the package', () => {
    const make = (clientId: string, secret: string) =>
      new VaultConnection({
        address: 'https://vault.example.com',
        clientId,
        secret,
        pinned: null,
        transport,
      });
    expect(() => make(`fdvc_${'b'.repeat(22)}`, 'fdvs_short')).toThrow(VaultError);
    expect(() => make('fdvc_short', `fdvs_${'c'.repeat(43)}`)).toThrow(VaultError);
    expect(() => make(`fdvc_${'b'.repeat(22)}`, `fdvs_${'c'.repeat(43)}`)).not.toThrow();
  });

  it('counts a key as expiring soon within 14 days, and not once it has expired', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(expiresSoon(null, now)).toBe(false);
    expect(expiresSoon('2026-12-31T00:00:00Z', now)).toBe(false);
    expect(expiresSoon('2026-12-01T00:00:00Z', now)).toBe(true);
    expect(expiresSoon('2026-11-17T00:00:00Z', now)).toBe(false);
  });
});

describe('connecting with an API key (ADR-0054 §2; VLT-01, VLT-08)', () => {
  it('lets only owners and admins see the connection, and only an owner connect', async () => {
    current = await fake.register();
    expect(await get()).toBeNull();
    expect((await adminUser.get(url('/family-vault'))).body).toEqual({ connection: null });
    expect((await partner.get(url('/family-vault'))).status).toBe(403);
    const byAdmin = await connect({ connectionString: current.codeWithSecret }, adminUser);
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.code).toBe('vault.owner_only');
    expect((await connect({ connectionString: current.codeWithSecret }, partner)).status).toBe(403);
    expect(await vaultRow()).toBeUndefined();
  });

  it('asks for a recent sign-in before connecting', async () => {
    const res = await stale(() => connect({ connectionString: current.codeWithSecret }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth.required');
    expect(await vaultRow()).toBeUndefined();
  });

  it('refuses what isn’t a connection string, one from before API keys, and a missing or wrong secret', async () => {
    const said = async (body: Record<string, unknown>) => {
      const res = await connect(body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(422);
      // Montra's words, never what was pasted.
      expect(JSON.stringify(res.body)).not.toContain(current.secret);
      return res.body as { code: string; detail: string };
    };
    expect((await said({ connectionString: 'not a connection string' })).code).toBe('vault.invalid_code');
    const old = await said({ connectionString: 'fdvapp1.eyJ1cmwiOiJodHRwczovL3ZhdWx0LmV4YW1wbGUuY29tIn0' });
    expect(old.code).toBe('vault.old_code');
    expect(old.detail).toMatch(/before the vault used API keys/);
    const noSecret = await said({ connectionString: current.code });
    expect(noSecret.code).toBe('vault.secret_needed');
    expect(noSecret.detail).toMatch(/doesn’t include the secret/);
    expect((await said({ connectionString: current.code, secret: 'hunter2' })).code).toBe(
      'vault.invalid_key',
    );
    const wrong = await said({ connectionString: current.code, secret: WRONG_SECRET });
    expect(wrong).toMatchObject({
      code: 'vault.key_invalid',
      detail: 'The vault key isn’t valid. An owner needs to paste a new key.',
    });
    expect(await vaultRow()).toBeUndefined();
  });

  it('refuses http, loopback and private addresses in a string, and a vault that isn’t the one at its address', async () => {
    for (const address of [
      'http://localhost:8091',
      'http://127.0.0.1:8091',
      'https://localhost',
      'https://10.0.0.5',
      'https://192.168.1.10',
      'https://[::1]',
    ]) {
      const res = await connect({ connectionString: changed(current.codeWithSecret, { url: address }) });
      expect(res.status, address).toBe(422);
      // Plain http elsewhere isn't even a string to the package; the rest pass it and Montra's guard refuses them.
      expect(['vault.not_allowed_host', 'vault.invalid_code'], address).toContain(res.body.code);
      if (address.startsWith('http://localhost')) expect(res.body.code).toBe('vault.not_allowed_host');
    }
    const other = await connect({
      connectionString: changed(current.codeWithSecret, {
        instance_id: '9f9f9f9f-0000-4000-8000-000000000000',
      }),
    });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('vault.identity_changed');
    expect(await vaultRow()).toBeUndefined();
  });

  it('connects with a pasted string and the secret pasted apart, sealing the secret at once (§15)', async () => {
    const res = await connect({
      // With the line breaks people paste.
      connectionString: `${current.code.slice(0, 30)}\n${current.code.slice(30)}`,
      secret: ` ${current.secret} `,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      stage: 'connected',
      status: 'active',
      address: 'https://fake.example',
      householdName: 'The fake family',
      // Montra acts as itself in the vault (APP8, the vault's default), under its own name there.
      actsAs: 'app',
      actingAs: 'Montra',
      keyProblem: null,
      key: {
        clientId: current.clientId,
        name: 'Montra',
        permissions: ['documents.send'],
        expiresSoon: false,
      },
      vaultKinds: [{ key: 'utility_bill', name: 'Utility / bill' }],
      canDelete: false,
      lastError: null,
    });
    expect(res.body.key.createdAt).not.toBeNull();
    const days = (Date.parse(res.body.key.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
    expect(res.body.groups).toEqual([
      { group: 'receipts', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'statements', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'bills', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'payslips', mode: 'not_sent', vaultKind: null },
      { group: 'tax_documents', mode: 'not_sent', vaultKind: null },
      { group: 'other', mode: 'not_sent', vaultKind: null },
    ]);
    expect(res.body).not.toHaveProperty('publicKey');
    expect(res.body).not.toHaveProperty('fingerprint');
    const row = await vaultRow();
    expect(row.config).toMatchObject({ auth: 'key', clientId: current.clientId, appId: current.appId });
    // The pinned identity is the vault's own installation id, as it reported it.
    expect(row.config.identity).toMatch(/^[0-9a-f-]{36}$/);
    // Sending is on once connected; nothing is queued until the owner maps a group (PR 3).
    expect(row).toMatchObject({ kind: 'fdv', mirror_files: true, status: 'active', secret_hint: null });
    expect(row.file_kinds).toEqual([]);
    // The secret is sealed: not in the config, and not readable in the ciphertext; opened, it is the key pasted.
    expect(JSON.stringify(row.config)).not.toContain(current.secret);
    expect(row.secret_enc.toString('latin1')).not.toContain(current.secret);
    expect(await sealedSecret()).toEqual({ v: 2, clientId: current.clientId, secret: current.secret });
    const s = await state();
    expect(s.checked_at).not.toBeNull();
    expect(s.next_check_at.getTime()).toBeGreaterThan(Date.now());
    const [connected] = await events('vault_connected');
    expect(connected).toEqual({
      host: 'fake.example',
      householdName: 'The fake family',
      approved: true,
      clientId: current.clientId,
      actsAs: 'app',
    });

    // Connecting again is refused while connected: a new key goes through "Replace the key".
    const again = await connect({ connectionString: current.codeWithSecret, version: res.body.version });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('vault.exists');
    // Admins may ask Montra to check again (D4). A check isn't a change to the settings: the version stays.
    const checked = await adminUser.post(url('/family-vault/check'));
    expect(checked.status).toBe(200);
    expect(checked.body.status).toBe('active');
    expect(checked.body.version).toBe(res.body.version);
  });

  it('stops the connection, with the vault’s words, when the app is paused or removed there', async () => {
    fakeApp(current.appId).paused = 'owner';
    const paused = await c.post(url('/family-vault/check'));
    expect(paused.body).toMatchObject({
      status: 'needs_vault',
      stage: 'connected',
      lastError: 'An owner of the vault has paused Montra there.',
      keyProblem: null,
    });
    fakeApp(current.appId).paused = null;
    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({
      status: 'active',
      lastError: null,
    });

    fakeApp(current.appId).revoked = true;
    const removed = await c.post(url('/family-vault/check'));
    expect(removed.body.status).toBe('needs_vault');
    // The vault's own message, written for people.
    expect(removed.body.lastError).toMatch(/removed from the vault/);
    fakeApp(current.appId).revoked = false;
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');
  });

  it('stops the connection when a different vault answers at the pinned address', async () => {
    const before = (await vaultRow()).config.identity;
    await db.query(
      `update app.storage_destination set config = jsonb_set(config, '{identity}', '"another-vault-entirely"')
        where workspace_id = $1 and kind = 'fdv'`,
      [wsId],
    );
    const res = await c.post(url('/family-vault/check'));
    expect(res.body.status).toBe('needs_vault');
    expect(res.body.lastError).toMatch(/different vault answered/);
    await db.query(
      `update app.storage_destination set config = jsonb_set(config, '{identity}', to_jsonb($2::text))
        where workspace_id = $1 and kind = 'fdv'`,
      [wsId, before],
    );
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');
  });

  it('counts a vault it can’t reach as a failed check, and turns failing after five in a row', async () => {
    const real = transport.fetch;
    (transport as { fetch: unknown }).fetch = () => Promise.reject(new Error('socket hang up'));
    try {
      let last: any;
      for (let i = 1; i <= VAULT_FAILING_AFTER; i++) {
        last = (await c.post(url('/family-vault/check'))).body;
        expect(last.status, `check ${i}`).toBe(i < VAULT_FAILING_AFTER ? 'active' : 'failing');
      }
      expect(last.lastError).toMatch(/couldn’t reach the vault/);
    } finally {
      (transport as { fetch: unknown }).fetch = real;
    }
    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({
      status: 'active',
      lastError: null,
    });
  });
});

describe('a key the vault refuses (vault 0.9.0-dev.63)', () => {
  const key = () => fakeApp(current.appId).keys.find((k) => k.client_id === current.clientId)!;

  it('says a key that isn’t valid any more needs a new one', async () => {
    const kept = key().secret_sha256;
    key().secret_sha256 = '0'.repeat(64);
    try {
      const res = await c.post(url('/family-vault/check'));
      expect(res.body).toMatchObject({
        status: 'needs_vault',
        keyProblem: 'invalid',
        lastError: 'The vault key isn’t valid. An owner needs to paste a new key.',
      });
    } finally {
      key().secret_sha256 = kept;
    }
    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({
      status: 'active',
      keyProblem: null,
    });
  });

  it('says an expired key has expired, and a revoked one was revoked', async () => {
    fake.vault.expireAppKey(current.clientId);
    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({
      status: 'needs_vault',
      keyProblem: 'expired',
      lastError: 'The vault key has expired. An owner needs to paste a new key.',
    });
    // Replaced by an owner (below, in full), then that one revoked in the vault.
    const next = await fake.newKey(current.appId);
    const replaced = await c.post(url('/family-vault/key'), {
      version: (await get()).version,
      connectionString: next.codeWithSecret,
    });
    expect(replaced.body).toMatchObject({ status: 'active', keyProblem: null });
    current = next;
    await fake.revokeKey(current.appId, current.keyId);
    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({
      status: 'needs_vault',
      keyProblem: 'revoked',
      lastError: 'The vault key was revoked. An owner needs to paste a new key.',
    });
    // Nothing changes until an owner pastes a new key, so the job looks again daily, not every 15 minutes.
    expect((await state()).next_check_at.getTime()).toBeGreaterThan(Date.now() + 12 * 3600_000);
    current = await fake.newKey(current.appId);
    expect(
      (
        await c.post(url('/family-vault/key'), {
          version: (await get()).version,
          clientId: current.clientId,
          secret: current.secret,
        })
      ).body,
    ).toMatchObject({ status: 'active', keyProblem: null, lastError: null });
  });
});

describe('replacing the key, owner-driven (ADR-0054 §2, §7)', () => {
  it('checks a new key with the vault before switching to it; the old one goes on working until then', async () => {
    const before = await get();
    const next = await fake.newKey(current.appId);
    const body = { version: before.version, connectionString: next.code, secret: next.secret };
    expect((await stale(() => c.post(url('/family-vault/key'), body))).body.code).toBe('reauth.required');
    expect((await adminUser.post(url('/family-vault/key'), body)).status).toBe(403);
    // Neither a string nor a client ID; the key Montra already uses; a wrong secret: refused, nothing changed.
    expect((await c.post(url('/family-vault/key'), { version: before.version })).status).toBe(400);
    const same = await c.post(url('/family-vault/key'), {
      version: before.version,
      clientId: current.clientId,
      secret: current.secret,
    });
    expect(same.body.code).toBe('vault.same_key');
    const noSecret = await c.post(url('/family-vault/key'), {
      version: before.version,
      clientId: next.clientId,
    });
    expect(noSecret.body.code).toBe('vault.secret_needed');
    const wrong = await c.post(url('/family-vault/key'), {
      version: before.version,
      clientId: next.clientId,
      secret: WRONG_SECRET,
    });
    expect(wrong.body).toMatchObject({ code: 'vault.key_invalid' });
    expect((await get()).key.clientId).toBe(current.clientId);
    expect(await sealedSecret()).toMatchObject({ clientId: current.clientId });
    // The current key still works.
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');

    const done = await c.post(url('/family-vault/key'), body);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ stage: 'connected', status: 'active', keyProblem: null });
    expect(done.body.key.clientId).toBe(next.clientId);
    expect(done.body.version).toBe(before.version + 1);
    expect(await sealedSecret()).toEqual({ v: 2, clientId: next.clientId, secret: next.secret });
    expect((await events('vault_key_replaced')).at(-1)).toEqual({
      clientId: next.clientId,
      previousClientId: current.clientId,
    });
    // The old key is the owner's to revoke in the vault; Montra doesn't notice.
    await fake.revokeKey(current.appId, current.keyId);
    current = next;
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');
  });

  it('refuses a key for another app in the vault, or for another vault', async () => {
    const other = await fake.register();
    const res = await c.post(url('/family-vault/key'), {
      version: (await get()).version,
      connectionString: other.codeWithSecret,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('vault.other_app');
    const elsewhere = await c.post(url('/family-vault/key'), {
      version: (await get()).version,
      connectionString: changed(other.codeWithSecret, {
        instance_id: '9f9f9f9f-0000-4000-8000-000000000000',
      }),
    });
    expect(elsewhere.body.code).toBe('vault.identity_changed');
    expect((await get()).key.clientId).toBe(current.clientId);
  });
});

describe('waiting for approval, and whom Montra acts as (ADR-0054 §2 step 4; APP8)', () => {
  it('connects with a string that includes the secret, acting as a person who still has to turn it on', async () => {
    await c.delete(url('/family-vault'));
    const k = await fake.register({ approved: false });
    const res = await connect({ connectionString: k.codeWithSecret });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      stage: 'approval',
      status: 'needs_vault',
      householdName: 'The fake family',
      actsAs: 'person',
      actingAs: 'Alex',
    });
    expect((await events('vault_connected')).at(-1)).toMatchObject({ approved: false, actsAs: 'person' });
    // Sooner than daily, while it waits.
    expect((await state()).next_check_at.getTime() - Date.now()).toBeLessThan(60 * 60_000);

    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({ stage: 'approval' });
    fakeApp(k.appId).approval = 'approved';
    const now = await adminUser.post(url('/family-vault/check'));
    expect(now.body).toMatchObject({ stage: 'connected', status: 'active', actsAs: 'person' });
    current = k;
  });
});

describe('a connection made before API keys (Ed25519, hard cutover)', () => {
  /** Turns the connection back into the shape a connection made with a key pair was saved in, as it is in the database. */
  async function asSigned(stage: 'connected' | 'register') {
    const row = await vaultRow();
    const { FieldCrypto } = await import('../src/crypto/crypto.service.js');
    const { Db } = await import('../src/db/database.js');
    const owner = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0]
      .id as string;
    const sealed = await h.app
      .get(Db)
      .run({ workspaceId: wsId, userId: owner }, (trx) =>
        h.app
          .get(FieldCrypto)
          .encrypt(
            trx,
            wsId,
            'storage_destination.secret',
            JSON.stringify({ v: 1, current: { pkcs8: 'MC4CAQAwBQYDK2VwBCIEIA', keyId: 'k-1' }, next: null }),
          ),
      );
    const config = {
      stage,
      publicKey: 'ed25519:Bm0rbJ7Q8V3d8w7c2b1aXyZ0123456789abcdefghij',
      fingerprint: 'ce2d 6777 0439 61a5 d947 31bb 086a 4fb4',
      newKey: null,
      groups: row.config.groups,
      ...(stage === 'connected'
        ? {
            address: row.config.address,
            appId: row.config.appId,
            keyId: 'k-1',
            identity: row.config.identity,
            householdName: row.config.householdName,
          }
        : {}),
    };
    await db.query(
      `update app.storage_destination set config = $2, secret_enc = $3, status = $4
        where workspace_id = $1 and kind = 'fdv'`,
      [wsId, JSON.stringify(config), sealed, stage === 'connected' ? 'active' : 'needs_vault'],
    );
  }

  it('says it needs a new key, in Settings and when checked, rather than failing silently', async () => {
    await asSigned('connected');
    const dto = await get();
    expect(dto).toMatchObject({ keyProblem: 'signed', key: null, stage: 'connected' });
    const calls = fake.vault.state.calls?.length ?? 0;
    const checked = await c.post(url('/family-vault/check'));
    expect(checked.body).toMatchObject({ status: 'needs_vault', keyProblem: 'signed' });
    expect(checked.body.lastError).toMatch(/before the vault used API keys/);
    // Never sent to the vault: it no longer takes signed requests.
    expect(fake.vault.state.calls?.length ?? 0).toBe(calls);
    // The job says the same and tells owners and admins, once.
    await db.query(
      `update app.storage_destination set status = 'active' where workspace_id = $1 and kind = 'fdv'`,
      [wsId],
    );
    await db.query(`update app.vault_connection_state set next_check_at = now() where workspace_id = $1`, [
      wsId,
    ]);
    await h.app.get(VaultJobs).run({ sendGapMs: 0, settleMs: 0 });
    expect(await vaultRow()).toMatchObject({ status: 'needs_vault' });
    const told = await db.query(
      `select count(*)::int as n from app.notification where workspace_id = $1 and type = 'vault_attention'`,
      [wsId],
    );
    expect(told.rows[0].n).toBe(2);
  });

  it('takes a new key for the same app, and works again', async () => {
    const k = await fake.newKey(current.appId);
    const res = await c.post(url('/family-vault/key'), {
      version: (await get()).version,
      connectionString: k.codeWithSecret,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active', keyProblem: null, key: { clientId: k.clientId } });
    expect((await vaultRow()).config).toMatchObject({ auth: 'key', clientId: k.clientId });
    expect((await vaultRow()).config).not.toHaveProperty('publicKey');
    expect((await events('vault_key_replaced')).at(-1)).toMatchObject({
      clientId: k.clientId,
      fromSigned: true,
    });
    await fake.revokeKey(current.appId, current.keyId);
    current = k;
  });

  it('connects one begun before API keys, never given its code, with a connection string', async () => {
    await asSigned('register');
    const dto = await get();
    expect(dto).toMatchObject({ stage: 'register', keyProblem: 'signed' });
    const k = await fake.newKey(current.appId);
    expect((await connect({ connectionString: k.codeWithSecret })).status).toBe(409);
    const res = await connect({ connectionString: k.codeWithSecret, version: dto.version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ stage: 'connected', keyProblem: null, key: { clientId: k.clientId } });
    expect(res.body.groups).toEqual(dto.groups);
    await fake.revokeKey(current.appId, current.keyId);
    current = k;
  });
});

describe('secrets (ADR-0054 §7; VLT-08)', () => {
  it('never puts the key’s secret in an answer, the security log, the database or an archive', async () => {
    const answers = JSON.stringify([await get(), (await adminUser.get(url('/family-vault'))).body]);
    expect(answers).not.toContain(current.secret);
    expect(answers).not.toMatch(/fdvs_|pkcs8|privateKey|secret/i);
    // Nowhere in the database but sealed: not in any table's text, the idempotency store and the logs included.
    const tables = (
      await db.query(
        `select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name as string);
    for (const t of tables) {
      const { rows } = await db.query(`select count(*)::int as n from app."${t}" x where x::text like $1`, [
        `%${current.secret.slice(5)}%`,
      ]);
      expect(rows[0].n, t).toBe(0);
    }
    // Archives leave out the connection, its secret, its state and its outbox (ADR-0054 §7, catalog test).
    for (const table of ['storage_destination', 'vault_connection_state', 'vault_item']) {
      expect(NOT_EXPORTED[table], table).toBeTruthy();
    }
  });

  it('writes nothing about the key, its secret or a connection string to the process’s output', async () => {
    const next = await fake.newKey(current.appId);
    const all = await output(async () => {
      await c.post(url('/family-vault/check'));
      await connect({ connectionString: 'fdvapp2.bad', secret: next.secret });
      await c.post(url('/family-vault/key'), {
        version: (await get()).version,
        clientId: next.clientId,
        secret: WRONG_SECRET,
      });
      await c.post(url('/family-vault/key'), {
        version: (await get()).version,
        connectionString: next.code,
        secret: next.secret,
      });
    });
    expect((await get()).key.clientId).toBe(next.clientId);
    for (const s of [current.secret, next.secret, WRONG_SECRET]) expect(all).not.toContain(s.slice(5));
    expect(all).not.toMatch(/fdvapp2\.|authorization|basic /i);
    await fake.revokeKey(current.appId, current.keyId);
    current = next;
  });

  it('lets go of the key when a connection closes', () => {
    const conn = new VaultConnection({
      address: 'https://vault.example.com',
      clientId: `fdvc_${'b'.repeat(22)}`,
      secret: `fdvs_${'c'.repeat(43)}`,
      pinned: null,
      transport,
    });
    conn.close();
    expect((conn as any).client).toBeNull();
    return expect(conn.check()).rejects.toThrow(VaultError);
  });
});

describe('disconnecting (ADR-0054 §7, §10)', () => {
  it('needs an owner with a recent sign-in, destroys the key, and a new connection takes a new one', async () => {
    expect((await stale(() => c.delete(url('/family-vault')))).body.code).toBe('reauth.required');
    expect((await adminUser.delete(url('/family-vault'))).status).toBe(403);
    expect(await vaultRow()).toBeDefined();
    const res = await c.delete(url('/family-vault'), { anyway: false });
    expect(res.status).toBe(204);
    expect(await vaultRow()).toBeUndefined();
    expect(await state()).toBeUndefined();
    expect((await events('vault_disconnected')).at(-1)).toMatchObject({ host: 'fake.example' });
    const k = await fake.newKey(current.appId);
    const again = await connect({ connectionString: k.codeWithSecret });
    expect(again.status).toBe(201);
    expect(again.body.key.clientId).toBe(k.clientId);
    await c.delete(url('/family-vault'));
  });
});

async function sealedSecret(): Promise<VaultSecret> {
  // Opened through the API's own FieldCrypto, as the service does: the test never keeps the plaintext anywhere else.
  const { FieldCrypto } = await import('../src/crypto/crypto.service.js');
  const { Db } = await import('../src/db/database.js');
  const crypto = h.app.get(FieldCrypto);
  const database = h.app.get(Db);
  const row = await vaultRow();
  const owner = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0]
    .id as string;
  const plain = await database.run({ workspaceId: wsId, userId: owner }, (trx) =>
    crypto.decrypt(trx, wsId, 'storage_destination.secret', row.secret_enc),
  );
  return VaultSecret.parse(JSON.parse(plain!));
}
