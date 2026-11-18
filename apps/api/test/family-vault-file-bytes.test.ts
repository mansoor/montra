/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { ApiRequestError } from '@fdv/client';
import { BackupService } from '../src/data/backup.service.js';
import { Worker } from '../src/jobs/queue.js';
import { VaultError } from '../src/storage/destinations/vault.js';
import { FileBytes, heldKey, NOT_AVAILABLE_WORDS } from '../src/storage/file-bytes.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { StorageMirrorJobs } from '../src/storage/storage-mirror.jobs.js';
import { VaultConnection } from '../src/storage/vault/connection.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { ADMIN_URL } from './env.js';
import { fakeS3, type FakeServer } from './fakes/storage-servers.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Reading a file's bytes, whoever holds them (ADR-0054 §5, PR 5a): `FileBytes` tries Montra's copy, the owner's own
// storage, then the vault, and every reader of a file's bytes goes through it. A file held only in the vault is made
// here as PR 5b's removal will make one: sent to the vault's own fake (`@fdv/client/testing`, in this process; no real
// vault is ever reached), filed there by a person, then Montra's object removed and the file marked `vault`. The files
// are binary, every byte value from 0 to 255: client 0.9.0-dev.62's fake keeps what it is sent byte for byte.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-bytes@example.com';
const PARTNER = 'partner-vault-bytes@example.com';
const STRANGER = 'stranger-vault-bytes@example.com';
const KINDS = ['bank_statement', 'utility_bill', 'pay_statement'];
const SCOPES = [
  'documents.send',
  'documents.read',
  'documents.download',
  'documents.links',
  'documents.delete',
];
const S3_KEY = 'AKIAVAULTBYTES01';
/** Every byte value, so a file that is changed anywhere on its way doesn't hash the same. */
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

let h: Harness;
let c: Client;
let partner: Client;
let stranger: Client;
let db: pg.Client;
let transport: VaultTransport & { fake: FakeVaultHandle };
let fake: FakeVaultHandle;
let jobs: VaultJobs;
let files: FileBytes;
let storage: StoragePort;
let worker: Worker;
let s3: FakeServer;
let wsId: string;
let ownerId: string;
let personal: string;
let appId: string;
let url: (p: string) => string;
let realFetch: VaultTransport['fetch'];

const run = () => jobs.run({ sendGapMs: 0, settleMs: 0 });
const ctx = () => ({ workspaceId: wsId, userId: ownerId });
const vstate = () => fake.vault.state as any;
const app = () => vstate().connectedApps.find((a: any) => a.id === appId);
const item = async (fileId: string) =>
  (await db.query(`select * from app.vault_item where file_id = $1`, [fileId])).rows[0];
const fileRow = async (fileId: string) =>
  (await db.query(`select * from app.file where id = $1`, [fileId])).rows[0];
const dueNow = () =>
  db.query(
    `update app.vault_item set next_attempt_at = now() - interval '1 second'
      where workspace_id = $1 and status in ('queued', 'pending', 'received', 'delete')`,
    [wsId],
  );
const contentCalls = () =>
  vstate().calls.filter((x: any) => /^\/api\/v1\/apps\/intake\/[^/]+\/content$/.test(x.path))
    .length as number;

/** A binary file of every byte value, made different from every other by its id. */
const binary = (id: string) => Buffer.concat([ALL_BYTES, Buffer.from(id), ALL_BYTES]);

/** A file in Montra, as an upload stores it: its bytes in storage, its row (which fires the trigger). */
async function file(kind: string, name: string): Promise<{ id: string; bytes: Buffer }> {
  const id = randomUUID();
  const bytes = binary(id);
  const key = storageKey(wsId, kind, id);
  await storage.put(key, bytes, 'image/png');
  await db.query(
    `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, uploaded_by)
     values ($1, $2, $3, $4, $5, 'image/png', $6, $7, $8)`,
    [wsId, id, kind, key, name, bytes.length, sha256(bytes), ownerId],
  );
  return { id, bytes };
}

/** A receipt holding a file, dated in 2026 in the personal books. */
async function receiptFor(fileId: string, merchant = 'Grocer'): Promise<string> {
  return (
    await db.query(
      `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor,
                                attachment_ids, retain_until)
       values ($1, $2, 'inbox', $3, '2026-03-14', 'USD', 4250, array[$4::uuid], '2033-12-31') returning id`,
      [wsId, personal, merchant, fileId],
    )
  ).rows[0].id as string;
}

/**
 * Sends a receipt's file to the fake vault and has a person there file it as a document of its own, made from the very
 * bytes the fake received. Then, as PR 5b's removal does once the vault has filed it, Montra's object goes and the file
 * is marked `vault`. Answers the file and its id in the vault.
 */
async function heldOnlyInVault(
  name: string,
): Promise<{ id: string; bytes: Buffer; ref: string; doc: string }> {
  const f = await file('receipt', name);
  await run();
  const sent = await item(f.id);
  expect(sent.status).toBe('received');
  const ref = sent.vault_ref as string;
  const intake = app().intake.get(ref);
  const received: Uint8Array = intake.bytes ?? intake.file.bytes;
  // The fake kept what Montra sent, byte for byte (0.9.0-dev.62).
  expect(Buffer.from(received).equals(f.bytes)).toBe(true);
  const doc = randomUUID();
  vstate().documents.push({
    id: doc,
    title: `${name} in the vault`,
    type_key: 'utility_bill',
    visibility: 'household',
    sensitive: false,
    is_essential: false,
    issued: { date: '2026-03-14', precision: 'day' },
    expires: null,
    issued_by: null,
    extra: {},
    owner_member_id: null,
    household_owned: true,
  });
  vstate().captures.set(`cap-${doc}`, {
    kind: 'capture',
    document_id: doc,
    version_id: randomUUID(),
    version_no: 1,
    filename: name,
    mime: 'image/png',
    byte_size: received.length,
    uploaded_at: new Date().toISOString(),
    bytes: received,
  });
  fake.vault.fileAppIntake(appId, ref, doc);
  await dueNow();
  await run();
  expect(await item(f.id)).toMatchObject({ status: 'filed', content_available: true });
  await removeMontrasCopy(f.id);
  return { ...f, ref, doc };
}

/** What PR 5b's removal leaves: no Montra object, no key, `location = 'vault'`, the old key on the outbox row. */
async function removeMontrasCopy(fileId: string) {
  const row = await fileRow(fileId);
  await storage.delete(row.storage_key);
  await db.query(`update app.file set location = 'vault', storage_key = null where id = $1`, [fileId]);
  await db.query(`update app.vault_item set source_key = $2, source_removed_at = now() where file_id = $1`, [
    fileId,
    row.storage_key,
  ]);
}

const docOf = (id: string) => vstate().documents.find((d: any) => d.id === id);

function readZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('no zip'));
      const out = new Map<string, Buffer>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (d: Buffer) => chunks.push(d));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

/** Asks for an archive (a backup or a tax package), runs the job and downloads it: it must be ready, never failed. */
async function archive(path: string, body: object): Promise<Map<string, Buffer>> {
  const created = await c.post(url(path), body);
  expect(created.status).toBe(201);
  // Run here, not by whichever test file drains the shared report queue next: only this process has the fake vault.
  const { rows } = await db.query(
    `delete from app.job where workspace_id = $1 and queue = 'report' and status = 'queued' returning *`,
    [wsId],
  );
  for (const job of rows) await (worker as any).handlers.get(job.type)(job, { progress: async () => {} });
  expect((await c.get(url(`/backups/${created.body.id}`))).body).toMatchObject({
    status: 'ready',
    error: null,
  });
  const res = await h.app.inject({
    method: 'GET',
    url: url(`/backups/${created.body.id}/download`),
    headers: { authorization: `Bearer dev:${OWNER}` },
  });
  expect(res.statusCode).toBe(200);
  return readZip(res.rawPayload);
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', FAMILY_VAULT_FAKE: 'on' });
  h.app.get(BackupService).register();
  worker = h.app.get(Worker);
  transport = h.app.get(VAULT_TRANSPORT);
  fake = transport.fake;
  realFetch = transport.fetch;
  jobs = h.app.get(VaultJobs);
  files = h.app.get(FileBytes);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(OWNER);
  partner = h.as(PARTNER);
  stranger = h.as(STRANGER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  s3 = await fakeS3({ buckets: ['family-files'], accessKeyId: S3_KEY });
  wsId = (
    await c.post('/v1/workspaces', { name: 'Vault file bytes', baseCurrency: 'USD', template: 'household' })
  ).body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  ownerId = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0].id;
  personal = (
    await db.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
  ).rows[0].id;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  await stranger.post('/v1/workspaces', { name: 'Someone else', baseCurrency: 'USD', template: 'household' });

  const started = await c.post(url('/family-vault'));
  const registered = await fake.register(started.body.publicKey, { kinds: KINDS, scopes: SCOPES });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault/code'), {
    code: registered.code,
    version: started.body.version,
  });
  expect(pasted.body.stage).toBe('connected');
  const mapped = await c.patch(url('/family-vault'), {
    version: pasted.body.version,
    groups: [{ group: 'receipts', vaultKind: 'utility_bill' }],
  });
  expect(mapped.status).toBe(200);
});

afterEach(() => {
  (transport as any).fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.query(`delete from app.storage_destination where workspace_id = $1`, [wsId]);
  // Nothing of ours may wake a worker in another test file.
  await db.query(`delete from app.job where type in ('storage.vault', 'storage.mirror')`);
  await db.query(`delete from app.job where workspace_id = $1 and status = 'queued'`, [wsId]);
  await db.end();
  await s3.close();
  await h.close();
});

describe('the schema (migration 0066)', () => {
  it('lets a file have no key only while the vault holds it', async () => {
    const id = randomUUID();
    await expect(
      db.query(
        `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256)
         values ($1, $2, 'other', null, 'x.png', 'image/png', 1, $3)`,
        [wsId, id, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/file_storage_key_held/);
    await db.query(
      `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, location)
       values ($1, $2, 'other', null, 'x.png', 'image/png', 1, $3, 'vault')`,
      [wsId, id, 'a'.repeat(64)],
    );
    await db.query(`delete from app.file where id = $1`, [id]);
  });

  it('purges every object of a workspace, and no key that isn’t there', async () => {
    const ws = (
      await c.post('/v1/workspaces', {
        name: 'Purged with the vault',
        baseCurrency: 'USD',
        template: 'household',
      })
    ).body.id;
    const held = randomUUID();
    const gone = randomUUID();
    await db.query(
      `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, location)
       values ($1, $2, 'other', 'k/held', 'a.png', 'image/png', 1, $4, 'montra'),
              ($1, $3, 'other', null, 'b.png', 'image/png', 1, $4, 'vault')`,
      [ws, held, gone, 'b'.repeat(64)],
    );
    const dest = (
      await db.query(
        `insert into app.storage_destination (workspace_id, kind, label, secret_enc, folder, file_kinds)
         values ($1, 'fdv', 'Family Document Vault', decode('00', 'hex'), 'x', array['other']) returning id`,
        [ws],
      )
    ).rows[0].id;
    await db.query(
      `insert into app.vault_item (workspace_id, destination_id, file_id, status, vault_ref, filed_at, source_key)
       values ($1, $2, $3, 'filed', 'm1-purge', now(), 'k/still-to-remove')`,
      [ws, dest, gone],
    );
    await db.query(`update app.workspace set purge_after = now() - interval '1 day' where id = $1`, [ws]);
    const keys = (await db.query(`select k from app.workspace_storage_keys($1) k`, [ws])).rows.map(
      (r) => r.k,
    );
    expect(keys.sort()).toEqual(['k/held', 'k/still-to-remove']);
    await db.query(`delete from app.storage_destination where workspace_id = $1`, [ws]);
    await db.query(`update app.workspace set purge_after = null where id = $1`, [ws]);
  });

  it('says where a file’s copies are to the workspace’s members only, never to anyone else', async () => {
    const f = await file('receipt', 'Copies.png');
    await run();
    // Through the API's own context: the owner sees where the copies are, a stranger nothing.
    const mine = await (files as any).copiesOf(ctx(), f.id);
    expect(mine).toMatchObject({ userId: ownerId, vaultRef: (await item(f.id)).vault_ref });
    const strangerId = (await db.query(`select id from app.app_user where email = $1`, [STRANGER])).rows[0]
      .id;
    expect(await (files as any).copiesOf({ workspaceId: wsId, userId: strangerId }, f.id)).toBeNull();
  });
});

describe('reading back the exact file Montra sent (ADR-0054 §5)', () => {
  it('reads a file only the vault holds, every byte as it was, counted against the vault’s daily reads', async () => {
    const f = await heldOnlyInVault('Round trip.png');
    expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
    const before = contentCalls();
    const readBefore = app().read_bytes_today ?? 0;
    const got = await files.readById(ctx(), f.id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.from).toBe('vault');
    expect(Buffer.from(got.bytes).equals(f.bytes)).toBe(true);
    expect(sha256(got.bytes)).toBe((await fileRow(f.id)).sha256);
    for (let b = 0; b < 256; b++) expect(got.bytes.includes(b)).toBe(true);
    expect(contentCalls()).toBe(before + 1);
    expect(app().read_bytes_today).toBe(readBefore + f.bytes.length);
  });

  it('asks by Montra’s own id, so it is the file Montra sent even after the family adds a newer version', async () => {
    const f = await heldOnlyInVault('Newer version.png');
    vstate().captures.set(`cap-${f.doc}-2`, {
      kind: 'version',
      document_id: f.doc,
      version_id: randomUUID(),
      version_no: 2,
      filename: 'rescanned.png',
      mime: 'image/png',
      byte_size: 3,
      uploaded_at: new Date().toISOString(),
      bytes: new Uint8Array([1, 2, 3]),
    });
    const got = await files.readById(ctx(), f.id);
    expect(got.ok && Buffer.from(got.bytes).equals(f.bytes)).toBe(true);
  });

  it('is unavailable when the vault doesn’t return it, without a guess at why', async () => {
    const f = await heldOnlyInVault('Private now.png');
    docOf(f.doc).visibility = 'private';
    try {
      const got = await files.readById(ctx(), f.id);
      expect(got).toEqual({
        ok: false,
        reason: 'vault_refused',
        words: NOT_AVAILABLE_WORDS.vault_refused,
        heldUntil: null,
      });
    } finally {
      docOf(f.doc).visibility = 'household';
    }
    // A vault that no longer lets Montra download says the same.
    const was = app().scopes;
    app().scopes = was.filter((s: string) => s !== 'documents.download');
    try {
      expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'vault_refused' });
    } finally {
      app().scopes = was;
    }
    // And the connection carries on: nothing about this stops sending.
    const row = (
      await db.query(`select status from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [
        wsId,
      ])
    ).rows[0];
    expect(row.status).toBe('active');
  });

  it('refuses a different file under Montra’s id', async () => {
    const f = await heldOnlyInVault('Changed.png');
    const intake = app().intake.get(f.ref);
    const cap = [...vstate().captures.values()].find((v: any) => v.version_id === intake.version_id);
    const kept = cap.bytes;
    cap.bytes = new Uint8Array([...kept].reverse());
    try {
      expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'vault_refused' });
    } finally {
      cap.bytes = kept;
    }
  });

  it('holds reads until the vault’s reset when its daily reading is used up, and doesn’t ask again before then', async () => {
    const f = await heldOnlyInVault('Daily cap.png');
    app().daily_read_bytes = (app().read_bytes_today ?? 0) + 10;
    try {
      const got = await files.readById(ctx(), f.id);
      expect(got).toMatchObject({ ok: false, reason: 'vault_read_cap' });
      const held = (
        await db.query(`select read_held_until from app.vault_connection_state where workspace_id = $1`, [
          wsId,
        ])
      ).rows[0].read_held_until as Date;
      expect(held.getTime()).toBeGreaterThan(Date.now());
      const calls = contentCalls();
      expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'vault_read_cap' });
      expect(contentCalls()).toBe(calls);
      // A person asking for it gets a 429 that says how long; the connection isn't failing over it.
      const res = await h.app.inject({
        method: 'POST',
        url: url('/receipts'),
        headers: { authorization: `Bearer dev:${OWNER}` },
        payload: { source: 'upload', fileIds: [f.id] },
      });
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.parse(res.body).code).toBe('file.vault_read_cap');
      const row = (
        await db.query(`select * from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [
          wsId,
        ])
      ).rows[0];
      expect(row).toMatchObject({ status: 'active', consecutive_failures: 0 });
    } finally {
      app().daily_read_bytes = undefined;
      await db.query(`update app.vault_connection_state set read_held_until = null where workspace_id = $1`, [
        wsId,
      ]);
    }
  });

  it('can’t ask a vault whose connection needs a person, and a connection problem wakes its check', async () => {
    const f = await heldOnlyInVault('Paused vault.png');
    app().paused = 'owner';
    try {
      expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'vault_unavailable' });
      const s = (
        await db.query(`select next_check_at from app.vault_connection_state where workspace_id = $1`, [wsId])
      ).rows[0];
      expect(new Date(s.next_check_at).getTime()).toBeLessThanOrEqual(Date.now());
      await db.query(
        `update app.storage_destination set status = 'needs_vault' where workspace_id = $1 and kind = 'fdv'`,
        [wsId],
      );
      const calls = contentCalls();
      expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'vault_unavailable' });
      expect(contentCalls()).toBe(calls);
    } finally {
      app().paused = null;
      await db.query(
        `update app.storage_destination set status = 'active' where workspace_id = $1 and kind = 'fdv'`,
        [wsId],
      );
    }
  });

  it('reads Montra’s own copy first, and never asks the vault for a file Montra holds', async () => {
    const f = await file('receipt', 'Held here.png');
    await run();
    const calls = contentCalls();
    const got = await files.readById(ctx(), f.id);
    expect(got.ok && got.from).toBe('montra');
    expect(contentCalls()).toBe(calls);
  });

  it('asks the vault when Montra’s object is gone though the file says Montra holds it', async () => {
    const f = await heldOnlyInVault('Lost object.png');
    // Put back a key that points nowhere: Montra's copy is lost, and the vault still has it.
    await db.query(`update app.file set location = 'montra', storage_key = $2 where id = $1`, [
      f.id,
      storageKey(wsId, 'receipt', randomUUID()),
    ]);
    const got = await files.readById(ctx(), f.id);
    expect(got.ok && got.from).toBe('vault');
  });

  it('says a file nothing holds isn’t available', async () => {
    const f = await file('receipt', 'Nowhere.png');
    await storage.delete((await fileRow(f.id)).storage_key);
    expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'not_held' });
  });
});

describe('every reader, for a file only the vault holds', () => {
  it('a person viewing it is sent to the vault: 409 with words, the bytes never fetched for a preview', async () => {
    const f = await heldOnlyInVault('Viewed.png');
    const receipt = await receiptFor(f.id);
    const calls = contentCalls();
    const res = await c.get(url(`/receipts/${receipt}/files/${f.id}`));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'file.in_vault', detail: NOT_AVAILABLE_WORDS.in_vault });
    expect(contentCalls()).toBe(calls);
  });

  it('a job reading it (an AI extraction, a statement import) gets it from the vault', async () => {
    const f = await heldOnlyInVault('Read by a job.png');
    const bytes = await files.forJob(ctx(), (await fileRow(f.id)) as any);
    expect(Buffer.from(bytes).equals(f.bytes)).toBe(true);
    // One the vault won't return fails the job for good, in words; a hold is tried again by the queue.
    docOf(f.doc).visibility = 'private';
    try {
      await expect(files.forJob(ctx(), (await fileRow(f.id)) as any)).rejects.toMatchObject({
        name: 'PermanentJobError',
        code: 'file.vault_refused',
      });
    } finally {
      docOf(f.doc).visibility = 'household';
    }
    await db.query(
      `update app.vault_connection_state set read_held_until = now() + interval '1 hour' where workspace_id = $1`,
      [wsId],
    );
    try {
      const err = await files.forJob(ctx(), (await fileRow(f.id)) as any).catch((e) => e);
      expect(err.name).toBe('Error');
      expect(err.message).toBe('file.vault_read_cap');
    } finally {
      await db.query(`update app.vault_connection_state set read_held_until = null where workspace_id = $1`, [
        wsId,
      ]);
    }
  });

  it('a new receipt made of it (read again by the doc-worker) puts Montra’s copy back first', async () => {
    const f = await heldOnlyInVault('Read again.png');
    const made = await c.post(url('/receipts'), { source: 'upload', fileIds: [f.id] });
    // Kept out of the doc and AI queues other test files drain; this test only needs Montra's copy put back.
    await db.query(
      `delete from app.job where workspace_id = $1 and status = 'queued' and queue in ('doc', 'ai')`,
      [wsId],
    );
    expect(made.status).toBe(201);
    const row = await fileRow(f.id);
    expect(row.location).toBe('montra');
    expect(row.storage_key).toMatch(new RegExp(`^${wsId}/receipt/\\d{4}/${f.id}-[0-9a-f]{8}$`));
    expect(Buffer.from(await storage.get(row.storage_key)).equals(f.bytes)).toBe(true);
    // Held again, the next read is Montra's own.
    const calls = contentCalls();
    expect((await files.readById(ctx(), f.id)).ok).toBe(true);
    expect(contentCalls()).toBe(calls);
    // Asked again, nothing changes.
    expect((await files.ensureHeld(ctx(), [f.id])).get(f.id)).toBe(row.storage_key);
  });

  it('a backup holds it, from the vault', async () => {
    const f = await heldOnlyInVault('Backed up.png');
    await receiptFor(f.id, 'Backed up');
    const zip = await archive('/backups', {});
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    const entry = manifest.files.find((x: any) => x.id === f.id);
    expect(entry).toBeTruthy();
    expect(zip.get(entry.path)!.equals(f.bytes)).toBe(true);
    expect(zip.get('README.txt')!.toString()).not.toContain(f.id);
  });

  it('a backup lists a file the vault doesn’t return, and is ready all the same', async () => {
    const f = await heldOnlyInVault('Not returned.png');
    await receiptFor(f.id, 'Not returned');
    docOf(f.doc).visibility = 'private';
    try {
      const zip = await archive('/backups', {});
      const manifest = JSON.parse(zip.get('manifest.json')!.toString());
      expect(manifest.files.find((x: any) => x.id === f.id)).toBeUndefined();
      const readme = zip.get('README.txt')!.toString();
      expect(readme).toContain(`Not returned.png (file ${f.id}): ${NOT_AVAILABLE_WORDS.vault_refused}`);
      expect(readme).toContain('Upload them again in Montra');
    } finally {
      docOf(f.doc).visibility = 'household';
    }
  });

  it('a tax package holds it from the vault, and lists one the vault doesn’t return rather than failing', async () => {
    const got = await heldOnlyInVault('Tax receipt.png');
    await receiptFor(got.id, 'Office chair');
    const refused = await heldOnlyInVault('Refused receipt.png');
    await receiptFor(refused.id, 'Desk lamp');
    docOf(refused.doc).visibility = 'private';
    try {
      const zip = await archive('/tax-package', { entityId: personal, year: 2026 });
      const path = [...zip.keys()].find((k) => k.startsWith('receipts/') && k.includes(got.id.slice(0, 8)));
      expect(path).toBeTruthy();
      expect(zip.get(path!)!.equals(got.bytes)).toBe(true);
      expect([...zip.keys()].some((k) => k.includes(refused.id.slice(0, 8)))).toBe(false);
      const readme = zip.get('README.txt')!.toString();
      expect(readme).toContain(
        `Refused receipt.png (file ${refused.id}): ${NOT_AVAILABLE_WORDS.vault_refused}`,
      );
      expect(readme).not.toContain(got.id);
    } finally {
      docOf(refused.doc).visibility = 'household';
    }
  });

  it('the vault’s own job doesn’t fetch it back to send it again', async () => {
    const f = await heldOnlyInVault('Not resent.png');
    const calls = contentCalls();
    await db.query(
      `update app.vault_item set status = 'pending', attempts = 0, next_attempt_at = now() where file_id = $1`,
      [f.id],
    );
    try {
      await run();
      expect(contentCalls()).toBe(calls);
      expect((await item(f.id)).last_error).toBe('The vault couldn’t take this just now.');
    } finally {
      await db.query(`update app.vault_item set status = 'filed', last_error = null where file_id = $1`, [
        f.id,
      ]);
      await db.query(
        `update app.storage_destination set consecutive_failures = 0, last_error = null, last_error_at = null
          where workspace_id = $1 and kind = 'fdv'`,
        [wsId],
      );
    }
  });

  it('every reader of a file’s bytes goes through FileBytes: no other code reads a file by its key', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const reads: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !/file-bytes\.ts$|[\\/]storage\.ts$/.test(p)) {
          const rel = p.replace(/\\/g, '/').replace(/.*\/src\//, '');
          for (const m of readFileSync(p, 'utf8').matchAll(/\.(get|getStream)\([^)]*storage_key[^)]*\)/g))
            reads.push(`${rel}: ${m[0]}`);
        }
      }
    };
    walk(src);
    // Only archives Montra made itself (backups and restores, by their own jobs' keys) are read by a key; an uploaded
    // file's bytes are read only by `FileBytes`.
    expect(reads.sort()).toEqual([
      'data/backup.service.ts: .getStream(row.storage_key!)',
      'data/restore.service.ts: .getStream(r.storage_key)',
      'storage/storage-mirror.jobs.ts: .getStream(job.storage_key)',
    ]);
  });
});

describe('the owner’s own storage, read back (ADR-0054 §5)', () => {
  it('gives a file back before the vault is asked, and only a copy with the file’s hash', async () => {
    const created = await c.post(url('/storage-destination'), {
      label: 'Backblaze',
      connection: {
        kind: 's3',
        s3: { endpoint: s3.url, region: 'us-east-1', bucket: 'family-files', pathStyle: true },
        secret: { accessKeyId: S3_KEY, secretAccessKey: 'a secret access key value' },
      },
      copyExisting: false,
    });
    expect(created.status).toBe(201);
    const mirror = h.app.get(StorageMirrorJobs);
    try {
      const f = await file('receipt', 'Mirrored.png');
      await mirror.run();
      const copied = (await db.query(`select * from app.storage_mirror_item where file_id = $1`, [f.id]))
        .rows[0];
      expect(copied.status).toBe('done');
      await run();
      const ref = (await item(f.id)).vault_ref;
      const intake = app().intake.get(ref);
      const doc = randomUUID();
      vstate().documents.push({ ...docOf(vstate().documents[0].id), id: doc, title: 'Mirrored' });
      vstate().captures.set(`cap-${doc}`, {
        kind: 'capture',
        document_id: doc,
        version_id: randomUUID(),
        version_no: 1,
        filename: 'Mirrored.png',
        mime: 'image/png',
        byte_size: f.bytes.length,
        uploaded_at: new Date().toISOString(),
        bytes: intake.bytes ?? intake.file.bytes,
      });
      fake.vault.fileAppIntake(appId, ref, doc);
      await dueNow();
      await run();
      await removeMontrasCopy(f.id);

      const calls = contentCalls();
      const got = await files.readById(ctx(), f.id);
      expect(got.ok && got.from).toBe('mirror');
      expect(got.ok && Buffer.from(got.bytes).equals(f.bytes)).toBe(true);
      expect(contentCalls()).toBe(calls);
      // A partner reading it (their backup, say) reads the owner's copies under the owner's context.
      const partnerId = (await db.query(`select id from app.app_user where email = $1`, [PARTNER])).rows[0]
        .id;
      const theirs = await files.readById({ workspaceId: wsId, userId: partnerId }, f.id);
      expect(theirs.ok && theirs.from).toBe('mirror');
      // A preview of a file the owner's storage holds is served from there.
      const receipt = await receiptFor(f.id, 'Mirrored');
      const res = await h.app.inject({
        method: 'GET',
        url: url(`/receipts/${receipt}/files/${f.id}`),
        headers: { authorization: `Bearer dev:${OWNER}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(f.bytes)).toBe(true);

      // A copy that isn't the file any more is passed over for the vault's.
      s3.objects.set(`family-files/${copied.remote_path}`, Buffer.from('not the file'));
      const fromVault = await files.readById(ctx(), f.id);
      expect(fromVault.ok && fromVault.from).toBe('vault');
      // The mirror's own job doesn't fetch a file only the vault holds just to copy it.
      await db.query(
        `update app.storage_mirror_item set status = 'pending', next_attempt_at = now() where file_id = $1`,
        [f.id],
      );
      const before = contentCalls();
      await mirror.run();
      expect(contentCalls()).toBe(before);
      expect(
        (await db.query(`select * from app.storage_mirror_item where file_id = $1`, [f.id])).rows[0],
      ).toMatchObject({
        status: 'skipped',
        last_error: NOT_AVAILABLE_WORDS.in_vault,
      });
    } finally {
      await c.delete(url('/storage-destination'));
    }
  });
});

describe('the client, in Montra’s terms', () => {
  it('reads the vault’s refusals of a download as Montra’s', async () => {
    const conn = Object.create(VaultConnection.prototype) as VaultConnection;
    const throwing = (e: unknown) => ({ sentFile: async () => Promise.reject(e) });
    const cases: [unknown, string][] = [
      [new ApiRequestError(404, 'not_found', 'Nothing by that id.'), 'unavailable'],
      [new ApiRequestError(403, 'scope_not_granted', 'Not allowed.'), 'unavailable'],
      [new ApiRequestError(413, 'larger_than_daily_read', 'Too large.'), 'unavailable'],
      [
        new ApiRequestError(429, 'app_read_day_full', 'Used up.', undefined, { retryAfterSeconds: 60 }),
        'read_cap',
      ],
      [new ApiRequestError(401, 'app_paused', 'Paused.'), 'connection'],
      [new ApiRequestError(500, 'internal', 'Oops.'), 'failed'],
    ];
    for (const [e, code] of cases) {
      (conn as any).client = throwing(e);
      (conn as any).opts = { transport: { refused: () => null } };
      const err = await conn.sentFile('m1-x').catch((x) => x);
      expect(err).toBeInstanceOf(VaultError);
      expect(err.code).toBe(code);
    }
  });

  it('a key the doc-worker needs inside a transaction is a 409 to try again, never a null key', () => {
    expect(heldKey({ storage_key: 'a/b' })).toBe('a/b');
    expect(() => heldKey({ storage_key: null })).toThrow(/Try again/);
  });
});
