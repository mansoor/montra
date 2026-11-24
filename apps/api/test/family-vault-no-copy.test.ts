/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileBytes } from '../src/storage/file-bytes.js';
import { MISSING_WORDS } from '../src/storage/missing-files.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { StorageMirrorJobs } from '../src/storage/storage-mirror.jobs.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { configOf, VaultService } from '../src/storage/vault/vault.service.js';
import { ADMIN_URL } from './env.js';
import { fakeS3, type FakeServer } from './fakes/storage-servers.js';
import { startHarness, type Client, type Harness } from './harness.js';

// "Sent, no local copy" (ADR-0054 §5, §5a; PR 5b). For a group in that mode the vault's job removes Montra's copy of a
// file once the vault has filed it, the vault says it could give it back, the owner's own storage has its copy when it
// copies that kind, and nothing in Montra reads it; then a file the vault doesn't give back is missing, listed in Review
// and provided again under the same id. Against the vault's own fake (`@fdv/client/testing`, in this process; no real
// vault is ever reached), with binary files: every byte value from 0 to 255, after a PNG's signature so that a file
// provided again is a paper Montra takes.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-nocopy@example.com';
const PARTNER = 'partner-vault-nocopy@example.com';
const KINDS = ['bank_statement', 'utility_bill', 'pay_statement'];
const SCOPES = [
  'documents.send',
  'documents.read',
  'documents.download',
  'documents.links',
  'documents.delete',
];
const S3_KEY = 'AKIAVAULTNOCOPY01';
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
const dueNow = () =>
  db.query(
    `update app.vault_item set next_attempt_at = now() - interval '1 second'
      where workspace_id = $1 and status in ('queued', 'pending', 'received', 'delete')`,
    [wsId],
  );
const removeNow = (fileId: string) =>
  db.query(`update app.vault_item set remove_at = now() - interval '1 second' where file_id = $1`, [fileId]);
const feedDue = () =>
  db.query(
    `update app.vault_connection_state set feed_next_at = now() - interval '1 second' where workspace_id = $1`,
    [wsId],
  );
const contentCalls = () =>
  vstate().calls.filter((x: any) => /^\/api\/v1\/apps\/intake\/[^/]+\/content$/.test(x.path))
    .length as number;
const moves = async (fileId: string) =>
  Number(
    (
      await db.query(
        `select count(*) from app.audit_log where subject_id = $1 and action = 'file.moved_to_vault'`,
        [fileId],
      )
    ).rows[0].count,
  );
const exists = async (key: string) =>
  storage.get(key).then(
    () => true,
    () => false,
  );
const docOf = (id: string) => vstate().documents.find((d: any) => d.id === id);
const binary = (id: string) => Buffer.concat([PNG, ALL_BYTES, Buffer.from(id), ALL_BYTES]);

/** A file in Montra, as an upload stores it: its bytes in storage, its row (which fires the trigger). */
async function file(kind: string, name: string): Promise<{ id: string; bytes: Buffer; key: string }> {
  const id = randomUUID();
  const bytes = binary(id);
  const key = storageKey(wsId, kind, id);
  await storage.put(key, bytes, 'image/png');
  await db.query(
    `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, uploaded_by)
     values ($1, $2, $3, $4, $5, 'image/png', $6, $7, $8)`,
    [wsId, id, kind, key, name, bytes.length, sha256(bytes), ownerId],
  );
  return { id, bytes, key };
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

/** Sent, filed by a person in the vault, and the job's next run: Montra's copy goes when §5 holds. */
async function filed(name: string) {
  const s = await sent(name);
  const doc = fileInVault(s.ref, name);
  await dueNow();
  await run();
  return { ...s, doc };
}

/** Filed, and Montra's copy removed: the file is held only in the vault. */
async function onlyInVault(name: string) {
  const f = await filed(name);
  expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
  return f;
}

function multipart(bytes: Buffer, name = 'again.png') {
  const boundary = '----vault-nocopy';
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

async function provide(fileId: string, bytes: Buffer, as = OWNER) {
  const body = multipart(bytes);
  const res = await h.app.inject({
    method: 'POST',
    url: url(`/missing-files/${fileId}`),
    ...body,
    headers: { ...body.headers, authorization: `Bearer dev:${as}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const notifications = async (type: string) =>
  (await db.query(`select * from app.notification where workspace_id = $1 and type = $2`, [wsId, type])).rows;

const connection = async () => (await c.get(url('/family-vault'))).body.connection;

async function setMode(mode: 'sent_keep_copy' | 'sent_no_copy') {
  const d = await connection();
  const res = await c.patch(url('/family-vault'), {
    version: d.version,
    groups: [{ group: 'receipts', mode, vaultKind: 'utility_bill' }],
  });
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', FAMILY_VAULT_FAKE: 'on' });
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
    await c.post('/v1/workspaces', { name: 'Vault no copy', baseCurrency: 'USD', template: 'household' })
  ).body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  ownerId = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0].id;
  personal = (
    await db.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
  ).rows[0].id;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);

  // The vault's owner connects Montra there and generates its API key; the owner pastes the connection string.
  const registered = await fake.register({ kinds: KINDS, scopes: SCOPES });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault'), { connectionString: registered.codeWithSecret });
  expect(pasted.body.stage).toBe('connected');
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

describe('choosing “sent, no local copy” (ADR-0054 §1, §6)', () => {
  it('is offered now, and files the vault had already filed keep their copy until a move', async () => {
    // Filed while receipts kept a copy.
    const before = await filed('Filed before.png');
    expect(await fileRow(before.id)).toMatchObject({ location: 'montra', storage_key: before.key });

    const saved = await setMode('sent_no_copy');
    expect(saved.groups.find((g: any) => g.group === 'receipts')).toMatchObject({ mode: 'sent_no_copy' });
    const log = (
      await db.query(
        `select detail from app.security_event where workspace_id = $1 and kind = 'vault_changed'
          order by at desc limit 1`,
        [wsId],
      )
    ).rows[0].detail;
    expect(log.groups).toEqual([
      { group: 'receipts', mode: 'sent_no_copy', vaultKind: 'utility_bill', unkept: 'dont_send' },
    ]);

    await run();
    expect(await fileRow(before.id)).toMatchObject({ location: 'montra', storage_key: before.key });
    expect(await exists(before.key)).toBe(true);
  });
});

describe('Montra removes its copy only when all four hold (ADR-0054 §5)', () => {
  it('never while the document is only in someone’s Inbox', async () => {
    const s = await sent('Inbox only.png');
    await dueNow();
    await run();
    expect((await item(s.id)).status).toBe('received');
    expect(await fileRow(s.id)).toMatchObject({ location: 'montra', storage_key: s.key });
    expect(await exists(s.key)).toBe(true);
  });

  it('not until the vault says it could give the exact file back, asked again before removing', async () => {
    const was = app().scopes;
    app().scopes = was.filter((x: string) => x !== 'documents.download');
    let f: Awaited<ReturnType<typeof filed>>;
    try {
      f = await filed('Not downloadable.png');
      const i = await item(f.id);
      expect(i).toMatchObject({ status: 'filed', content_available: false });
      expect(await fileRow(f.id)).toMatchObject({ location: 'montra', storage_key: f.key });
      // Looked at again later, not on every run.
      expect(new Date(i.remove_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    } finally {
      app().scopes = was;
    }
    // The vault now could: asked again, it says so, and the copy goes.
    await removeNow(f.id);
    await run();
    expect(await item(f.id)).toMatchObject({ content_available: true, source_key: f.key });
    expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
  });

  it('not while Montra is reading the file or a person has it in Review', async () => {
    const s = await sent('In review.png');
    const receipt = await receiptFor(s.id, 'needs_review');
    fileInVault(s.ref, 'In review.png');
    await dueNow();
    await run();
    expect((await item(s.id)).status).toBe('filed');
    expect(await fileRow(s.id)).toMatchObject({ location: 'montra', storage_key: s.key });
    // Reviewed: nothing reads it now.
    await db.query(`update app.receipt set status = 'inbox' where id = $1`, [receipt]);
    await removeNow(s.id);
    await run();
    expect(await fileRow(s.id)).toMatchObject({ location: 'vault', storage_key: null });
  });

  it('not until the owner’s own storage has its copy when it copies that kind, which never fetches from the vault', async () => {
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
      // Settings says the owner's storage still keeps a copy of a group sent without one.
      expect((await connection()).mirrorGroups).toContain('receipts');
      const f = await filed('Mirrored.png');
      expect((await item(f.id)).status).toBe('filed');
      expect(await fileRow(f.id)).toMatchObject({ location: 'montra', storage_key: f.key });
      // The mirror copies it from Montra's copy; then Montra's copy goes.
      await mirror.run();
      expect(
        (await db.query(`select status from app.storage_mirror_item where file_id = $1`, [f.id])).rows[0]
          .status,
      ).toBe('done');
      await removeNow(f.id);
      await run();
      expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
      // Read back from the owner's storage before the vault.
      const calls = contentCalls();
      const got = await files.readById(ctx(), f.id);
      expect(got.ok && got.from).toBe('mirror');
      // The mirror's own job never asks the vault for a file only the vault holds, just to copy it.
      await db.query(
        `update app.storage_mirror_item set status = 'pending', next_attempt_at = now() where file_id = $1`,
        [f.id],
      );
      await db.query(`update app.file set location = 'vault' where id = $1`, [f.id]);
      s3.objects.clear();
      await mirror.run();
      expect(contentCalls()).toBe(calls);
      expect(
        (await db.query(`select status from app.storage_mirror_item where file_id = $1`, [f.id])).rows[0]
          .status,
      ).toBe('skipped');
    } finally {
      await c.delete(url('/storage-destination'));
    }
  });

  it('not while the connection isn’t active, and without spinning the worker meanwhile', async () => {
    const s = await sent('Failing.png');
    // Filed while a person still has it in Review, so the run that files it keeps the copy.
    const receipt = await receiptFor(s.id, 'needs_review');
    fileInVault(s.ref, 'Failing.png');
    try {
      // A failing connection's own check, at the start of a run, would turn it active again: so the step alone, as a
      // run would take it with the connection failing.
      const vault = h.app.get(VaultService);
      const row = (
        await db.query(`select * from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [
          wsId,
        ])
      ).rows[0];
      await dueNow();
      await run();
      expect((await item(s.id)).status).toBe('filed');
      expect(await fileRow(s.id)).toMatchObject({ location: 'montra', storage_key: s.key });
      await db.query(`update app.receipt set status = 'inbox' where id = $1`, [receipt]);
      await db.query(`update app.storage_destination set status = 'failing' where id = $1`, [row.id]);
      await removeNow(s.id);
      const conn = await vault.openRow(ctx(), row);
      try {
        await (jobs as any).removeSources(
          ctx(),
          { ...row, status: 'failing' },
          configOf(row),
          conn,
          Date.now() + 30_000,
          {
            moved: 0,
          },
        );
      } finally {
        conn.close();
      }
      const i = await item(s.id);
      expect(i.status).toBe('filed');
      expect(await fileRow(s.id)).toMatchObject({ location: 'montra', storage_key: s.key });
      expect(new Date(i.remove_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    } finally {
      await db.query(
        `update app.storage_destination set status = 'active', consecutive_failures = 0
          where workspace_id = $1 and kind = 'fdv'`,
        [wsId],
      );
    }
    await removeNow(s.id);
    await run();
    expect(await fileRow(s.id)).toMatchObject({ location: 'vault', storage_key: null });
  });

  it('when all hold: moves it in one step with an audit row, then deletes the object', async () => {
    const usedBefore = BigInt((await c.get(url('/storage'))).body.usedBytes);
    const f = await onlyInVault('Moved.png');
    expect(await exists(f.key)).toBe(false);
    const i = await item(f.id);
    expect(i).toMatchObject({ status: 'filed', source_key: f.key, remove_at: null });
    expect(i.source_removed_at).not.toBeNull();
    expect(await moves(f.id)).toBe(1);
    const audit = (
      await db.query(`select * from app.audit_log where subject_id = $1 and action = 'file.moved_to_vault'`, [
        f.id,
      ])
    ).rows[0];
    expect(audit).toMatchObject({ actor_type: 'system', subject_type: 'file' });
    expect(audit.diff).toMatchObject({ vaultDocumentId: f.doc });
    // BAK-08: a file held only in the vault takes no room in Montra's storage.
    expect(BigInt((await c.get(url('/storage'))).body.usedBytes)).toBe(usedBefore);
    expect((await connection()).files.onlyInVault).toBeGreaterThanOrEqual(1);
    // The badge says where it is; anyone who can see the file sees it.
    const badge = (await partner.get(url(`/family-vault/files?ids=${f.id}`))).body.data[0];
    expect(badge).toMatchObject({ location: 'vault', missing: null, vault: { status: 'filed' } });
    // Read back from the vault, every byte as it was.
    const got = await files.readById(ctx(), f.id);
    expect(got.ok && got.from).toBe('vault');
    expect(got.ok && Buffer.from(got.bytes).equals(f.bytes)).toBe(true);
  });

  it('a crash between the commit and the delete is finished by the next run, and running again changes nothing', async () => {
    const s = await sent('Crash.png');
    fileInVault(s.ref, 'Crash.png');
    await dueNow();
    const del = vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('crashed'));
    await run();
    expect(del).toHaveBeenCalledWith(s.key);
    // Committed: the vault is the record, the object is still to remove, and the file is readable meanwhile.
    expect(await fileRow(s.id)).toMatchObject({ location: 'vault', storage_key: null });
    expect(await item(s.id)).toMatchObject({ source_key: s.key, source_removed_at: null });
    expect(await exists(s.key)).toBe(true);
    const due = (await db.query(`select * from app.vault_due() where workspace_id = $1`, [wsId])).rows;
    expect(due).toHaveLength(1);

    await run();
    expect(await exists(s.key)).toBe(false);
    const after = await item(s.id);
    expect(after.source_removed_at).not.toBeNull();
    await run();
    expect(await item(s.id)).toMatchObject({ source_key: s.key, source_removed_at: after.source_removed_at });
    expect(await moves(s.id)).toBe(1);
  });

  it('a file put back to be read again loses its copy again once nothing reads it', async () => {
    const f = await onlyInVault('Read again.png');
    const key = (await files.ensureHeld(ctx(), [f.id])).get(f.id)!;
    expect(await fileRow(f.id)).toMatchObject({ location: 'montra', storage_key: key });
    // Looked at again a while later, by when whatever reads it has its record (and is waited for while it reads).
    expect(new Date((await item(f.id)).remove_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    await run();
    expect(await fileRow(f.id)).toMatchObject({ location: 'montra', storage_key: key });
    await removeNow(f.id);
    await run();
    expect(await fileRow(f.id)).toMatchObject({ location: 'vault', storage_key: null });
    expect(await exists(key)).toBe(false);
    expect(await item(f.id)).toMatchObject({ source_key: key });
    expect(await moves(f.id)).toBe(2);
  });
});

describe('files the vault doesn’t give back (ADR-0054 §5a)', () => {
  it('a refusal makes the file missing, listed in Review with what uses it, and tells people once a day', async () => {
    const f = await onlyInVault('Refused.png');
    await receiptFor(f.id);
    docOf(f.doc).visibility = 'private';
    try {
      const got = await files.readById(ctx(), f.id);
      expect(got).toMatchObject({ ok: false, reason: 'vault_refused' });
    } finally {
      docOf(f.doc).visibility = 'household';
    }
    const row = await fileRow(f.id);
    expect(row.missing_since).not.toBeNull();
    expect(row.missing_reason).toBe(MISSING_WORDS.refused);
    expect(
      (
        await db.query(
          `select count(*) from app.audit_log where subject_id = $1 and action = 'file.marked_missing'`,
          [f.id],
        )
      ).rows[0].count,
    ).toBe(1n);

    const list = (await c.get(url('/missing-files'))).body.data;
    expect(list.find((x: any) => x.fileId === f.id)).toMatchObject({
      fileName: 'Refused.png',
      group: 'receipts',
      reason: MISSING_WORDS.refused,
      usedBy: [{ kind: 'receipt', label: 'Grocer · 2026-03-14' }],
    });
    // A partner who didn't upload it doesn't see it: owners and admins, and whoever uploaded it, do.
    expect((await partner.get(url('/missing-files'))).body.data).toEqual([]);
    // The badges and Settings count it.
    const badge = (await c.get(url(`/family-vault/files?ids=${f.id}`))).body.data[0];
    expect(badge.missing).toMatchObject({ reason: MISSING_WORDS.refused });
    expect((await connection()).files.missing).toBeGreaterThanOrEqual(1);

    // One notification today, with no file name, for the owner (the partner is neither an admin nor the uploader).
    const sentToday = await notifications('files_missing');
    expect(sentToday).toHaveLength(1);
    expect(sentToday[0]).toMatchObject({ user_id: ownerId, link: `/w/${wsId}/review#files-to-provide` });
    expect(`${sentToday[0].title} ${sentToday[0].body}`).not.toContain('Refused');

    // Another refusal the same day: listed, but nobody is told twice.
    const other = await onlyInVault('Refused too.png');
    docOf(other.doc).visibility = 'private';
    try {
      await files.readById(ctx(), other.id);
      await files.readById(ctx(), other.id);
    } finally {
      docOf(other.doc).visibility = 'household';
    }
    expect((await fileRow(other.id)).missing_since).not.toBeNull();
    expect(await notifications('files_missing')).toHaveLength(1);
    expect((await c.get(url('/missing-files'))).body.data.map((x: any) => x.fileId)).toEqual(
      expect.arrayContaining([f.id, other.id]),
    );
  });

  it('a document the vault no longer shows makes a file only it held missing, and shown again it isn’t', async () => {
    const f = await onlyInVault('Out of reach.png');
    await feedDue();
    await run();
    docOf(f.doc).visibility = 'private';
    try {
      await feedDue();
      await run();
      expect((await item(f.id)).status).toBe('out_of_reach');
      expect(await fileRow(f.id)).toMatchObject({ missing_reason: MISSING_WORDS.outOfReach });
      // Read now: still missing, never asked of the vault.
      const calls = contentCalls();
      expect(await files.readById(ctx(), f.id)).toMatchObject({ ok: false, reason: 'vault_refused' });
      expect(contentCalls()).toBe(calls);
    } finally {
      docOf(f.doc).visibility = 'household';
    }
    await feedDue();
    await run();
    expect((await item(f.id)).status).toBe('filed');
    expect(await fileRow(f.id)).toMatchObject({
      missing_since: null,
      missing_reason: null,
      location: 'vault',
    });
  });

  it('a file Montra still holds is never missing, even when its object is lost and the vault says no', async () => {
    await setMode('sent_keep_copy');
    try {
      const kept = await filed('Kept copy.png');
      expect(await fileRow(kept.id)).toMatchObject({ location: 'montra', storage_key: kept.key });
      await storage.delete(kept.key);
      docOf(kept.doc).visibility = 'private';
      try {
        expect(await files.readById(ctx(), kept.id)).toMatchObject({ ok: false, reason: 'vault_refused' });
      } finally {
        docOf(kept.doc).visibility = 'household';
      }
      expect((await fileRow(kept.id)).missing_since).toBeNull();
    } finally {
      await setMode('sent_no_copy');
    }
  });
});

describe('providing a file again (ADR-0054 §5a)', () => {
  async function missing(name: string) {
    const f = await onlyInVault(name);
    await db.query(`update app.file set missing_since = now(), missing_reason = $2 where id = $1`, [
      f.id,
      MISSING_WORDS.refused,
    ]);
    return f;
  }

  it('stores it under the same id, clears the mark, and sends it again as a new send', async () => {
    const f = await missing('Provided.png');
    const oldRef = (await item(f.id)).vault_ref;
    const usedBefore = BigInt((await c.get(url('/storage'))).body.usedBytes);
    const res = await provide(f.id, f.bytes);
    expect(res).toMatchObject({
      status: 200,
      body: { fileId: f.id, location: 'montra', hashChanged: false, queuedForVault: true },
    });
    const row = await fileRow(f.id);
    expect(row).toMatchObject({
      location: 'montra',
      missing_since: null,
      missing_reason: null,
      sha256: sha256(f.bytes),
      replaced_sha256: null,
    });
    expect(row.storage_key).toMatch(new RegExp(`^${wsId}/receipt/\\d{4}/${f.id}-[0-9a-f]{8}$`));
    expect(Buffer.from(await storage.get(row.storage_key)).equals(f.bytes)).toBe(true);
    // A new send: a new row, so a new id in the vault.
    expect(await item(f.id)).toMatchObject({ status: 'queued', vault_ref: null, source_key: null });
    await run();
    const again = await item(f.id);
    expect(again.vault_ref).not.toBe(oldRef);
    expect(
      (
        await db.query(
          `select diff from app.audit_log where subject_id = $1 and action = 'file.provided_again'`,
          [f.id],
        )
      ).rows[0].diff,
    ).toEqual({ hashChanged: false });
    expect((await c.get(url('/missing-files'))).body.data.map((x: any) => x.fileId)).not.toContain(f.id);
    // It counts against the quota again.
    expect(BigInt((await c.get(url('/storage'))).body.usedBytes)).toBe(usedBefore + BigInt(f.bytes.length));
  });

  it('accepts a different file, noting the hash it replaced', async () => {
    const f = await missing('Rescanned.png');
    const rescan = Buffer.concat([PNG, Buffer.from('a fresh scan of the same paper'), ALL_BYTES]);
    const res = await provide(f.id, rescan);
    expect(res.body).toMatchObject({ hashChanged: true });
    expect(await fileRow(f.id)).toMatchObject({
      sha256: sha256(rescan),
      replaced_sha256: sha256(f.bytes),
      bytes: BigInt(rescan.length),
    });
  });

  it('only for an owner or admin, or whoever uploaded it; only a missing file; only a paper', async () => {
    const f = await missing('Guarded.png');
    expect((await provide(f.id, f.bytes, PARTNER)).status).toBe(403);
    expect((await provide(f.id, Buffer.from('not a paper'))).status).toBe(415);
    expect((await provide(f.id, f.bytes)).status).toBe(200);
    expect((await provide(f.id, f.bytes)).body.code).toBe('file.not_missing');
    expect((await provide(randomUUID(), f.bytes)).status).toBe(404);
  });
});

// Disconnecting while files are kept only in the vault is a choice from PR 5b2: family-vault-move-back.test.ts.
