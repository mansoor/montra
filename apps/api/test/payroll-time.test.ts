/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Staff time (PRL-23..28; ADR-0036): vacation and California sick leave on pay runs, daily overtime, final pay and
// contractor timesheets. Made-up people only. Runs are in March 2026; periods start on Sundays, as workweeks do.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const EMAIL = 'payroll-time@example.test';
const ANCHOR = '2026-01-04'; // a Sunday

let h: Harness;
let c: Client;
let admin: pg.Client;
let url: (p: string) => string;
let biz: string;
let checking: string;
let schedule: any;
let hourly: any;
let salaried: any;
let contractor: any;
let customer: any;
let run: any;
let run2: any;

const paycheckOf = (r: any, person: any) => r.paychecks.find((p: any) => p.personId === person.id);
const line = (pc: any, code: string) => pc.lines.find((l: any) => l.code === code);
const leaveOf = (pc: any, kind: string) => pc.leave.find((l: any) => l.kind === kind);
const balance = async (person: any, kind: string) =>
  (await c.get(url(`/payroll/people/${person.id}/leave`))).body.balances.find((b: any) => b.kind === kind)
    .balanceMilli;
const patchPaycheck = async (r: any, person: any, body: object) => {
  const pc = paycheckOf((await c.get(url(`/payroll/runs/${r.id}`))).body, person);
  return c.patch(url(`/payroll/runs/${r.id}/paychecks/${pc.id}`), { ...body, version: pc.version });
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Time', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (await c.post(url('/entities'), { type: 'business', name: 'Tidepool Cafe', businessType: 'llc' }))
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
  schedule = (
    await c.post(url('/payroll/schedules'), {
      entityId: biz,
      name: 'Every other Thursday',
      frequency: 'biweekly',
      anchorDate: ANCHOR,
      payLagDays: 5,
      payFromAccountId: checking,
    })
  ).body;
  const make = (body: object) => c.post(url('/payroll/people'), { entityId: biz, ...body });
  hourly = (
    await make({
      kind: 'employee',
      firstName: 'Casey',
      lastName: 'Exampleton',
      hireDate: '2025-06-02',
      payType: 'hourly',
      rate: '2000',
      defaultHoursMilli: '72000',
      workState: 'CA',
      payScheduleId: schedule.id,
    })
  ).body;
  salaried = (
    await make({
      kind: 'employee',
      firstName: 'Dana',
      lastName: 'Specimen',
      hireDate: '2025-06-02',
      payType: 'salary',
      rate: '5200000',
      workState: 'CA',
      payScheduleId: schedule.id,
    })
  ).body;
  contractor = (
    await make({
      kind: 'contractor',
      firstName: 'Emery',
      lastName: 'Placeholder',
      payType: 'hourly',
      rate: '7500',
    })
  ).body;
  customer = (await c.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Harborview Hotel' }))
    .body;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('leave policies (PRL-23, PRL-24)', () => {
  it('starts with California’s sick leave minimum and no vacation', async () => {
    const s = (await c.get(url(`/payroll/leave-settings?entityId=${biz}`))).body;
    expect(s.vacation).toMatchObject({ method: 'none', isDefault: true });
    expect(s.sick).toMatchObject({
      method: 'accrual',
      accrueMilli: '1000',
      perHoursMilli: '30000',
      maxBalanceMilli: '80000',
      useCapMilli: '40000',
      isDefault: true,
      shortfalls: [],
    });
    expect(s.caSickRule).toMatchObject({
      from: '2024-01-01',
      minHoursMilli: '40000',
      minDays: 5,
      usableFromDay: 90,
    });
    expect(s.caSickRule.source).toContain('dir.ca.gov/dlse/paid_sick_leave.htm');
    expect(s.workweekStarts).toBe(6);
  });

  it('saves a vacation accrual and refuses a sick policy below the minimum', async () => {
    const bad = await c.put(url(`/payroll/leave-settings?entityId=${biz}`), {
      sick: { method: 'accrual', accrueMilli: '1000', perHoursMilli: '40000' },
    });
    expect(bad).toMatchObject({ status: 422, body: { code: 'payroll.sick_below_minimum' } });
    const none = await c.put(url(`/payroll/leave-settings?entityId=${biz}`), { sick: { method: 'none' } });
    expect(none).toMatchObject({ status: 422, body: { code: 'payroll.sick_below_minimum' } });
    const res = await c.put(url(`/payroll/leave-settings?entityId=${biz}`), {
      vacation: { method: 'accrual', accrueMilli: '1000', perHoursMilli: '20000', maxBalanceMilli: '120000' },
      workweekStarts: 6,
    });
    expect(res.status).toBe(200);
    expect(res.body.vacation).toMatchObject({ method: 'accrual', perHoursMilli: '20000', isDefault: false });
  });

  it('takes one opening balance per kind for someone hired before Montra', async () => {
    const res = await c.post(url(`/payroll/people/${hourly.id}/leave`), {
      kind: 'vacation',
      source: 'opening',
      date: '2026-01-01',
      hoursMilli: '10000',
      note: 'Carried from the old spreadsheet',
    });
    expect(res.status).toBe(201);
    expect(res.body.balances.find((b: any) => b.kind === 'vacation')).toMatchObject({
      tracked: true,
      balanceMilli: '10000',
    });
    const again = await c.post(url(`/payroll/people/${hourly.id}/leave`), {
      kind: 'vacation',
      source: 'opening',
      date: '2026-01-01',
      hoursMilli: '2000',
    });
    expect(again).toMatchObject({ status: 409, body: { code: 'payroll.leave_opening_exists' } });
    const forContractor = await c.post(url(`/payroll/people/${contractor.id}/leave`), {
      kind: 'vacation',
      source: 'opening',
      date: '2026-01-01',
      hoursMilli: '2000',
    });
    expect(forContractor).toMatchObject({ status: 422, body: { code: 'payroll.leave_employee' } });
  });
});

describe('leave on a pay run (PRL-25, PRL-26)', () => {
  it('pays vacation hours at the regular rate and plans the balances', async () => {
    run = (
      await c.post(url('/payroll/runs'), { entityId: biz, scheduleId: schedule.id, periodDate: '2026-03-04' })
    ).body;
    expect(run).toMatchObject({ periodStart: '2026-03-01', periodEnd: '2026-03-14', payDate: '2026-03-19' });
    const res = await patchPaycheck(run, hourly, { vacationHoursMilli: '8000' });
    expect(res.status).toBe(200);
    const pc = paycheckOf(res.body, hourly);
    expect(line(pc, 'regular')).toMatchObject({ hoursMilli: '72000', amount: '144000' });
    expect(line(pc, 'vacation')).toMatchObject({ hoursMilli: '8000', rate: '2000', amount: '16000' });
    expect(pc.gross).toBe('160000');
    // 72 hours worked: vacation 72 / 20 = 3.6 hours, sick 72 / 30 = 2.4 hours. Leave hours aren't work.
    expect(leaveOf(pc, 'vacation')).toEqual({
      kind: 'vacation',
      beforeMilli: '10000',
      usedMilli: '8000',
      accruedMilli: '3600',
      paidOutMilli: '0',
      afterMilli: '5600',
      warnings: [],
    });
    expect(leaveOf(pc, 'sick')).toMatchObject({ beforeMilli: '0', accruedMilli: '2400', afterMilli: '2400' });
    expect(pc.overtimeMethod).toBe('manual');
    expect(pc.overtimeRules).toBe('california');
  });

  it('leaves a salary unchanged and refuses to approve more leave than the balance until allowed', async () => {
    const res = await patchPaycheck(run, salaried, { sickHoursMilli: '8000' });
    const pc = paycheckOf(res.body, salaried);
    expect(line(pc, 'salary').amount).toBe('200000');
    expect(line(pc, 'sick')).toBeUndefined();
    expect(pc.gross).toBe('200000');
    // Deemed 80 hours less 8 of sick leave = 72 worked: 2.4 hours accrue, but the 8 used were more than the 0 there.
    expect(leaveOf(pc, 'sick')).toMatchObject({
      beforeMilli: '0',
      usedMilli: '8000',
      accruedMilli: '2400',
      afterMilli: '-5600',
      warnings: ['over_balance'],
    });
    const fresh = (await c.get(url(`/payroll/runs/${run.id}`))).body;
    const refused = await c.post(url(`/payroll/runs/${run.id}/approve`), {
      version: fresh.version,
      confirmed: true,
    });
    expect(refused).toMatchObject({ status: 422, body: { code: 'payroll.leave_over_balance' } });
    expect(refused.body.detail).toContain('Dana Specimen');
    const allowed = await patchPaycheck(run, salaried, { allowLeaveOverBalance: true });
    expect(paycheckOf(allowed.body, salaried).leaveOverAllowed).toBe(true);
  });

  it('writes accrual and use when the run is approved', async () => {
    const fresh = (await c.get(url(`/payroll/runs/${run.id}`))).body;
    const res = await c.post(url(`/payroll/runs/${run.id}/approve`), {
      version: fresh.version,
      confirmed: true,
    });
    expect(res.status).toBe(200);
    run = res.body;
    expect(await balance(hourly, 'vacation')).toBe('5600');
    expect(await balance(hourly, 'sick')).toBe('2400');
    expect(await balance(salaried, 'sick')).toBe('-5600');
    // The salaried person accrues vacation on the 72 deemed hours too.
    expect(await balance(salaried, 'vacation')).toBe('3600');
    const leave = (await c.get(url(`/payroll/people/${hourly.id}/leave`))).body;
    expect(
      leave.entries.map((e: any) => [e.kind, e.source, e.hoursMilli, e.payRunId, e.canDelete]).sort(),
    ).toEqual(
      [
        ['sick', 'accrual', '2400', run.id, false],
        ['vacation', 'accrual', '3600', run.id, false],
        ['vacation', 'opening', '10000', null, true],
        ['vacation', 'used', '-8000', run.id, false],
      ].sort(),
    );
    // An approved paycheck shows what was written.
    expect(leaveOf(paycheckOf(run, hourly), 'vacation')).toMatchObject({
      beforeMilli: '10000',
      afterMilli: '5600',
    });
    const rows = (await c.get(url(`/payroll/leave?entityId=${biz}`))).body.data;
    expect(rows.map((r: any) => r.personName)).toEqual(['Casey Exampleton', 'Dana Specimen']);
  });

  it('shows the balances on the payslip', async () => {
    const pc = paycheckOf(run, hourly);
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/payroll/paychecks/${pc.id}/payslip`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(res.statusCode).toBe(200);
    const pdf = await PDFDocument.load(res.rawPayload);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('takes the leave back out when the run is reopened, and writes it again on approval', async () => {
    const reopened = await c.post(url(`/payroll/runs/${run.id}/reopen`), { version: run.version });
    expect(reopened.status).toBe(200);
    expect(await balance(hourly, 'vacation')).toBe('10000');
    expect(await balance(hourly, 'sick')).toBe('0');
    expect(await balance(salaried, 'sick')).toBe('0');
    const n = await admin.query(
      `select count(*)::int as n from app.leave_entry where paycheck_id in
         (select id from app.paycheck where pay_run_id = $1)`,
      [run.id],
    );
    expect(n.rows[0].n).toBe(0);
    run = (
      await c.post(url(`/payroll/runs/${run.id}/approve`), {
        version: reopened.body.version,
        confirmed: true,
      })
    ).body;
    expect(run.status).toBe('approved');
    expect(await balance(hourly, 'vacation')).toBe('5600');
  });
});

describe('California daily overtime (PRL-27)', () => {
  it('works out overtime and double time from hours each day', async () => {
    run2 = (await c.post(url('/payroll/runs'), { entityId: biz, scheduleId: schedule.id })).body;
    expect(run2).toMatchObject({ periodStart: '2026-03-15', periodEnd: '2026-03-28' });
    const res = await patchPaycheck(run2, hourly, {
      days: [
        { date: '2026-03-16', hoursMilli: '10000' },
        { date: '2026-03-17', hoursMilli: '13000' },
        { date: '2026-03-18', hoursMilli: '8000' },
        { date: '2026-03-19', hoursMilli: '8000' },
        { date: '2026-03-20', hoursMilli: '8000' },
        { date: '2026-03-21', hoursMilli: '6000' },
      ],
      // Totals are ignored once days are given.
      hoursMilli: '1000',
    });
    expect(res.status).toBe(200);
    const pc = paycheckOf(res.body, hourly);
    expect(pc.overtimeMethod).toBe('daily');
    // Mon 10 (2 OT), Tue 13 (4 OT, 1 DT), Wed–Fri 8 reach 40 straight-time hours, so Saturday's 6 are OT.
    expect(line(pc, 'regular')).toMatchObject({ hoursMilli: '40000', amount: '80000' });
    expect(line(pc, 'overtime')).toMatchObject({ hoursMilli: '12000', rate: '3000', amount: '36000' });
    expect(line(pc, 'double_time')).toMatchObject({ hoursMilli: '1000', rate: '4000', amount: '4000' });
    expect(pc.days).toHaveLength(6);
    expect(pc.days[1]).toMatchObject({ date: '2026-03-17', overtimeMilli: '4000', doubleTimeMilli: '1000' });
    // 53 hours worked accrue sick leave: 53 / 30 = 1.767.
    expect(leaveOf(pc, 'sick').accruedMilli).toBe('1767');
  });

  it('refuses a day outside the period, and daily hours for a salary', async () => {
    const outside = await patchPaycheck(run2, hourly, { days: [{ date: '2026-03-30', hoursMilli: '8000' }] });
    expect(outside).toMatchObject({ status: 422, body: { code: 'payroll.daily_hours_date' } });
    const salary = await patchPaycheck(run2, salaried, {
      days: [{ date: '2026-03-16', hoursMilli: '8000' }],
    });
    expect(salary).toMatchObject({ status: 422, body: { code: 'payroll.daily_hours_hourly' } });
  });

  it('goes back to entered totals', async () => {
    const res = await patchPaycheck(run2, salaried, {});
    expect(res.status).toBe(200);
    const back = await patchPaycheck(run2, hourly, {
      days: null,
      hoursMilli: '80000',
      overtimeHoursMilli: '0',
    });
    const pc = paycheckOf(back.body, hourly);
    expect(pc).toMatchObject({ overtimeMethod: 'manual', days: [] });
    expect(line(pc, 'double_time')).toBeUndefined();
    expect(line(pc, 'regular').hoursMilli).toBe('80000');
  });
});

describe('final pay (PRL-26)', () => {
  it('pays out unused vacation only on the final paycheck', async () => {
    const early = await patchPaycheck(run2, hourly, { vacationPayoutHoursMilli: '1000' });
    expect(early).toMatchObject({ status: 422, body: { code: 'payroll.payout_not_final' } });
    const p = (await c.get(url(`/payroll/people/${hourly.id}`))).body;
    await c.patch(url(`/payroll/people/${hourly.id}`), { endDate: '2026-03-27', version: p.version });
    const pc = paycheckOf((await c.get(url(`/payroll/runs/${run2.id}`))).body, hourly);
    // 5.6 hours left, plus 80 / 20 = 4 accrued on this paycheck.
    expect(pc.finalPay).toEqual({
      endDate: '2026-03-27',
      vacationPayableMilli: '9600',
      rate: '2000',
      payoutRequired: true,
    });
    const res = await patchPaycheck(run2, hourly, {
      vacationPayoutHoursMilli: pc.finalPay.vacationPayableMilli,
    });
    const paid = paycheckOf(res.body, hourly);
    expect(line(paid, 'vacation_payout')).toMatchObject({
      hoursMilli: '9600',
      rate: '2000',
      amount: '19200',
    });
    expect(leaveOf(paid, 'vacation')).toMatchObject({ paidOutMilli: '9600', afterMilli: '0', warnings: [] });
    // Sick leave isn't paid out.
    expect(leaveOf(paid, 'sick').paidOutMilli).toBe('0');
    const fresh = (await c.get(url(`/payroll/runs/${run2.id}`))).body;
    const approved = await c.post(url(`/payroll/runs/${run2.id}/approve`), {
      version: fresh.version,
      confirmed: true,
    });
    expect(approved.status).toBe(200);
    expect(await balance(hourly, 'vacation')).toBe('0');
  });
});

describe('contractor timesheets (PRL-28)', () => {
  let sheet: any;

  it('keeps hours with a note and an optional customer, at the contractor’s rate', async () => {
    await c.post(url(`/payroll/people/${contractor.id}/time`), {
      workDate: '2026-03-02',
      hoursMilli: '3500',
      note: 'Menu design',
    });
    const res = await c.post(url(`/payroll/people/${contractor.id}/time`), {
      workDate: '2026-03-03',
      hoursMilli: '2000',
      note: 'Hotel brunch setup',
      customerPartyId: customer.id,
    });
    expect(res.status).toBe(201);
    sheet = res.body;
    expect(sheet).toMatchObject({ rate: '7500', unbilledHoursMilli: '5500', unbilledAmount: '41250' });
    expect(sheet.entries[0]).toMatchObject({
      workDate: '2026-03-03',
      customerName: 'Harborview Hotel',
      amount: '15000',
      billId: null,
    });
    const employee = await c.get(url(`/payroll/people/${hourly.id}/time`));
    expect(employee).toMatchObject({ status: 422, body: { code: 'payroll.time_contractor' } });
    const vendor = await c.post(url('/parties'), { entityId: biz, kind: 'vendor', name: 'Not a customer' });
    const wrong = await c.post(url(`/payroll/people/${contractor.id}/time`), {
      workDate: '2026-03-04',
      hoursMilli: '1000',
      customerPartyId: vendor.body.id,
    });
    expect(wrong).toMatchObject({ status: 422, body: { code: 'payroll.time_customer' } });
  });

  it('bills chosen hours as one bill to the vendor record, and locks them', async () => {
    const res = await c.post(url(`/payroll/people/${contractor.id}/time/bill`), {
      entryIds: sheet.entries.map((e: any) => e.id),
      billDate: '2026-03-06',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: '41250', hoursMilli: '5500' });
    const bill = (await c.get(url(`/bills/${res.body.billId}`))).body;
    expect(bill).toMatchObject({
      partyId: contractor.vendorPartyId,
      amount: '41250',
      billDate: '2026-03-06',
      dueDate: '2026-03-06',
      reference: 'Hours',
      notes: '5.5 hours, 2026-03-02 to 2026-03-03',
    });
    const account = await admin.query(`select tax_line_code from app.ledger_account where id = $1`, [
      bill.expenseAccountId,
    ]);
    expect(account.rows[0].tax_line_code).toBe('US_SCH_C_L11');
    sheet = res.body.timesheet;
    expect(sheet).toMatchObject({ unbilledHoursMilli: '0' });
    expect(sheet.entries.every((e: any) => e.billId === res.body.billId && e.billStatus)).toBe(true);
    const entry = sheet.entries[0];
    const edit = await c.patch(url(`/payroll/time/${entry.id}`), {
      hoursMilli: '9000',
      version: entry.version,
    });
    expect(edit).toMatchObject({ status: 409, body: { code: 'payroll.time_billed' } });
    expect((await c.delete(url(`/payroll/time/${entry.id}`))).status).toBe(409);
    const again = await c.post(url(`/payroll/people/${contractor.id}/time/bill`), {
      entryIds: [entry.id],
      billDate: '2026-03-06',
    });
    expect(again).toMatchObject({ status: 409, body: { code: 'payroll.time_billed' } });
    // The database refuses it too.
    await expect(
      admin.query(`update app.contractor_time set hours_milli = 9000 where id = $1`, [entry.id]),
    ).rejects.toThrow(/on a bill/);
  });

  it('frees the hours when the bill is voided', async () => {
    const entry = sheet.entries[0];
    const bill = (await c.get(url(`/bills/${entry.billId}`))).body;
    expect((await c.patch(url(`/bills/${bill.id}`), { void: true, version: bill.version })).status).toBe(200);
    const now = (await c.get(url(`/payroll/people/${contractor.id}/time`))).body;
    expect(now).toMatchObject({ unbilledHoursMilli: '5500' });
    expect(now.entries[0].billId).toBeNull();
    const edit = await c.patch(url(`/payroll/time/${entry.id}`), {
      hoursMilli: '2500',
      version: entry.version,
    });
    expect(edit.status).toBe(200);
    // 3.5 + 2.5 = 6 hours at $75.00 = $450.00.
    expect(edit.body.unbilledAmount).toBe('45000');
  });

  it('needs a rate to bill', async () => {
    const p = (await c.get(url(`/payroll/people/${contractor.id}`))).body;
    await c.patch(url(`/payroll/people/${contractor.id}`), { rate: null, version: p.version });
    const now = (await c.get(url(`/payroll/people/${contractor.id}/time`))).body;
    const res = await c.post(url(`/payroll/people/${contractor.id}/time/bill`), {
      entryIds: [now.entries[0].id],
      billDate: '2026-03-06',
    });
    expect(res).toMatchObject({ status: 422, body: { code: 'payroll.no_rate' } });
  });
});
