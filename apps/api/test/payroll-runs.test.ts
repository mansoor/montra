/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { addDays, payPeriodContaining, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Payroll, stage 2: pay schedules, pay runs, payslips, posting and reimbursements (PRL-06..11; ADR-0034 §6–8).
// Made-up people and never-issued test SSNs only. The built-in engine works out federal and California taxes (stage 3);
// a tax typed in by hand overrides its line. Runs are in June 2026, a year Montra has tables for.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const today = todayIn('UTC');
const EMAIL = 'payroll-runs@example.test';
const ACCOUNTANT = 'payroll-runs-accountant@example.test';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/iZvQWQAAAABJRU5ErkJggg==',
  'base64',
);
// Periods counted from a Monday well in the past, so this run's period is the one containing today.
const ANCHOR = '2026-01-05';

let h: Harness;
let c: Client;
let accountant: Client;
let admin: pg.Client;
let url: (p: string) => string;
let biz: string;
let checking: string;
let schedule: any;
let hourly: any;
let salaried: any;
let contractor: any;
let run: any;
let category: (name: string) => string;

const auth = (email = EMAIL) => ({ authorization: `Bearer dev:${email}` });
const paycheckOf = (r: any, person: any) => r.paychecks.find((p: any) => p.personId === person.id);
const line = (pc: any, code: string) => pc.lines.find((l: any) => l.code === code);

async function uploadReceipt() {
  const boundary = '----montra-receipt';
  const res = await h.app.inject({
    method: 'POST',
    url: url(`/payroll/files?entityId=${biz}&purpose=receipt`),
    headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="parking.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).fileId as string;
}

const postings = async (transactionId: string) =>
  (
    await admin.query(
      `select a.name, a.type, p.amount_minor::text as amount
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
  const ws = (await c.post('/v1/workspaces', { name: 'Pay', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (await c.post(url('/entities'), { type: 'business', name: 'Harbor Bakery', businessType: 'llc' }))
    .body.id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Bakery checking',
      kind: 'checking',
      openingBalance: { amount: '5000000', currency: 'USD' },
      openingDate: '2026-01-01',
      entityId: biz,
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  category = (name) => cats.find((x: any) => x.name === name && x.entityId === biz).id;
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

describe('pay schedules (PRL-06)', () => {
  it('makes a schedule every two weeks and works out the next period and payday', async () => {
    const res = await c.post(url('/payroll/schedules'), {
      entityId: biz,
      name: 'Every other Friday',
      frequency: 'biweekly',
      anchorDate: ANCHOR,
      payLagDays: 5,
      payFromAccountId: checking,
    });
    expect(res.status).toBe(201);
    schedule = res.body;
    const period = payPeriodContaining('biweekly', ANCHOR as any, today);
    expect(schedule.nextPeriod).toEqual({
      start: period.start,
      end: period.end,
      payDate: addDays(period.end, 5),
    });
    const bad = await c.post(url('/payroll/schedules'), {
      entityId: biz,
      name: 'From a category',
      frequency: 'monthly',
      anchorDate: ANCHOR,
      payFromAccountId: category('Supplies'),
    });
    expect(bad).toMatchObject({ status: 422, body: { code: 'payroll.pay_from_account' } });
  });

  it('puts employees on it, and refuses a contractor', async () => {
    const make = (body: object) => c.post(url('/payroll/people'), { entityId: biz, ...body });
    hourly = (
      await make({
        kind: 'employee',
        firstName: 'Avery',
        lastName: 'Testperson',
        hireDate: '2026-01-05',
        payType: 'hourly',
        rate: '2250',
        defaultHoursMilli: '80000',
        workState: 'CA',
        tin: { type: 'ssn', value: '900-12-3456' },
        address: { line1: '12 Fern St', city: 'Oakland', region: 'CA', postalCode: '94607' },
        payScheduleId: schedule.id,
      })
    ).body;
    salaried = (
      await make({
        kind: 'employee',
        firstName: 'Blake',
        lastName: 'Sample',
        hireDate: '2026-01-05',
        payType: 'salary',
        rate: '5200000',
        workState: 'CA',
        payScheduleId: schedule.id,
      })
    ).body;
    contractor = (await make({ kind: 'contractor', firstName: 'Rowan', lastName: 'Sampleton' })).body;
    expect(hourly).toMatchObject({ payScheduleId: schedule.id, defaultHoursMilli: '80000' });
    const refused = await c.patch(url(`/payroll/people/${contractor.id}`), {
      payScheduleId: schedule.id,
      version: contractor.version,
    });
    expect(refused).toMatchObject({ status: 422, body: { code: 'payroll.schedule_for_contractor' } });
    const list = (await c.get(url(`/payroll/schedules?entityId=${biz}`))).body.data;
    expect(list[0].people).toBe(2);
  });
});

describe('a pay run (PRL-07)', () => {
  it('drafts a paycheck per employee from their hours or salary, with the engine’s taxes', async () => {
    const res = await c.post(url('/payroll/runs'), {
      entityId: biz,
      scheduleId: schedule.id,
      periodDate: '2026-06-15',
    });
    expect(res.status).toBe(201);
    run = res.body;
    expect(run).toMatchObject({
      status: 'draft',
      engine: 'montra',
      payFromAccountId: checking,
      periodStart: '2026-06-08',
      periodEnd: '2026-06-21',
      payDate: '2026-06-26',
    });
    expect(run.paychecks.map((p: any) => p.personName)).toEqual(['Avery Testperson', 'Blake Sample']);
    const a = paycheckOf(run, hourly);
    expect(line(a, 'regular')).toMatchObject({
      hoursMilli: '80000',
      rate: '2250',
      amount: '180000',
      source: 'computed',
    });
    // No W-4, DE 4 or UI rate yet: single, no adjustments or allowances, and the new-employer UI rate.
    // FIT: 1,800 × 26 = 46,800 − 8,600 = 38,200; 1,240 + 12% × 18,300 = 3,436; / 26 = 132.15.
    // CA PIT: 1,800 − 219 = 1,581; 17.54 + 4.4% × 571 = 42.66. SS 6.2%, Medicare 1.45%, SDI 1.3%.
    const taxes = (pc: any, kind: string) =>
      Object.fromEntries(pc.lines.filter((l: any) => l.kind === kind).map((l: any) => [l.code, l.amount]));
    expect(taxes(a, 'employee_tax')).toEqual({
      fit: '13215',
      ss: '11160',
      medicare: '2610',
      ca_pit: '4266',
      ca_sdi: '2340',
    });
    // FUTA 0.6%, UI 3.4% and ETT 0.1% on the first $7,000.
    expect(taxes(a, 'employer_tax')).toEqual({
      ss_er: '11160',
      medicare_er: '2610',
      futa: '1080',
      ca_ui: '6120',
      ca_ett: '180',
    });
    expect(a).toMatchObject({
      gross: '180000',
      employeeTaxes: '33591',
      net: '146409',
      employerTaxes: '21150',
    });
    expect(a.taxNotes).toEqual([
      'No W-4 on file: federal tax is withheld as single with no adjustments.',
      'No DE 4 on file: California tax is withheld as single with no allowances.',
      'No UI rate entered for the business: the new-employer rate, 3.4%, is used.',
    ]);
    const b = paycheckOf(run, salaried);
    expect(line(b, 'salary').amount).toBe('200000');
    // FIT 156.15; SS 124.00; Medicare 29.00; CA PIT 2,000 − 219 = 1,781: 43.24 + 6.6% × 187 = 55.58; SDI 26.00.
    expect(b).toMatchObject({ employeeTaxes: '39073', net: '160927' });
    expect(run.totals).toMatchObject({ gross: '380000', net: '307336', paychecks: 2 });
    const again = await c.post(url('/payroll/runs'), {
      entityId: biz,
      scheduleId: schedule.id,
      periodDate: run.periodStart,
    });
    expect(again).toMatchObject({ status: 409, body: { code: 'payroll.run_exists' } });
  });

  it('takes hours, overtime, deductions and taxes entered by hand, which override the engine’s', async () => {
    const a = paycheckOf(run, hourly);
    const res = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${a.id}`), {
      hoursMilli: '75500',
      overtimeHoursMilli: '2000',
      earnings: [{ code: 'bonus', label: 'Holiday bonus', amount: '10000' }],
      preTaxDeductions: [{ code: 'retirement', label: '401(k)', amount: '9000' }],
      employeeTaxes: [
        { code: 'fit', label: 'Federal income tax', amount: '12000' },
        { code: 'ss', label: 'Social Security', amount: '11253' },
        { code: 'medicare', label: 'Medicare', amount: '2632' },
        { code: 'ca_pit', label: 'California income tax', amount: '3100' },
        { code: 'ca_sdi', label: 'California SDI', amount: '2178' },
      ],
      employerTaxes: [{ code: 'ss_er', label: 'Social Security (employer)', amount: '11253' }],
      version: a.version,
    });
    expect(res.status).toBe(200);
    const pc = paycheckOf(res.body, hourly);
    // 75.5 h × $22.50 = $1,698.75; 2 h × $33.75 = $67.50; plus $100 bonus.
    expect(line(pc, 'regular').amount).toBe('169875');
    expect(line(pc, 'overtime')).toMatchObject({ hoursMilli: '2000', rate: '3375', amount: '6750' });
    // Every employee tax was typed in. Of the employer's, Social Security was; the engine adds the rest on all
    // $1,866.25, since a 401(k) deferral stays in those wages: Medicare 27.06, FUTA 11.20, UI 63.45, ETT 1.87.
    expect(pc).toMatchObject({
      gross: '186625',
      preTax: '9000',
      employeeTaxes: '31163',
      postTax: '0',
      net: '146462',
      employerTaxes: '21611',
    });
    const badPreTax = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${a.id}`), {
      preTaxDeductions: [{ code: 'gym', label: 'Gym', amount: '100' }],
      version: pc.version,
    });
    expect(badPreTax).toMatchObject({ status: 422, body: { code: 'payroll.pre_tax_code' } });
    const stale = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${a.id}`), {
      hoursMilli: '1000',
      version: a.version,
    });
    expect(stale.status).toBe(409);
    const badTax = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${a.id}`), {
      employeeTaxes: [{ code: 'state', label: 'Made up', amount: '1' }],
      version: pc.version,
    });
    expect(badTax).toMatchObject({ status: 422, body: { code: 'payroll.tax_code' } });
    const computed = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${a.id}`), {
      earnings: [{ code: 'salary', label: 'Salary', amount: '1' }],
      version: pc.version,
    });
    expect(computed.body.code).toBe('payroll.computed_earning');
  });
});

describe('reimbursements (PRL-11)', () => {
  let reimbursement: any;

  it('pays an approved employee reimbursement on the draft run, untaxed and outside gross pay', async () => {
    const fileId = await uploadReceipt();
    const res = await c.post(url('/payroll/reimbursements'), {
      entityId: biz,
      personId: hourly.id,
      spentOn: today,
      description: 'Parking for the farmers market',
      amount: '2400',
      expenseAccountId: category('Travel'),
      fileIds: [fileId],
    });
    expect(res.status).toBe(201);
    reimbursement = res.body;
    expect(reimbursement).toMatchObject({
      status: 'submitted',
      personName: 'Avery Testperson',
      files: [{ id: fileId }],
    });
    const decided = await c.post(url(`/payroll/reimbursements/${reimbursement.id}/decision`), {
      decision: 'approve',
      version: reimbursement.version,
    });
    expect(decided.body).toMatchObject({ status: 'approved', payVia: 'pay_run', payRunId: run.id });
    run = (await c.get(url(`/payroll/runs/${run.id}`))).body;
    const pc = paycheckOf(run, hourly);
    expect(line(pc, 'reimbursement')).toMatchObject({ amount: '2400', reimbursementId: reimbursement.id });
    expect(pc).toMatchObject({ gross: '186625', reimbursements: '2400', net: '148862' });
    const receipt = await h.app.inject({
      method: 'GET',
      url: url(`/payroll/reimbursements/${reimbursement.id}/files/${fileId}`),
      headers: auth(),
    });
    expect(receipt.rawPayload.equals(PNG)).toBe(true);
  });

  it('declines with a reason, once', async () => {
    const r = (
      await c.post(url('/payroll/reimbursements'), {
        entityId: biz,
        personId: salaried.id,
        spentOn: today,
        description: 'Personal lunch',
        amount: '1800',
        expenseAccountId: category('Travel'),
      })
    ).body;
    const res = await c.post(url(`/payroll/reimbursements/${r.id}/decision`), {
      decision: 'decline',
      reason: 'Not a business expense',
      version: r.version,
    });
    expect(res.body).toMatchObject({ status: 'declined', declineReason: 'Not a business expense' });
    const twice = await c.post(url(`/payroll/reimbursements/${r.id}/decision`), {
      decision: 'approve',
      version: res.body.version,
    });
    expect(twice.status).toBe(409);
  });

  it('turns a contractor reimbursement into a bill to their vendor, paid when the bill is', async () => {
    const r = (
      await c.post(url('/payroll/reimbursements'), {
        entityId: biz,
        personId: contractor.id,
        spentOn: today,
        description: 'Printer ink',
        amount: '4599',
        expenseAccountId: category('Supplies'),
      })
    ).body;
    const approved = (
      await c.post(url(`/payroll/reimbursements/${r.id}/decision`), {
        decision: 'approve',
        version: r.version,
      })
    ).body;
    expect(approved).toMatchObject({ status: 'approved', payVia: 'bill' });
    const bill = (await c.get(url(`/bills/${approved.billId}`))).body;
    expect(bill).toMatchObject({ partyId: contractor.vendorPartyId, amount: '4599', status: 'open' });
    await c.post(url(`/bills/${bill.id}/payment`), { accountId: checking, date: today, amount: '4599' });
    expect((await c.get(url(`/payroll/reimbursements/${r.id}`))).body.status).toBe('paid');
  });
});

describe('approving and posting (PRL-08, PRL-09)', () => {
  it('posts each paycheck: wages and reimbursed costs as expenses, withholding as liabilities, net from the bank', async () => {
    const res = await c.post(url(`/payroll/runs/${run.id}/approve`), {
      version: run.version,
      confirmed: true,
    });
    expect(res.status).toBe(200);
    run = res.body;
    expect(run.status).toBe('approved');
    const pc = paycheckOf(run, hourly);
    expect(pc.transactionId).toBeTruthy();
    expect(await postings(pc.transactionId)).toEqual([
      { name: 'Bakery checking', type: 'asset', amount: '-148862' },
      { name: 'California withholding owed', type: 'liability', amount: '-5278' },
      { name: 'Federal income tax withheld', type: 'liability', amount: '-12000' },
      { name: 'Payroll deductions owed', type: 'liability', amount: '-9000' },
      { name: 'Social Security and Medicare owed', type: 'liability', amount: '-13885' },
      { name: 'Travel', type: 'expense', amount: '2400' },
      { name: 'Wages', type: 'expense', amount: '186625' },
    ]);
    // Employer taxes are owed, not yet posted (cash basis, ADR-0034 §6). Only this business's books: other suites
    // record deposits to their own Payroll taxes accounts in the same database at the same time.
    const all = await admin.query(
      `select count(*)::int as n from app.posting p join app.ledger_account a on a.id = p.ledger_account_id
        where a.name = 'Payroll taxes' and a.entity_id = $1`,
      [biz],
    );
    expect(all.rows[0].n).toBe(0);
    const t = (await c.get(url(`/transactions/${pc.transactionId}`))).body;
    expect(t).toMatchObject({ source: 'payroll', managedBy: 'paycheck', payee: 'Avery Testperson' });
    const edit = await c.patch(url(`/transactions/${pc.transactionId}`), {
      categoryId: category('Supplies'),
    });
    expect(edit.body.code).toBe('paycheck.managed');
    const reimbursements = (await c.get(url(`/payroll/reimbursements?entityId=${biz}&status=paid`))).body
      .data;
    expect(reimbursements.map((r: any) => r.description).sort()).toEqual([
      'Parking for the farmers market',
      'Printer ink',
    ]);
    const changed = await c.patch(url(`/payroll/runs/${run.id}/paychecks/${pc.id}`), {
      hoursMilli: '1',
      version: pc.version,
    });
    expect(changed.body.code).toBe('payroll.run_approved');
  });

  it('puts wages on Schedule C line 26', async () => {
    const sc = (await c.get(url(`/reports/schedule-c?entityId=${biz}&year=${run.payDate.slice(0, 4)}`))).body;
    const wages = JSON.stringify(sc);
    expect(wages).toContain('US_SCH_C_L26');
  });

  it('makes a payslip with the year to date', async () => {
    const pc = paycheckOf(run, hourly);
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/payroll/paychecks/${pc.id}/payslip`),
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((await PDFDocument.load(res.rawPayload)).getPageCount()).toBe(1);
    expect(pc.ytd).toMatchObject({ gross: '186625', net: '148862' });
  });

  it('carries the year to date into the next run', async () => {
    const next = (await c.post(url('/payroll/runs'), { entityId: biz, scheduleId: schedule.id })).body;
    expect(next.periodStart).toBe(addDays(run.periodEnd, 1));
    const pc = paycheckOf(next, hourly);
    expect(pc.gross).toBe('180000');
    if (next.payDate.slice(0, 4) === run.payDate.slice(0, 4)) {
      expect(pc.ytd.gross).toBe(String(186625 + 180000));
    }
    expect((await c.delete(url(`/payroll/runs/${next.id}`))).status).toBe(204);
  });

  it('reopens the run, taking its transactions out, and approves it again', async () => {
    const pc = paycheckOf(run, hourly);
    const res = await c.post(url(`/payroll/runs/${run.id}/reopen`), { version: run.version });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
    const t = await admin.query(`select status, deleted_at from app.transaction where id = $1`, [
      pc.transactionId,
    ]);
    expect(t.rows[0].status).toBe('void');
    expect(await postings(pc.transactionId)).toEqual([]);
    // The reimbursement stays on the run while it's a draft, unpaid.
    const r = (await c.get(url(`/payroll/reimbursements?entityId=${biz}&personId=${hourly.id}`))).body
      .data[0];
    expect(r).toMatchObject({ status: 'approved', payRunId: run.id });
    run = (
      await c.post(url(`/payroll/runs/${run.id}/approve`), { version: res.body.version, confirmed: true })
    ).body;
    expect(run.status).toBe('approved');
  });
});

describe('a read-only accountant', () => {
  it('sees pay runs and payslips, but changes nothing and sees no personal data', async () => {
    const runs = (await accountant.get(url(`/payroll/runs?entityId=${biz}`))).body.data;
    expect(runs.map((r: any) => r.id)).toContain(run.id);
    const full = (await accountant.get(url(`/payroll/runs/${run.id}`))).body;
    expect(full.paychecks.map((p: any) => p.personName)).toEqual(['Avery Testperson', 'Blake Sample']);
    const pc = paycheckOf(full, hourly);
    const slip = await h.app.inject({
      method: 'GET',
      url: url(`/payroll/paychecks/${pc.id}/payslip`),
      headers: auth(ACCOUNTANT),
    });
    expect(slip.statusCode).toBe(200);
    expect(
      (await accountant.post(url('/payroll/runs'), { entityId: biz, scheduleId: schedule.id })).status,
    ).toBe(403);
    expect(
      (await accountant.post(url(`/payroll/runs/${run.id}/reopen`), { version: run.version })).status,
    ).toBe(403);
  });
});
