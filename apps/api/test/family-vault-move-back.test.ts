/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { BackupService } from '../src/data/backup.service.js';
import { RestoreService } from '../src/data/restore.service.js';
import { Worker } from '../src/jobs/queue.js';
import { FileBytes, NOT_AVAILABLE_WORDS } from '../src/storage/file-bytes.js';
import { MISSING_WORDS } from '../src/storage/missing-files.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { StorageMirrorJobs } from '../src/storage/storage-mirror.jobs.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { ADMIN_URL } from './env.js';
import { fakeS3, type FakeServer } from './fakes/storage-servers.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The vault as the record, the rest (ADR-0054 §5, §5a, §10; PR 5b2): moving files the vault filed before their group
// went "no local copy" (offered right after saving, and in Settings), bringing files back, the disconnect choice with
// its soft disconnect, connecting the same vault again, what an archive says about files it couldn't include and its one
// wait for the vault's daily read cap, restore marking, and the possible-duplicate warning. Against the vault's own fake
// (`@fdv/client/testing`, in this process; no real vault is ever reached), with binary files: every byte value from 0
// to 255, after a PNG's signature so that a file provided again is a paper Montra takes.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-moveback@example.com';
const PARTNER = 'partner-vault-moveback@example.com';
const KINDS = ['bank_statement', 'utility_bill', 'pay_statement'];
const SCOPES = [
  'documents.send',
  'documents.read',
  'documents.download',
  'documents.links',
  'documents.delete',
];
const S3_KEY = 'AKIAVAULTMOVEBACK1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

let h: Harness;
let c: Client;
let partner: Client;
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

const run = () => jobs.run({ sendGapMs: 0, settleMs: 0 });
const ctx = () => ({ workspaceId: wsId, userId: ownerId });
const vstate = () => fake.vault.state as any;
const app = () => vstate().connectedApps.find((a: any) => a.id === appId);
const item = async (fileId: string) =>
  (await db.query(`select * from app.vault_item where file_id = $1`, [fileId])).rows[0];
const fileRow = async (fileId: string) =>
  (await db.query(`select * from app.file where id = $1`, [fileId])).rows[0];
const vaultRow = async () =>
  (await db.query(`select * from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [wsId]))
    .rows[0];
const dueNow = () =>
  db.query(
    `update app.vault_item set next_attempt_at = now() - interval '1 second'
      where workspace_id = $1 and status in ('queued', 'pending', 'received', 'delete')`,
    [wsId],
  );
const removeNow = (fileId: string) =>
  db.query(`update app.vault_item set remove_at = now() - interval '1 second' where file_id = $1`, [fileId]);
const contentCalls = () =>
  vstate().calls.filter((x: any) => /^\/api\/v1\/apps\/intake\/[^/]+\/content$/.test(x.path))
    .length as number;
const audits = async (fileId: string, action: string) =>
  Number(
    (
      await db.query(`select count(*) from app.audit_log where subject_id = $1 and action = $2`, [
        fileId,
        action,
      ])
    ).rows[0].count,
  );
const security = async (kind: string) =>
  (
    await db.query(
      `select detail from app.security_event where workspace_id = $1 and kind = $2 order by at desc limit 1`,
      [wsId, kind],
    )
  ).rows[0]?.detail;
const exists = async (key: string) =>
  storage.get(key).then(
    () => true,
    () => false,
  );
const docOf = (id: string) => vstate().documents.find((d: any) => d.id === id);
const binary = (id: string) => Buffer.concat([PNG, ALL_BYTES, Buffer.from(id), ALL_BYTES]);

/** A file in Montra, as an upload stores it: its bytes in storage, its row (which fires the trigger). */
async function file(
  kind: string,
  name: string,
  bytes?: Buffer,
): Promise<{ id: string; bytes: Buffer; key: string }> {
  const id = randomUUID();
  const b = bytes ?? binary(id);
  const key = storageKey(wsId, kind, id);
  await storage.put(key, b, 'image/png');
  await db.query(
    `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, uploaded_by)
     values ($1, $2, $3, $4, $5, 'image/png', $6, $7, $8)`,
    [wsId, id, kind, key, name, b.length, sha256(b), ownerId],
  );
  return { id, bytes: b, key };
}

/** A receipt holding a file, dated in 2026 in the personal books. */
async function receiptFor(fileId: string, status = 'inbox'): Promise<string> {
  return (
    await db.query(
      `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor,
                                attachment_ids, retain_until)
       values ($1, $2, $3, 'Grocer', '2026-03-14', 'USD', 4250, array[$4::uuid], '2033-12-31') returning id`,
      [wsId, personal, status, fileId],
    )
  ).rows[0].id as string;
}

/** Sends a receipt's file to the fake vault: it lands in someone's Inbox there. */
async function sent(name: string) {
  const f = await file('receipt', name);
  await run();
  const i = await item(f.id);
  expect(i.status).toBe('received');
  return { ...f, ref: i.vault_ref as string };
}

/** A person in the fake vault files what Montra sent as a document of its own, from the very bytes it received. */
function fileInVault(ref: string, name: string): string {
  const intake = app().intake.get(ref);
  const received: Uint8Array = intake.bytes ?? intake.file.bytes;
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
  return doc;
}

/** Sent, filed by a person in the vault, and the job's next run. */
async function filed(name: string) {
  const s = await sent(name);
  const doc = fileInVault(s.ref, name);
  await dueNow();
  await run();
  expect((await item(s.id)).status).toBe('filed');
  return { ...s, doc };
}

/** Filed while receipts go with no local copy, so Montra's copy is removed: the file is held only in the vault. */
async function onlyInVault(name: string) {
  await setMode('sent_no_copy');
  const f = await filed(name);
  expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
  return f;
}

const connection = async () => (await c.get(url('/family-vault'))).body.connection;

async function setMode(mode: 'sent_keep_copy' | 'sent_no_copy') {
  const d = await connection();
  const now = d.groups.find((g: any) => g.group === 'receipts');
  if (now?.mode === mode && now.vaultKind === 'utility_bill') return d;
  const res = await c.patch(url('/family-vault'), {
    version: d.version,
    groups: [{ group: 'receipts', mode, vaultKind: 'utility_bill' }],
  });
  expect(res.status).toBe(200);
  return res.body;
}

/** Connects the workspace to the fake vault, as Montra's app there (a new app the first time). */
async function connect() {
  const started = await c.post(url('/family-vault'));
  expect(started.status).toBeLessThan(300);
  const registered = await fake.register(started.body.publicKey, { kinds: KINDS, scopes: SCOPES });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault/code'), {
    code: registered.code,
    version: started.body.version,
  });
  expect(pasted.body.stage).toBe('connected');
}

/** Every file held only in the vault, provided again, so the connection can go: a clean start for the next test. */
async function clearOnlyInVault() {
  const left = (
    await db.query(`select id from app.file where workspace_id = $1 and location = 'vault'`, [wsId])
  ).rows;
  for (const f of left) {
    await db.query(`update app.file set deleted_at = now() where id = $1`, [f.id]);
    await db.query(`delete from app.file where id = $1`, [f.id]);
  }
}

function multipart(bytes: Buffer, name = 'again.png') {
  const boundary = '----vault-moveback';
  return {
    headers: {
      authorization: `Bearer dev:${OWNER}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function upload(path: string, bytes: Buffer, name = 'again.png') {
  const res = await h.app.inject({ method: 'POST', url: url(path), ...multipart(bytes, name) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

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

/**
 * Runs this workspace's queued archive jobs here, not by whichever test file drains the shared report queue next: only
 * this process has the fake vault. Jobs waiting for later (`run_after`) are left, as the queue leaves them.
 */
async function runArchiveJobs() {
  const { rows } = await db.query(
    `delete from app.job where workspace_id = $1 and queue = 'report' and status = 'queued' and run_after <= now()
     returning *`,
    [wsId],
  );
  for (const job of rows) await (worker as any).handlers.get(job.type)(job, { progress: async () => {} });
  return rows.length;
}

async function download(exportId: string) {
  const res = await h.app.inject({
    method: 'GET',
    url: url(`/backups/${exportId}/download`),
    headers: { authorization: `Bearer dev:${OWNER}` },
  });
  expect(res.statusCode).toBe(200);
  return { bytes: res.rawPayload, zip: await readZip(res.rawPayload) };
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', FAMILY_VAULT_FAKE: 'on' });
  h.app.get(BackupService).register();
  h.app.get(RestoreService).register();
  worker = h.app.get(Worker);
  transport = h.app.get(VAULT_TRANSPORT);
  fake = transport.fake;
  jobs = h.app.get(VaultJobs);
  files = h.app.get(FileBytes);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(OWNER);
  partner = h.as(PARTNER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  s3 = await fakeS3({ buckets: ['family-files'], accessKeyId: S3_KEY });
  wsId = (
    await c.post('/v1/workspaces', { name: 'Vault move back', baseCurrency: 'USD', template: 'household' })
  ).body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  ownerId = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0].id;
  personal = (
    await db.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
  ).rows[0].id;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  await connect();
  await setMode('sent_keep_copy');
});

afterEach(() => {
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

describe('moving files the vault had already filed (ADR-0054 §5, §12; the owner’s “offer to move now”)', () => {
  it('counts them right after a group goes “no local copy”, and moves nothing until the owner confirms', async () => {
    const a = await filed('Before A.png');
    const b = await filed('Before B.png');
    const inbox = await sent('Still in the Inbox.png');
    const saved = await setMode('sent_no_copy');
    expect(saved.groups.find((g: any) => g.group === 'receipts').mode).toBe('sent_no_copy');

    // Saving the mode moves nothing on its own.
    await run();
    for (const f of [a, b]) {
      expect(await fileRow(f.id)).toMatchObject({ location: 'montra', storage_key: f.key });
      expect(await exists(f.key)).toBe(true);
    }

    // The offer: the group's files the vault has filed. An Inbox item isn't one (it moves once filed, as before).
    const offer = await c.get(url('/family-vault/move?groups=receipts'));
    expect(offer.body).toEqual({ count: 2, groups: [{ group: 'receipts', count: 2 }] });
    expect((await c.get(url('/family-vault/move'))).body.count).toBe(2);
    // Another group's count is nought.
    expect((await c.get(url('/family-vault/move?groups=bills'))).body).toEqual({ count: 0, groups: [] });
    // Owners and admins see the count; only the owner moves.
    expect((await partner.get(url('/family-vault/move'))).status).toBe(403);
    expect((await partner.post(url('/family-vault/move'), { expected: 2 })).status).toBe(403);
    // A count other than the one shown is refused, and nothing moves.
    const wrong = await c.post(url('/family-vault/move'), { expected: 1, groups: ['receipts'] });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe('vault.count_changed');
    await run();
    expect((await fileRow(a.id)).location).toBe('montra');
    expect((await item(a.id)).remove_at).toBeNull();

    const moved = await c.post(url('/family-vault/move'), { expected: 2, groups: ['receipts'] });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ count: 0, groups: [] });
    expect(await security('vault_move_started')).toMatchObject({
      count: 2,
      groups: [{ group: 'receipts', count: 2 }],
      keepCopy: false,
    });
    await run();
    for (const f of [a, b]) {
      expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
      expect(await exists(f.key)).toBe(false);
      expect(await audits(f.id, 'file.moved_to_vault')).toBe(1);
    }
    // The Inbox item moves when it is filed, as any file of the group filed from now on.
    fileInVault(inbox.ref, 'Still in the Inbox.png');
    await dueNow();
    await run();
    expect((await fileRow(inbox.id)).location).toBe('vault');
  });

  it('checks §5’s conditions for each file, one at a time, and leaves the ones that don’t hold yet', async () => {
    await setMode('sent_keep_copy');
    const busy = await filed('Busy.png');
    const receipt = await receiptFor(busy.id, 'needs_review');
    const notBack = await filed('Not given back.png');
    const clean = await filed('Clean.png');
    await setMode('sent_no_copy');
    const count = (await c.get(url('/family-vault/move?groups=receipts'))).body.count;
    expect(count).toBe(3);
    expect((await c.post(url('/family-vault/move'), { expected: 3 })).status).toBe(200);

    // The vault won't give one back just now: asked again before anything is removed, it says so.
    await db.query(`update app.vault_item set content_available = null where file_id = $1`, [notBack.id]);
    const was = app().scopes;
    app().scopes = was.filter((x: string) => x !== 'documents.download');
    const moveOne = vi.spyOn(jobs as any, 'moveOne');
    try {
      await run();
    } finally {
      app().scopes = was;
    }
    // One file per call, each in its own transaction.
    const calls = moveOne.mock.calls.map((args: any[]) => args[3].file_id);
    expect(calls).toEqual(expect.arrayContaining([busy.id, notBack.id, clean.id]));
    expect(new Set(calls).size).toBe(calls.length);
    expect(await fileRow(clean.id)).toMatchObject({ location: 'vault' });
    expect(await fileRow(busy.id)).toMatchObject({ location: 'montra', storage_key: busy.key });
    expect(await fileRow(notBack.id)).toMatchObject({ location: 'montra', storage_key: notBack.key });
    for (const f of [busy, notBack]) {
      expect(new Date((await item(f.id)).remove_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    }

    // Both hold later: reviewed, and the vault can give it back.
    await db.query(`update app.receipt set status = 'inbox' where id = $1`, [receipt]);
    await removeNow(busy.id);
    await removeNow(notBack.id);
    await run();
    expect((await fileRow(busy.id)).location).toBe('vault');
    expect((await fileRow(notBack.id)).location).toBe('vault');
  });

  it('waits for the owner’s own storage when it copies the group, and for an active connection', async () => {
    await setMode('sent_keep_copy');
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
    try {
      const f = await filed('Mirrored first.png');
      await setMode('sent_no_copy');
      expect((await c.post(url('/family-vault/move'), { expected: 1, groups: ['receipts'] })).status).toBe(
        200,
      );
      await run();
      expect((await fileRow(f.id)).location).toBe('montra');
      await h.app.get(StorageMirrorJobs).run();
      // The connection isn't active: still not.
      await db.query(`update app.storage_destination set status = 'needs_vault' where id = $1`, [
        (await vaultRow()).id,
      ]);
      await removeNow(f.id);
      const row = await vaultRow();
      const conn = await h.app
        .get((await import('../src/storage/vault/vault.service.js')).VaultService)
        .openRow(ctx(), row);
      try {
        await (jobs as any).removeSources(
          ctx(),
          { ...row, status: 'needs_vault' },
          (await import('../src/storage/vault/vault.service.js')).configOf(row),
          conn,
          Date.now() + 30_000,
          { moved: 0 },
        );
      } finally {
        conn.close();
      }
      expect((await fileRow(f.id)).location).toBe('montra');
      await db.query(`update app.storage_destination set status = 'active' where id = $1`, [row.id]);
      await removeNow(f.id);
      await run();
      expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
    } finally {
      await c.delete(url('/storage-destination'));
    }
  });
});

describe('bringing the files back (ADR-0054 §10)', () => {
  it('copies every file held only in the vault back into Montra, byte for byte, and keeps the copies', async () => {
    const f = await onlyInVault('Bring me back.png');
    const others = (
      await db.query(`select id from app.file where workspace_id = $1 and location = 'vault'`, [wsId])
    ).rows.map((r) => r.id as string);
    expect(others.length).toBeGreaterThan(1);
    // Owner only, with a recent sign-in.
    expect((await partner.post(url('/family-vault/bring-back'), {})).status).toBe(403);
    const asked = await c.post(url('/family-vault/bring-back'), {});
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ queued: others.length, heldUntil: null });
    const d = await connection();
    expect(d.bringingBack).toEqual({ then: 'keep' });
    // Nothing goes without a copy again, and choosing it again waits until they are back.
    expect(d.groups.find((g: any) => g.group === 'receipts').mode).toBe('sent_keep_copy');
    const again = await c.patch(url('/family-vault'), {
      version: d.version,
      groups: [{ group: 'receipts', mode: 'sent_no_copy' }],
    });
    expect(again.body.code).toBe('vault.bringing_back');

    await run();
    for (const id of others) {
      const row = await fileRow(id);
      expect(row.location).toBe('montra');
      expect(row.storage_key).toMatch(new RegExp(`^${wsId}/receipt/\\d{4}/${id}-[0-9a-f]{8}$`));
      expect(await audits(id, 'file.brought_back')).toBe(1);
      // No longer a file that moved: only a move with its confirmation takes the copy again.
      expect(await item(id)).toMatchObject({ source_key: null, source_removed_at: null, remove_at: null });
    }
    const back = await fileRow(f.id);
    expect(Buffer.from(await storage.get(back.storage_key)).equals(f.bytes)).toBe(true);
    expect(sha256(await storage.get(back.storage_key))).toBe(back.sha256);
    expect((await connection()).bringingBack).toBeNull();
    expect((await connection()).files.onlyInVault).toBe(0);
    expect(await security('vault_changed')).toMatchObject({ broughtBack: true, stillOnlyInVault: 0 });
    // Running again changes nothing.
    await run();
    expect((await fileRow(f.id)).storage_key).toBe(back.storage_key);
  });

  it('waits for the vault’s daily reset when its reading is used up, then goes on', async () => {
    const f = await onlyInVault('Capped.png');
    await setMode('sent_keep_copy');
    app().daily_read_bytes = (app().read_bytes_today ?? 0) + 10;
    try {
      expect((await c.post(url('/family-vault/bring-back'), {})).status).toBe(200);
      await run();
      expect((await fileRow(f.id)).location).toBe('vault');
      expect((await fileRow(f.id)).missing_since).toBeNull();
      const state = (
        await db.query(`select * from app.vault_connection_state where workspace_id = $1`, [wsId])
      ).rows[0];
      expect(state.bring_back_then).toBe('keep');
      expect(new Date(state.bring_back_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      app().daily_read_bytes = undefined;
    }
    await db.query(
      `update app.vault_connection_state set bring_back_at = now(), read_held_until = null where workspace_id = $1`,
      [wsId],
    );
    await run();
    expect((await fileRow(f.id)).location).toBe('montra');
    expect((await connection()).bringingBack).toBeNull();
  });
});

describe('disconnecting while files are kept only in the vault (ADR-0054 §10)', () => {
  it('asks for a choice: a disconnect that doesn’t say is refused with the count', async () => {
    await onlyInVault('Choose.png');
    const res = await c.delete(url('/family-vault'), {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('vault.files_only_in_vault');
    expect(res.body.detail ?? res.body.title).toMatch(/kept only in the vault/);
    expect((await connection()).status).toBe('active');
    expect((await c.delete(url('/family-vault'), { anyway: true, bringBack: true })).status).toBe(400);
  });

  it('“Disconnect anyway” keeps the connection, disconnected: no key, nothing sent, files missing with the reason', async () => {
    const f = (
      await db.query(`select id from app.file where workspace_id = $1 and location = 'vault' limit 1`, [wsId])
    ).rows[0].id as string;
    await receiptFor(f);
    const res = await c.delete(url('/family-vault'), { anyway: true });
    expect(res.status).toBe(204);
    const d = await connection();
    expect(d).toMatchObject({ status: 'disconnected', bringingBack: null });
    const row = await vaultRow();
    expect(row.secret_enc).toBeNull();
    expect(row).toMatchObject({ mirror_files: false, file_kinds: [] });
    expect(await security('vault_disconnected')).toMatchObject({ kept: true, anyway: true });
    // The outbox stays: it is how Montra reads them back from the same vault.
    expect((await item(f)).status).toBe('filed');
    expect(await fileRow(f)).toMatchObject({ missing_reason: MISSING_WORDS.disconnected });
    expect(await audits(f, 'file.marked_missing')).toBe(1);
    const list = (await c.get(url('/missing-files'))).body.data;
    expect(list.find((x: any) => x.fileId === f)).toMatchObject({ reason: MISSING_WORDS.disconnected });
    // Readers are told why, and the vault is never asked.
    const calls = contentCalls();
    expect(await files.readById(ctx(), f)).toMatchObject({
      ok: false,
      reason: 'vault_disconnected',
      words: NOT_AVAILABLE_WORDS.vault_disconnected,
    });
    expect(contentCalls()).toBe(calls);
    // Nothing opens, is sent or is changed there; the job never looks at it.
    expect((await c.get(url(`/family-vault/files?ids=${f}`))).body.data[0].vault.canOpen).toBe(false);
    const due = (await db.query(`select * from app.vault_due() where workspace_id = $1`, [wsId])).rows;
    expect(due).toEqual([]);
    expect((await c.patch(url('/family-vault'), { version: d.version, paused: true })).body.code).toBe(
      'vault.disconnected',
    );
    expect((await c.post(url('/family-vault/check'))).body.code).toBe('vault.disconnected');
    // A file uploaded now isn't queued for it.
    const later = await file('receipt', 'After the disconnect.png');
    expect(await item(later.id)).toBeUndefined();
    // It can't be removed while those files are only in the vault: their references would go.
    const gone = await c.delete(url('/family-vault'), { anyway: true });
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe('vault.files_only_in_vault');
    // People are told, once, with no file names.
    const told = (
      await db.query(`select * from app.notification where workspace_id = $1 and type = 'files_missing'`, [
        wsId,
      ])
    ).rows;
    expect(told.length).toBe(1);
  });

  it('connecting the same vault again resumes reading those files, byte for byte', async () => {
    const missing = (
      await db.query(
        `select id from app.file where workspace_id = $1 and location = 'vault' and missing_reason = $2`,
        [wsId, MISSING_WORDS.disconnected],
      )
    ).rows.map((r) => r.id as string);
    expect(missing.length).toBeGreaterThan(0);
    const started = await c.post(url('/family-vault'));
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ stage: 'register', status: 'needs_vault' });
    // The same app in the same vault, with Montra's new key added by someone there.
    const raw = Buffer.from(started.body.publicKey.slice('ed25519:'.length), 'base64url');
    app().keys.push({
      id: randomUUID(),
      raw: new Uint8Array(raw),
      added_by: 'owner',
      created_at: new Date().toISOString(),
      retired: false,
    });
    const code = await fake.codeFor(appId);
    const pasted = await c.post(url('/family-vault/code'), { code, version: started.body.version });
    expect(pasted.status).toBe(200);
    expect(pasted.body).toMatchObject({ stage: 'connected', status: 'active' });
    expect(await security('vault_connected')).toMatchObject({ reconnected: true, sameVault: true });
    for (const id of missing) {
      expect(await fileRow(id)).toMatchObject({ missing_since: null, location: 'vault' });
      expect(await audits(id, 'file.found_again')).toBe(1);
      const got = await files.readById(ctx(), id);
      expect(got.ok && got.from).toBe('vault');
      const row = await fileRow(id);
      expect(got.ok && sha256(got.bytes)).toBe(row.sha256);
    }
    // Its groups are as they were.
    expect((await connection()).groups.find((g: any) => g.group === 'receipts').vaultKind).toBe(
      'utility_bill',
    );
  });

  it('“Bring the files back” then disconnects: once all are back, the connection goes', async () => {
    const f = await onlyInVault('Back then gone.png');
    const res = await c.delete(url('/family-vault'), { bringBack: true });
    expect(res.status).toBe(204);
    expect((await connection()).bringingBack).toEqual({ then: 'disconnect' });
    await run();
    expect(await fileRow(f.id)).toMatchObject({ location: 'montra' });
    expect(Buffer.from(await storage.get((await fileRow(f.id)).storage_key)).equals(f.bytes)).toBe(true);
    expect(await connection()).toBeNull();
    expect(await security('vault_disconnected')).toMatchObject({ afterBringBack: true });
    await connect();
    await setMode('sent_keep_copy');
  });

  it('“Bring the files back” then disconnects, keeping the connection for a file the vault won’t give back', async () => {
    const f = await onlyInVault('Refused on the way back.png');
    docOf(f.doc).visibility = 'private';
    try {
      expect((await c.delete(url('/family-vault'), { bringBack: true })).status).toBe(204);
      await run();
    } finally {
      docOf(f.doc).visibility = 'household';
    }
    expect(await fileRow(f.id)).toMatchObject({ location: 'vault', missing_reason: MISSING_WORDS.refused });
    expect((await connection()).status).toBe('disconnected');
    // Once it is provided again, the connection can go.
    const again = await upload(`/missing-files/${f.id}`, f.bytes);
    expect(again).toMatchObject({ status: 200, body: { queuedForVault: false } });
    expect((await c.delete(url('/family-vault'), {})).status).toBe(204);
    expect(await connection()).toBeNull();
    await clearOnlyInVault();
    await connect();
    await setMode('sent_keep_copy');
  });
});

describe('archives and the vault (ADR-0054 §5a)', () => {
  it('an archive’s screen counts the files it couldn’t include', async () => {
    const f = await onlyInVault('Not in the backup.png');
    docOf(f.doc).visibility = 'private';
    try {
      const created = await c.post(url('/backups'), {});
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ missingFiles: 0, waitingUntil: null });
      expect(await runArchiveJobs()).toBe(1);
      const done = (await c.get(url(`/backups/${created.body.id}`))).body;
      expect(done).toMatchObject({ status: 'ready', missingFiles: 1, waitingUntil: null });
      const { zip } = await download(created.body.id);
      expect(zip.get('README.txt')!.toString()).toContain(`Not in the backup.png (file ${f.id})`);
      expect((await c.get(url('/backups'))).body.data[0]).toMatchObject({ missingFiles: 1 });
    } finally {
      docOf(f.doc).visibility = 'household';
    }
  });

  it('a background archive waits once for the vault’s daily reset, then lists what is still unavailable', async () => {
    await clearOnlyInVault();
    const f = await onlyInVault('Read cap backup.png');
    await receiptFor(f.id);
    const held = new Date(Date.now() + 6 * 3600_000);
    await db.query(`update app.vault_connection_state set read_held_until = $2 where workspace_id = $1`, [
      wsId,
      held,
    ]);
    for (const [path, body] of [
      ['/backups', {}],
      ['/tax-package', { entityId: personal, year: 2026 }],
    ] as const) {
      const created = await c.post(url(path), body);
      expect(created.status).toBe(201);
      expect(await runArchiveJobs()).toBe(1);
      const waiting = (await c.get(url(`/backups/${created.body.id}`))).body;
      expect(waiting.status).toBe('queued');
      expect(new Date(waiting.waitingUntil).getTime()).toBeGreaterThanOrEqual(held.getTime());
      // Queued again for after the reset, once.
      const queued = (
        await db.query(
          `select * from app.job where workspace_id = $1 and queue = 'report' and status = 'queued'
            and payload->>'exportId' = $2`,
          [wsId, created.body.id],
        )
      ).rows;
      expect(queued).toHaveLength(1);
      expect(queued[0].payload.vaultWaited).toBe(true);
      expect(new Date(queued[0].run_after).getTime()).toBeGreaterThanOrEqual(held.getTime());
      // Nothing runs before then.
      expect(await runArchiveJobs()).toBe(0);
      // The reset came, but the vault's reading is still used up: it doesn't wait again, and lists the file.
      await db.query(`update app.job set run_after = now() where id = $1`, [queued[0].id]);
      expect(await runArchiveJobs()).toBe(1);
      const done = (await c.get(url(`/backups/${created.body.id}`))).body;
      expect(done).toMatchObject({ status: 'ready', missingFiles: 1, waitingUntil: null });
      const { zip } = await download(created.body.id);
      expect(zip.get('README.txt')!.toString()).toContain(
        `Read cap backup.png (file ${f.id}): ${NOT_AVAILABLE_WORDS.vault_read_cap}`,
      );
    }
    await db.query(`update app.vault_connection_state set read_held_until = null where workspace_id = $1`, [
      wsId,
    ]);
  });

  it('a restore marks the files the archive didn’t hold as missing, with the reason', async () => {
    const f = (
      await db.query(`select id from app.file where workspace_id = $1 and location = 'vault' limit 1`, [wsId])
    ).rows[0].id as string;
    const kept = await file('receipt', 'Kept in the archive.png');
    docOf((await item(f)).vault_document_id).visibility = 'private';
    let bytes: Buffer;
    try {
      const created = await c.post(url('/backups'), {});
      await runArchiveJobs();
      expect((await c.get(url(`/backups/${created.body.id}`))).body.missingFiles).toBeGreaterThanOrEqual(1);
      bytes = (await download(created.body.id)).bytes;
    } finally {
      docOf((await item(f)).vault_document_id).visibility = 'household';
    }
    const boundary = '----vault-restore';
    const up = await h.app.inject({
      method: 'POST',
      url: '/v1/me/restores',
      headers: {
        authorization: `Bearer dev:${OWNER}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        bytes!,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(up.statusCode).toBe(201);
    const id = JSON.parse(up.body).id;
    // Read here, not by whichever test file drains the shared queue next.
    const inspect = async () => {
      const { rows } = await db.query(
        `delete from app.job where type like 'data.restore%' and status = 'queued' and payload::text like $1 returning *`,
        [`%${id}%`],
      );
      for (const job of rows) await (worker as any).handlers.get(job.type)(job, { progress: async () => {} });
    };
    await inspect();
    expect(
      (await c.post(`/v1/me/restores/${id}/confirm`, { mode: 'new', name: 'Restored vault' })).status,
    ).toBe(200);
    await inspect();
    const done = (await c.get(`/v1/me/restores/${id}`)).body;
    expect(done).toMatchObject({ status: 'done', error: null });
    const ws = done.targetWorkspaceId as string;
    const restored = (
      await db.query(`select * from app.file where workspace_id = $1 and file_name = $2`, [
        ws,
        (await fileRow(f)).file_name,
      ])
    ).rows[0];
    expect(restored).toMatchObject({
      location: 'vault',
      storage_key: null,
      missing_reason: MISSING_WORDS.notInBackup,
    });
    expect(restored.missing_since).not.toBeNull();
    expect(await audits(restored.id, 'file.marked_missing')).toBe(1);
    const list = (await c.get(`/v1/workspaces/${ws}/missing-files`)).body.data;
    expect(list.find((x: any) => x.fileId === restored.id)).toMatchObject({
      reason: MISSING_WORDS.notInBackup,
    });
    // A file the archive held is Montra's, with its bytes.
    const back = (
      await db.query(
        `select * from app.file where workspace_id = $1 and file_name = 'Kept in the archive.png'`,
        [ws],
      )
    ).rows[0];
    expect(back).toMatchObject({ location: 'montra', missing_since: null });
    expect(Buffer.from(await storage.get(back.storage_key)).equals(kept.bytes)).toBe(true);
    await db.query(`delete from app.storage_destination where workspace_id = $1`, [ws]);
  });
});

describe('a possible duplicate (the owner’s clarification, 2026-11-18)', () => {
  it('warns when a file provided again is another file’s bytes, and stores it when the person goes on', async () => {
    const other = await onlyInVault('Already here.png');
    const f = await onlyInVault('Lost one.png');
    await db.query(`update app.file set missing_since = now(), missing_reason = $2 where id = $1`, [
      f.id,
      MISSING_WORDS.refused,
    ]);
    // The same bytes as a file held only in the vault: a possible duplicate, named for the owner. Nothing is stored.
    const warned = await upload(`/missing-files/${f.id}`, other.bytes);
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe('file.possible_duplicate');
    expect(warned.body.detail ?? warned.body.title).toContain('Already here.png');
    expect((await fileRow(f.id)).missing_since).not.toBeNull();
    // Cancelling is simply not going on. Uploading anyway stores it and sends it to the vault like any other.
    const anyway = await h.app.inject({
      method: 'POST',
      url: url(`/missing-files/${f.id}?anyway=true`),
      ...multipart(other.bytes),
    });
    expect(anyway.statusCode).toBe(200);
    expect(JSON.parse(anyway.body)).toMatchObject({ hashChanged: true, queuedForVault: true });
    // Its own bytes again are no duplicate of anything.
    const g = await onlyInVault('Its own bytes.png');
    await db.query(`update app.file set missing_since = now(), missing_reason = $2 where id = $1`, [
      g.id,
      MISSING_WORDS.refused,
    ]);
    expect((await upload(`/missing-files/${g.id}`, g.bytes)).status).toBe(200);
  });

  it('an upload of a receipt, payslip or bill says which file it repeats, wherever that file is held', async () => {
    const held = await onlyInVault('Vault only receipt.png');
    const receipt = await upload('/receipts/files', held.bytes, 'again.png');
    expect(receipt.status).toBe(201);
    expect(receipt.body.duplicateOf).toMatchObject({ fileId: held.id });
    const fresh = await upload('/receipts/files', binary(randomUUID()), 'new.png');
    expect(fresh.body.duplicateOf).toBeNull();

    const payslip = binary(randomUUID());
    const first = await upload('/payslips/files', payslip, 'payslip.png');
    expect(first.body.duplicateOf).toBeNull();
    const second = await upload('/payslips/files', payslip, 'payslip again.png');
    expect(second.body).toMatchObject({ duplicateOf: { fileId: first.body.fileId, receiptId: null } });

    const bill = binary(randomUUID());
    const b1 = await upload('/household-bills/files', bill, 'bill.png');
    expect(b1.body.duplicateOf).toBeNull();
    const b2 = await upload('/businesses/files', bill, 'bill again.png');
    expect(b2.body).toMatchObject({ duplicateOf: { fileId: b1.body.fileId } });
  });
});
