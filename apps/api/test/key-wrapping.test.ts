/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LocalKms, type KmsPort } from '../src/crypto/crypto.service.js';
import { createKms, MovingKms } from '../src/crypto/kms.js';
import { rewrapKeys } from '../src/crypto/rewrap.js';
import { VaultKms } from '../src/crypto/vault-kms.js';
import { resolveSecretFiles, secretFromEnv, type SecretFileSystem } from '../src/secret-files.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Harness } from './harness.js';

// ADR-0050 §2–3: secrets from files, key wrapping without a cloud (a local key file, or Vault Transit), and moving the
// wrapped keys from one mode to another while the service runs.

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

/** Files in memory, with the permission bits each one has. */
function files(entries: Record<string, { value: string; mode?: number }>): SecretFileSystem {
  return {
    read: (path) => {
      const f = entries[path];
      if (!f) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return f.value;
    },
    mode: (path) => entries[path]?.mode ?? 0o600,
  };
}

const prod = {
  NODE_ENV: 'production',
  AUTH_MODE: 'kratos',
  KRATOS_PUBLIC_URL: 'http://kratos:4433',
  ADMIN_DATABASE_URL: 'postgres://a',
  SUPPORT_DATABASE_URL: 'postgres://b',
};

describe('secrets from files (ADR-0050 §2)', () => {
  it('reads NAME_FILE into NAME, dropping one trailing line break', () => {
    const fs = files({ '/run/secrets/db': { value: 'postgres://x\n' }, '/s/k': { value: 'sk\r\n' } });
    const { env, fromFiles } = resolveSecretFiles(
      { DATABASE_URL_FILE: '/run/secrets/db', STRIPE_SECRET_KEY_FILE: '/s/k', OTHER_FILE: '/nope' },
      ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      fs,
    );
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.STRIPE_SECRET_KEY).toBe('sk');
    expect(fromFiles.get('DATABASE_URL')).toBe('/run/secrets/db');
    // Only settings it knows: an unrelated *_FILE is left alone.
    expect(env.OTHER).toBeUndefined();
  });

  it('refuses both at once, names a file it can’t read, and treats empty as not set', () => {
    const fs = files({ '/s/a': { value: 'a' } });
    expect(() => resolveSecretFiles({ A: 'x', A_FILE: '/s/a' }, ['A'], fs)).toThrow(/A or A_FILE, not both/);
    expect(() => resolveSecretFiles({ A_FILE: '/s/missing' }, ['A'], fs)).toThrow(
      /A_FILE: can't read \/s\/missing \(ENOENT\)/,
    );
    expect(resolveSecretFiles({ A: '', A_FILE: '/s/a' }, ['A'], fs).env.A).toBe('a');
    expect(secretFromEnv('A', { A_FILE: '' }, fs)).toBeUndefined();
  });

  it('gives every setting of the API a _FILE form', () => {
    const fs = files({
      '/s/stripe': { value: 'sk_test_1' },
      '/s/hook': { value: 'whsec_1' },
      '/s/db': { value: 'postgres://montra_app@db/montra' },
    });
    const config = loadConfig(
      {
        BILLING_MODE: 'stripe',
        STRIPE_SECRET_KEY_FILE: '/s/stripe',
        STRIPE_WEBHOOK_SECRET_FILE: '/s/hook',
        DATABASE_URL_FILE: '/s/db',
      },
      { files: fs },
    );
    expect(config.STRIPE_SECRET_KEY).toBe('sk_test_1');
    expect(config.DATABASE_URL).toBe('postgres://montra_app@db/montra');
  });

  it('reads a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'montra-secrets-'));
    const path = join(dir, 'master.key');
    writeFileSync(path, `${KEY_A}\n`);
    chmodSync(path, 0o600);
    expect(loadConfig({ ...prod, MASTER_KEY_FILE: path }).MASTER_KEY).toBe(KEY_A);
  });
});

describe('a master key in a file (ADR-0050 §3)', () => {
  it('is how production runs KMS_MODE=local, and an environment variable is refused', () => {
    const fs = files({ '/k': { value: KEY_A, mode: 0o400 } });
    expect(loadConfig({ ...prod, MASTER_KEY_FILE: '/k' }, { files: fs }).KMS_MODE).toBe('local');
    expect(() => loadConfig({ ...prod, MASTER_KEY: KEY_A }, { files: fs })).toThrow(
      /give MASTER_KEY as MASTER_KEY_FILE/,
    );
    expect(() => loadConfig(prod, { files: fs })).toThrow(/MASTER_KEY_FILE \(or KMS_MODE=aws or vault\)/);
    // Outside production a plain variable is still fine.
    expect(loadConfig({ MASTER_KEY: KEY_A }).MASTER_KEY).toBe(KEY_A);
  });

  it('refuses a key file anyone else can read or change', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620, 0o666]) {
      const fs = files({ '/k': { value: KEY_A, mode } });
      expect(() => loadConfig({ MASTER_KEY_FILE: '/k' }, { files: fs })).toThrow(
        /can be read or changed by others/,
      );
    }
    for (const mode of [0o400, 0o600]) {
      const fs = files({ '/k': { value: KEY_A, mode } });
      expect(loadConfig({ MASTER_KEY_FILE: '/k' }, { files: fs }).MASTER_KEY).toBe(KEY_A);
    }
  });

  it('checks the key itself when the adapter is made', () => {
    expect(() => new LocalKms(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('Vault Transit (KMS_MODE=vault)', () => {
  let server: Server;
  let addr: string;
  const calls: { url: string; token: string; namespace?: string }[] = [];
  /** Stands in for Transit: "encrypts" by tagging the plaintext, which is enough to check the protocol. */
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const token = String(req.headers['x-vault-token'] ?? '');
        const namespace = req.headers['x-vault-namespace'] as string | undefined;
        calls.push({ url: req.url ?? '', token, ...(namespace ? { namespace } : {}) });
        res.setHeader('content-type', 'application/json');
        if (!token.startsWith('good')) {
          res.statusCode = 403;
          return res.end(JSON.stringify({ errors: ['permission denied'] }));
        }
        const json = JSON.parse(body);
        if (req.url === '/v1/transit-x/encrypt/montra-key') {
          return res.end(JSON.stringify({ data: { ciphertext: `vault:v1:${json.plaintext}` } }));
        }
        if (req.url === '/v1/transit-x/decrypt/montra-key') {
          return res.end(JSON.stringify({ data: { plaintext: json.ciphertext.replace('vault:v1:', '') } }));
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    addr = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const vaultEnv = () => ({
    KMS_MODE: 'vault',
    VAULT_ADDR: `${addr}/`,
    VAULT_TOKEN: 'good-token',
    VAULT_NAMESPACE: 'family',
    VAULT_TRANSIT_MOUNT: '/transit-x/',
    VAULT_TRANSIT_KEY: 'montra-key',
  });

  it('needs an address and a token', () => {
    expect(() => loadConfig({ KMS_MODE: 'vault' })).toThrow(/VAULT_ADDR and VAULT_TOKEN/);
    expect(
      () => loadConfig({ ...prod, KMS_MODE: 'vault', VAULT_ADDR: addr, VAULT_TOKEN: 't' }).KMS_MODE,
    ).not.toThrow();
  });

  it('wraps and unwraps through Transit with the token and namespace', async () => {
    const kms = createKms(loadConfig(vaultEnv()));
    expect(kms).toBeInstanceOf(VaultKms);
    const key = randomBytes(32);
    const wrapped = await kms.wrap(key);
    expect(wrapped.toString()).toMatch(/^vault:v1:/);
    expect((await kms.unwrap(wrapped)).equals(key)).toBe(true);
    expect(calls.slice(-2)).toEqual([
      { url: '/v1/transit-x/encrypt/montra-key', token: 'good-token', namespace: 'family' },
      { url: '/v1/transit-x/decrypt/montra-key', token: 'good-token', namespace: 'family' },
    ]);
  });

  it('doesn’t send another adapter’s ciphertext to Vault, and reports Vault’s refusal', async () => {
    const before = calls.length;
    const kms = new VaultKms(loadConfig(vaultEnv()));
    await expect(kms.unwrap(await new LocalKms(KEY_A).wrap(randomBytes(32)))).rejects.toThrow(/Not a Vault/);
    expect(calls.length).toBe(before);
    const denied = new VaultKms(loadConfig({ ...vaultEnv(), VAULT_TOKEN: 'revoked' }));
    await expect(denied.wrap(randomBytes(32))).rejects.toThrow(/Vault encrypt failed: 403/);
  });

  it('reads VAULT_TOKEN_FILE again on each call, for a token a Vault Agent renews', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'montra-vault-'));
    const path = join(dir, 'token');
    writeFileSync(path, 'good-1\n');
    const { VAULT_TOKEN: _, ...env } = vaultEnv();
    const kms = createKms(loadConfig({ ...env, VAULT_TOKEN_FILE: path }));
    await kms.wrap(randomBytes(32));
    writeFileSync(path, 'good-2\n');
    await kms.wrap(randomBytes(32));
    expect(calls.slice(-2).map((c) => c.token)).toEqual(['good-1', 'good-2']);
    expect(() => loadConfig({ ...vaultEnv(), VAULT_TOKEN_FILE: path })).toThrow(/not both/);
  });
});

describe('moving between modes', () => {
  it('needs what the previous mode needs, and a reason to move', () => {
    expect(() => loadConfig({ KMS_PREVIOUS_MODE: 'local', MASTER_KEY: KEY_A })).toThrow(
      /PREVIOUS_MASTER_KEY_FILE/,
    );
    expect(() =>
      loadConfig({ KMS_PREVIOUS_MODE: 'local', MASTER_KEY: KEY_A, PREVIOUS_MASTER_KEY: KEY_A }),
    ).toThrow(/same key/);
    expect(() =>
      loadConfig({ KMS_MODE: 'vault', KMS_PREVIOUS_MODE: 'aws', VAULT_ADDR: 'http://v', VAULT_TOKEN: 't' }),
    ).toThrow(/AWS_KMS_KEY_ID/);
    expect(() => loadConfig({ KMS_MODE: 'aws', KMS_PREVIOUS_MODE: 'aws', AWS_KMS_KEY_ID: 'k' })).toThrow(
      /same as KMS_MODE/,
    );
    // Away from local, the key file can stay where it is.
    const fs = files({ '/k': { value: KEY_A } });
    const away = loadConfig(
      { ...prod, KMS_MODE: 'aws', AWS_KMS_KEY_ID: 'k', KMS_PREVIOUS_MODE: 'local', MASTER_KEY_FILE: '/k' },
      { files: fs },
    );
    expect(createKms(away)).toBeInstanceOf(MovingKms);
  });

  it('wraps new keys with the current mode and unwraps with either', async () => {
    const kms = createKms(
      loadConfig({ MASTER_KEY: KEY_B, KMS_PREVIOUS_MODE: 'local', PREVIOUS_MASTER_KEY: KEY_A }),
    );
    const oldKms = new LocalKms(KEY_A);
    const newKms = new LocalKms(KEY_B);
    const key = randomBytes(32);
    expect((await kms.unwrap(await oldKms.wrap(key))).equals(key)).toBe(true);
    const fresh = await kms.wrap(key);
    expect((await newKms.unwrap(fresh)).equals(key)).toBe(true);
    await expect(oldKms.unwrap(fresh)).rejects.toThrow();
    // Neither: the current adapter's error is the one reported.
    await expect(kms.unwrap(await new LocalKms(undefined).wrap(key))).rejects.toThrow();
  });
});

describe('crypto:rewrap', () => {
  const EMAIL = 'rewrap@example.com';
  let h: Harness;
  let admin: pg.Pool;
  let wsId: string;
  let txnId: string;
  const dev = new LocalKms(undefined);
  const next = new LocalKms(KEY_B);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    h = await startHarness();
    const c = h.as(EMAIL);
    const ws = await c.post('/v1/workspaces', { name: 'Rewrap', baseCurrency: 'USD' });
    wsId = ws.body.id;
    const url = (p: string) => `/v1/workspaces/${wsId}${p}`;
    const account = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
    const cats = (await c.get(url('/categories'))).body.data;
    const t = await c.post(url('/transactions'), {
      date: '2026-11-01',
      accountId: account,
      amount: { amount: '-1250', currency: 'USD' },
      categoryId: cats.find((x: any) => x.kind === 'expense')?.id ?? cats[0].id,
      memo: 'Kept across the move',
    });
    expect(t.status).toBe(201);
    txnId = t.body.id;
    await h.close();
    // A backup schedule's key and a queued backup's key, wrapped the same way as the workspace's.
    const user = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
    await admin.query(
      `insert into app.backup_schedule (workspace_id, user_id, cadence, next_run_on, wrapped_key)
       values ($1, $2, 'weekly', current_date, $3)`,
      [wsId, user, await dev.wrap(randomBytes(32))],
    );
    await admin.query(
      `insert into app.job (workspace_id, queue, type, payload, status)
       values ($1, 'report', 'rewrap.test', $2, 'succeeded')`,
      [wsId, { wrappedKey: (await dev.wrap(randomBytes(32))).toString('base64'), kdf: {} }],
    );
  });
  afterAll(async () => {
    // Put every key back under the development key, for the test files that run after this one.
    await rewrapKeys(admin, dev, next);
    await admin.end();
  });

  const total = (
    counts: { done: number; rewrapped: number; failed: number }[],
    k: 'done' | 'rewrapped' | 'failed',
  ) => counts.reduce((n, c) => n + c[k], 0);

  it('counts on a dry run and writes nothing', async () => {
    const before = (
      await admin.query(`select wrapped_key from app.workspace_key where workspace_id = $1`, [wsId])
    ).rows;
    const counts = await rewrapKeys(admin, next, dev, { dryRun: true });
    expect(counts.map((c) => c.name)).toEqual([
      'workspace keys',
      'backup schedules',
      'restores',
      'backup jobs',
    ]);
    expect(total(counts, 'rewrapped')).toBeGreaterThanOrEqual(3);
    expect(total(counts, 'failed')).toBe(0);
    const after = (
      await admin.query(`select wrapped_key from app.workspace_key where workspace_id = $1`, [wsId])
    ).rows;
    expect(after).toEqual(before);
  });

  it('resumes after stopping part way, and skips what already moved', async () => {
    // A current adapter that stops working after two keys, as if the process were killed.
    let wraps = 0;
    const flaky: KmsPort = {
      wrap: async (k) => {
        if (++wraps > 2) throw new Error('stopped');
        return next.wrap(k);
      },
      unwrap: (w) => next.unwrap(w),
    };
    await expect(rewrapKeys(admin, flaky, dev, { batchSize: 2 })).rejects.toThrow('stopped');
    const lines: string[] = [];
    const counts = await rewrapKeys(admin, next, dev, { batchSize: 2, log: (l) => lines.push(l) });
    expect(total(counts, 'done')).toBe(2);
    expect(total(counts, 'failed')).toBe(0);
    expect(lines.some((l) => /^workspace keys: \d+ checked/.test(l))).toBe(true);
    const again = await rewrapKeys(admin, next, dev);
    expect(total(again, 'rewrapped')).toBe(0);
    expect(total(again, 'done')).toBe(total(counts, 'done') + total(counts, 'rewrapped'));
  });

  it('leaves the data readable with the new key alone', async () => {
    const { rows } = await admin.query(
      `select s.wrapped_key, j.payload->>'wrappedKey' as job_key
         from app.backup_schedule s, app.job j where s.workspace_id = $1 and j.workspace_id = $1 and j.type = 'rewrap.test'`,
      [wsId],
    );
    await expect(next.unwrap(rows[0].wrapped_key)).resolves.toHaveLength(32);
    await expect(next.unwrap(Buffer.from(rows[0].job_key, 'base64'))).resolves.toHaveLength(32);
    const moved = await startHarness({ MASTER_KEY: KEY_B });
    try {
      const t = await moved.as(EMAIL).get(`/v1/workspaces/${wsId}/transactions/${txnId}`);
      expect(t.status).toBe(200);
      expect(t.body.memo).toBe('Kept across the move');
    } finally {
      await moved.close();
    }
  });

  it('reports a key neither adapter can unwrap, and carries on', async () => {
    const stranger = new LocalKms(KEY_A);
    const { rows } = await admin.query(
      `insert into app.job (workspace_id, queue, type, payload, status)
       values ($1, 'report', 'rewrap.stranger', $2, 'failed') returning id`,
      [wsId, { wrappedKey: (await stranger.wrap(randomBytes(32))).toString('base64') }],
    );
    const lines: string[] = [];
    const counts = await rewrapKeys(admin, next, dev, { log: (l) => lines.push(l) });
    expect(counts.find((c) => c.name === 'backup jobs')!.failed).toBe(1);
    expect(lines.join('\n')).toContain(`app.job (${rows[0].id}): neither adapter unwraps it`);
    await admin.query(`delete from app.job where id = $1`, [rows[0].id]);
  });
});
