/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { BackupService } from '../src/data/backup.service.js';
import { OwnershipService } from '../src/data/ownership.service.js';
import { RestoreService } from '../src/data/restore.service.js';
import { Worker } from '../src/jobs/queue.js';
import { NotificationJobs } from '../src/notifications/notification-jobs.service.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Tax forms in the tax package, retention and the Trash, backups, and the 16 February reminder (ADR-0052 PR 5:
// TAX-07, TAX-08 retention, TAX-10). Builds and reads real archives, so slower than most.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'pkg-owner@example.test';
const MEMBER = 'pkg-member@example.test';
const CPA = 'pkg-cpa@example.test';
const PARTNER = 'pkg-partner@example.test';
const YEAR = 2025;

let h: Harness;
let db: pg.Client;
let worker: Worker;
let storage: StoragePort;
let owner: Client;
let member: Client;
let cpa: Client;
let partner: Client;
let wsId: string;
let url: (p: string) => string;
let personal: string;
let rental: string;
let checking: string;
let savings: string;
let mortgage: string;
let sam: string;
let acme: string;
let beta: string;
let w2: any;
let form1098: any;
let w2File: string;

const usd = (amount: string) => ({ amount, currency: 'USD' });
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const drain = () => worker.drain(['report'], 50);
const join = async (who: Client, body: object) => {
  const invite = await owner.post(url('/sharing/invites'), body);
  expect(invite.status).toBe(201);
  expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
};
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

/** Ask for an archive (a tax package or a backup), run the job and download it. */
async function archive(who: Client, email: string, path: string, body: object): Promise<Map<string, Buffer>> {
  const created = await who.post(url(path), body);
  expect(created.status).toBe(201);
  await drain();
  expect((await who.get(url(`/backups/${created.body.id}`))).body).toMatchObject({ status: 'ready' });
  const res = await h.app.inject({
    method: 'GET',
    url: url(`/backups/${created.body.id}/download`),
    headers: { authorization: `Bearer dev:${email}` },
  });
  expect(res.statusCode).toBe(200);
  return readZip(res.rawPayload);
}
const taxPackage = (who: Client, email: string, entityId: string) =>
  archive(who, email, '/tax-package', { entityId, year: YEAR });

/** A month's pay, posted. */
const payslip = async (employerId: string, payDate: string, at = url) => {
  const p = (await owner.post(at('/payslips'), { employerId, payDate })).body;
  const filled = await owner.patch(at(`/payslips/${p.id}`), {
    version: p.version,
    net: '430000',
    lines: [
      { section: 'earning', code: 'salary', label: 'Salary', amount: '500000' },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '70000' },
    ],
  });
  expect(filled.status).toBe(200);
  const posted = await owner.post(at(`/payslips/${p.id}/confirm`), { version: filled.body.version });
  expect(posted.body.status).toBe('posted');
};

/** A file of the tax form kind, stored, and put on a form. */
async function attach(formId: string, label: string): Promise<string> {
  const bytes = pdf(label);
  const id = (
    await db.query(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, uploaded_by)
       values ($1, 'tax_form', $2, $3, 'application/pdf', $4, $5, $6) returning id`,
      [wsId, `${wsId}/tax_form/${label}`, `${label}.pdf`, bytes.length, sha(bytes), await userId(OWNER)],
    )
  ).rows[0].id as string;
  await storage.put(`${wsId}/tax_form/${label}`, bytes, 'application/pdf');
  await db.query(`update app.tax_form set file_ids = file_ids || $2::uuid where id = $1`, [formId, id]);
  return id;
}

const csvRows = (zip: Map<string, Buffer>) => zip.get('tax-forms.csv')!.toString().trim().split('\r\n');

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(BackupService).register();
  h.app.get(RestoreService).register();
  worker = h.app.get(Worker);
  storage = h.app.get(STORAGE_PORT) as StoragePort;
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as(OWNER);
  member = h.as(MEMBER);
  cpa = h.as(CPA);
  partner = h.as(PARTNER);
  wsId = (await owner.post('/v1/workspaces', { name: 'Package', baseCurrency: 'USD', template: 'hybrid' }))
    .body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  const entities = (await owner.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  rental = entities.find((e: any) => e.type === 'rental').id;
  const account = async (body: object) => {
    const res = await owner.post(url('/accounts'), { openingDate: '2024-01-01', ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  checking = await account({
    name: 'Checking',
    kind: 'checking',
    entityId: personal,
    openingBalance: usd('5000000'),
  });
  savings = await account({ name: 'Savings', kind: 'savings', entityId: personal, last4: '4321' });
  const rentalBank = await account({
    name: 'Rental bank',
    kind: 'checking',
    entityId: rental,
    openingBalance: usd('5000000'),
  });
  mortgage = await account({
    name: 'Elm loan',
    kind: 'mortgage',
    entityId: rental,
    openingBalance: usd('10000000'),
    openingDate: '2024-12-01',
  });

  sam = (await owner.post(url('/family-members'), { name: 'Sam Rivera', relationship: 'spouse_partner' }))
    .body.id;
  await join(member, { email: MEMBER, role: 'member', familyMember: { id: sam } });
  await join(cpa, { email: CPA, role: 'accountant' });
  await join(partner, { email: PARTNER, role: 'partner' });
  await owner.put(url(`/sharing/members/${await userId(CPA)}/grants`), {
    grants: [
      { entityId: personal, access: 'read' },
      { entityId: rental, access: 'read' },
    ],
  });
  const employer = async (name: string) =>
    (
      await owner.post(url('/employers'), {
        memberId: sam,
        name,
        payFrequency: 'monthly',
        depositAccountId: checking,
      })
    ).body.id as string;
  acme = await employer('Acme Corp');
  beta = await employer('Beta LLC');
  await payslip(acme, '2025-03-31');
  await payslip(beta, '2025-06-30');

  // Interest on the savings account, so a 1099-INT is expected (and never comes).
  const interest = (await owner.get(url('/categories'))).body.data.find(
    (c: any) => c.name === 'Interest income' && c.entityId === personal,
  ).id;
  await owner.post(url('/transactions'), {
    date: '2025-06-30',
    accountId: savings,
    amount: usd('4500'),
    payee: 'Savings interest',
    categoryId: interest,
  });

  // The rental's mortgage, paid through the year.
  const property = (
    await owner.post(url('/properties'), { entityId: rental, name: 'Elm House', type: 'sfh' })
  ).body;
  const loan = await owner.post(url('/loans'), {
    propertyId: property.id,
    loanAccountId: mortgage,
    name: 'Elm loan',
    principal: '10000000',
    rateBps: 600,
    termMonths: 360,
    firstPaymentDate: '2025-01-01',
  });
  expect(loan.status).toBe(201);
  for (let n = 1; n <= 3; n++) {
    await owner.post(url(`/loans/${loan.body.id}/payments`), {
      number: n,
      accountId: rentalBank,
      date: `2025-0${n}-01`,
    });
  }

  const typed = await owner.post(url('/tax-forms'), {
    kind: 'w2',
    taxYear: YEAR,
    issuerName: 'Acme Corp',
    issuerEin: '12-3456789',
    personTinLast4: '6789',
    targets: [{ employerId: acme }],
    boxes: { box1: '500000', box2: '70000', box3: '500000', box5: '500000' },
  });
  expect(typed.status).toBe(201);
  w2 = typed.body;
  expect(w2.entityId).toBe(personal);
  const lender = await owner.post(url('/tax-forms'), {
    kind: '1098',
    taxYear: YEAR,
    issuerName: 'Elm Bank',
    targets: [{ accountId: mortgage }],
    boxes: { box1: '149000' },
  });
  expect(lender.status).toBe(201);
  form1098 = lender.body;
  expect(form1098.entityId).toBe(rental);
  w2File = await attach(w2.id, 'acme-w2');
});
afterAll(async () => {
  await db.end();
  await h.close();
});

describe('the tax package (TAX-07, §7.3)', () => {
  it('holds the personal books’ forms, their index with what’s missing, and the checks', async () => {
    const zip = await taxPackage(owner, OWNER, personal);
    expect(zip.get('tax-forms/W-2-Acme Corp-Sam.pdf')!.equals(pdf('acme-w2'))).toBe(true);
    const rows = csvRows(zip);
    expect(rows[0]).toBe(
      'Form,Issuer,EIN,Person,Account (last four),Main box,Amount,Federal tax withheld,Result,Difference,Accepted differences,Files',
    );
    const acmeRow = rows.find((r) => r.startsWith('W-2,Acme Corp'))!;
    expect(acmeRow.startsWith('W-2,Acme Corp,12-3456789,Sam Rivera,,Box 1 wages,5000.00,700.00,')).toBe(true);
    expect(acmeRow.endsWith(',tax-forms/W-2-Acme Corp-Sam.pdf')).toBe(true);
    expect(rows).toContain('W-2,Beta LLC,,Sam Rivera,,,,,Not received,,,');
    expect(rows.some((r) => r.startsWith('1099-INT,Savings') && r.includes('Not received'))).toBe(true);
    // The rental's 1098 goes in the rental's package.
    expect(rows.some((r) => r.startsWith('1098'))).toBe(false);
    const check = zip.get('tax-forms-check.pdf')!;
    expect(check.subarray(0, 5).toString()).toBe('%PDF-');
    const readme = zip.get('README.txt')!.toString();
    expect(readme).toContain('tax-forms.csv');
    expect(readme).toContain('It didn’t prepare a tax return');
    expect(readme).not.toContain('not included');
  });

  it('puts a rental mortgage’s 1098 in the rental’s package, and nothing personal', async () => {
    const zip = await taxPackage(owner, OWNER, rental);
    const rows = csvRows(zip);
    expect(rows.find((r) => r.startsWith('1098,Elm Bank'))).toMatch(/Box 1 mortgage interest,1490\.00,/);
    expect(rows.some((r) => r.includes('Acme') || r.includes('Beta') || r.startsWith('1099'))).toBe(false);
    expect([...zip.keys()].filter((k) => k.startsWith('tax-forms/'))).toEqual([]);
    expect(zip.has('tax-forms-check.pdf')).toBe(true);
  });

  it('leaves a member’s form out of an accountant’s package while the setting is off, and counts it', async () => {
    const zip = await taxPackage(cpa, CPA, personal);
    expect([...zip.keys()].some((k) => k.startsWith('tax-forms/'))).toBe(false);
    expect(csvRows(zip).some((r) => r.includes('Acme'))).toBe(false);
    expect(zip.get('README.txt')!.toString()).toContain("1 tax form not included: you can't see it.");
  });

  it('includes it once the owner turns the setting on', async () => {
    expect((await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: true })).status).toBe(
      200,
    );
    try {
      const zip = await taxPackage(cpa, CPA, personal);
      expect(zip.get('tax-forms/W-2-Acme Corp-Sam.pdf')!.equals(pdf('acme-w2'))).toBe(true);
      expect(csvRows(zip).some((r) => r.startsWith('W-2,Acme Corp,12-3456789,Sam Rivera'))).toBe(true);
      expect(zip.get('README.txt')!.toString()).not.toContain('not included');
    } finally {
      await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: false });
    }
  });

  it('leaves another member’s form out of a partner’s package', async () => {
    // Members don't make packages (they don't export); a partner does, and isn't the person the W-2 is for.
    expect((await member.post(url('/tax-package'), { entityId: personal, year: YEAR })).status).toBe(403);
    const zip = await taxPackage(partner, PARTNER, personal);
    expect(zip.has('tax-forms/W-2-Acme Corp-Sam.pdf')).toBe(false);
    expect(zip.get('README.txt')!.toString()).toContain('not included');
  });

  it('leaves a workspace without tax forms with the package it always had', async () => {
    const other = (await owner.post('/v1/workspaces', { name: 'No forms', baseCurrency: 'USD' })).body.id;
    const books = (await owner.get(`/v1/workspaces/${other}/entities`)).body.data[0].id;
    const created = await owner.post(`/v1/workspaces/${other}/tax-package`, { entityId: books, year: YEAR });
    await drain();
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${other}/backups/${created.body.id}/download`,
      headers: { authorization: `Bearer dev:${OWNER}` },
    });
    const zip = await readZip(res.rawPayload);
    expect(zip.has('tax-forms.csv')).toBe(false);
    expect(zip.get('README.txt')!.toString()).not.toContain('tax-forms');
  });
});

describe('retention (§8.5)', () => {
  it('keeps a form’s files until 31 December of the tax year + 7, and follows a corrected year', async () => {
    const retain = async (id: string) =>
      (await db.query(`select retain_until::text as d from app.file where id = $1`, [id])).rows[0].d;
    expect(await retain(w2File)).toBe('2032-12-31');
    await db.query(`update app.tax_form set tax_year = 2024 where id = $1`, [w2.id]);
    expect(await retain(w2File)).toBe('2031-12-31');
    await db.query(`update app.tax_form set tax_year = 2025 where id = $1`, [w2.id]);
    expect(await retain(w2File)).toBe('2032-12-31');
  });

  it('stores an uploaded form as a tax form file, with its retention', async () => {
    const boundary = '----pkg';
    const res = await h.app.inject({
      method: 'POST',
      url: url('/tax-forms/files'),
      headers: {
        authorization: `Bearer dev:${OWNER}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="year"\r\n\r\n2024\r\n`),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        pdf('uploaded'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode).toBe(202);
    // Kept out of the doc queue other test files drain; this test only needs the stored file.
    await db.query(
      `update app.job set run_after = now() + interval '1 day'
        where workspace_id = $1 and type = 'taxform.read' and status = 'queued'`,
      [wsId],
    );
    const formId = JSON.parse(res.body).files[0].formId;
    const { rows } = await db.query(
      `select f.kind, f.retain_until::text as retain from app.tax_form t join app.file f on f.id = t.file_ids[1]
        where t.id = $1`,
      [formId],
    );
    expect(rows).toEqual([{ kind: 'tax_form', retain: '2031-12-31' }]);
    await db.query(`delete from app.tax_form where id = $1`, [formId]);
  });

  it('purges a form from the Trash after 30 days, with the files no other form holds', async () => {
    const typed = await owner.post(url('/tax-forms'), {
      kind: '1099_int',
      taxYear: YEAR,
      issuerName: 'Old Bank',
      personMemberId: sam,
      boxes: { box1: '1500' },
    });
    const gone = typed.body.id as string;
    const own = await attach(gone, 'old-bank');
    // A consolidated statement's file, shared with a form that stays.
    const shared = await attach(gone, 'shared');
    await db.query(`update app.tax_form set file_ids = file_ids || $2::uuid where id = $1`, [
      form1098.id,
      shared,
    ]);
    expect((await owner.delete(url(`/tax-forms/${gone}`))).status).toBeLessThan(300);
    const retention = () => h.app.get(OwnershipService).retention();
    await retention();
    expect((await db.query(`select 1 from app.tax_form where id = $1`, [gone])).rowCount).toBe(1);
    await db.query(`update app.tax_form set deleted_at = now() - interval '31 days' where id = $1`, [gone]);
    await retention();
    expect((await db.query(`select 1 from app.tax_form where id = $1`, [gone])).rowCount).toBe(0);
    expect((await db.query(`select 1 from app.file where id = $1`, [own])).rowCount).toBe(0);
    await expect(storage.get(`${wsId}/tax_form/old-bank`)).rejects.toThrow();
    expect((await db.query(`select deleted_at from app.file where id = $1`, [shared])).rows).toEqual([
      { deleted_at: null },
    ]);
    expect(Buffer.from(await storage.get(`${wsId}/tax_form/shared`)).equals(pdf('shared'))).toBe(true);
    await db.query(`update app.tax_form set file_ids = array_remove(file_ids, $2::uuid) where id = $1`, [
      form1098.id,
      shared,
    ]);
  });
});

describe('backups (§3)', () => {
  it('take the forms, their targets, waivers and files, and bring them back', async () => {
    const waiver = await owner.post(url('/tax-forms/waivers'), {
      taxYear: YEAR,
      kind: '1099_int',
      accountId: savings,
      reason: 'not_issued',
      note: 'Under $10 at the bank’s count',
    });
    expect(waiver.status).toBe(201);
    try {
      const created = await owner.post(url('/backups'), {});
      expect(created.status).toBe(201);
      await drain();
      const res = await h.app.inject({
        method: 'GET',
        url: url(`/backups/${created.body.id}/download`),
        headers: { authorization: `Bearer dev:${OWNER}` },
      });
      const zip = await readZip(res.rawPayload);
      for (const t of ['tax_form', 'tax_form_target', 'tax_form_waiver'])
        expect(zip.has(`data/${t}.jsonl`)).toBe(true);
      const manifest = JSON.parse(zip.get('manifest.json')!.toString());
      expect(manifest.files.find((f: any) => f.id === w2File)).toMatchObject({ kind: 'tax_form' });

      const boundary = '----restore';
      const upload = await h.app.inject({
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
          res.rawPayload,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      expect(upload.statusCode).toBe(201);
      const restore = JSON.parse(upload.body);
      await owner.post(`/v1/me/restores/${restore.id}/confirm`, { mode: 'new', name: 'Package again' });
      await drain();
      const done = (await owner.get(`/v1/me/restores/${restore.id}`)).body;
      expect(done).toMatchObject({ status: 'done', error: null });
      const copy = (p: string) => `/v1/workspaces/${done.targetWorkspaceId}${p}`;

      const before = (await owner.get(url(`/tax-forms?year=${YEAR}`))).body;
      const after = (await owner.get(copy(`/tax-forms?year=${YEAR}`))).body;
      const shape = (y: any) =>
        y.forms
          .map((f: any) => [
            f.kind,
            f.issuerName,
            f.boxes,
            f.result.state,
            f.targets.length,
            f.fileIds.length,
          ])
          .sort((a: any, b: any) => String(a[1]).localeCompare(String(b[1])));
      expect(shape(after)).toEqual(shape(before));
      expect(after.forms.every((f: any) => !before.forms.some((b: any) => b.id === f.id))).toBe(true);
      expect(after.waivers).toEqual([
        expect.objectContaining({
          kind: '1099_int',
          reason: 'not_issued',
          note: 'Under $10 at the bank’s count',
        }),
      ]);
      expect(after.expected.map((e: any) => [e.kind, e.name, e.state]).sort()).toEqual(
        before.expected.map((e: any) => [e.kind, e.name, e.state]).sort(),
      );
      // The file comes back under a key of the new workspace, readable through its form.
      const restoredW2 = after.forms.find((f: any) => f.issuerName === 'Acme Corp');
      const file = await h.app.inject({
        method: 'GET',
        url: copy(`/tax-forms/${restoredW2.id}/files/${restoredW2.fileIds[0]}`),
        headers: { authorization: `Bearer dev:${OWNER}` },
      });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.equals(pdf('acme-w2'))).toBe(true);
      const { rows } = await db.query(
        `select kind, retain_until::text as retain from app.file where id = $1`,
        [restoredW2.fileIds[0]],
      );
      expect(rows).toEqual([{ kind: 'tax_form', retain: '2032-12-31' }]);
    } finally {
      await owner.delete(url(`/tax-forms/waivers/${waiver.body.id}`));
    }
  });

  it('leave a member’s form file out of a partner’s backup of the books', async () => {
    const created = await partner.post(url('/backups'), { entityId: personal });
    expect(created.status).toBe(201);
    await drain();
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/backups/${created.body.id}/download`),
      headers: { authorization: `Bearer dev:${PARTNER}` },
    });
    const zip = await readZip(res.rawPayload);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    expect(manifest.partial).toBe(true);
    expect(manifest.files.some((f: any) => f.id === w2File)).toBe(false);
    expect(zip.get('data/tax_form.jsonl')!.toString()).not.toContain(w2.id);
  });
});

describe('the reminder on 16 February (TAX-10, §11)', () => {
  const at = (day: string) => new Date(`2026-02-${day}T15:00:00Z`);
  const reminders = async (email: string) =>
    (
      await db.query(
        `select title, body, link from app.notification
          where workspace_id = $1 and user_id = $2 and type = 'tax_forms_missing'`,
        [wsId, await userId(email)],
      )
    ).rows;
  const sweep = async (day: string, workspaceId = wsId) => {
    const { rows } = await db.query(`select user_id from app.workspace_active_members($1::uuid)`, [
      workspaceId,
    ]);
    for (const r of rows)
      await h.app.get(NotificationJobs).forMember({ workspaceId, userId: r.user_id }, at(day));
  };

  it('waits for 16 February', async () => {
    await sweep('15');
    expect(await reminders(OWNER)).toEqual([]);
  });

  it('lists last year’s missing forms once, each person seeing only theirs', async () => {
    await sweep('16');
    const mine = await reminders(OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe('2 tax forms for 2025 haven’t come yet');
    expect(mine[0].body).toContain('W-2 from Beta LLC, for Sam Rivera');
    expect(mine[0].body).toContain('1099-INT from Savings');
    expect(mine[0].body).not.toMatch(/\$|\d+\.\d\d/);
    expect(mine[0].link).toBe(`/w/${wsId}/tax-forms?year=2025`);
    // The member hears about their own W-2; the accountant, who can't see employers, doesn't.
    const sams = await reminders(MEMBER);
    expect(sams).toHaveLength(1);
    expect(sams[0].body).toContain('W-2 from Beta LLC');
    const cpas = await reminders(CPA);
    expect(cpas.every((n: any) => !n.body.includes('Beta'))).toBe(true);

    await sweep('16');
    await sweep('17');
    expect(await reminders(OWNER)).toHaveLength(1);
    expect(await reminders(MEMBER)).toHaveLength(1);
  });

  it('sends nothing when nothing is missing', async () => {
    const quiet = (await owner.post('/v1/workspaces', { name: 'All here', baseCurrency: 'USD' })).body.id;
    const here = (p: string) => `/v1/workspaces/${quiet}${p}`;
    const books = (await owner.get(here('/entities'))).body.data[0].id;
    const bank = (
      await owner.post(here('/accounts'), {
        name: 'Checking',
        kind: 'checking',
        entityId: books,
        openingBalance: usd('100000'),
        openingDate: '2024-01-01',
      })
    ).body.id;
    const me = (await owner.post(here('/family-members'), { name: 'Pat', relationship: 'self' })).body.id;
    const job = (
      await owner.post(here('/employers'), {
        memberId: me,
        name: 'Gamma Inc',
        payFrequency: 'monthly',
        depositAccountId: bank,
      })
    ).body.id;
    await payslip(job, '2025-05-31', here);
    const received = await owner.post(here('/tax-forms'), {
      kind: 'w2',
      taxYear: YEAR,
      issuerName: 'Gamma Inc',
      targets: [{ employerId: job }],
      boxes: { box1: '500000', box2: '70000' },
    });
    expect(received.status).toBe(201);
    const y = (await owner.get(here(`/tax-forms?year=${YEAR}`))).body;
    expect(y.expected.map((e: any) => e.state)).toEqual(['received']);
    await sweep('16', quiet);
    const { rows } = await db.query(
      `select 1 from app.notification where workspace_id = $1 and type = 'tax_forms_missing'`,
      [quiet],
    );
    expect(rows).toEqual([]);
  });
});
