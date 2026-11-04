/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { createHash } from 'node:crypto';
import { addDays, startOfMonth, todayIn } from '@montra/domain';
import { EXPORT_ONLY, exportedTables, NOT_EXPORTED, readCatalog } from '../src/data/catalog.js';
import { BackupService } from '../src/data/backup.service.js';
import { OwnershipService } from '../src/data/ownership.service.js';
import { RestoreService } from '../src/data/restore.service.js';
import { Db } from '../src/db/database.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Taking your data out and back in, and leaving (NFR-05, NFR-06, BAK-04..09, AUTH-12, RPT-04; ADR-0019).
// Each builds and reads real archives, so these are slower than most.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const lastMonth = startOfMonth(addDays(startOfMonth(today), -1));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'owner-data@example.com';
const PARTNER = 'partner-data@example.com';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/iZvQWQAAAABJRU5ErkJggg==',
  'base64',
);

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let worker: Worker;
let storage: StoragePort;
let url: (p: string) => string;
let wsId: string;
let ownerId: string;
let personal: string;
let business: string;
let rental: string;
let checking: string;
let bizChecking: string;
let cat: (name: string, entity?: string) => string;
let receiptId: string;
let fileId: string;
let memoTransaction: string;
let leaseId: string;

const auth = (email = EMAIL) => ({ authorization: `Bearer dev:${email}` });
const drain = () => worker.drain(['report'], 50);

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

function writeZip(files: Map<string, Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (d: Buffer) => chunks.push(d));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [name, bytes] of files) zip.addBuffer(bytes, name);
    zip.end();
  });
}

/** Ask for a backup, run the job, download it. */
async function backup(
  body: object = {},
  client = c,
  email = EMAIL,
  base = url,
): Promise<{ id: string; bytes: Buffer }> {
  const created = await client.post(base('/backups'), body);
  expect(created.status).toBe(201);
  await drain();
  const job = (await client.get(base(`/backups/${created.body.id}`))).body;
  expect(job).toMatchObject({ status: 'ready', error: null });
  const res = await h.app.inject({
    method: 'GET',
    url: base(`/backups/${created.body.id}/download`),
    headers: auth(email),
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toContain('no-store');
  return { id: created.body.id, bytes: res.rawPayload };
}

function multipart(fields: Record<string, string>, file: Buffer) {
  const boundary = '----montra-data';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = async (bytes: Buffer, fields: Record<string, string> = {}, email = EMAIL) => {
  const m = multipart(fields, bytes);
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/me/restores',
    headers: { ...auth(email), 'content-type': m.contentType },
    payload: m.payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

/** Every account's balance, by entity and account name: what a restore has to reproduce. */
const books = async (workspaceId: string) =>
  (
    await admin.query(
      `select e.name as entity, a.name as account, sum(p.amount_minor)::text as amount
         from app.posting p
         join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
        where p.workspace_id = $1
        group by 1, 2 having sum(p.amount_minor) <> 0 order by 1, 2`,
      [workspaceId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(ImportJobs).register();
  h.app.get(BackupService).register();
  h.app.get(RestoreService).register();
  worker = h.app.get(Worker);
  storage = h.app.get(STORAGE_PORT) as StoragePort;
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Everything', baseCurrency: 'USD', template: 'hybrid' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  business = entities.find((e: any) => e.type === 'business').id;
  rental = entities.find((e: any) => e.type === 'rental').id;
  const account = async (name: string, entityId: string, kind = 'checking', opening = '1000000') =>
    (
      await c.post(url('/accounts'), {
        name,
        kind,
        openingBalance: usd(opening),
        openingDate: `${year - 1}-12-01`,
        entityId,
      })
    ).body.id as string;
  checking = await account('Joint', personal);
  bizChecking = await account('Studio', business);
  const rentalChecking = await account('Rental bank', rental);
  const mortgage = await account('Elm loan', rental, 'mortgage', '10000000');
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity = personal) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  ownerId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);

  const t = await c.post(url('/transactions'), {
    date: today,
    accountId: checking,
    amount: usd('-5000'),
    payee: 'WHOLE FOODS',
    categoryId: cat('Groceries'),
    tags: ['food', 'weekly'],
    memo: 'A private note about a gift',
  });
  memoTransaction = t.body.id;
  await c.post(url('/transactions'), {
    date: lastMonth,
    accountId: checking,
    amount: usd('300000'),
    payee: 'ACME PAYROLL',
    categoryId: cat('Salary'),
  });
  await c.post(url('/transfers'), {
    date: today,
    fromAccountId: checking,
    toAccountId: bizChecking,
    amount: usd('20000'),
  });
  await c.post(url('/transactions'), {
    date: today,
    accountId: bizChecking,
    amount: usd('77700'),
    payee: 'BLUEBIRD',
    categoryId: cat('Other business income', business),
  });
  const budget = await c.post(url('/budgets'), { entityId: personal, name: 'Home' });
  await c.put(url(`/budgets/${budget.body.id}/periods/${startOfMonth(today)}/lines/${cat('Groceries')}`), {
    assigned: '40000',
    version: budget.body.version,
  });
  // A rental, with its rent, deposit and mortgage.
  const property = (await c.post(url('/properties'), { entityId: rental, name: 'Elm House', type: 'sfh' }))
    .body;
  const tenant = (await c.post(url('/tenants'), { entityId: rental, name: 'Rita Rent' })).body;
  const lease = await c.post(url('/leases'), {
    unitId: property.units[0].id,
    tenantIds: [tenant.id],
    startDate: lastMonth,
    rent: '150000',
    deposit: '150000',
  });
  leaseId = lease.body.id;
  await c.post(url(`/leases/${leaseId}/payments`), {
    accountId: rentalChecking,
    date: today,
    amount: '150000',
  });
  await c.post(url(`/leases/${leaseId}/deposit-events`), {
    kind: 'received_new',
    accountId: rentalChecking,
    date: today,
    amount: '150000',
  });
  const loan = await c.post(url('/loans'), {
    propertyId: property.id,
    loanAccountId: mortgage,
    name: 'Elm loan',
    principal: '10000000',
    rateBps: 600,
    termMonths: 360,
    firstPaymentDate: today,
  });
  await c.post(url(`/loans/${loan.body.id}/payments`), { number: 1, accountId: rentalChecking, date: today });
  // A closed period, which a restore has to get past.
  await admin.query(`update app.ledger_account set tax_line_code = tax_line_code where false`);

  // A receipt with its file.
  const stored = await admin.query(
    `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, uploaded_by)
     values ($1, 'receipt', $2, 'till slip.png', 'image/png', $3, $4, $5) returning id`,
    [
      wsId,
      `${wsId}/receipt/${year}/slip`,
      PNG.length,
      createHash('sha256').update(PNG).digest('hex'),
      ownerId,
    ],
  );
  fileId = stored.rows[0].id;
  await storage.put(`${wsId}/receipt/${year}/slip`, PNG, 'image/png');
  const receipt = await admin.query(
    `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor, attachment_ids)
     values ($1, $2, 'inbox', 'Print Shop', $3, 'USD', 5000, $4) returning id`,
    [wsId, business, today, [fileId]],
  );
  receiptId = receipt.rows[0].id;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('what an archive holds (ADR-0019 §7)', () => {
  it('decides about every table, so a new one can’t be forgotten', async () => {
    const catalog = await h.app.get(Db).run({}, (trx) => readCatalog(trx));
    const withWorkspace = [...catalog.values()]
      .filter((t) => t.columns.has('workspace_id'))
      .map((t) => t.name);
    const decided = new Set([...exportedTables(catalog), ...Object.keys(NOT_EXPORTED)]);
    expect(withWorkspace.filter((t) => !decided.has(t))).toEqual([]);
    // And the exclusion list doesn't name tables that are gone.
    expect(Object.keys(NOT_EXPORTED).filter((t) => !catalog.has(t))).toEqual([]);
    for (const t of EXPORT_ONLY) expect(catalog.has(t)).toBe(true);
  });

  it('has the data, decrypted, with what makes it usable, and leaves secrets out', async () => {
    await c
      .put(url('/ai/credentials/anthropic'), { apiKey: 'sk-secret-value-123456' })
      .catch(() => undefined);
    const { bytes } = await backup();
    const zip = await readZip(bytes);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({ format: 1, partial: false, entityScoped: false });
    expect(manifest.workspace.name).toBe('Everything');
    expect(manifest.tables.transaction.rows).toBeGreaterThanOrEqual(4);
    expect(zip.has('README.txt')).toBe(true);
    expect(zip.has('summary.xlsx')).toBe(true);
    expect(zip.has('csv/transaction.csv')).toBe(true);
    const transactions = zip.get('data/transaction.jsonl')!.toString();
    expect(transactions).toContain('A private note about a gift');
    expect(transactions).not.toContain('memo_enc');
    expect(zip.get('csv/transaction.csv')!.toString()).toContain('A private note about a gift');
    expect(zip.has('data/workspace_key.jsonl')).toBe(false);
    expect(zip.has('data/ai_credential.jsonl')).toBe(false);
    const everything = [...zip.values()].map((b) => b.toString('latin1')).join('\n');
    expect(everything).not.toContain('sk-secret-value');
    const file = manifest.files.find((f: any) => f.id === fileId);
    expect(zip.get(file.path)!.equals(PNG)).toBe(true);
    // A file holds what it needs to prove itself.
    const hash = createHash('sha256').update(zip.get('data/posting.jsonl')!).digest('hex');
    expect(manifest.tables.posting.sha256).toBe(hash);
  });

  it('lets a partner take only books they can read, and not the workspace', async () => {
    expect((await partner.post(url('/backups'), {})).status).toBe(403);
    expect((await partner.post(url('/backups'), { entityId: business })).status).toBe(404);
    const { bytes } = await backup({ entityId: personal }, partner, PARTNER);
    const zip = await readZip(bytes);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({ partial: true, entityScoped: true });
    expect(manifest.entities.map((e: any) => e.type)).toEqual(['personal']);
    const text = [...zip.values()].map((b) => b.toString('latin1')).join('\n');
    expect(text).not.toContain('BLUEBIRD');
    expect(text).not.toContain('Rita Rent');
  });

  it('is private to whoever asked for it', async () => {
    const { id } = await backup();
    expect((await partner.get(url(`/backups/${id}`))).status).toBe(404);
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/backups/${id}/download`),
      headers: auth(PARTNER),
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps one entity to itself', async () => {
    const { bytes } = await backup({ entityId: business });
    const zip = await readZip(bytes);
    const text = zip.get('data/transaction.jsonl')!.toString();
    expect(text).toContain('BLUEBIRD');
    expect(text).not.toContain('WHOLE FOODS');
    expect(zip.get('data/entity.jsonl')!.toString().trim().split('\n')).toHaveLength(1);
    expect(zip.get('data/lease.jsonl')?.toString() ?? '').toBe('');
  });
});

describe('restoring into a new workspace (BAK-06)', () => {
  let restored: string;

  it('shows what’s in the file, and changes nothing until confirmed', async () => {
    const before = (await admin.query(`select count(*)::int as n from app.workspace`)).rows[0].n;
    const { bytes } = await backup();
    const res = await upload(bytes);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ready');
    expect(res.body.preview).toMatchObject({
      workspaceName: 'Everything',
      entityScoped: false,
      partial: false,
      files: 1,
    });
    expect(res.body.preview.counts.transaction).toBeGreaterThanOrEqual(4);
    expect(res.body.preview.entities.map((e: any) => e.type).sort()).toEqual([
      'business',
      'personal',
      'rental',
    ]);
    expect((await admin.query(`select count(*)::int as n from app.workspace`)).rows[0].n).toBe(before);

    const original = await books(wsId);
    const confirmed = await c.post(`/v1/me/restores/${res.body.id}/confirm`, {
      mode: 'new',
      name: 'Back again',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('restoring');
    await drain();
    const done = (await c.get(`/v1/me/restores/${res.body.id}`)).body;
    expect(done).toMatchObject({ status: 'done', error: null });
    restored = done.targetWorkspaceId;
    expect(restored).not.toBe(wsId);
    // The original is untouched, and the copy has identical books.
    expect(await books(wsId)).toEqual(original);
    expect(await books(restored)).toEqual(original);
  });

  const inRestored = (p: string) => `/v1/workspaces/${restored}${p}`;

  it('brings back the books as you’d use them', async () => {
    const list = (await c.get(inRestored('/transactions?limit=50'))).body.data;
    const groceries = list.find((t: any) => t.payee === 'WHOLE FOODS');
    expect(groceries.memo).toBe('A private note about a gift');
    expect(groceries.tags.sort()).toEqual(['food', 'weekly']);
    expect(groceries.id).not.toBe(memoTransaction);
    expect((await c.get(`/v1/workspaces/${restored}`)).body.name).toBe('Back again');
    const original = (await c.get(url(`/reports/catalog/trial-balance?to=${today}&entityId=${personal}`)))
      .body;
    const entities = (await c.get(inRestored('/entities'))).body.data;
    const copyPersonal = entities.find((e: any) => e.type === 'personal').id;
    const copy = (
      await c.get(inRestored(`/reports/catalog/trial-balance?to=${today}&entityId=${copyPersonal}`))
    ).body;
    expect(copy.totals).toEqual(original.totals);
    expect(copy.rows.map((r: any) => r.cells)).toEqual(original.rows.map((r: any) => r.cells));
  });

  it('keeps references between records working', async () => {
    const entities = (await c.get(inRestored('/entities'))).body.data;
    const copyRental = entities.find((e: any) => e.type === 'rental').id;
    const roll = (await c.get(inRestored(`/rent-roll?entityId=${copyRental}&month=${lastMonth}`))).body;
    const originalRoll = (await c.get(url(`/rent-roll?entityId=${rental}&month=${lastMonth}`))).body;
    expect(roll.rows[0]).toMatchObject({ paid: originalRoll.rows[0].paid, tenants: ['Rita Rent'] });
    const lease = (await c.get(inRestored(`/leases?entityId=${copyRental}`))).body.data[0];
    expect(lease.id).not.toBe(leaseId);
    expect(lease.depositHeld).toBe('150000');
    const loans = (await c.get(inRestored(`/loans?entityId=${copyRental}`))).body.data;
    expect(loans[0]).toMatchObject({ name: 'Elm loan', paymentsMade: 1 });
    const budget = (await c.get(inRestored('/budgets'))).body.data[0];
    const period = (await c.get(inRestored(`/budgets/${budget.id}/periods/${startOfMonth(today)}`))).body;
    const lines = period.groups.flatMap((g: any) => g.lines);
    expect(lines.find((l: any) => l.name === 'Groceries').assigned).toBe('40000');
    // A transaction's stored input points at the new accounts: it can still be edited.
    const list = (await c.get(inRestored('/transactions?limit=50'))).body.data;
    const t = list.find((x: any) => x.payee === 'WHOLE FOODS');
    const edit = await c.patch(inRestored(`/transactions/${t.id}`), { amount: usd('-6000') });
    expect(edit.status).toBe(200);
  });

  it('copies files under keys of its own', async () => {
    const { rows } = await admin.query(`select storage_key from app.file where workspace_id = $1`, [
      restored,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_key.startsWith(`${restored}/`)).toBe(true);
    expect(Buffer.from(await storage.get(rows[0].storage_key)).equals(PNG)).toBe(true);
    const { rows: receipts } = await admin.query(
      `select r.attachment_ids[1] = f.id as linked from app.receipt r join app.file f on f.workspace_id = r.workspace_id where r.workspace_id = $1`,
      [restored],
    );
    expect(receipts[0].linked).toBe(true);
  });

  it('gives access only to whoever restored it', async () => {
    expect((await partner.get(inRestored('/transactions'))).status).toBe(403);
    const { rows } = await admin.query(
      `select user_id, role from app.workspace_member where workspace_id = $1`,
      [restored],
    );
    expect(rows).toEqual([{ user_id: ownerId, role: 'owner' }]);
  });

  it('doesn’t carry AI settings or keys across', async () => {
    const { rows } = await admin.query(`select ai_settings from app.workspace where id = $1`, [restored]);
    expect(rows[0].ai_settings).toEqual({});
    const creds = await admin.query(
      `select count(*)::int as n from app.ai_credential where workspace_id = $1`,
      [restored],
    );
    expect(creds.rows[0].n).toBe(0);
  });

  it('runs once', async () => {
    const list = (await c.get('/v1/me/restores')).body.data;
    const res = await c.post(`/v1/me/restores/${list[0].id}/confirm`, { mode: 'new' });
    expect(res.status).toBe(409);
  });

  it('is private to whoever uploaded it', async () => {
    const list = (await c.get('/v1/me/restores')).body.data;
    expect((await partner.get(`/v1/me/restores/${list[0].id}`)).status).toBe(404);
    expect((await partner.post(`/v1/me/restores/${list[0].id}/confirm`, { mode: 'new' })).status).toBe(404);
  });
});

describe('a password on a backup (BAK-04)', () => {
  const PASSWORD = 'correct horse battery staple';

  it('encrypts the file, restores with the password, and never stores it', async () => {
    const { bytes, id } = await backup({ password: PASSWORD });
    expect(bytes.subarray(0, 9).toString()).toBe('MONTRABK1');
    expect(bytes.toString('latin1')).not.toContain('WHOLE FOODS');
    const job = (await c.get(url(`/backups/${id}`))).body;
    expect(job).toMatchObject({ encrypted: true });
    expect(job.fileName).toMatch(/\.montra$/);
    const queued = await admin.query(
      `select payload::text as p from app.job where type = 'data.backup' order by created_at desc limit 1`,
    );
    expect(queued.rows[0].p).not.toContain(PASSWORD);

    expect((await upload(bytes)).body.code ?? '').toBe('restore.password_required');
    const wrong = await upload(bytes, { password: 'not the right password' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('restore.bad_password');
    const right = await upload(bytes, { password: PASSWORD });
    expect(right.status).toBe(201);
    expect(right.body.preview.workspaceName).toBe('Everything');
  });

  it('refuses a short one', async () => {
    expect((await c.post(url('/backups'), { password: 'short' })).status).toBe(400);
  });
});

describe('an archive is untrusted (ADR-0019 §9)', () => {
  const rezip = async (bytes: Buffer, change: (zip: Map<string, Buffer>, manifest: any) => void) => {
    const zip = await readZip(bytes);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    change(zip, manifest);
    zip.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    return writeZip(zip);
  };
  const resign = (zip: Map<string, Buffer>, manifest: any, table: string) => {
    manifest.tables[table].sha256 = createHash('sha256')
      .update(zip.get(`data/${table}.jsonl`)!)
      .digest('hex');
  };

  it('refuses what isn’t a backup', async () => {
    for (const bytes of [Buffer.from('not a zip'), await writeZip(new Map([['a.txt', Buffer.from('hi')]]))]) {
      const res = await upload(bytes);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('restore.invalid');
    }
  });

  it('notices a change to the data', async () => {
    const { bytes } = await backup();
    const zip = await readZip(bytes);
    zip.set(
      'data/transaction.jsonl',
      Buffer.from(zip.get('data/transaction.jsonl')!.toString().replace('WHOLE FOODS', 'OTHER PLACE')),
    );
    const res = await upload(await writeZip(zip));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('restore.invalid');
  });

  it('never trusts a storage key from the file', async () => {
    const { bytes } = await backup();
    const victimKey = `${wsId}/receipt/${year}/slip`;
    const forged = await rezip(bytes, (zip, manifest) => {
      const rows = zip
        .get('data/file.jsonl')!
        .toString()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      for (const r of rows) r.storage_key = victimKey;
      zip.set('data/file.jsonl', Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
      resign(zip, manifest, 'file');
    });
    const res = await upload(forged);
    await c.post(`/v1/me/restores/${res.body.id}/confirm`, { mode: 'new' });
    await drain();
    const done = (await c.get(`/v1/me/restores/${res.body.id}`)).body;
    const { rows } = await admin.query(`select storage_key from app.file where workspace_id = $1`, [
      done.targetWorkspaceId,
    ]);
    expect(rows[0].storage_key).not.toBe(victimKey);
    expect(rows[0].storage_key.startsWith(`${done.targetWorkspaceId}/`)).toBe(true);
  });

  it('keeps every row in the target workspace, whatever the file says', async () => {
    const { bytes } = await backup();
    const forged = await rezip(bytes, (zip, manifest) => {
      const other = '00000000-0000-4000-8000-000000000000';
      zip.set('data/tag.jsonl', Buffer.from(zip.get('data/tag.jsonl')!.toString().replaceAll(wsId, other)));
      resign(zip, manifest, 'tag');
    });
    const res = await upload(forged);
    await c.post(`/v1/me/restores/${res.body.id}/confirm`, { mode: 'new' });
    await drain();
    const done = (await c.get(`/v1/me/restores/${res.body.id}`)).body;
    const { rows } = await admin.query(`select count(*)::int as n from app.tag where workspace_id = $1`, [
      done.targetWorkspaceId,
    ]);
    expect(rows[0].n).toBe(2);
  });

  it('leaves nothing behind when the books wouldn’t come back right', async () => {
    const before = (await admin.query(`select count(*)::int as n from app.workspace`)).rows[0].n;
    const { bytes } = await backup();
    const forged = await rezip(bytes, (_zip, manifest) => {
      const [account] = Object.keys(manifest.balances);
      manifest.balances[account!] = '123';
    });
    const res = await upload(forged);
    await c.post(`/v1/me/restores/${res.body.id}/confirm`, { mode: 'new' });
    await drain();
    const done = (await c.get(`/v1/me/restores/${res.body.id}`)).body;
    expect(done).toMatchObject({
      status: 'failed',
      error: 'The restore could not be finished, and nothing was changed.',
    });
    expect((await admin.query(`select count(*)::int as n from app.workspace`)).rows[0].n).toBe(before);
  });
});

describe('restoring into an existing workspace (BAK-06)', () => {
  let target: string;
  const inTarget = (p: string) => `/v1/workspaces/${target}${p}`;

  beforeAll(async () => {
    target = (await c.post('/v1/workspaces', { name: 'Target', baseCurrency: 'USD', template: 'household' }))
      .body.id;
    const entity = (await c.get(inTarget('/entities'))).body.data[0].id;
    const acct = (
      await c.post(inTarget('/accounts'), {
        name: 'Target bank',
        kind: 'checking',
        openingBalance: usd('50000'),
        openingDate: `${year - 1}-12-01`,
        entityId: entity,
      })
    ).body.id;
    const cats = (await c.get(inTarget('/categories'))).body.data;
    await c.post(inTarget('/transactions'), {
      date: today,
      accountId: acct,
      amount: usd('-1000'),
      payee: 'TARGET SHOP',
      categoryId: cats.find((x: any) => x.name === 'Groceries').id,
      tags: ['FOOD'],
    });
  });

  it('adds a business as new books, leaving what’s there alone', async () => {
    const before = await books(target);
    const { bytes } = await backup({ entityId: business });
    const res = await upload(bytes);
    const confirmed = await c.post(`/v1/me/restores/${res.body.id}/confirm`, {
      mode: 'existing',
      workspaceId: target,
    });
    expect(confirmed.status).toBe(200);
    await drain();
    const done = (await c.get(`/v1/me/restores/${res.body.id}`)).body;
    expect(done).toMatchObject({ status: 'done', targetWorkspaceId: target });
    const after = await books(target);
    expect(after.filter((r: any) => before.some((b: any) => b.entity === r.entity))).toEqual(before);
    const added = after.filter((r: any) => r.entity.endsWith('(restored)'));
    expect(added.length).toBeGreaterThan(0);
    const source = (await books(wsId)).filter((r: any) => r.entity === 'My Business');
    expect(added.map((r: any) => [r.account, r.amount])).toEqual(
      source.map((r: any) => [r.account, r.amount]),
    );
  });

  it('maps a shared list onto what’s there', async () => {
    const { bytes } = await backup();
    const res = await upload(bytes);
    // Personal books can't be added, but the rest of this archive can.
    await c.post(`/v1/me/restores/${res.body.id}/confirm`, { mode: 'existing', workspaceId: target });
    await drain();
    const done = (await c.get(`/v1/me/restores/${res.body.id}`)).body;
    expect(done.status).toBe('done');
    const { rows } = await admin.query(
      `select name from app.tag where workspace_id = $1 and lower(name) = 'food'`,
      [target],
    );
    expect(rows.map((r) => r.name)).toEqual(['FOOD']);
    const personals = await admin.query(
      `select count(*)::int as n from app.entity where workspace_id = $1 and type = 'personal'`,
      [target],
    );
    expect(personals.rows[0].n).toBe(1);
  });

  it('refuses personal books alone, since a workspace has only one set', async () => {
    const { bytes } = await backup({ entityId: personal });
    const res = await upload(bytes);
    const confirmed = await c.post(`/v1/me/restores/${res.body.id}/confirm`, {
      mode: 'existing',
      workspaceId: target,
    });
    expect(confirmed.status).toBe(422);
    expect(confirmed.body.code ?? confirmed.body.error?.code).toBe('restore.personal_existing');
  });

  it('counts possible duplicates for the owner to judge', async () => {
    const zipped = (await backup({ entityId: business })).bytes;
    const res = await upload(zipped);
    await admin.query(
      `update app.transaction set dedupe_key = 'same-line' where workspace_id = $1 and payee_raw = 'BLUEBIRD'`,
      [wsId],
    );
    const withKey = await upload((await backup({ entityId: business })).bytes);
    await admin.query(
      `update app.transaction set dedupe_key = 'same-line' where workspace_id = $1 and payee_raw = 'TARGET SHOP'`,
      [target],
    );
    const seen = (await c.get(`/v1/me/restores/${withKey.body.id}?workspaceId=${target}`)).body;
    expect(seen.preview.possibleDuplicates).toBe(1);
    const none = (await c.get(`/v1/me/restores/${res.body.id}?workspaceId=${target}`)).body;
    expect(none.preview.possibleDuplicates).toBe(0);
  });

  it('needs the restorer to own the target', async () => {
    const { bytes } = await backup({ entityId: business });
    const mine = await upload(bytes);
    const stranger = h.as('stranger-data@example.com');
    const hers = (
      await stranger.post('/v1/workspaces', { name: 'Hers', baseCurrency: 'USD', template: 'household' })
    ).body.id;
    const res = await c.post(`/v1/me/restores/${mine.body.id}/confirm`, {
      mode: 'existing',
      workspaceId: hers,
    });
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.error?.code).toBe('restore.not_owner');
  });
});

describe('the tax package (RPT-04, UP-10)', () => {
  it('holds a year’s reports and receipts for one set of books', async () => {
    const created = await c.post(url('/tax-package'), { entityId: business, year });
    expect(created.status).toBe(201);
    await drain();
    const job = (await c.get(url(`/backups/${created.body.id}`))).body;
    expect(job).toMatchObject({ status: 'ready', kind: 'tax_package', taxYear: year });
    expect(job.fileName).toBe(`My Business-tax-package-${year}.zip`);
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/backups/${created.body.id}/download`),
      headers: auth(),
    });
    const zip = await readZip(res.rawPayload);
    const names = [...zip.keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        'receipts.csv',
        'reports/schedule-c.pdf',
        'reports/schedule-c.csv',
        'reports/pnl.pdf',
        'reports/trial-balance.csv',
        'reports/balance-sheet.pdf',
        'reports/general-ledger.csv',
      ]),
    );
    expect(names).not.toContain('reports/schedule-e.pdf');
    expect(zip.get('reports/pnl.pdf')!.subarray(0, 5).toString()).toBe('%PDF-');
    expect(zip.get('README.txt')!.toString()).toContain('tax advice');
    expect(zip.get('receipts.csv')!.toString()).toContain('Print Shop');
    const slip = names.find((n) => n.startsWith('receipts/') && n.endsWith('.png'))!;
    expect(zip.get(slip)!.equals(PNG)).toBe(true);
  });

  it('has Schedule E for a portfolio, and no-one else’s receipts', async () => {
    const created = await c.post(url('/tax-package'), { entityId: rental, year });
    await drain();
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/backups/${created.body.id}/download`),
      headers: auth(),
    });
    const zip = await readZip(res.rawPayload);
    expect(zip.has('reports/schedule-e.pdf')).toBe(true);
    expect(zip.get('receipts.csv')!.toString()).not.toContain('Print Shop');
  });

  it('won’t make one for books the asker can’t read', async () => {
    expect((await partner.post(url('/tax-package'), { entityId: business, year })).status).toBe(404);
  });
});

describe('trash (BAK-06)', () => {
  it('lists what’s deleted, with the last day it can come back, and restores it', async () => {
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-111'),
        payee: 'OOPS',
        categoryId: cat('Groceries'),
      })
    ).body;
    await c.delete(url(`/transactions/${t.id}`));
    const list = (await c.get(url('/trash'))).body.data;
    const item = list.find((i: any) => i.id === t.id);
    expect(item).toMatchObject({
      kind: 'transaction',
      title: 'OOPS',
      amount: '-111',
      purgeOn: addDays(today, 30),
    });
    expect((await c.post(url(`/trash/transaction/${t.id}/restore`))).status).toBe(204);
    expect((await c.get(url('/trash'))).body.data.map((i: any) => i.id)).not.toContain(t.id);
    expect((await c.get(url(`/transactions/${t.id}`))).body.status).toBe('posted');
    await c.delete(url(`/transactions/${t.id}`));
  });

  it('restores a receipt', async () => {
    expect((await c.delete(url(`/receipts/${receiptId}`))).status).toBeLessThan(300);
    expect((await c.get(url('/trash'))).body.data.find((i: any) => i.id === receiptId)).toMatchObject({
      kind: 'receipt',
      title: 'Print Shop',
    });
    expect((await c.post(url(`/trash/receipt/${receiptId}/restore`))).status).toBe(204);
    expect((await c.get(url(`/receipts/${receiptId}`))).status).toBe(200);
  });

  it('clears out after 30 days', async () => {
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-222'),
        payee: 'LONG GONE',
        categoryId: cat('Groceries'),
      })
    ).body;
    await c.delete(url(`/transactions/${t.id}`));
    await h.app.get(OwnershipService).retention();
    expect((await admin.query(`select 1 from app.transaction where id = $1`, [t.id])).rowCount).toBe(1);
    await admin.query(`update app.transaction set deleted_at = now() - interval '31 days' where id = $1`, [
      t.id,
    ]);
    await h.app.get(OwnershipService).retention();
    expect((await admin.query(`select 1 from app.transaction where id = $1`, [t.id])).rowCount).toBe(0);
  });
});

describe('storage (BAK-08)', () => {
  it('meters what’s stored, by kind', async () => {
    const res = (await c.get(url('/storage'))).body;
    expect(res.quotaBytes).toBe(String(5 * 1024 ** 3));
    expect(BigInt(res.usedBytes)).toBeGreaterThanOrEqual(BigInt(PNG.length));
    expect(BigInt(res.byKind.receipt)).toBeGreaterThanOrEqual(BigInt(PNG.length));
  });

  it('stops new files at the quota, but never stops a backup', async () => {
    await admin.query(`update app.workspace set storage_quota_bytes = 10 where id = $1`, [wsId]);
    const boundary = '----q';
    const res = await h.app.inject({
      method: 'POST',
      url: url('/rentals/files'),
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        PNG,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('storage.quota');
    const { bytes } = await backup();
    expect(bytes.length).toBeGreaterThan(0);
    await admin.query(`update app.workspace set storage_quota_bytes = 5368709120 where id = $1`, [wsId]);
  });
});

describe('expiry and schedules (BAK-05, BAK-09)', () => {
  it('removes an archive after its 7 days', async () => {
    const { id } = await backup();
    const job = (await c.get(url(`/backups/${id}`))).body;
    const days = (Date.parse(job.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.ceil(days)).toBe(7);
    const { rows } = await admin.query(`select storage_key from app.export_job where id = $1`, [id]);
    await admin.query(`update app.export_job set expires_at = now() - interval '1 hour' where id = $1`, [id]);
    await h.app.get(OwnershipService).retention();
    expect((await c.get(url(`/backups/${id}`))).body.status).toBe('expired');
    const res = await h.app.inject({ method: 'GET', url: url(`/backups/${id}/download`), headers: auth() });
    expect(res.statusCode).toBe(409);
    await expect(storage.get(rows[0].storage_key)).rejects.toThrow();
  });

  it('removes a file past its retention, and leaves the rest', async () => {
    const before = await admin.query(`select count(*)::int as n from app.file where workspace_id = $1`, [
      wsId,
    ]);
    const old = await admin.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, retain_until)
       values ($1, 'receipt', $2, 'old.png', 'image/png', 1, repeat('b', 64), current_date - 1) returning id`,
      [wsId, `${wsId}/receipt/${year}/old`],
    );
    await storage.put(`${wsId}/receipt/${year}/old`, PNG, 'image/png');
    await h.app.get(OwnershipService).retention();
    expect((await admin.query(`select 1 from app.file where id = $1`, [old.rows[0].id])).rowCount).toBe(0);
    await expect(storage.get(`${wsId}/receipt/${year}/old`)).rejects.toThrow();
    expect(
      (await admin.query(`select count(*)::int as n from app.file where workspace_id = $1`, [wsId])).rows[0]
        .n,
    ).toBe(before.rows[0].n);
  });

  it('runs a scheduled backup and emails a link that leads to the app', async () => {
    expect((await c.get(url('/backup-schedule'))).body.schedule).toBeNull();
    expect((await partner.put(url('/backup-schedule'), { cadence: 'weekly' })).status).toBe(403);
    const saved = await c.put(url('/backup-schedule'), { cadence: 'weekly' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      cadence: 'weekly',
      destination: 'email_link',
      nextRunOn: addDays(today, 7),
    });
    await h.app.get(OwnershipService).retention();
    await drain();
    const untouched = (await c.get(url('/backups'))).body.data.length;

    await admin.query(`update app.backup_schedule set next_run_on = current_date where workspace_id = $1`, [
      wsId,
    ]);
    await h.app.get(OwnershipService).retention();
    await drain();
    expect((await c.get(url('/backups'))).body.data).toHaveLength(untouched + 1);
    expect((await c.get(url('/backup-schedule'))).body.schedule.nextRunOn).toBe(addDays(today, 7));
    const mail = h.app.get(MAIL_PORT) as MemoryMail;
    mail.outbox.length = 0;
    await c.patch('/v1/me/notification-prefs', { quietStart: null, quietEnd: null });
    await h.app.get(NotificationsService).deliverWaiting();
    const email = mail.outbox.find((m) => m.subject === 'Your scheduled backup is ready')!;
    expect(email.text).toContain(`/w/${wsId}/settings?tab=data`);
    expect(email.category).toBe('transactional');
    expect((await c.delete(url('/backup-schedule'))).status).toBe(204);
  });
});

describe('the security log (AUTH-12)', () => {
  it('records exports and downloads, per person', async () => {
    const { id } = await backup({ entityId: personal });
    const events = (await c.get('/v1/me/security-activity')).body.data;
    const kinds = events.map((e: any) => e.kind);
    expect(kinds).toContain('export_requested');
    expect(kinds).toContain('export_downloaded');
    expect(kinds).toContain('restore_started');
    expect(kinds).toContain('restore_finished');
    expect(id).toBeDefined();
    const theirs = (await partner.get('/v1/me/security-activity')).body.data;
    expect(theirs.map((e: any) => e.id)).not.toContain(events[0].id);
  });

  it('can’t be rewritten', async () => {
    const appDb = h.app.get(Db);
    await expect(
      appDb.run({ userId: ownerId }, (trx) =>
        trx.deleteFrom('app.security_event').where('user_id', '=', ownerId).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('leaving (NFR-06, BAK-09)', () => {
  const LEAVING = 'leaving@example.com';
  const STAYING = 'staying@example.com';
  let leaving: Client;
  let staying: Client;
  let soleOwned: string;
  let shared: string;
  let leavingId: string;
  let soleKey: string;

  beforeAll(async () => {
    leaving = h.as(LEAVING);
    staying = h.as(STAYING);
    soleOwned = (
      await leaving.post('/v1/workspaces', { name: 'Mine alone', baseCurrency: 'USD', template: 'hybrid' })
    ).body.id;
    shared = (
      await staying.post('/v1/workspaces', { name: 'Shared', baseCurrency: 'USD', template: 'household' })
    ).body.id;
    const invite = await staying.post(`/v1/workspaces/${shared}/sharing/invites`, {
      email: LEAVING,
      role: 'partner',
    });
    await leaving.post(`/v1/invites/${invite.body.token}/accept`);
    leavingId = (await admin.query(`select id from app.app_user where email = $1`, [LEAVING])).rows[0].id;
    const entity = (await leaving.get(`/v1/workspaces/${soleOwned}/entities`)).body.data[0].id;
    const acct = (
      await leaving.post(`/v1/workspaces/${soleOwned}/accounts`, {
        name: 'Bank',
        kind: 'checking',
        openingBalance: usd('1000'),
        openingDate: today,
        entityId: entity,
      })
    ).body.id;
    expect(acct).toBeDefined();
    soleKey = `${soleOwned}/receipt/${year}/mine`;
    await admin.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256)
       values ($1, 'receipt', $2, 'mine.png', 'image/png', 1, repeat('c', 64))`,
      [soleOwned, soleKey],
    );
    await storage.put(soleKey, PNG, 'image/png');
  });

  it('says what would go first', async () => {
    const status = (await leaving.get('/v1/me/deletion')).body;
    expect(status).toMatchObject({ requested: false, purgeAfter: null });
    expect(status.workspaces).toEqual([{ id: soleOwned, name: 'Mine alone', otherMembers: 0 }]);
  });

  it('needs a typed confirmation', async () => {
    expect((await leaving.post('/v1/me/deletion', { confirm: 'yes' })).status).toBe(400);
  });

  it('closes the account at once, and it can be undone', async () => {
    const res = await leaving.post('/v1/me/deletion', { confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(true);
    expect(Math.round((Date.parse(res.body.purgeAfter) - Date.now()) / 86_400_000)).toBe(30);
    const blocked = await leaving.get('/v1/workspaces');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe('account.deleting');
    // The way back stays open.
    expect((await leaving.get('/v1/me/deletion')).status).toBe(200);
    const flagged = await admin.query(`select deleted_at is not null as d from app.workspace where id = $1`, [
      soleOwned,
    ]);
    expect(flagged.rows[0].d).toBe(true);
    // A workspace with another owner carries on.
    expect((await staying.get(`/v1/workspaces/${shared}`)).status).toBe(200);

    const cancelled = await leaving.delete('/v1/me/deletion');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.requested).toBe(false);
    expect((await leaving.get(`/v1/workspaces/${soleOwned}`)).status).toBe(200);
    const kinds = (await leaving.get('/v1/me/security-activity')).body.data.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['deletion_requested', 'deletion_cancelled']));
  });

  it('won’t purge early', async () => {
    await leaving.post('/v1/me/deletion', { confirm: 'DELETE' });
    await h.app.get(OwnershipService).retention();
    expect((await admin.query(`select 1 from app.workspace where id = $1`, [soleOwned])).rowCount).toBe(1);
    const appDb = h.app.get(Db);
    const { sql } = await import('kysely');
    await expect(
      appDb.run({}, (trx) => sql`select app.purge_workspace(${soleOwned}::uuid)`.execute(trx)),
    ).rejects.toThrow(/not due/);
    await expect(
      appDb.run({}, (trx) => sql`select app.purge_user(${leavingId}::uuid)`.execute(trx)),
    ).rejects.toThrow(/not due/);
  });

  it('purges everything after 30 days, and keeps other people’s workspaces', async () => {
    await admin.query(`update app.workspace set purge_after = now() - interval '1 hour' where id = $1`, [
      soleOwned,
    ]);
    await admin.query(`update app.app_user set purge_after = now() - interval '1 hour' where id = $1`, [
      leavingId,
    ]);
    await h.app.get(OwnershipService).retention();
    // Nothing of that workspace is left, in any table.
    const { rows: tables } = await admin.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id'
        where n.nspname = 'app' and c.relkind = 'r'`,
    );
    for (const t of tables) {
      const { rows } = await admin.query(
        `select count(*)::int as n from app.${t.relname} where workspace_id = $1`,
        [soleOwned],
      );
      expect([t.relname, rows[0].n]).toEqual([t.relname, 0]);
    }
    expect((await admin.query(`select 1 from app.workspace where id = $1`, [soleOwned])).rowCount).toBe(0);
    await expect(storage.get(soleKey)).rejects.toThrow();
    // The person is gone, leaving a row with nothing to identify them.
    const user = (
      await admin.query(`select email, display_name, identity_id from app.app_user where id = $1`, [
        leavingId,
      ])
    ).rows[0];
    expect(user.email).toBe(`deleted+${leavingId}@invalid.example`);
    expect(user.display_name).toBe('');
    expect(user.identity_id).toBeNull();
    // The workspace they were only a member of carries on, without them.
    expect((await staying.get(`/v1/workspaces/${shared}`)).status).toBe(200);
    const member = await admin.query(
      `select status from app.workspace_member where workspace_id = $1 and user_id = $2`,
      [shared, leavingId],
    );
    expect(member.rows[0].status).toBe('revoked');
  });

  it('frees the email address', async () => {
    const back = await h.as(LEAVING).get('/v1/workspaces');
    expect(back.status).toBe(200);
    expect(back.body.data).toEqual([]);
  });
});
