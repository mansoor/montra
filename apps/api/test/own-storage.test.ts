/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '../src/data/backup.service.js';
import { Worker } from '../src/jobs/queue.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import {
  assertAllowedUrl,
  checkDestination,
  cleanName,
  DestinationError,
  filePath,
  isBlockedAddress,
  openDestination,
} from '../src/storage/destinations/index.js';
import { guardedLookup } from '../src/storage/destinations/guard.js';
import { backupPath, defaultFolder, shortId, splitName } from '../src/storage/destinations/paths.js';
import { FAILING_AFTER, MAX_ATTEMPTS, StorageMirrorJobs } from '../src/storage/storage-mirror.jobs.js';
import { ADMIN_URL } from './env.js';
import { fakeS3, fakeWebDav, type FakeServer } from './fakes/storage-servers.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Your own storage for files and backups (BAK-03, BAK-05; ADR-0031), against in-process S3 and WebDAV servers.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-storage@example.com';
const PARTNER = 'partner-storage@example.com';
const DAV_OWNER = 'dav-storage@example.com';
const KEY = 'AKIATESTKEY0001';
const SECRET = 'super-secret-access-key-value';
const DAV_PASSWORD = 'dav app password 1';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/iZvQWQAAAABJRU5ErkJggg==',
  'base64',
);

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let worker: Worker;
let mirror: StorageMirrorJobs;
let s3: FakeServer;
let dav: FakeServer;
let wsId: string;
let url: (p: string) => string;

const s3Connection = (over: Record<string, unknown> = {}, secret: Record<string, unknown> = {}) => ({
  kind: 's3',
  s3: { endpoint: s3.url, region: 'us-east-1', bucket: 'family-files', pathStyle: true, ...over },
  secret: { accessKeyId: KEY, secretAccessKey: SECRET, ...secret },
});

async function upload(email: string, workspace: string, bytes: Buffer, fileName: string) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspace}/receipts/files`,
    headers: {
      authorization: `Bearer dev:${email}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).fileId as string;
}

const item = async (fileId: string) =>
  (await admin.query(`select * from app.storage_mirror_item where file_id = $1`, [fileId])).rows[0];
const dueNow = () =>
  admin.query(`update app.storage_mirror_item set next_attempt_at = now() - interval '1 second'`);
const destination = async () =>
  (await admin.query(`select * from app.storage_destination where workspace_id = $1`, [wsId])).rows[0];
const keysIn = (fake: FakeServer, prefix: string) =>
  [...fake.objects.keys()].filter((k) => k.startsWith(prefix));

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(BackupService).register();
  mirror = h.app.get(StorageMirrorJobs);
  mirror.register();
  worker = h.app.get(Worker);
  c = h.as(OWNER);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  s3 = await fakeS3({ buckets: ['family-files'], accessKeyId: KEY });
  dav = await fakeWebDav({ username: 'sam', password: DAV_PASSWORD });
  const ws = (
    await c.post('/v1/workspaces', { name: 'Storage test', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});

afterAll(async () => {
  // Nothing of ours may wake a worker in another test file.
  await admin.query(`delete from app.storage_destination where workspace_id in (
    select id from app.workspace where name in ('Storage test', 'Dav test'))`);
  await admin.query(`delete from app.job where type = 'storage.mirror'`);
  await admin.end();
  await s3.close();
  await dav.close();
  await h.close();
});

describe('names and folders (ADR-0031 §4)', () => {
  it('files copies by kind and year, with a readable name that traces back to Montra', () => {
    const p = filePath('Montra/Smith household', {
      id: '019a7c3e-0000-7000-8000-00009c41d07e',
      kind: 'receipt',
      file_name: 'Costco receipt.JPG',
      mime: 'image/jpeg',
      created_at: new Date('2026-11-10T22:00:00Z'),
    });
    expect(p).toBe('Montra/Smith household/receipts/2026/2026-11-10 Costco receipt (9c41d07e).jpg');
    expect(
      backupPath(
        'Montra/Smith household',
        'Smith household-backup-2026-11-10.montra',
        '019a7c3e-aaaa-7bbb-8ccc-0000005b2f81',
      ),
    ).toBe('Montra/Smith household/backups/Smith household-backup-2026-11-10 (005b2f81).montra');
  });

  it('cleans names every desktop and S3 can hold', () => {
    expect(cleanName('a/b\\c:d*e?f"g<h>i|j\u0001k')).toBe('a b c d e f g h i j k');
    expect(cleanName('  trailing dots... ')).toBe('trailing dots');
    expect(cleanName('CON')).toBe('_CON');
    expect(cleanName('...')).toBe('file');
    expect(cleanName('x'.repeat(300))).toHaveLength(120);
    expect(splitName('scan', 'application/pdf')).toEqual({ stem: 'scan', ext: 'pdf' });
    expect(splitName('statement.csv', 'text/csv')).toEqual({ stem: 'statement', ext: 'csv' });
    expect(defaultFolder('Our: "home"')).toBe('Montra/Our home');
  });
});

describe('where Montra may connect (ADR-0031 §3)', () => {
  const prod = { allowPrivate: false };

  it('refuses private, loopback, link-local and metadata addresses', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.10',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '52.216.0.1', '2606:4700::1111']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('wants https and a public name in production', () => {
    expect(() => assertAllowedUrl(new URL('http://s3.example.com'), prod)).toThrow(DestinationError);
    expect(() => assertAllowedUrl(new URL('https://localhost:9000'), prod)).toThrow(DestinationError);
    expect(() => assertAllowedUrl(new URL('https://169.254.169.254/latest'), prod)).toThrow(DestinationError);
    expect(() => assertAllowedUrl(new URL('https://[::1]/'), prod)).toThrow(DestinationError);
    expect(() => assertAllowedUrl(new URL('https://s3.us-west-004.backblazeb2.com'), prod)).not.toThrow();
    expect(() => assertAllowedUrl(new URL('http://nas.local:5005'), { allowPrivate: true })).not.toThrow();
  });

  it('checks the address a name resolves to, as the connection is made', async () => {
    const result = await new Promise<{ err: unknown }>((resolve) =>
      guardedLookup('localhost', {}, (err) => resolve({ err })),
    );
    expect(result.err).toBeInstanceOf(DestinationError);
    expect((result.err as DestinationError).code).toBe('not_allowed_host');
  });

  it('refuses the fake servers themselves when private addresses aren’t allowed', async () => {
    expect(() =>
      openDestination(
        'webdav',
        { url: dav.url.replace('http:', 'https:'), username: 'sam' },
        { password: 'x' },
        prod,
      ),
    ).toThrow(expect.objectContaining({ code: 'not_allowed_host' }));
    expect(() =>
      openDestination('webdav', { url: dav.url, username: 'sam' }, { password: 'x' }, prod),
    ).toThrow(expect.objectContaining({ code: 'not_allowed_host' }));
    // Allowed here (tests allow private addresses), the same server answers.
    const dest = openDestination(
      'webdav',
      { url: dav.url, username: 'sam' },
      { password: DAV_PASSWORD },
      { allowPrivate: true },
    );
    await expect(checkDestination(dest, 'Montra/check')).resolves.toEqual({ canDelete: true });
    dest.close();
  });
});

describe('connecting S3-compatible storage (ADR-0031 §2, §3)', () => {
  it('is for owners only', async () => {
    expect((await partner.get(url('/storage-destination'))).status).toBe(403);
    expect(
      (await partner.post(url('/storage-destination'), { label: 'x', connection: s3Connection() })).status,
    ).toBe(403);
    expect((await c.get(url('/storage-destination'))).body.destination).toBeNull();
  });

  it('tests before saving, and says what’s wrong in words a person can act on', async () => {
    const wrongKey = await c.post(url('/storage-destination/test'), {
      connection: s3Connection({}, { accessKeyId: 'AKIAWRONG' }),
    });
    expect(wrongKey.body).toMatchObject({ ok: false, code: 'refused' });
    expect(wrongKey.body.error).toMatch(/refused/);
    const wrongBucket = await c.post(url('/storage-destination/test'), {
      connection: s3Connection({ bucket: 'nope-bucket' }),
    });
    expect(wrongBucket.body).toMatchObject({ ok: false, code: 'not_found' });
    const refused = await c.post(url('/storage-destination'), {
      label: 'Backblaze',
      connection: s3Connection({}, { secretAccessKey: SECRET, accessKeyId: 'AKIAWRONG' }),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('storage.refused');
    expect(await destination()).toBeUndefined();
  });

  it('copies a file that was there before, and seals the secret so it never comes back', async () => {
    const before = await upload(OWNER, wsId, PNG, 'Corner shop.png');
    const res = await c.post(url('/storage-destination'), { label: 'Backblaze', connection: s3Connection() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 's3',
      label: 'Backblaze',
      folder: 'Montra/Storage test',
      canDelete: true,
      status: 'active',
      s3: { bucket: 'family-files', pathStyle: true, accessKeyHint: '0001' },
      files: { pending: 1, done: 0 },
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify((await c.get(url('/storage-destination'))).body.destination)).not.toContain(SECRET);
    const row = await destination();
    expect(row.secret_enc.toString('latin1')).not.toContain(SECRET);
    expect(JSON.stringify(row.config)).not.toContain(SECRET);
    // The check wrote a file and took it away again.
    expect(s3.log).toContain('PUT family-files/Montra/Storage test/.montra-connection-check');
    expect(s3.log).toContain('DELETE family-files/Montra/Storage test/.montra-connection-check');
    // Connecting asked a worker to look, through NOTIFY.
    expect(
      (await admin.query(`select 1 from app.job where type = 'storage.mirror' and status = 'queued'`))
        .rowCount,
    ).toBe(1);

    await mirror.run();
    const copied = await item(before);
    expect(copied).toMatchObject({ status: 'done', attempts: 1 });
    const year = new Date().getUTCFullYear();
    expect(copied.remote_path).toMatch(
      new RegExp(
        `^Montra/Storage test/receipts/${year}/\\d{4}-\\d{2}-\\d{2} Corner shop \\(${shortId(before)}\\)\\.png$`,
      ),
    );
    expect(s3.objects.get(`family-files/${copied.remote_path}`)).toEqual(PNG);
    expect((await c.get(url('/storage-destination'))).body.destination).toMatchObject({
      files: { pending: 0, done: 1 },
    });
    expect((await destination()).last_success_at).not.toBeNull();
  });

  it('copies what anyone uploads afterwards, though only owners can see the connection', async () => {
    const fileId = await upload(PARTNER, wsId, PNG, 'Partner lunch.png');
    expect((await item(fileId)).status).toBe('pending');
    await mirror.run();
    expect((await item(fileId)).status).toBe('done');
    const done = (await c.get(url('/storage-destination/items?status=done'))).body.data;
    expect(done.map((d: any) => d.fileName)).toContain('Partner lunch.png');
  });

  it('leaves out a sealed copy of an identity document, which the owner couldn’t open there', async () => {
    const f = await admin.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, sealed)
       values ($1, 'other', $2, 'id.png', 'application/octet-stream', 1, repeat('0', 64), true) returning id`,
      [wsId, `${wsId}/other/sealed-id`],
    );
    expect(await item(f.rows[0].id)).toBeUndefined();
  });

  it('retries with backoff, shows failing after five failures in a row, and recovers', async () => {
    const mail = h.app.get(MAIL_PORT) as MemoryMail;
    // Whatever the time of day this runs, nothing is held for quiet hours.
    await c.patch('/v1/me/notification-prefs', { quietStart: null, quietEnd: null });
    s3.failWith = 403;
    const fileId = await upload(OWNER, wsId, PNG, 'While it was down.png');
    for (let i = 1; i <= FAILING_AFTER; i++) {
      await dueNow();
      await mirror.run();
      const row = await item(fileId);
      expect(row).toMatchObject({ status: 'pending', attempts: i });
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    }
    const dest = (await c.get(url('/storage-destination'))).body.destination;
    expect(dest).toMatchObject({ status: 'failing', files: { pending: 1 } });
    expect(dest.lastError).toMatch(/refused/);
    const told = await admin.query(
      `select title from app.notification where workspace_id = $1 and type = 'storage_failing'`,
      [wsId],
    );
    expect(told.rows).toHaveLength(1); // the owner only, and once
    mail.outbox.length = 0;
    await h.app.get(NotificationsService).deliverWaiting();
    expect(mail.outbox.some((m) => m.subject.startsWith('Montra can’t save copies to Backblaze'))).toBe(true);

    s3.failWith = null;
    await dueNow();
    await mirror.run();
    expect((await item(fileId)).status).toBe('done');
    expect((await destination()).status).toBe('active');
    expect((await destination()).consecutive_failures).toBe(0);
  });

  it('gives up after its attempts, until the owner tries again', async () => {
    s3.failWith = 500;
    const fileId = await upload(OWNER, wsId, PNG, 'Gives up.png');
    await admin.query(`update app.storage_mirror_item set attempts = $2 where file_id = $1`, [
      fileId,
      MAX_ATTEMPTS - 1,
    ]);
    await mirror.run();
    expect(await item(fileId)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect((await c.get(url('/storage-destination/items?status=failed'))).body.data[0]).toMatchObject({
      fileId,
      fileName: 'Gives up.png',
    });
    s3.failWith = null;
    expect((await c.post(url('/storage-destination/retry'))).body.queued).toBe(1);
    await mirror.run();
    expect((await item(fileId)).status).toBe('done');
  });

  it('skips a file in the trash, and copies it once it’s restored', async () => {
    const fileId = await upload(OWNER, wsId, PNG, 'Binned.png');
    await admin.query(`update app.file set deleted_at = now() where id = $1`, [fileId]);
    await mirror.run();
    expect((await item(fileId)).status).toBe('skipped');
    await admin.query(`update app.file set deleted_at = null where id = $1`, [fileId]);
    expect((await item(fileId)).status).toBe('pending');
    await mirror.run();
    expect((await item(fileId)).status).toBe('done');
  });
});

describe('when Montra deletes a file for good (ADR-0031 §6)', () => {
  it('keeps your copy by default', async () => {
    const fileId = await upload(OWNER, wsId, PNG, 'Kept.png');
    await mirror.run();
    const path = (await item(fileId)).remote_path;
    await admin.query(`select app.purge_file($1, $2)`, [wsId, fileId]);
    expect(await item(fileId)).toBeUndefined();
    await mirror.run();
    expect(s3.objects.has(`family-files/${path}`)).toBe(true);
  });

  it('deletes your copy too when you asked for that', async () => {
    const current = (await c.get(url('/storage-destination'))).body.destination;
    const changed = await c.patch(url('/storage-destination'), {
      version: current.version,
      deleteWithMontra: true,
    });
    expect(changed.status).toBe(200);
    const fileId = await upload(OWNER, wsId, PNG, 'Gone.png');
    await mirror.run();
    const path = (await item(fileId)).remote_path;
    expect(s3.objects.has(`family-files/${path}`)).toBe(true);
    await admin.query(`select app.purge_file($1, $2)`, [wsId, fileId]);
    expect((await item(fileId)).status).toBe('delete');
    await mirror.run();
    expect(s3.objects.has(`family-files/${path}`)).toBe(false);
    expect(await item(fileId)).toBeUndefined();
    const again = (await c.get(url('/storage-destination'))).body.destination;
    await c.patch(url('/storage-destination'), { version: again.version, deleteWithMontra: false });
  });
});

describe('backups to your storage (ADR-0031 §7)', () => {
  const drain = () => worker.drain(['report'], 20);

  beforeEach(async () => {
    await admin.query(`update app.notification set read_at = now() where workspace_id = $1`, [wsId]);
  });

  it('saves "Back up now" there as well, and keeps only the newest ones it wrote', async () => {
    const current = (await c.get(url('/storage-destination'))).body.destination;
    await c.patch(url('/storage-destination'), { version: current.version, keepBackups: 1 });
    const first = await c.post(url('/backups'), {});
    expect(first.status).toBe(201);
    await drain();
    await mirror.run();
    const one = (await c.get(url(`/backups/${first.body.id}`))).body;
    expect(one.storageCopy).toMatchObject({ status: 'done' });
    expect(one.storageCopy.path).toMatch(/^Montra\/Storage test\/backups\/Storage test-backup-.+\.zip$/);
    const download = await h.app.inject({
      method: 'GET',
      url: url(`/backups/${first.body.id}/download`),
      headers: { authorization: `Bearer dev:${OWNER}` },
    });
    expect(s3.objects.get(`family-files/${one.storageCopy.path}`)).toEqual(download.rawPayload);

    const second = await c.post(url('/backups'), {});
    await drain();
    await mirror.run();
    const two = (await c.get(url(`/backups/${second.body.id}`))).body;
    expect(two.storageCopy.status).toBe('done');
    expect((await c.get(url(`/backups/${first.body.id}`))).body.storageCopy.status).toBe('pruned');
    expect(s3.objects.has(`family-files/${one.storageCopy.path}`)).toBe(false);
    expect(s3.objects.has(`family-files/${two.storageCopy.path}`)).toBe(true);

    const notSaved = await c.post(url('/backups'), { saveToStorage: false });
    await drain();
    expect((await c.get(url(`/backups/${notSaved.body.id}`))).body.storageCopy).toBeNull();
  });

  it('lets only owners save there', async () => {
    const entityId = (await partner.get(url('/entities'))).body.data[0].id;
    expect((await partner.post(url('/backups'), { entityId, saveToStorage: true })).status).toBe(403);
    const own = await partner.post(url('/backups'), { entityId });
    expect(own.status).toBe(201);
    expect(own.body.storageCopy).toBeNull();
  });

  it('runs a scheduled backup with a password there, and never keeps the password', async () => {
    const PASSWORD = 'correct horse battery staple';
    const saved = await c.put(url('/backup-schedule'), {
      cadence: 'monthly',
      destination: 'storage',
      password: PASSWORD,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ cadence: 'monthly', destination: 'storage', encrypted: true });
    const kept = await admin.query(
      `select wrapped_key, kdf from app.backup_schedule where workspace_id = $1`,
      [wsId],
    );
    expect(kept.rows[0].wrapped_key).not.toBeNull();
    expect(kept.rows[0].wrapped_key.toString('latin1')).not.toContain(PASSWORD);
    // Changing something else keeps the password.
    expect(
      (await c.put(url('/backup-schedule'), { cadence: 'weekly', destination: 'storage' })).body.encrypted,
    ).toBe(true);

    await admin.query(`update app.backup_schedule set next_run_on = current_date where workspace_id = $1`, [
      wsId,
    ]);
    expect(await h.app.get(BackupService).runSchedules()).toBe(1);
    const payload = await admin.query(
      `select payload::text as p from app.job where type = 'data.backup' order by created_at desc limit 1`,
    );
    expect(payload.rows[0].p).not.toContain(PASSWORD);
    await drain();
    await mirror.run();
    const job = (await c.get(url('/backups'))).body.data[0];
    expect(job).toMatchObject({ encrypted: true, storageCopy: { status: 'done' } });
    expect(job.storageCopy.path).toMatch(/\.montra$/);
    const bytes = s3.objects.get(`family-files/${job.storageCopy.path}`)!;
    expect(bytes.subarray(0, 10).toString()).toBe('MONTRABK1\n');
    const told = await admin.query(
      `select title, link from app.notification where workspace_id = $1 and type = 'backup_ready' and read_at is null`,
      [wsId],
    );
    expect(told.rows).toEqual([
      { title: 'Your scheduled backup is saved to Backblaze', link: `/w/${wsId}/settings?tab=storage` },
    ]);

    expect(
      (await c.put(url('/backup-schedule'), { cadence: 'weekly', destination: 'email_link', password: null }))
        .body,
    ).toMatchObject({
      destination: 'email_link',
      encrypted: false,
    });
    expect((await c.delete(url('/backup-schedule'))).status).toBe(204);
  });

  it('tells a schedule’s owner when the backup couldn’t be saved there', async () => {
    await c.put(url('/backup-schedule'), { cadence: 'weekly', destination: 'storage' });
    await admin.query(`update app.backup_schedule set next_run_on = current_date where workspace_id = $1`, [
      wsId,
    ]);
    await h.app.get(BackupService).runSchedules();
    await drain();
    s3.failWith = 500;
    await admin.query(
      `update app.export_job set destination_attempts = $2 where workspace_id = $1 and destination_status = 'pending'`,
      [wsId, MAX_ATTEMPTS - 1],
    );
    await mirror.run();
    s3.failWith = null;
    const job = (await c.get(url('/backups'))).body.data[0];
    expect(job.storageCopy.status).toBe('failed');
    const told = await admin.query(
      `select title from app.notification where workspace_id = $1 and type = 'backup_ready' and read_at is null`,
      [wsId],
    );
    expect(told.rows).toEqual([{ title: 'Your scheduled backup couldn’t be saved to Backblaze' }]);
    // Its download is still there, so trying again can still save it.
    expect((await c.post(url('/storage-destination/retry'))).body.queued).toBe(1);
    await mirror.run();
    expect((await c.get(url(`/backups/${job.id}`))).body.storageCopy.status).toBe('done');
    await c.delete(url('/backup-schedule'));
  });
});

describe('changing and disconnecting (ADR-0031 §3, §6)', () => {
  it('re-tests a changed connection with the stored secret, and refuses a stale version', async () => {
    const current = (await c.get(url('/storage-destination'))).body.destination;
    expect(
      (await c.patch(url('/storage-destination'), { version: current.version - 1, label: 'x' })).status,
    ).toBe(409);
    const moved = await c.patch(url('/storage-destination'), {
      version: current.version,
      folder: 'Backups/Montra',
      connection: {
        kind: 's3',
        s3: { endpoint: s3.url, region: 'us-east-1', bucket: 'family-files', pathStyle: true },
      },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ folder: 'Backups/Montra', s3: { accessKeyHint: '0001' } });
    const bad = await c.patch(url('/storage-destination'), {
      version: moved.body.version,
      connection: s3Connection({ bucket: 'missing-bucket' }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('storage.not_found');
  });

  it('notices when Montra may not delete there, and leaves old backups alone then', async () => {
    s3.refuseDeletes = true;
    const r = await c.post(url('/storage-destination/test'), {
      connection: { kind: 's3', s3: s3Connection().s3 },
    });
    expect(r.body).toMatchObject({ ok: true, canDelete: false });
    s3.refuseDeletes = false;
  });

  it('pauses, and copies what waited once resumed', async () => {
    const current = (await c.get(url('/storage-destination'))).body.destination;
    const paused = await c.patch(url('/storage-destination'), { version: current.version, paused: true });
    expect(paused.body.status).toBe('paused');
    const fileId = await upload(OWNER, wsId, PNG, 'While paused.png');
    expect(await item(fileId)).toBeUndefined();
    await c.patch(url('/storage-destination'), { version: paused.body.version, paused: false });
    expect((await c.post(url('/storage-destination/backfill'))).body.queued).toBe(1);
    await mirror.run();
    expect((await item(fileId)).status).toBe('done');
  });

  it('forgets the connection and its secret, leaves the copies, and logs each change', async () => {
    const copies = keysIn(s3, 'family-files/Montra/Storage test/receipts/').length;
    expect(copies).toBeGreaterThan(0);
    expect((await partner.delete(url('/storage-destination'))).status).toBe(403);
    expect((await c.delete(url('/storage-destination'))).status).toBe(204);
    expect(await destination()).toBeUndefined();
    expect(
      (await admin.query(`select 1 from app.storage_mirror_item where workspace_id = $1`, [wsId])).rowCount,
    ).toBe(0);
    expect(keysIn(s3, 'family-files/Montra/Storage test/receipts/')).toHaveLength(copies);
    const events = await admin.query(
      `select kind from app.security_event where workspace_id = $1 and kind like 'storage_%' order by at`,
      [wsId],
    );
    expect(events.rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['storage_connected', 'storage_changed', 'storage_disconnected']),
    );
    // A new upload has nowhere to go.
    const fileId = await upload(OWNER, wsId, PNG, 'After.png');
    expect(await item(fileId)).toBeUndefined();
  });
});

describe('WebDAV storage (ADR-0031 §2)', () => {
  let dc: Client;
  let davWs: string;
  const durl = (p: string) => `/v1/workspaces/${davWs}${p}`;

  beforeAll(async () => {
    dc = h.as(DAV_OWNER);
    davWs = (
      await dc.post('/v1/workspaces', { name: 'Dav test', baseCurrency: 'USD', template: 'household' })
    ).body.id;
  });

  it('refuses a wrong password', async () => {
    const res = await dc.post(durl('/storage-destination'), {
      label: 'Nextcloud',
      connection: {
        kind: 'webdav',
        webdav: { url: dav.url, username: 'sam' },
        secret: { password: 'wrong' },
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('storage.refused');
  });

  it('makes the folders it needs, copies files, and streams backups', async () => {
    const res = await dc.post(durl('/storage-destination'), {
      label: 'Nextcloud',
      folder: 'Family/Montra',
      fileKinds: ['receipt'],
      connection: {
        kind: 'webdav',
        webdav: { url: dav.url, username: 'sam' },
        secret: { password: DAV_PASSWORD },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'webdav', webdav: { url: dav.url, username: 'sam' }, s3: null });
    expect(JSON.stringify(res.body)).not.toContain(DAV_PASSWORD);
    const fileId = await upload(DAV_OWNER, davWs, PNG, 'Café: brunch?.png');
    await mirror.run();
    const row = await item(fileId);
    expect(row.status).toBe('done');
    expect(row.remote_path).toMatch(
      /^Family\/Montra\/receipts\/\d{4}\/\d{4}-\d{2}-\d{2} Café brunch \(.{8}\)\.png$/,
    );
    expect(dav.objects.get(row.remote_path)).toEqual(PNG);
    expect(dav.log).toContain('MKCOL Family/Montra/receipts');

    const b = await dc.post(durl('/backups'), {});
    await worker.drain(['report'], 20);
    await mirror.run();
    const job = (await dc.get(durl(`/backups/${b.body.id}`))).body;
    expect(job.storageCopy.status).toBe('done');
    expect(dav.objects.get(job.storageCopy.path)!.subarray(0, 2).toString()).toBe('PK');
  });

  it('copies only the kinds it was asked to', async () => {
    const f = await admin.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256)
       values ($1, 'statement', $2, 's.csv', 'text/csv', 1, repeat('0', 64)) returning id`,
      [davWs, `${davWs}/statement/x`],
    );
    expect(await item(f.rows[0].id)).toBeUndefined();
  });

  it('backs off, rather than spinning, when the connection can’t even be opened', async () => {
    await admin.query(
      `update app.storage_destination set config = '{"url": "not a url"}' where workspace_id = $1`,
      [davWs],
    );
    const fileId = await upload(DAV_OWNER, davWs, PNG, 'Unreachable.png');
    await mirror.run();
    const row = await item(fileId);
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    const dest = (await dc.get(durl('/storage-destination'))).body.destination;
    expect(dest.lastError).toBeTruthy();
    expect(dest.webdav.url).toBe('not a url');
  });
});
