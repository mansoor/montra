/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { PDFDocument } from 'pdf-lib';
import { addDays, todayIn } from '@montra/domain';
import { BackupService } from '../src/data/backup.service.js';
import { RestoreService } from '../src/data/restore.service.js';
import { Worker } from '../src/jobs/queue.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Payroll, stage 1: people and onboarding forms (PRL-01..05; ADR-0032). Only made-up people and never-issued test SSNs
// (the 9xx range) appear here.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const today = todayIn('UTC');
const EMAIL = 'payroll-owner@example.test';
const PARTNER = 'payroll-partner@example.test';
const ACCOUNTANT = 'payroll-accountant@example.test';
const SSN = '900-12-3456';
const EIN = '98-7654321';
const ROUTING = '011000015'; // a valid checksum
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/iZvQWQAAAABJRU5ErkJggg==',
  'base64',
);

let h: Harness;
let c: Client;
let partner: Client;
let accountant: Client;
let admin: pg.Client;
let worker: Worker;
let storage: StoragePort;
let url: (p: string) => string;
let wsId: string;
let biz: string;
let employee: any;
let contractor: any;

const auth = (email = EMAIL) => ({ authorization: `Bearer dev:${email}` });

async function uploadCopy(entityId = biz, bytes = PNG, email = EMAIL) {
  const boundary = '----montra-payroll';
  const res = await h.app.inject({
    method: 'POST',
    url: url(`/payroll/files?entityId=${entityId}`),
    headers: { ...auth(email), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="licence.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function raw(path: string, email = EMAIL) {
  const res = await h.app.inject({ method: 'GET', url: url(path), headers: auth(email) });
  return { status: res.statusCode, bytes: res.rawPayload, headers: res.headers };
}

const audits = async (action: string) =>
  (
    await admin.query(
      `select subject_id, diff from app.audit_log where workspace_id = $1 and action = $2 order by id`,
      [wsId, action],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(BackupService).register();
  h.app.get(RestoreService).register();
  worker = h.app.get(Worker);
  storage = h.app.get(STORAGE_PORT) as StoragePort;
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  accountant = h.as(ACCOUNTANT);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Payroll', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (await c.post(url('/entities'), { type: 'business', name: 'Harbor Bakery', businessType: 'llc' }))
    .body.id;
  await c.patch(url(`/businesses/${biz}`), {
    legalName: 'Harbor Bakery LLC',
    address: '5 Dock Rd\nPortland, ME 04101',
  });
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
  const acc = await c.post(url('/sharing/invites'), {
    email: ACCOUNTANT,
    role: 'accountant',
    entityGrants: [{ entityId: biz, access: 'read' }],
  });
  await accountant.post(`/v1/invites/${acc.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('people (PRL-01, PRL-05)', () => {
  it('adds an employee, sealing the SSN, birth date and bank details and showing them masked', async () => {
    const res = await c.post(url('/payroll/people'), {
      entityId: biz,
      kind: 'employee',
      firstName: 'Avery',
      middleName: 'Quinn',
      lastName: 'Testperson',
      email: 'avery@example.test',
      address: { line1: '12 Fern St', city: 'Portland', region: 'me', postalCode: '04102' },
      tin: { type: 'ssn', value: SSN },
      birthDate: '1990-04-02',
      hireDate: addDays(today, -30),
      payType: 'hourly',
      rate: '2250',
      workState: 'me',
      bank: { routing: ROUTING, account: '000123456789', accountType: 'checking' },
    });
    expect(res.status).toBe(201);
    employee = res.body;
    expect(employee).toMatchObject({
      kind: 'employee',
      displayName: 'Avery Quinn Testperson',
      tinMasked: '•••-••-3456',
      hasBirthDate: true,
      status: 'active',
      payType: 'hourly',
      rate: '2250',
      workState: 'ME',
      address: { region: 'me', country: 'US' },
      bank: { accountType: 'checking', last4: '6789' },
      vendorPartyId: null,
      onboarding: { w4: null, w9: null, i9: null },
    });
    expect(JSON.stringify(employee)).not.toContain('123456');
    const row = (
      await admin.query(
        `select tin_enc, tin_last4, birth_date_enc, bank_account_enc from app.payroll_person where id = $1`,
        [employee.id],
      )
    ).rows[0];
    expect(row.tin_last4).toBe('3456');
    for (const v of [row.tin_enc, row.birth_date_enc, row.bank_account_enc]) {
      expect(Buffer.isBuffer(v)).toBe(true);
      expect(v.toString('latin1')).not.toMatch(/900123456|1990-04-02|000123456789/);
    }
    // The audit trigger never copies a sealed value.
    const created = (
      await admin.query(
        `select diff from app.audit_log where subject_id = $1 and action = 'payroll_person.insert'`,
        [employee.id],
      )
    ).rows[0].diff;
    expect(created.tin_enc).toBe('[redacted]');
  });

  it('refuses a bad tax ID or routing number', async () => {
    const base = { entityId: biz, kind: 'employee', firstName: 'No', lastName: 'Good' };
    expect(
      (await c.post(url('/payroll/people'), { ...base, tin: { type: 'ssn', value: '000-12-3456' } })).status,
    ).toBe(400);
    expect(
      (await c.post(url('/payroll/people'), { ...base, tin: { type: 'ssn', value: '12345' } })).status,
    ).toBe(400);
    const bank = { routing: '011000016', account: '1234', accountType: 'checking' };
    expect((await c.post(url('/payroll/people'), { ...base, bank })).status).toBe(400);
    const dates = { ...base, hireDate: today, endDate: addDays(today, -1) };
    expect((await c.post(url('/payroll/people'), dates)).status).toBe(422);
  });

  it('adds a contractor as a vendor of the business, so bills can pay them', async () => {
    const res = await c.post(url('/payroll/people'), {
      entityId: biz,
      kind: 'contractor',
      firstName: 'Rowan',
      lastName: 'Sampleton',
      businessName: 'Sampleton Design',
      tin: { type: 'ein', value: EIN },
    });
    expect(res.status).toBe(201);
    contractor = res.body;
    expect(contractor).toMatchObject({ displayName: 'Sampleton Design', tinMasked: '••-•••4321' });
    const vendors = (await c.get(url(`/parties?entityId=${biz}&kind=vendor`))).body.data;
    expect(vendors.find((v: any) => v.id === contractor.vendorPartyId).name).toBe('Sampleton Design');
    // The directory isn't where people live: employees aren't vendors.
    expect(vendors.some((v: any) => v.name.includes('Avery'))).toBe(false);
  });

  it('lists people by kind', async () => {
    const all = (await c.get(url(`/payroll/people?entityId=${biz}`))).body.data;
    expect(all.map((p: any) => p.lastName)).toEqual(['Sampleton', 'Testperson']);
    const employees = (await c.get(url(`/payroll/people?entityId=${biz}&kind=employee`))).body.data;
    expect(employees.map((p: any) => p.id)).toEqual([employee.id]);
  });

  it('updates details with the version, and clears the bank account with null', async () => {
    const stale = await c.patch(url(`/payroll/people/${employee.id}`), { phone: '555-0100', version: 99 });
    expect(stale.status).toBe(409);
    const res = await c.patch(url(`/payroll/people/${employee.id}`), {
      phone: '555-0100',
      bank: null,
      version: employee.version,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '555-0100', bank: null, tinMasked: '•••-••-3456' });
    employee = res.body;
  });

  it('reveals one full value, logged in the audit log', async () => {
    const res = await c.post(url(`/payroll/people/${employee.id}/reveal`), { field: 'tin' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('900123456');
    expect(
      (await c.post(url(`/payroll/people/${employee.id}/reveal`), { field: 'birthDate' })).body.value,
    ).toBe('1990-04-02');
    const logged = await audits('payroll.revealed');
    expect(logged.map((r: any) => r.diff.field)).toEqual(['tin', 'birthDate']);
    expect(logged[0].subject_id).toBe(employee.id);
  });

  it('shows nothing to a partner without a grant, or to a read-only accountant', async () => {
    for (const who of [partner, accountant]) {
      const list = await who.get(url(`/payroll/people?entityId=${biz}`));
      expect(list.status === 404 || list.status === 403).toBe(true);
      expect((await who.get(url(`/payroll/people/${employee.id}`))).status).toBe(404);
      const reveal = await who.post(url(`/payroll/people/${employee.id}/reveal`), { field: 'tin' });
      expect(reveal.status).toBe(404);
    }
    // The accountant can read the business, so they're told why rather than shown an empty list.
    const res = await accountant.get(url(`/payroll/people?entityId=${biz}`));
    expect(res).toMatchObject({ status: 403, body: { code: 'payroll.no_access' } });
    const rls = await admin.query(
      `select count(*)::int as n from app.payroll_person where workspace_id = $1`,
      [wsId],
    );
    expect(rls.rows[0].n).toBe(2);
  });
});

describe('W-4 and W-9 (PRL-02, PRL-03)', () => {
  let w4: any;

  it('records a W-4 as signed, keeping the SSN and address it was signed with', async () => {
    const res = await c.post(url(`/payroll/people/${employee.id}/w4`), {
      effectiveDate: addDays(today, -30),
      filingStatus: 'married_jointly',
      multipleJobs: true,
      dependents: '400000',
      extraWithholding: '2500',
      signedName: 'Avery Q Testperson',
      signedOn: addDays(today, -31),
      attested: true,
    });
    expect(res.status).toBe(201);
    w4 = res.body;
    expect(w4).toMatchObject({
      filingStatus: 'married_jointly',
      multipleJobs: true,
      dependents: '400000',
      otherIncome: '0',
      extraWithholding: '2500',
      tinMasked: '•••-••-3456',
      address: '12 Fern St\nPortland, me 04102',
      current: true,
    });
    const unattested = await c.post(url(`/payroll/people/${employee.id}/w4`), {
      effectiveDate: today,
      filingStatus: 'single',
      signedName: 'x',
      signedOn: today,
    });
    expect(unattested.status).toBe(400);
  });

  it('lets a later W-4 take over from its date, and keeps the history', async () => {
    const later = await c.post(url(`/payroll/people/${employee.id}/w4`), {
      effectiveDate: addDays(today, 10),
      filingStatus: 'single',
      signedName: 'Avery Q Testperson',
      signedOn: today,
      attested: true,
    });
    expect(later.status).toBe(201);
    const list = (await c.get(url(`/payroll/people/${employee.id}/w4`))).body.data;
    expect(list.map((w: any) => [w.filingStatus, w.current])).toEqual([
      ['single', false],
      ['married_jointly', true],
    ]);
    const person = (await c.get(url(`/payroll/people/${employee.id}`))).body;
    expect(person.onboarding.w4).toMatchObject({ id: w4.id, filingStatus: 'married_jointly' });
    const twice = await c.post(url(`/payroll/people/${employee.id}/w4`), {
      effectiveDate: addDays(today, 10),
      filingStatus: 'single',
      signedName: 'x',
      signedOn: today,
      attested: true,
    });
    expect(twice.status).toBe(409);
    expect(
      (await c.post(url(`/payroll/people/${contractor.id}/w4`), { ...later, attested: true })).status,
    ).toBe(400);
  });

  it('renders the W-4 as a PDF, and logs the download', async () => {
    const res = await raw(`/payroll/people/${employee.id}/w4/${w4.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
    expect((await PDFDocument.load(res.bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
    const logged = await audits('payroll.form_downloaded');
    expect(logged.at(-1).diff).toEqual({ form: 'w4', id: w4.id });
  });

  it('records a W-9, which updates the contractor’s TIN to the one certified', async () => {
    const res = await c.post(url(`/payroll/people/${contractor.id}/w9`), {
      legalName: 'Rowan Sampleton',
      businessName: 'Sampleton Design',
      taxClassification: 'individual',
      address: '9 Pine Ave\nBangor, ME 04401',
      tin: { type: 'ssn', value: '900-55-1212' },
      signedName: 'Rowan Sampleton',
      signedOn: today,
      attested: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tinType: 'ssn', tinMasked: '•••-••-1212', current: true });
    const person = (await c.get(url(`/payroll/people/${contractor.id}`))).body;
    expect(person).toMatchObject({ tinType: 'ssn', tinMasked: '•••-••-1212' });
    expect(person.onboarding.w9.id).toBe(res.body.id);
    const pdf = await raw(`/payroll/people/${contractor.id}/w9/${res.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    const reveal = await c.post(url(`/payroll/people/${contractor.id}/reveal`), {
      field: 'w9.tin',
      recordId: res.body.id,
    });
    expect(reveal.body.value).toBe('900551212');
  });
});

describe('I-9 (PRL-04)', () => {
  let i9: any;

  it('takes Section 1 with the attestation, and needs the A-Number of a permanent resident', async () => {
    const section1 = {
      lastName: 'Testperson',
      firstName: 'Avery',
      middleInitial: 'Q',
      address: '12 Fern St',
      city: 'Portland',
      state: 'ME',
      zip: '04102',
      birthDate: '1990-04-02',
      ssn: SSN,
      citizenship: 'permanent_resident',
      signedName: 'Avery Q Testperson',
      signedOn: addDays(today, -30),
      attested: true,
    };
    expect(
      (await c.put(url(`/payroll/people/${employee.id}/i9/section1`), { ...section1, aNumber: null })).status,
    ).toBe(422);
    const res = await c.put(url(`/payroll/people/${employee.id}/i9/section1`), {
      ...section1,
      aNumber: 'A123456789',
    });
    expect(res.status).toBe(200);
    i9 = res.body;
    expect(i9.section1).toMatchObject({ ssnMasked: '•••-••-3456', hasANumber: true, hasBirthDate: true });
    expect(i9.status).toMatchObject({
      section1: true,
      section2: false,
      documents: 0,
      retainUntil: null,
      mayDestroy: false,
    });
    expect(JSON.stringify(i9)).not.toContain('A123456789');
    expect((await c.put(url(`/payroll/people/${contractor.id}/i9/section1`), section1)).status).toBe(422);
  });

  it('keeps copies of documents sealed in storage, and serves them only through the I-9, logged', async () => {
    const up = await uploadCopy();
    expect(up.status).toBe(201);
    const fileId = up.body.fileId;
    const file = (
      await admin.query(`select storage_key, sealed, sha256, bytes from app.file where id = $1`, [fileId])
    ).rows[0];
    expect(file.sealed).toBe(true);
    expect(Number(file.bytes)).toBe(PNG.length);
    const stored = Buffer.from(await storage.get(file.storage_key));
    expect(stored.equals(PNG)).toBe(false);
    expect(stored.includes(PNG.subarray(0, 8))).toBe(false);

    const res = await c.post(url(`/payroll/people/${employee.id}/i9/documents`), {
      list: 'A',
      title: 'Permanent Resident Card (Form I-551)',
      issuingAuthority: 'USCIS',
      number: 'XYZ0012345',
      expiresOn: addDays(today, 3650),
      fileIds: [fileId],
    });
    expect(res.status).toBe(201);
    const doc = res.body.documents[0];
    expect(doc).toMatchObject({
      list: 'A',
      numberMasked: '•••• 2345',
      files: [{ id: fileId, mime: 'image/png' }],
    });
    // A copy can't be on two documents, and a file that isn't sealed can't be a copy.
    const again = await c.post(url(`/payroll/people/${employee.id}/i9/documents`), {
      list: 'C',
      title: 'Social Security card',
      fileIds: [fileId],
    });
    expect(again.status).toBe(422);

    const served = await raw(`/payroll/people/${employee.id}/i9/documents/${doc.id}/files/${fileId}`);
    expect(served.status).toBe(200);
    expect(served.bytes.equals(PNG)).toBe(true);
    expect((await audits('payroll.document_viewed')).at(-1).diff).toEqual({ document: doc.id, file: fileId });
    const other = await raw(`/payroll/people/${contractor.id}/i9/documents/${doc.id}/files/${fileId}`);
    expect(other.status).toBe(404);
    const reveal = await c.post(url(`/payroll/people/${employee.id}/reveal`), {
      field: 'i9.document',
      recordId: doc.id,
    });
    expect(reveal.body.value).toBe('XYZ0012345');
  });

  it('signs Section 2 once the documents are recorded, and then locks Section 1', async () => {
    const current = (await c.get(url(`/payroll/people/${employee.id}/i9`))).body.data;
    const body = {
      firstDay: addDays(today, -30),
      signedName: 'Morgan Owner',
      title: 'Owner',
      signedOn: addDays(today, -29),
      businessName: 'Harbor Bakery LLC',
      businessAddress: '5 Dock Rd, Portland, ME 04101',
      examinedOriginals: true,
      version: current.version,
    };
    expect(
      (await c.put(url(`/payroll/people/${employee.id}/i9/section2`), { ...body, examinedOriginals: false }))
        .status,
    ).toBe(400);
    const res = await c.put(url(`/payroll/people/${employee.id}/i9/section2`), body);
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ section1: true, section2: true, documents: 1 });
    expect(res.body.status.section2Due).toBeTruthy();
    const relock = await c.put(url(`/payroll/people/${employee.id}/i9/section1`), {
      lastName: 'Changed',
      firstName: 'Avery',
      citizenship: 'citizen',
      signedName: 'x',
      signedOn: today,
      attested: true,
    });
    expect(relock).toMatchObject({ status: 409, body: { code: 'payroll.i9_signed' } });
    const pdf = await raw(`/payroll/people/${employee.id}/i9/pdf`);
    expect(pdf.status).toBe(200);
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1);
  });

  it('keeps the I-9 for 3 years after hire or 1 year after leaving, whichever is later', async () => {
    const refuse = await c.delete(url(`/payroll/people/${employee.id}/i9`));
    expect(refuse).toMatchObject({ status: 409, body: { code: 'payroll.i9_retained' } });
    expect((await c.delete(url(`/payroll/people/${employee.id}`))).status).toBe(409);
    // Left last week: the hire date + 3 years is later.
    const p = (await c.get(url(`/payroll/people/${employee.id}`))).body;
    const ended = await c.patch(url(`/payroll/people/${employee.id}`), {
      endDate: addDays(today, -7),
      version: p.version,
    });
    expect(ended.body.status).toBe('ended');
    expect(ended.body.onboarding.i9).toMatchObject({ mayDestroy: false });
    expect(ended.body.onboarding.i9.retainUntil > addDays(today, 365 * 2)).toBe(true);
    expect((await c.delete(url(`/payroll/people/${employee.id}/i9`))).status).toBe(409);
  });

  it('lets the I-9 and its copies go once the period is over', async () => {
    // Someone hired and gone long ago.
    const old = (
      await c.post(url('/payroll/people'), {
        entityId: biz,
        kind: 'employee',
        firstName: 'Former',
        lastName: 'Sample',
        hireDate: '2019-01-07',
        endDate: '2021-06-30',
      })
    ).body;
    await c.put(url(`/payroll/people/${old.id}/i9/section1`), {
      lastName: 'Sample',
      firstName: 'Former',
      citizenship: 'citizen',
      signedName: 'Former Sample',
      signedOn: '2019-01-07',
      attested: true,
    });
    const up = await uploadCopy();
    await c.post(url(`/payroll/people/${old.id}/i9/documents`), {
      list: 'A',
      title: 'U.S. Passport',
      fileIds: [up.body.fileId],
    });
    const key = (await admin.query(`select storage_key from app.file where id = $1`, [up.body.fileId]))
      .rows[0].storage_key;
    const person = (await c.get(url(`/payroll/people/${old.id}`))).body;
    expect(person.onboarding.i9).toMatchObject({ retainUntil: '2022-06-30', mayDestroy: true });
    expect((await c.delete(url(`/payroll/people/${old.id}/i9`))).status).toBe(204);
    expect(
      (await admin.query(`select count(*)::int as n from app.file where id = $1`, [up.body.fileId])).rows[0]
        .n,
    ).toBe(0);
    await expect(storage.get(key)).rejects.toThrow();
    expect((await c.delete(url(`/payroll/people/${old.id}`))).status).toBe(204);
  });
});

describe('backup and restore (ADR-0032 §3)', () => {
  function readZip(bytes: Buffer): Promise<Map<string, Buffer>> {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        const out = new Map<string, Buffer>();
        zip.on('entry', (entry: yauzl.Entry) => {
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return reject(e);
            const chunks: Buffer[] = [];
            stream.on('data', (ch: Buffer) => chunks.push(ch));
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
  const drain = () => worker.drain(['report'], 50);

  it('puts personal data and copies in the archive readable, and seals them again on restore', async () => {
    const created = await c.post(url('/backups'), {});
    expect(created.status).toBe(201);
    await drain();
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/backups/${created.body.id}/download`),
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const zip = await readZip(res.rawPayload);
    const people = zip.get('data/payroll_person.jsonl')!.toString();
    expect(people).toContain('900123456');
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    const copy = manifest.files.find((f: any) => f.sealed);
    expect(copy).toBeTruthy();
    expect(zip.get(copy.path)!.equals(PNG)).toBe(true);

    const boundary = '----montra-restore';
    const up = await h.app.inject({
      method: 'POST',
      url: '/v1/me/restores',
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        res.rawPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(up.statusCode).toBe(201);
    const restoreId = JSON.parse(up.body).id;
    expect(
      (await c.post(`/v1/me/restores/${restoreId}/confirm`, { mode: 'new', name: 'Payroll again' })).status,
    ).toBe(200);
    await drain();
    const done = (await c.get(`/v1/me/restores/${restoreId}`)).body;
    expect(done).toMatchObject({ status: 'done', error: null });
    const other = (p: string) => `/v1/workspaces/${done.targetWorkspaceId}${p}`;
    const entities = (await c.get(other('/entities'))).body.data;
    const copyBiz = entities.find((e: any) => e.type === 'business').id;
    const list = (await c.get(other(`/payroll/people?entityId=${copyBiz}&kind=employee`))).body.data;
    const avery = list.find((p: any) => p.lastName === 'Testperson');
    expect(avery.tinMasked).toBe('•••-••-3456');
    const reveal = await c.post(other(`/payroll/people/${avery.id}/reveal`), { field: 'tin' });
    expect(reveal.body.value).toBe('900123456');
    const i9 = (await c.get(other(`/payroll/people/${avery.id}/i9`))).body.data;
    const doc = i9.documents[0];
    const fileId = doc.files[0].id;
    const sealed = (await admin.query(`select sealed, storage_key from app.file where id = $1`, [fileId]))
      .rows[0];
    expect(sealed.sealed).toBe(true);
    expect(Buffer.from(await storage.get(sealed.storage_key)).equals(PNG)).toBe(false);
    const served = await h.app.inject({
      method: 'GET',
      url: other(`/payroll/people/${avery.id}/i9/documents/${doc.id}/files/${fileId}`),
      headers: auth(),
    });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(PNG)).toBe(true);
  });
});
