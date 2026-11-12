/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { FieldCrypto } from '../src/crypto/crypto.service.js';
import { Db } from '../src/db/database.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Payroll, stage 4: year-end forms (PRL-17..20; ADR-0034 §7b). Made-up people and never-issued test SSNs only: 9xx
// ones through the API, and one never-issued non-9 number (group 00) sealed directly, since SSA rejects 9xx on a W-2.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const EMAIL = 'payroll-year-end@example.test';
const ACCOUNTANT = 'payroll-year-end-accountant@example.test';
const YEAR = 2026;

let h: Harness;
let c: Client;
let accountant: Client;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
let biz: string;
let checking: string;
let card: string;
let casey: any;
let rowan: any;
let sky: any;

const q = `entityId=__BIZ__&year=${YEAR}`;
const withBiz = (p: string) => p.replace('__BIZ__', biz);
const download = (path: string) =>
  h.app.inject({ method: 'GET', url: url(withBiz(path)), headers: { authorization: `Bearer dev:${EMAIL}` } });
const pages = async (bytes: Buffer) => (await PDFDocument.load(bytes)).getPageCount();

async function payBill(partyId: string, amount: string, accountId: string, date: string, category: string) {
  const bill = (
    await c.post(url('/bills'), {
      entityId: biz,
      partyId,
      billDate: date,
      dueDate: date,
      amount,
      expenseAccountId: category,
    })
  ).body;
  const paid = await c.post(url(`/bills/${bill.id}/payment`), { accountId, date, amount });
  expect(paid.status).toBe(201);
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  accountant = h.as(ACCOUNTANT);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Year end', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (await c.post(url('/entities'), { type: 'business', name: 'Tide Pool Cafe', businessType: 'llc' }))
    .body.id;
  const account = async (name: string, kind: string) =>
    (
      await c.post(url('/accounts'), {
        name,
        kind,
        openingBalance: { amount: kind === 'checking' ? '5000000' : '0', currency: 'USD' },
        openingDate: '2026-01-01',
        entityId: biz,
      })
    ).body.id;
  checking = await account('Cafe checking', 'checking');
  card = await account('Cafe card', 'credit_card');
  const acc = await c.post(url('/sharing/invites'), {
    email: ACCOUNTANT,
    role: 'accountant',
    entityGrants: [{ entityId: biz, access: 'read' }],
  });
  await accountant.post(`/v1/invites/${acc.body.token}/accept`);
  // ADR-0037: the EIN, EDD account and filing address are set on the business; the forms read them from there.
  const registrations = await c.patch(url(`/businesses/${biz}`), {
    ein: '12-3456789',
    caEmployerAccount: '123-4567-8',
    filingAddress: { line1: '1 Harbor Rd', city: 'Monterey', state: 'ca', zip: '93940' },
  });
  expect(registrations.status).toBe(200);
  const settings = await c.put(url(`/payroll/settings?entityId=${biz}`), {
    caUiRate: '2.5',
    ssaUserId: 'TEST1234',
    contactName: 'Pat Owner',
    contactPhone: '831-555-0100',
    contactEmail: 'pat@example.test',
    version: 0,
  });
  expect(settings.body).toMatchObject({
    filingAddress: { line1: '1 Harbor Rd', line2: null, city: 'Monterey', state: 'CA', zip: '93940' },
    ssaUserId: 'TEST1234',
  });
  const schedule = (
    await c.post(url('/payroll/schedules'), {
      entityId: biz,
      name: 'Every other Friday',
      frequency: 'biweekly',
      anchorDate: '2026-01-05',
      payLagDays: 5,
      payFromAccountId: checking,
    })
  ).body;
  const person = (body: object) =>
    c.post(url('/payroll/people'), { entityId: biz, ...body }).then((r) => r.body);
  casey = await person({
    kind: 'employee',
    firstName: 'Casey',
    lastName: 'Exampleton',
    hireDate: '2026-01-05',
    payType: 'salary',
    rate: '7800000',
    workState: 'CA',
    tin: { type: 'ssn', value: '900-55-1234' },
    address: { line1: '4 Kelp Way', city: 'Monterey', region: 'CA', postalCode: '93940' },
    payScheduleId: schedule.id,
  });
  const signed = { signedName: 'Casey Exampleton', signedOn: '2026-01-05', attested: true };
  await c.post(url(`/payroll/people/${casey.id}/w4`), {
    effectiveDate: '2026-01-05',
    filingStatus: 'married_jointly',
    ...signed,
  });
  await c.post(url(`/payroll/people/${casey.id}/de4`), {
    effectiveDate: '2026-01-05',
    filingStatus: 'married',
    allowances: 2,
    ...signed,
  });
  const run = (
    await c.post(url('/payroll/runs'), { entityId: biz, scheduleId: schedule.id, periodDate: '2026-06-15' })
  ).body;
  const pc = run.paychecks[0];
  const edited = (
    await c.patch(url(`/payroll/runs/${run.id}/paychecks/${pc.id}`), {
      preTaxDeductions: [
        { code: 'section125', label: 'Health plan', amount: '10000' },
        { code: 'retirement', label: '401(k)', amount: '20000' },
      ],
      version: pc.version,
    })
  ).body;
  expect(
    (await c.post(url(`/payroll/runs/${run.id}/approve`), { version: edited.version, confirmed: true }))
      .status,
  ).toBe(200);

  // Contractors: Rowan has a W-9 and is paid $2,300 by bank (plus $500 by card); Sky is paid $1,000.
  rowan = await person({
    kind: 'contractor',
    firstName: 'Rowan',
    lastName: 'Sampleton',
    tin: { type: 'ssn', value: '900-11-2222' },
  });
  sky = await person({ kind: 'contractor', firstName: 'Sky', lastName: 'Testwood' });
  const w9 = await c.post(url(`/payroll/people/${rowan.id}/w9`), {
    legalName: 'Rowan Sampleton',
    businessName: 'Sampleton Design',
    taxClassification: 'individual',
    address: '9 Dune St, Seaside, CA 93955',
    tin: { type: 'ssn', value: '900-11-2222' },
    signedName: 'Rowan Sampleton',
    signedOn: '2026-02-01',
    attested: true,
  });
  expect(w9.status).toBe(201);
  const cats = (await c.get(url('/categories'))).body.data;
  const supplies = cats.find((x: any) => x.name === 'Supplies' && x.entityId === biz).id;
  await payBill(rowan.vendorPartyId, '150000', checking, '2026-03-10', supplies);
  await payBill(rowan.vendorPartyId, '80000', checking, '2026-08-10', supplies);
  await payBill(rowan.vendorPartyId, '50000', card, '2026-09-10', supplies);
  await payBill(rowan.vendorPartyId, '99900', checking, '2025-12-30', supplies);
  await payBill(sky.vendorPartyId, '100000', checking, '2026-05-01', supplies);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('W-2s and the W-3 (PRL-17, PRL-19)', () => {
  let summary: any;

  it('works out each employee’s boxes from the year’s approved paychecks', async () => {
    const res = await c.get(url(withBiz(`/payroll/year-end?${q}`)));
    expect(res.status).toBe(200);
    summary = res.body;
    expect(summary).toMatchObject({
      year: YEAR,
      dueDate: '2027-02-01',
      employer: { name: 'Tide Pool Cafe', ein: '12-3456789', caEmployerAccount: '123-4567-8' },
    });
    // $3,000 gross: box 1 less both deductions; boxes 3 and 5 less the cafeteria plan only.
    expect(summary.w2s).toEqual([
      {
        personId: casey.id,
        name: 'Casey Exampleton',
        tinMasked: 'XXX-XX-1234',
        paychecks: 1,
        boxes: {
          box1: '270000',
          box2: '15631',
          box3: '290000',
          box4: '17980',
          box5: '290000',
          box6: '4205',
          box12D: '20000',
          retirementPlan: true,
          caSdi: '3770',
          caWages: '270000',
          caTax: '3272',
        },
      },
    ]);
    expect(summary.w3).toMatchObject({ forms: 1, boxes: { box1: '270000', box2: '15631' } });
    expect(summary.notes.join(' ')).toContain('box 12 code D');
  });

  it('gives an employee copies B, C and 2, and the employer copy D and the W-3, each logged', async () => {
    const employee = await download(`/payroll/year-end/w2/${casey.id}?${q}`);
    expect(employee.statusCode).toBe(200);
    expect(await pages(employee.rawPayload)).toBe(3);
    const employer = await download(`/payroll/year-end/w2-employer?${q}`);
    expect(employer.statusCode).toBe(200);
    expect(await pages(employer.rawPayload)).toBe(2);
    const logged = await admin.query(
      `select diff->>'form' as form from app.audit_log
        where workspace_id = $1 and action = 'payroll.form_downloaded'`,
      [wsId],
    );
    expect(logged.rows.map((r: any) => r.form)).toEqual(expect.arrayContaining(['w2', 'w2_employer']));
  });

  it('keeps year-end forms from a reader without payroll access', async () => {
    const res = await accountant.get(url(withBiz(`/payroll/year-end?${q}`)));
    expect(res).toMatchObject({ status: 403, body: { code: 'payroll.no_access' } });
  });
});

describe('1099-NECs and the 1096 (PRL-18)', () => {
  it('adds up what each contractor was paid by bank in the year, and owes a 1099-NEC from $2,000', async () => {
    const summary = (await c.get(url(withBiz(`/payroll/year-end?${q}`)))).body;
    expect(summary.necThreshold).toEqual({ amount: '200000', known: true });
    // Rowan: $1,500 + $800; the card payment and the 2025 one are left out. Sky: $1,000, under the threshold.
    expect(summary.necs).toEqual([
      {
        personId: rowan.id,
        name: 'Sampleton Design',
        tinMasked: 'XXX-XX-2222',
        nonemployeeCompensation: '230000',
        payments: 2,
        required: true,
        hasW9: true,
      },
      {
        personId: sky.id,
        name: 'Sky Testwood',
        tinMasked: null,
        nonemployeeCompensation: '100000',
        payments: 1,
        required: false,
        hasW9: false,
      },
    ]);
    expect(summary.form1096).toEqual({ forms: 1, total: '230000' });
  });

  it('gives the contractor copies B and 2, and the payer copy C and the 1096', async () => {
    const recipient = await download(`/payroll/year-end/1099/${rowan.id}?${q}`);
    expect(await pages(recipient.rawPayload)).toBe(2);
    const payer = await download(`/payroll/year-end/1099-payer?${q}`);
    expect(await pages(payer.rawPayload)).toBe(2);
  });
});

describe('the EFW2 file (PRL-20)', () => {
  it('refuses while SSA would reject it, and says why', async () => {
    const summary = (await c.get(url(withBiz(`/payroll/year-end?${q}`)))).body;
    expect(summary.efw2Problems).toEqual([
      {
        where: 'Casey Exampleton',
        message:
          'SSA doesn’t accept this SSN on a W-2: it starts with 9, 666 or 000 (an ITIN can’t be used).',
      },
    ]);
    const res = await download(`/payroll/year-end/efw2?${q}`);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('payroll.efw2_problems');
  });

  it('makes the wage file once it can be accepted', async () => {
    // A never-issued number SSA's format accepts (group 00), sealed the way the API seals SSNs.
    const owner = (await admin.query('select id from app.app_user where email = $1', [EMAIL])).rows[0].id;
    const sealed = await h.app
      .get(Db)
      .run({ workspaceId: wsId, userId: owner }, (trx) =>
        h.app.get(FieldCrypto).encrypt(trx, wsId, 'payroll_person.tin', '123006789'),
      );
    await admin.query(`update app.payroll_person set tin_enc = $1, tin_last4 = '6789' where id = $2`, [
      sealed,
      casey.id,
    ]);
    const res = await download(`/payroll/year-end/efw2?${q}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('W2REPORT_2026.txt');
    const records = res.body.split('\r\n').slice(0, -1);
    expect(records.map((r: string) => r.slice(0, 2))).toEqual(['RA', 'RE', 'RW', 'RT', 'RF']);
    for (const r of records) expect(r).toHaveLength(512);
    const rw = records[2]!;
    expect(rw.slice(2, 11)).toBe('123006789');
    expect(rw.slice(187, 198)).toBe('00000270000');
    expect(rw.slice(286, 297)).toBe('00000020000');
    const re = records[1]!;
    expect(re.slice(7, 16)).toBe('123456789');
    expect(re.slice(162, 169)).toBe('CA93940');
  });
});
