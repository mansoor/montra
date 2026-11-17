/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { BackupService } from '../src/data/backup.service.js';
import { RestoreService } from '../src/data/restore.service.js';
import { Worker } from '../src/jobs/queue.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Files go into a backup with the rows that hold them (ADR-0019 §7, PAY-09). A file carries no books or person, so
// row-level security lets every member read its row: a partner's backup of their books, or anyone's of one set of
// books, takes a file only with a payslip, receipt, scan or other record the archive holds.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'bkf-owner@example.test';
const PARTNER = 'bkf-partner@example.test';

let h: Harness;
let db: pg.Client;
let worker: Worker;
let storage: StoragePort;
let owner: Client;
let partner: Client;
let wsId: string;
let url: (p: string) => string;
let personal: string;
let rental: string;
/** File ids: Sam's payslip, the partner's own payslip, the owner's scan of Sam's next one, a receipt of the rental. */
let samFile: string;
let patFile: string;
let scanFile: string;
let rentalFile: string;
let samSlip: string;
let patSlip: string;

const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = (email: string) => ({ authorization: `Bearer dev:${email}` });
const drain = () => worker.drain(['report'], 50);
const userId = async (email: string) =>
  (await db.query(`select id from app.app_user where email = $1`, [email])).rows[0].id as string;

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

/** A backup, made and downloaded: the archive's bytes, its entries and its manifest. */
async function backup(who: Client, email: string, body: object) {
  const created = await who.post(url('/backups'), body);
  expect(created.status).toBe(201);
  await drain();
  expect((await who.get(url(`/backups/${created.body.id}`))).body).toMatchObject({ status: 'ready' });
  const res = await h.app.inject({
    method: 'GET',
    url: url(`/backups/${created.body.id}/download`),
    headers: auth(email),
  });
  expect(res.statusCode).toBe(200);
  const zip = await readZip(res.rawPayload);
  const manifest = JSON.parse(zip.get('manifest.json')!.toString());
  /** The bytes of a file in the archive, or null when it isn't there. */
  const file = (id: string): Buffer | null => {
    const f = manifest.files.find((x: any) => x.id === id);
    return f ? zip.get(f.path)! : null;
  };
  return { bytes: res.rawPayload, zip, manifest, file };
}

/** Restores an archive into a new workspace of whoever uploads it; returns a path maker for that workspace. */
async function restore(bytes: Buffer, email: string, who: Client, name: string) {
  const boundary = '----backup-files';
  const upload = await h.app.inject({
    method: 'POST',
    url: '/v1/me/restores',
    headers: { ...auth(email), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(upload.statusCode).toBe(201);
  const id = JSON.parse(upload.body).id;
  expect((await who.post(`/v1/me/restores/${id}/confirm`, { mode: 'new', name })).status).toBe(200);
  await drain();
  const done = (await who.get(`/v1/me/restores/${id}`)).body;
  expect(done).toMatchObject({ status: 'done', error: null });
  return (p: string) => `/v1/workspaces/${done.targetWorkspaceId}${p}`;
}

/** Uploads a payslip's file as the owner and makes a payslip of it. */
async function payslipWithFile(employerId: string, label: string): Promise<{ id: string; fileId: string }> {
  const boundary = '----payslip-file';
  const res = await h.app.inject({
    method: 'POST',
    url: url('/payslips/files'),
    headers: { ...auth(OWNER), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${label}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf(label),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode).toBe(201);
  const fileId = JSON.parse(res.body).fileId as string;
  const slip = await owner.post(url('/payslips'), { employerId, payDate: '2026-03-31', fileIds: [fileId] });
  expect(slip.status).toBe(201);
  return { id: slip.body.id, fileId };
}

/** A file stored and recorded straight in the database, as a scan or a receipt holds one. */
async function storedFile(kind: string, label: string): Promise<string> {
  const bytes = pdf(label);
  const key = `${wsId}/${kind}/${label}`;
  await storage.put(key, bytes, 'application/pdf');
  return (
    await db.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, uploaded_by)
       values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7) returning id`,
      [wsId, kind, key, `${label}.pdf`, bytes.length, sha(bytes), await userId(OWNER)],
    )
  ).rows[0].id as string;
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(BackupService).register();
  h.app.get(RestoreService).register();
  worker = h.app.get(Worker);
  storage = h.app.get(STORAGE_PORT) as StoragePort;
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as(OWNER);
  partner = h.as(PARTNER);
  wsId = (await owner.post('/v1/workspaces', { name: 'Files', baseCurrency: 'USD', template: 'hybrid' })).body
    .id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  const entities = (await owner.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  rental = entities.find((e: any) => e.type === 'rental').id;
  const checking = (
    await owner.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      entityId: personal,
      openingDate: '2026-01-01',
      openingBalance: { amount: '100000', currency: 'USD' },
    })
  ).body.id;

  // Sam is a member with no login; the partner is Pat, and sees Pat's payslips only (PAY-09).
  const sam = (await owner.post(url('/family-members'), { name: 'Sam', relationship: 'spouse_partner' })).body
    .id;
  const invite = await owner.post(url('/sharing/invites'), {
    email: PARTNER,
    role: 'partner',
    familyMember: { name: 'Pat', relationship: 'other' },
  });
  expect(invite.status).toBe(201);
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
  const pat = (await owner.get(url('/family-members'))).body.data.find((m: any) => m.name === 'Pat').id;
  const employer = async (memberId: string, name: string) => {
    const res = await owner.post(url('/employers'), {
      memberId,
      name,
      payFrequency: 'monthly',
      depositAccountId: checking,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const sams = await payslipWithFile(await employer(sam, 'Acme Corp'), 'sam-march');
  const pats = await payslipWithFile(await employer(pat, 'Pine Co'), 'pat-march');
  samSlip = sams.id;
  samFile = sams.fileId;
  patSlip = pats.id;
  patFile = pats.fileId;
  expect((await partner.get(url('/payslips'))).body.data.map((p: any) => p.id)).toEqual([patSlip]);

  // The owner's scan of Sam's next payslip, not yet made into one: a scan is its maker's alone (ADR-0048).
  scanFile = await storedFile('payslip', 'sam-april-scan');
  await db.query(
    `insert into app.document_scan (workspace_id, user_id, kind, file_ids, status)
     values ($1, $2, 'payslip', $3, 'ready')`,
    [wsId, await userId(OWNER), [scanFile]],
  );
  // A receipt of the rental's books, which the partner has no grant to.
  rentalFile = await storedFile('receipt', 'gutter-repair');
  await db.query(
    `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor, attachment_ids)
     values ($1, $2, 'inbox', 'Gutter Guys', '2026-03-02', 'USD', 25000, $3)`,
    [wsId, rental, [rentalFile]],
  );
});
afterAll(async () => {
  await db.end();
  await h.close();
});

describe('a partner’s backup of their books', () => {
  it('leaves out another member’s payslip file, and keeps the partner’s own', async () => {
    const { zip, manifest, file } = await backup(partner, PARTNER, { entityId: personal });
    expect(manifest).toMatchObject({ partial: true, entityScoped: true });
    expect(zip.get('data/payslip.jsonl')!.toString()).toContain(patSlip);
    expect(zip.get('data/payslip.jsonl')!.toString()).not.toContain(samSlip);
    expect(file(patFile)?.equals(pdf('pat-march'))).toBe(true);
    expect(file(samFile)).toBeNull();
    // Not even the file's row, with its name and size.
    const files = zip.get('data/file.jsonl')!.toString();
    expect(files).toContain(patFile);
    expect(files).not.toContain(samFile);
    expect(files).not.toContain('sam-march');
  });

  it('leaves out someone else’s scan and the files of books the partner can’t read', async () => {
    const { zip, file } = await backup(partner, PARTNER, { entityId: personal });
    expect(file(scanFile)).toBeNull();
    expect(file(rentalFile)).toBeNull();
    const everything = [...zip.values()].map((b) => b.toString('latin1')).join('\n');
    for (const label of ['sam-march', 'sam-april-scan', 'gutter-repair'])
      expect(everything).not.toContain(label);
  });
});

describe('an owner’s backup', () => {
  it('of the workspace holds every file', async () => {
    const { manifest, file } = await backup(owner, OWNER, {});
    expect(manifest.partial).toBe(false);
    expect(file(samFile)?.equals(pdf('sam-march'))).toBe(true);
    expect(file(patFile)?.equals(pdf('pat-march'))).toBe(true);
    expect(file(scanFile)?.equals(pdf('sam-april-scan'))).toBe(true);
    expect(file(rentalFile)?.equals(pdf('gutter-repair'))).toBe(true);
  });

  it('of one set of books holds those books’ files and no others', async () => {
    const home = await backup(owner, OWNER, { entityId: personal });
    expect(home.file(samFile)?.equals(pdf('sam-march'))).toBe(true);
    expect(home.file(patFile)).not.toBeNull();
    // A scan has no books: it goes with its maker's archives, as its row does.
    expect(home.file(scanFile)).not.toBeNull();
    expect(home.file(rentalFile)).toBeNull();
    const elm = await backup(owner, OWNER, { entityId: rental });
    expect(elm.file(rentalFile)?.equals(pdf('gutter-repair'))).toBe(true);
    expect(elm.file(samFile)).toBeNull();
    expect(elm.file(patFile)).toBeNull();
  });
});

describe('restoring (BAK-06)', () => {
  it('brings back every payslip with its file from an owner’s backup', async () => {
    const { bytes } = await backup(owner, OWNER, {});
    const copy = await restore(bytes, OWNER, owner, 'Files again');
    const slips = (await owner.get(copy('/payslips'))).body.data;
    expect(slips).toHaveLength(2);
    const bodies = [];
    for (const s of slips) {
      expect(s.fileIds).toHaveLength(1);
      const res = await h.app.inject({
        method: 'GET',
        url: copy(`/payslips/${s.id}/files/${s.fileIds[0]}`),
        headers: auth(OWNER),
      });
      expect(res.statusCode).toBe(200);
      bodies.push(res.rawPayload.toString('latin1'));
    }
    expect(bodies.sort()).toEqual([pdf('pat-march').toString('latin1'), pdf('sam-march').toString('latin1')]);
  });

  it('brings back the partner’s own payslip and file from their backup, and nothing of Sam’s', async () => {
    const { bytes } = await backup(partner, PARTNER, { entityId: personal });
    const copy = await restore(bytes, PARTNER, partner, 'Pat’s books');
    const slips = (await partner.get(copy('/payslips'))).body.data;
    expect(slips).toHaveLength(1);
    const res = await h.app.inject({
      method: 'GET',
      url: copy(`/payslips/${slips[0].id}/files/${slips[0].fileIds[0]}`),
      headers: auth(PARTNER),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(pdf('pat-march'))).toBe(true);
    const { rows } = await db.query(
      `select f.file_name from app.file f join app.workspace w on w.id = f.workspace_id
        where w.id = (select workspace_id from app.payslip where id = $1)`,
      [slips[0].id],
    );
    expect(rows.map((r) => r.file_name)).toEqual(['pat-march.pdf']);
  });
});
