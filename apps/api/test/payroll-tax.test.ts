/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { NotificationJobs } from '../src/notifications/notification-jobs.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Payroll, stage 3: employer tax (PRL-12..16; ADR-0034 §7). Made-up people and never-issued test SSNs only. The run is
// in June 2026, so the 2026 tables apply whatever today is; statuses that depend on today aren't pinned.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const EMAIL = 'payroll-tax@example.test';
const ACCOUNTANT = 'payroll-tax-accountant@example.test';

let h: Harness;
let c: Client;
let accountant: Client;
let admin: pg.Client;
let url: (p: string) => string;
let wsId: string;
let biz: string;
let checking: string;
let schedule: any;
let casey: any;
let run: any;

const taxes = (pc: any, kind: string) =>
  Object.fromEntries(pc.lines.filter((l: any) => l.kind === kind).map((l: any) => [l.code, l.amount]));
const lineOf = (w: any, line: string) => w.lines.find((l: any) => l.line === line);
const postings = async (transactionId: string) =>
  (
    await admin.query(
      `select a.name, p.amount_minor::text as amount
         from app.posting p join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         join app.ledger_account a on a.id = p.ledger_account_id
        where je.transaction_id = $1 order by a.name`,
      [transactionId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  accountant = h.as(ACCOUNTANT);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Tax', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (await c.post(url('/entities'), { type: 'business', name: 'Tide Pool Cafe', businessType: 'llc' }))
    .body.id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Cafe checking',
      kind: 'checking',
      openingBalance: { amount: '5000000', currency: 'USD' },
      openingDate: '2026-01-01',
      entityId: biz,
    })
  ).body.id;
  const acc = await c.post(url('/sharing/invites'), {
    email: ACCOUNTANT,
    role: 'accountant',
    entityGrants: [{ entityId: biz, access: 'read' }],
  });
  await accountant.post(`/v1/invites/${acc.body.token}/accept`);
  schedule = (
    await c.post(url('/payroll/schedules'), {
      entityId: biz,
      name: 'Every other Friday',
      frequency: 'biweekly',
      anchorDate: '2026-01-05',
      payLagDays: 5,
      payFromAccountId: checking,
    })
  ).body;
  casey = (
    await c.post(url('/payroll/people'), {
      entityId: biz,
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
    })
  ).body;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('payroll tax settings', () => {
  it('starts on the defaults, saves the employer numbers and rates, and checks the version', async () => {
    const start = (await c.get(url(`/payroll/settings?entityId=${biz}`))).body;
    expect(start).toMatchObject({
      einMasked: null,
      caEmployerAccountMasked: null,
      caUiRate: null,
      caUiRateDefault: '3.4',
      caEttRate: '0.1',
      federalDepositSchedule: 'monthly',
      caDepositSchedule: 'quarterly',
      version: 0,
    });
    expect(start.taxYears).toContain(2026);
    // ADR-0037: the employer's numbers are the business's registrations; payroll reads them, masked.
    const numbers = await c.patch(url(`/businesses/${biz}`), {
      ein: '12-3456789',
      caEmployerAccount: '123-4567-8',
    });
    expect(numbers.status).toBe(200);
    const res = await c.put(url(`/payroll/settings?entityId=${biz}`), { caUiRate: '2.5', version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      einMasked: '••-•••6789',
      caEmployerAccountMasked: '••••5678',
      caUiRate: '2.5',
      version: 1,
    });
    const stale = await c.put(url(`/payroll/settings?entityId=${biz}`), { caUiRate: '3', version: 0 });
    expect(stale.status).toBe(409);
    const bad = await c.patch(url(`/businesses/${biz}`), { ein: '12-345' });
    expect(bad.status).toBe(400);
    // An accountant with read access sees the settings but can't change them.
    expect((await accountant.get(url(`/payroll/settings?entityId=${biz}`))).body.caUiRate).toBe('2.5');
    const refused = await accountant.put(url(`/payroll/settings?entityId=${biz}`), {
      caUiRate: '1',
      version: 1,
    });
    expect(refused.status).toBe(403);
  });
});

describe('the DE 4 (PRL-14)', () => {
  it('records California allowances as signed, and makes a PDF', async () => {
    await c.post(url(`/payroll/people/${casey.id}/w4`), {
      effectiveDate: '2026-01-05',
      filingStatus: 'married_jointly',
      signedName: 'Casey Exampleton',
      signedOn: '2026-01-05',
      attested: true,
    });
    const res = await c.post(url(`/payroll/people/${casey.id}/de4`), {
      effectiveDate: '2026-01-05',
      filingStatus: 'married',
      allowances: 2,
      signedName: 'Casey Exampleton',
      signedOn: '2026-01-05',
      attested: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filingStatus: 'married',
      allowances: 2,
      estimatedDeductionAllowances: 0,
      tinMasked: '•••-••-1234',
      current: true,
    });
    const twice = await c.post(url(`/payroll/people/${casey.id}/de4`), {
      effectiveDate: '2026-01-05',
      filingStatus: 'single',
      signedName: 'Casey Exampleton',
      signedOn: '2026-01-05',
      attested: true,
    });
    expect(twice.body.code).toBe('payroll.de4_exists');
    const pdf = await h.app.inject({
      method: 'GET',
      url: url(`/payroll/people/${casey.id}/de4/${res.body.id}/pdf`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(pdf.statusCode).toBe(200);
    expect((await PDFDocument.load(pdf.rawPayload)).getPageCount()).toBe(1);
    // A DE 4 is personal data: to an accountant with read access, the person isn't there at all.
    expect((await accountant.get(url(`/payroll/people/${casey.id}/de4`))).status).toBe(404);
  });
});

describe('taxes worked out on a pay run (PRL-12..14)', () => {
  it('withholds from the W-4 and DE 4 and treats each kind of before-tax deduction as the law does', async () => {
    run = (
      await c.post(url('/payroll/runs'), { entityId: biz, scheduleId: schedule.id, periodDate: '2026-06-15' })
    ).body;
    const pc = run.paychecks[0];
    const res = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${pc.id}`), {
      preTaxDeductions: [
        { code: 'section125', label: 'Health plan', amount: '10000' },
        { code: 'retirement', label: '401(k)', amount: '20000' },
      ],
      version: pc.version,
    });
    expect(res.status).toBe(200);
    run = res.body;
    const p = run.paychecks[0];
    // $3,000 a period. Income-tax wages $2,700 (both deductions out); FICA, SDI and UI wages $2,900 (401(k) stays in).
    // FIT, married filing jointly: 2,700 × 26 = 70,200 − 12,900 = 57,300; 2,480 + 12% × 13,200 = 4,064; / 26 = 156.31.
    // CA, married with 2 allowances: 2,700 − 439 = 2,261; 35.07 + 4.4% × 241 = 45.67; less 12.95 = 32.72.
    expect(taxes(p, 'employee_tax')).toEqual({
      fit: '15631',
      ss: '17980',
      medicare: '4205',
      ca_pit: '3272',
      ca_sdi: '3770',
    });
    // UI at the business's 2.5%, ETT 0.1%, FUTA 0.6%.
    expect(taxes(p, 'employer_tax')).toEqual({
      ss_er: '17980',
      medicare_er: '4205',
      futa: '1740',
      ca_ui: '7250',
      ca_ett: '290',
    });
    expect(p).toMatchObject({ gross: '300000', preTax: '30000', employeeTaxes: '44858', net: '225142' });
    expect(p.taxNotes).toEqual([]);
  });

  it('says when another state’s taxes need entering', async () => {
    const before = (await c.get(url(`/payroll/people/${casey.id}`))).body;
    await c.patch(url(`/payroll/people/${casey.id}`), { workState: 'NV', version: before.version });
    const pc = run.paychecks[0];
    const r = (await c.patch(url(`/payroll/runs/${run.id}/paychecks/${pc.id}`), { version: pc.version }))
      .body;
    expect(r.paychecks[0].taxNotes).toEqual([
      'Montra works out California taxes only. Enter NV taxes on this paycheck.',
    ]);
    expect(taxes(r.paychecks[0], 'employee_tax').ca_pit).toBeUndefined();
    const now = (await c.get(url(`/payroll/people/${casey.id}`))).body;
    await c.patch(url(`/payroll/people/${casey.id}`), { workState: 'CA', version: now.version });
    run = (
      await c.patch(url(`/payroll/runs/${run.id}/paychecks/${pc.id}`), { version: r.paychecks[0].version })
    ).body;
    expect(taxes(run.paychecks[0], 'employee_tax').ca_pit).toBe('3272');
    const approved = await c.post(url(`/payroll/runs/${run.id}/approve`), {
      version: run.version,
      confirmed: true,
    });
    expect(approved.status).toBe(200);
  });
});

describe('deposits (PRL-15)', () => {
  let obligations: any[];
  const find = (tax: string, periodStart: string, status?: string) =>
    obligations.find(
      (o) =>
        o.tax === tax &&
        o.periodStart === periodStart &&
        (status ? o.status === status : o.status !== 'carried'),
    );

  it('says what to deposit and when, from approved paychecks', async () => {
    obligations = (await c.get(url(`/payroll/taxes?entityId=${biz}&year=2026`))).body.obligations;
    // Monthly depositor: June's 941 taxes by July 15.
    expect(find('federal_941', '2026-06-01')).toMatchObject({
      periodEnd: '2026-06-30',
      dueDate: '2026-07-15',
      amount: '60001',
      parts: { fit: '15631', ss: '17980', medicare: '4205', ss_er: '17980', medicare_er: '4205' },
      deposit: null,
      nextDay: false,
    });
    // California PIT and SDI quarterly, UI and ETT quarterly, by the end of the month after.
    expect(find('ca_pit_sdi', '2026-04-01')).toMatchObject({ dueDate: '2026-07-31', amount: '7042' });
    expect(find('ca_ui_ett', '2026-04-01')).toMatchObject({ dueDate: '2026-07-31', amount: '7540' });
    // FUTA of $17.40 is under $500, so it's carried to the fourth quarter, which also owes California's provisional
    // 1.5% credit reduction on the $2,900: due with Form 940.
    expect(find('federal_940', '2026-04-01', 'carried')).toMatchObject({ amount: '1740' });
    expect(find('federal_940', '2026-04-01')).toMatchObject({
      periodEnd: '2026-12-31',
      dueDate: '2027-02-01',
      amount: '6090',
      parts: { futa: '1740', futa_credit_reduction: '4350' },
    });
    // An accountant reads what's owed.
    expect((await accountant.get(url(`/payroll/taxes?entityId=${biz}&year=2026`))).status).toBe(200);
  });

  it('records a deposit, which takes withholding out of its liability and expenses the employer’s share', async () => {
    const future = await c.post(url('/payroll/deposits'), {
      entityId: biz,
      tax: 'federal_941',
      periodStart: '2026-06-01',
      paidOn: '2099-01-01',
      payFromAccountId: checking,
    });
    expect(future.body.code).toBe('payroll.deposit_future');
    const refused = await accountant.post(url('/payroll/deposits'), {
      entityId: biz,
      tax: 'federal_941',
      periodStart: '2026-06-01',
      paidOn: '2026-07-14',
      payFromAccountId: checking,
    });
    expect(refused.status).toBe(403);
    const res = await c.post(url('/payroll/deposits'), {
      entityId: biz,
      tax: 'federal_941',
      periodStart: '2026-06-01',
      paidOn: '2026-07-14',
      payFromAccountId: checking,
      confirmation: '270000000000001',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: '60001',
      dueDate: '2026-07-15',
      confirmation: '270000000000001',
    });
    expect(await postings(res.body.transactionId)).toEqual([
      { name: 'Cafe checking', amount: '-60001' },
      { name: 'Federal income tax withheld', amount: '15631' },
      { name: 'Payroll taxes', amount: '22185' },
      { name: 'Social Security and Medicare owed', amount: '22185' },
    ]);
    const t = (await c.get(url(`/transactions/${res.body.transactionId}`))).body;
    expect(t).toMatchObject({ source: 'payroll', managedBy: 'payroll_deposit', payee: 'IRS (EFTPS)' });
    const again = await c.post(url('/payroll/deposits'), {
      entityId: biz,
      tax: 'federal_941',
      periodStart: '2026-06-01',
      paidOn: '2026-07-14',
      payFromAccountId: checking,
    });
    expect(again.body.code).toBe('payroll.deposit_recorded');
    obligations = (await c.get(url(`/payroll/taxes?entityId=${biz}&year=2026`))).body.obligations;
    expect(find('federal_941', '2026-06-01')).toMatchObject({ status: 'paid', difference: '0' });
  });

  it('takes a deposit back and voids its transaction', async () => {
    const r = (
      await c.post(url('/payroll/deposits'), {
        entityId: biz,
        tax: 'ca_ui_ett',
        periodStart: '2026-04-01',
        paidOn: '2026-07-20',
        payFromAccountId: checking,
      })
    ).body;
    expect(await postings(r.transactionId)).toEqual([
      { name: 'Cafe checking', amount: '-7540' },
      { name: 'Payroll taxes', amount: '7540' },
    ]);
    expect((await c.delete(url(`/payroll/deposits/${r.id}`))).status).toBe(204);
    const t = await admin.query('select status from app.transaction where id = $1', [r.transactionId]);
    expect(t.rows[0].status).toBe('void');
    obligations = (await c.get(url(`/payroll/taxes?entityId=${biz}&year=2026`))).body.obligations;
    expect(find('ca_ui_ett', '2026-04-01').deposit).toBeNull();
  });
  it('reminds about a deposit due within three days, once', async () => {
    const jobs = h.app.get(NotificationJobs);
    const at = new Date('2026-07-29T17:00:00Z');
    await jobs.nightly(wsId, at);
    await jobs.nightly(wsId, at);
    const { rows } = await admin.query(
      `select n.title, n.link from app.notification n join app.app_user u on u.id = n.user_id
        where n.workspace_id = $1 and u.email = $2 and n.title like '%deposit%' order by n.title`,
      [wsId, EMAIL],
    );
    // June's 941 is paid; California's quarter is due July 31. FUTA was carried, so nothing is due for it.
    expect(rows.map((r: any) => r.title)).toEqual([
      'California PIT and SDI deposit of $70.42 is due on 2026-07-31',
      'California UI and ETT deposit of $75.40 is due on 2026-07-31',
    ]);
    expect(rows[0].link).toBe(`/w/${wsId}/business/${biz}/payroll/taxes`);
  });
});

describe('worksheets (PRL-16)', () => {
  const sheet = async (form: string, q = '') =>
    (await c.get(url(`/payroll/worksheets/${form}?entityId=${biz}&year=2026${q}`))).body;

  it('fills in Form 941 for the quarter', async () => {
    const w = await sheet('941', '&quarter=2');
    expect(w).toMatchObject({
      form: '941',
      quarter: 2,
      dueDate: '2026-07-31',
      employer: { name: 'Tide Pool Cafe', ein: '12-3456789' },
    });
    expect(lineOf(w, '1').count).toBe(1);
    expect(lineOf(w, '2').amount).toBe('270000');
    expect(lineOf(w, '3').amount).toBe('15631');
    expect(lineOf(w, '5a').amount).toBe('290000');
    expect(lineOf(w, '5a col 2').amount).toBe('35960');
    expect(lineOf(w, '5c col 2').amount).toBe('8410');
    expect(lineOf(w, '7').amount).toBe('0');
    expect(lineOf(w, '10').amount).toBe('60001');
    expect(lineOf(w, '13').amount).toBe('60001');
    expect(lineOf(w, '14').amount).toBe('0');
    expect(w.liabilities).toEqual([
      { label: 'April', amount: '0' },
      { label: 'May', amount: '0' },
      { label: 'June', amount: '60001' },
    ]);
  });

  it('fills in Form 940 for the year, with Schedule A’s credit reduction', async () => {
    const w = await sheet('940');
    expect(w).toMatchObject({ form: '940', quarter: null, dueDate: '2027-02-01' });
    expect(lineOf(w, '3').amount).toBe('300000');
    expect(lineOf(w, '4').amount).toBe('10000');
    expect(lineOf(w, '7').amount).toBe('290000');
    expect(lineOf(w, '8').amount).toBe('1740');
    expect(lineOf(w, '11').amount).toBe('4350');
    expect(lineOf(w, '12').amount).toBe('6090');
    expect(w.notes.join(' ')).toContain('provisional');
  });

  it('fills in the DE 9 and DE 9C', async () => {
    const de9 = await sheet('de9', '&quarter=2');
    expect(de9.employer.caEmployerAccount).toBe('123-4567-8');
    expect(lineOf(de9, 'C').amount).toBe('290000');
    expect(lineOf(de9, 'D(2)')).toMatchObject({ amount: '7250', rate: '2.5' });
    expect(lineOf(de9, 'E').amount).toBe('290');
    expect(lineOf(de9, 'F').amount).toBe('3770');
    expect(lineOf(de9, 'G').amount).toBe('3272');
    expect(lineOf(de9, 'H').amount).toBe('14582');
    expect(lineOf(de9, 'J').amount).toBe('14582');
    const de9c = await sheet('de9c', '&quarter=2');
    expect(de9c.employees).toEqual([
      {
        personId: casey.id,
        name: 'Casey Exampleton',
        tinMasked: '•••-••-1234',
        subjectWages: '290000',
        pitWages: '270000',
        pitWithheld: '3272',
      },
    ]);
    expect(lineOf(de9c, 'B3').count).toBe(1);
    expect((await c.get(url(`/payroll/worksheets/w2?entityId=${biz}&year=2026`))).status).toBe(404);
  });
});
