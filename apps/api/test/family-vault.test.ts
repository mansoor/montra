/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NetworkError } from '@fdv/client';
import { NOT_EXPORTED } from '../src/data/catalog.js';
import { VaultError } from '../src/storage/destinations/vault.js';
import { asVaultError, readVaultCode, VaultConnection } from '../src/storage/vault/connection.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { fingerprintOf, makeVaultKey, publicKeyOf, VaultSecret } from '../src/storage/vault/keys.js';
import {
  assertVaultAddress,
  guardedVaultTransport,
  VAULT_TRANSPORT,
  type VaultTransport,
} from '../src/storage/vault/transport.js';
import { VAULT_FAILING_AFTER } from '../src/storage/vault/vault.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Connecting the workspace to the household's Family Document Vault (ADR-0054 §2, §7, §8, PR 2), against the vault's
// own fake from `@fdv/client/testing`, in this process. No real vault is ever reached.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault@example.com';
const ADMIN = 'admin-vault@example.com';
const PARTNER = 'partner-vault@example.com';

let h: Harness;
let c: Client;
let adminUser: Client;
let partner: Client;
let db: pg.Client;
let transport: VaultTransport & { fake: FakeVaultHandle };
let fake: FakeVaultHandle;
let wsId: string;
let url: (p: string) => string;

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

/** A code as the vault writes one, with its address changed: what a person might paste from elsewhere. */
function withAddress(code: string, address: string, more: Record<string, unknown> = {}): string {
  const json = JSON.parse(Buffer.from(code.slice('fdvapp1.'.length), 'base64url').toString('utf8'));
  return `fdvapp1.${Buffer.from(JSON.stringify({ ...json, url: address, ...more })).toString('base64url')}`;
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

/** Starts a connection and registers its key in the fake; the code the vault's owner would paste back. */
async function startAndRegister(opts: { approved?: boolean } = {}) {
  const started = await c.post(url('/family-vault'));
  expect(started.status).toBe(201);
  const { code, appId } = await fake.register(started.body.publicKey, opts);
  return { started: started.body, code, appId };
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
  await db.end();
  await h.close();
});

describe('the key (ADR-0054 §2, §7)', () => {
  it('makes a fresh Ed25519 pair each time, with the fingerprint the vault shows', async () => {
    const a = makeVaultKey();
    const b = makeVaultKey();
    expect(a.publicKey).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.pkcs8).not.toBe(b.pkcs8);
    expect(publicKeyOf(a.pkcs8)).toBe(a.publicKey);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
    expect(fingerprintOf(Buffer.from(a.publicKey.slice(8), 'base64url'))).toBe(a.fingerprint);
  });
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

  it('stops the connection for a problem with the connection itself, showing the vault’s own words', () => {
    for (const code of [
      'app_key_unknown',
      'app_revoked',
      'app_paused',
      'app_not_approved',
      'signature_stale',
    ]) {
      const e = asVaultError(answer(401, code, 'Words for people.'));
      expect(e.code, code).toBe('connection');
      expect(e.stopsConnection).toBe(true);
      expect(e.shown).toBe('Words for people.');
    }
  });

  it('holds for the daily caps, waits when asked, retries server failures, and refuses the rest', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const cap = asVaultError(answer(429, 'app_day_full', 'x', 3600), undefined, now);
    expect(cap.code).toBe('send_cap');
    expect(cap.countsAsFailure).toBe(false);
    expect(cap.opts.heldUntil?.toISOString()).toBe('2026-11-17T13:00:00.000Z');
    expect(asVaultError(answer(429, 'app_read_day_full', 'x', 60), undefined, now).code).toBe('read_cap');
    const wait = asVaultError(answer(429, 'rate_limited', 'x', 30), undefined, now);
    expect(wait.code).toBe('retry_later');
    expect(wait.opts.retryAfter?.toISOString()).toBe('2026-11-17T12:00:30.000Z');
    expect(asVaultError(answer(500, 'internal')).code).toBe('failed');
    expect(asVaultError(answer(400, 'validation_failed')).code).toBe('refused');
    expect(asVaultError(new NetworkError('timeout')).code).toBe('unreachable');
    // The detail is codes only: never the vault's body, never a header.
    expect(asVaultError(answer(400, 'validation_failed', 'secret words')).opts.detail).toBe(
      '400 validation_failed',
    );
  });

  it('reads a code strictly through the package, and refuses anything else', () => {
    expect(() => readVaultCode('hello')).toThrow(VaultError);
    expect(() => readVaultCode('fdvapp1.!!!')).toThrow(VaultError);
    try {
      readVaultCode('fdvapp1.e30');
    } catch (e) {
      expect((e as VaultError).code).toBe('invalid_code');
    }
  });
});

describe('connecting (ADR-0054 §2; VLT-01, VLT-08)', () => {
  it('lets only owners and admins see the connection, and only an owner connect', async () => {
    expect(await get()).toBeNull();
    expect((await adminUser.get(url('/family-vault'))).body).toEqual({ connection: null });
    expect((await partner.get(url('/family-vault'))).status).toBe(403);
    const byAdmin = await adminUser.post(url('/family-vault'));
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.code).toBe('vault.owner_only');
    expect((await partner.post(url('/family-vault'))).status).toBe(403);
    expect(await vaultRow()).toBeUndefined();
  });

  it('asks for a recent sign-in before making a key', async () => {
    const res = await stale(() => c.post(url('/family-vault')));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth.required');
    expect(await vaultRow()).toBeUndefined();
  });

  it('makes a key for the workspace, seals the private half, and shows only the public half', async () => {
    const res = await c.post(url('/family-vault'));
    expect(res.status).toBe(201);
    const dto = res.body;
    expect(dto).toMatchObject({
      stage: 'register',
      status: 'needs_vault',
      address: null,
      householdName: null,
      newKey: null,
      keyRotation: 'none',
      items: { queued: 0, pending: 0, received: 0, filed: 0, notKept: 0, failed: 0, outOfReach: 0 },
    });
    expect(dto.publicKey).toMatch(/^ed25519:/);
    expect(dto.groups).toEqual([
      { group: 'receipts', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'statements', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'bills', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'payslips', mode: 'not_sent', vaultKind: null },
      { group: 'tax_documents', mode: 'not_sent', vaultKind: null },
      { group: 'other', mode: 'not_sent', vaultKind: null },
    ]);
    const row = await vaultRow();
    // Nothing is sent yet (PR 3): the trigger queues nothing while "send files" is off.
    expect(row).toMatchObject({ kind: 'fdv', mirror_files: false, status: 'needs_vault', secret_hint: null });
    expect(row.file_kinds).toEqual(['statement', 'receipt', 'invoice']);
    expect(row.config).not.toHaveProperty('pkcs8');
    expect(JSON.stringify(row.config)).not.toMatch(/private|pkcs8/i);
    // Sealed: the ciphertext carries neither the key nor anything readable.
    expect(row.secret_enc.toString('latin1')).not.toMatch(/pkcs8|BEGIN|"v":1/);
    // Nothing for the vault's job to look at until there is a code.
    expect((await state()).next_check_at.valueOf()).toBe(Infinity);
    // Asking again before a code gives back the same key: a reload doesn't strand the one in the vault.
    const again = await c.post(url('/family-vault'));
    expect(again.status).toBe(201);
    expect(again.body.publicKey).toBe(dto.publicKey);
    expect(again.body.id).toBe(dto.id);
    await c.delete(url('/family-vault'));
  });

  it('refuses a code that isn’t one, or that names another key, and keeps waiting', async () => {
    const { started } = await startAndRegister();
    const garbage = await c.post(url('/family-vault/code'), { code: 'not a code', version: started.version });
    expect(garbage.status).toBe(422);
    expect(garbage.body.code).toBe('vault.invalid_code');
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
    const { code: otherCode } = await fake.register(`ed25519:${other}`);
    const wrong = await c.post(url('/family-vault/code'), { code: otherCode, version: started.version });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('vault.other_key');
    expect(wrong.body.detail ?? wrong.body.message).toMatch(/different key/);
    const old = await c.post(url('/family-vault/code'), { code: otherCode, version: started.version + 5 });
    expect(old.status).toBe(409);
    expect((await get()).stage).toBe('register');
    await c.delete(url('/family-vault'));
  });

  it('refuses http, loopback and private addresses in a code, the vault’s own development address too', async () => {
    const { started, code } = await startAndRegister();
    for (const address of [
      'http://localhost:8091',
      'http://127.0.0.1:8091',
      'https://localhost',
      'https://10.0.0.5',
      'https://192.168.1.10',
      'https://[::1]',
    ]) {
      const res = await c.post(url('/family-vault/code'), {
        code: withAddress(code, address),
        version: started.version,
      });
      expect(res.status, address).toBe(422);
      // Plain http elsewhere isn't even a code to the package; the rest pass it and Montra's guard refuses them.
      expect(['vault.not_allowed_host', 'vault.invalid_code'], address).toContain(res.body.code);
      if (address.startsWith('http://localhost')) expect(res.body.code).toBe('vault.not_allowed_host');
    }
    expect((await get()).stage).toBe('register');
    await c.delete(url('/family-vault'));
  });

  it('refuses a code whose vault isn’t the one at its address', async () => {
    const { started, code } = await startAndRegister();
    const res = await c.post(url('/family-vault/code'), {
      code: withAddress(code, 'https://fake.example', {
        instance_id: '9f9f9f9f-0000-4000-8000-000000000000',
      }),
      version: started.version,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('vault.identity_changed');
    expect((await get()).stage).toBe('register');
    await c.delete(url('/family-vault'));
  });

  it('connects with a good code: a request signed through the package is accepted by the package’s fake (§15)', async () => {
    const { started, code } = await startAndRegister();
    const stalePaste = await stale(() =>
      c.post(url('/family-vault/code'), { code, version: started.version }),
    );
    expect(stalePaste.body.code).toBe('reauth.required');
    const byAdmin = await adminUser.post(url('/family-vault/code'), { code, version: started.version });
    expect(byAdmin.status).toBe(403);

    const res = await c.post(url('/family-vault/code'), { code, version: started.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stage: 'connected',
      status: 'active',
      address: 'https://fake.example',
      householdName: 'The fake family',
      actingAs: 'Fake Owner',
      publicKey: started.publicKey,
      fingerprint: started.fingerprint,
      vaultKinds: [{ key: 'utility_bill', name: 'Utility / bill' }],
      canDelete: false,
      lastError: null,
    });
    expect(res.body.lastSuccessAt).not.toBeNull();
    expect(Math.abs(res.body.clockOffsetMs)).toBeLessThan(60_000);
    const row = await vaultRow();
    // The pinned identity is the vault's own installation id, as it reported it.
    expect(row.config.identity).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.mirror_files).toBe(false);
    const s = await state();
    expect(s.checked_at).not.toBeNull();
    expect(s.next_check_at.getTime()).toBeGreaterThan(Date.now());
    const [connected] = await events('vault_connected');
    expect(connected).toMatchObject({
      host: 'fake.example',
      householdName: 'The fake family',
      approved: true,
    });

    // Pasting again, or starting again, is refused while connected.
    expect((await c.post(url('/family-vault/code'), { code, version: res.body.version })).body.code).toBe(
      'vault.already_connected',
    );
    expect((await c.post(url('/family-vault'))).body.code).toBe('vault.exists');
    // Admins may ask Montra to check again (D4).
    const checked = await adminUser.post(url('/family-vault/check'));
    expect(checked.status).toBe(200);
    expect(checked.body.status).toBe('active');
  });

  it('stops the connection, with the vault’s words, when the app is paused or removed there', async () => {
    const appId = (await vaultRow()).config.appId as string;
    fakeApp(appId).paused = 'owner';
    const paused = await c.post(url('/family-vault/check'));
    expect(paused.body).toMatchObject({
      status: 'needs_vault',
      stage: 'connected',
      lastError: 'An owner of the vault has paused Montra there.',
    });
    fakeApp(appId).paused = null;
    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({
      status: 'active',
      lastError: null,
    });

    fakeApp(appId).revoked = true;
    const removed = await c.post(url('/family-vault/check'));
    expect(removed.body.status).toBe('needs_vault');
    // The vault's own message, written for people.
    expect(removed.body.lastError).toMatch(/removed from the vault/);
    fakeApp(appId).revoked = false;
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

describe('waiting for approval (ADR-0054 §2 step 4)', () => {
  it('saves the connection as waiting, then connects once someone in the vault turns it on', async () => {
    await c.delete(url('/family-vault'));
    const { started, code, appId } = await startAndRegister({ approved: false });
    const res = await c.post(url('/family-vault/code'), { code, version: started.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stage: 'approval',
      status: 'needs_vault',
      householdName: 'The fake family',
    });
    expect(res.body.actingAs).toBe('Alex');
    expect((await events('vault_connected')).at(-1)).toMatchObject({ approved: false });
    // Sooner than daily, while it waits.
    expect((await state()).next_check_at.getTime() - Date.now()).toBeLessThan(60 * 60_000);

    expect((await c.post(url('/family-vault/check'))).body).toMatchObject({ stage: 'approval' });
    fakeApp(appId).approval = 'approved';
    const now = await adminUser.post(url('/family-vault/check'));
    expect(now.body).toMatchObject({ stage: 'connected', status: 'active' });
  });
});

describe('replacing the key (ADR-0054 §2, §7)', () => {
  it('makes a new key beside the current one, which goes on signing until the vault’s code for the new one', async () => {
    const before = await get();
    const appId = (await vaultRow()).config.appId as string;
    expect((await stale(() => c.post(url('/family-vault/key'), { version: before.version }))).body.code).toBe(
      'reauth.required',
    );
    expect((await adminUser.post(url('/family-vault/key'), { version: before.version })).status).toBe(403);

    const made = await c.post(url('/family-vault/key'), { version: before.version });
    expect(made.status).toBe(200);
    expect(made.body.keyRotation).toBe('made');
    expect(made.body.publicKey).toBe(before.publicKey);
    expect(made.body.newKey.publicKey).toMatch(/^ed25519:/);
    expect(made.body.newKey.publicKey).not.toBe(before.publicKey);
    // The current key still signs.
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');

    // Someone in the vault adds the new key to Montra's app (this fake has no route for that yet, so its state stands
    // in for the vault's Settings), and the vault's Settings then shows the code for it.
    const raw = Buffer.from(made.body.newKey.publicKey.slice('ed25519:'.length), 'base64url');
    fakeApp(appId).keys.push({
      id: randomUUID(),
      raw: new Uint8Array(raw),
      added_by: 'owner',
      created_at: new Date().toISOString(),
      retired: false,
    });
    const newCode = await fake.codeFor(appId);
    // The old code names the old key: refused while the new one is waited on.
    const oldCode = withAddress(newCode, 'https://fake.example', {
      key_id: (await vaultRow()).config.keyId,
      fingerprint: before.fingerprint,
    });
    const version = (await get()).version;
    expect((await c.post(url('/family-vault/code'), { code: oldCode, version })).body.code).toBe(
      'vault.other_key',
    );

    const done = await c.post(url('/family-vault/code'), { code: newCode, version });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      stage: 'connected',
      status: 'active',
      keyRotation: 'none',
      newKey: null,
      publicKey: made.body.newKey.publicKey,
      fingerprint: made.body.newKey.fingerprint,
    });
    expect(await events('vault_key_replaced')).toEqual([{ fingerprint: made.body.newKey.fingerprint }]);
    // Only the new key is sealed now, and it is the one the vault knows.
    const secret = await sealedSecret();
    expect(secret.next).toBeNull();
    expect(publicKeyOf(secret.current.pkcs8)).toBe(made.body.newKey.publicKey);
    // The old key can go in the vault without Montra noticing.
    fakeApp(appId).keys[0]!.retired = true;
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');
  });

  it('cancels a new key that wasn’t confirmed, and goes on with the current one', async () => {
    const before = await get();
    const made = await c.post(url('/family-vault/key'), { version: before.version });
    expect(made.body.newKey).not.toBeNull();
    const cancelled = await c.post(url('/family-vault/key'), { version: made.body.version, cancel: true });
    expect(cancelled.body).toMatchObject({ newKey: null, keyRotation: 'none', publicKey: before.publicKey });
    expect((await sealedSecret()).next).toBeNull();
    expect((await c.post(url('/family-vault/check'))).body.status).toBe('active');
  });
});

describe('secrets (ADR-0054 §7; VLT-08)', () => {
  it('never puts the private key in an answer, the security log or an archive', async () => {
    const secret = await sealedSecret();
    const dto = await get();
    const answers = JSON.stringify([dto, (await adminUser.get(url('/family-vault'))).body]);
    expect(answers).not.toContain(secret.current.pkcs8);
    expect(answers).not.toMatch(/pkcs8|privateKey|secret/i);
    const log = await db.query(`select detail::text from app.security_event where workspace_id = $1`, [wsId]);
    for (const r of log.rows) {
      expect(r.detail).not.toContain(secret.current.pkcs8);
      expect(r.detail).not.toMatch(/pkcs8/);
    }
    // Archives leave out the connection, its secret, its state and its outbox (ADR-0054 §7, catalog test).
    for (const table of ['storage_destination', 'vault_connection_state', 'vault_item']) {
      expect(NOT_EXPORTED[table], table).toBeTruthy();
    }
  });

  it('writes nothing about the key, the signature or the code to the process’s output', async () => {
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
      await c.post(url('/family-vault/check'));
      await c.post(url('/family-vault/code'), { code: 'fdvapp1.bad', version: 1 });
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const secret = await sealedSecret();
    const all = written.join('');
    expect(all).not.toContain(secret.current.pkcs8);
    expect(all).not.toMatch(/signature-input|fdvapp1\./i);
  });

  it('zeroes the key it was given when a connection closes', () => {
    const key = makeVaultKey();
    const bytes = Buffer.from(key.pkcs8, 'base64');
    const conn = new VaultConnection({
      address: 'https://vault.example.com',
      appId: '00000000-0000-4000-8000-000000000001',
      keyId: '00000000-0000-4000-8000-000000000002',
      privateKey: bytes,
      pinned: null,
      transport,
    });
    conn.close();
    expect(bytes.every((b) => b === 0)).toBe(true);
  });
});

describe('disconnecting (ADR-0054 §7, §10)', () => {
  it('needs an owner with a recent sign-in, destroys the key, and a new connection makes a new one', async () => {
    const before = await get();
    expect((await stale(() => c.delete(url('/family-vault')))).body.code).toBe('reauth.required');
    expect((await adminUser.delete(url('/family-vault'))).status).toBe(403);
    expect(await vaultRow()).toBeDefined();
    const res = await c.delete(url('/family-vault'), { anyway: false });
    expect(res.status).toBe(204);
    expect(await vaultRow()).toBeUndefined();
    expect(await state()).toBeUndefined();
    expect((await events('vault_disconnected')).at(-1)).toMatchObject({ host: 'fake.example' });
    const again = await c.post(url('/family-vault'));
    expect(again.body.publicKey).not.toBe(before.publicKey);
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
