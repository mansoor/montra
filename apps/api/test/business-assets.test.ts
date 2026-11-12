/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Business assets, who spent, meal details and mileage by driver (BIZ-16..19; ADR-0035). Made-up people only. Assets
// go into service in 2024, so three years of depreciation are already in the past.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'assets@example.test';
const ACCOUNTANT = 'assets-accountant@example.test';
const STRANGER = 'assets-stranger@example.test';

let h: Harness;
let c: Client;
let accountant: Client;
let admin: pg.Client;
let url: (p: string) => string;
let wsId: string;
let biz: string;
let checking: string;
let cat: (name: string) => string;
let employee: any;
let laptop: any;
let purchase: any;

const spend = async (amount: string, category: string, date: string = today, payee = 'Shop') =>
  (
    await c.post(url('/transactions'), {
      date,
      accountId: checking,
      amount: usd(amount),
      payee,
      categoryId: cat(category),
    })
  ).body;

/** A transaction's postings, by account name. */
const postings = async (transactionId: string) =>
  Object.fromEntries(
    (
      await admin.query(
        `select a.name, sum(p.amount_minor)::text as amount
           from app.posting p join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
           join app.ledger_account a on a.id = p.ledger_account_id
          where je.transaction_id = $1 group by a.name`,
        [transactionId],
      )
    ).rows.map((r) => [r.name, r.amount]),
  );

/** An account's balance in the business, by name: debits positive. */
const balance = async (name: string) =>
  (
    await admin.query(
      `select coalesce(sum(p.amount_minor), 0)::text as b from app.posting p
         join app.ledger_account a on a.id = p.ledger_account_id
        where a.entity_id = $1 and a.name = $2`,
      [biz, name],
    )
  ).rows[0].b as string;

const scheduleC = async (y: number) =>
  (await c.get(url(`/reports/schedule-c?entityId=${biz}&year=${y}`))).body;
const lineOf = (s: any, line: string) => s.lines.find((l: any) => l.line === line);

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  accountant = h.as(ACCOUNTANT);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Assets', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (await c.post(url('/entities'), { type: 'business', name: 'Lumen Studio', businessType: 'llc' })).body
    .id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Studio checking',
      kind: 'checking',
      openingBalance: usd('10000000'),
      openingDate: '2024-01-01',
      entityId: biz,
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === biz).id;
  employee = (
    await c.post(url('/payroll/people'), {
      entityId: biz,
      kind: 'employee',
      firstName: 'Casey',
      lastName: 'Example',
      hireDate: '2024-01-02',
    })
  ).body;
  const invite = await c.post(url('/sharing/invites'), {
    email: ACCOUNTANT,
    role: 'accountant',
    entityGrants: [{ entityId: biz, access: 'read' }],
  });
  await accountant.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('capitalizing a purchase (BIZ-16)', () => {
  it('moves the cost out of the expense category into fixed assets, and the asset owns the purchase', async () => {
    purchase = await spend('-1200000', 'Office expense', '2024-03-01', 'COMPUTER STORE');
    const res = await c.post(url('/business-assets'), {
      entityId: biz,
      name: 'Design workstation',
      category: 'computers',
      serial: 'SN-123',
      cost: '1000000',
      inServiceDate: '2024-03-01',
      method: 'macrs_half_year',
      transactionId: purchase.id,
    });
    expect(res.status).toBe(201);
    laptop = res.body;
    expect(laptop).toMatchObject({
      lifeYears: 5,
      accumulated: '0',
      bookValue: '1000000',
      transactionId: purchase.id,
    });
    expect(laptop.schedule.map((s: any) => s.amount)).toEqual([
      '200000',
      '320000',
      '192000',
      '115200',
      '115200',
      '57600',
    ]);
    expect(await postings(purchase.id)).toEqual({
      'Office expense': '200000',
      'Equipment and fixed assets': '1000000',
      'Studio checking': '-1200000',
    });
    const t = (await c.get(url(`/transactions/${purchase.id}`))).body;
    expect(t.managedBy).toBe('asset');
    expect(t.expenseDetail).toMatchObject({ assetId: laptop.id, assetCandidate: false });
    const edit = await c.patch(
      url(`/transactions/${purchase.id}`),
      { categoryId: cat('Supplies') },
      { 'if-match': `"v${t.version}"` },
    );
    expect(edit).toMatchObject({ status: 422, body: { code: 'asset.managed' } });
    const again = await c.post(url('/business-assets'), {
      entityId: biz,
      name: 'Twice',
      category: 'computers',
      cost: '1000',
      inServiceDate: '2024-03-01',
      method: 'straight_line',
      transactionId: purchase.id,
    });
    expect(again).toMatchObject({ status: 422, body: { code: 'asset.purchase_taken' } });
  });

  it('refuses a cost over the business spending in the purchase', async () => {
    const small = await spend('-50000', 'Supplies', '2024-04-01');
    const res = await c.post(url('/business-assets'), {
      entityId: biz,
      name: 'Too dear',
      category: 'equipment',
      cost: '60000',
      inServiceDate: '2024-04-01',
      method: 'straight_line',
      transactionId: small.id,
    });
    expect(res).toMatchObject({ status: 422, body: { code: 'asset.cost_over_purchase' } });
  });

  it('expenses an item up to $2,500 right away and refuses more', async () => {
    const chair = await spend('-40000', 'Office expense', '2024-05-01');
    const over = await c.post(url('/business-assets'), {
      entityId: biz,
      name: 'Server',
      category: 'computers',
      cost: '250001',
      inServiceDate: '2024-05-01',
      method: 'expense_now',
    });
    expect(over).toMatchObject({ status: 422, body: { code: 'asset.over_de_minimis' } });
    const res = await c.post(url('/business-assets'), {
      entityId: biz,
      name: 'Desk chair',
      category: 'furniture',
      cost: '40000',
      inServiceDate: '2024-05-01',
      method: 'expense_now',
      transactionId: chair.id,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ schedule: [], bookValue: '0', lifeYears: 7 });
    expect(await postings(chair.id)).toEqual({ 'Office expense': '40000', 'Studio checking': '-40000' });
    expect((await c.get(url(`/transactions/${chair.id}`))).body.managedBy).toBeNull();
  });

  it('books equipment the owner brought in as their contribution', async () => {
    const res = await c.post(url('/business-assets'), {
      entityId: biz,
      name: 'Camera',
      category: 'equipment',
      cost: '300000',
      inServiceDate: '2024-01-15',
      method: 'straight_line',
    });
    expect(res.body).toMatchObject({ transactionId: null, lifeYears: 7 });
    expect(await balance('Owner contribution')).toBe('-300000');
    // Removing it takes the contribution back out.
    expect((await c.delete(url(`/business-assets/${res.body.id}`))).status).toBe(204);
    expect(await balance('Owner contribution')).toBe('0');
  });

  it('gives the purchase its categories back when the asset is removed', async () => {
    const desk = await spend('-500000', 'Office expense', '2024-06-01');
    const a = (
      await c.post(url('/business-assets'), {
        entityId: biz,
        name: 'Standing desk',
        category: 'furniture',
        cost: '500000',
        inServiceDate: '2024-06-01',
        method: 'straight_line',
        transactionId: desk.id,
      })
    ).body;
    expect(await postings(desk.id)).toEqual({
      'Equipment and fixed assets': '500000',
      'Studio checking': '-500000',
    });
    expect((await c.delete(url(`/business-assets/${a.id}`))).status).toBe(204);
    expect(await postings(desk.id)).toEqual({ 'Office expense': '500000', 'Studio checking': '-500000' });
    expect((await c.get(url(`/transactions/${desk.id}`))).body.managedBy).toBeNull();
  });
});

describe('depreciation (BIZ-16)', () => {
  it('posts each year as a depreciation entry, and Schedule C line 13 and the P&L include it', async () => {
    const res = await c.post(url('/business-assets/depreciation'), { entityId: biz, throughYear: 2025 });
    expect(res.status).toBe(200);
    expect(res.body.posted.filter((p: any) => p.assetId === laptop.id)).toEqual([
      { assetId: laptop.id, year: 2024, amount: '200000' },
      { assetId: laptop.id, year: 2025, amount: '320000' },
    ]);
    const kinds = await admin.query(
      `select kind, entry_date::text as d, transaction_id from app.journal_entry where entity_id = $1 and description like 'Depreciation 2025:%'`,
      [biz],
    );
    expect(kinds.rows).toEqual([{ kind: 'depreciation', d: '2025-12-31', transaction_id: null }]);
    const s = await scheduleC(2025);
    expect(lineOf(s, '13')).toMatchObject({
      label: 'Depreciation and section 179 expense deduction',
      amount: '320000',
    });
    const pnl = (await c.get(url(`/reports/pnl?entityId=${biz}&from=2025-01-01&to=2025-12-31`))).body;
    expect(pnl.expense.find((l: any) => l.name === 'Depreciation').amount).toBe('320000');
    // Posting again adds nothing, and a year that hasn't ended yet can't be posted ahead.
    expect(
      (await c.post(url('/business-assets/depreciation'), { entityId: biz, throughYear: 2025 })).body.posted,
    ).toEqual([]);
    const ahead = await c.post(url('/business-assets/depreciation'), {
      entityId: biz,
      throughYear: year + 1,
    });
    expect(ahead).toMatchObject({ status: 422, body: { code: 'asset.future_year' } });
    laptop = (await c.get(url(`/business-assets/${laptop.id}`))).body;
    expect(laptop).toMatchObject({ accumulated: '520000', bookValue: '480000' });
  });

  it('un-posts only the latest year', async () => {
    expect(
      (await c.post(url('/business-assets/depreciation'), { entityId: biz, throughYear: 2026 })).status,
    ).toBe(200);
    const early = await c.delete(url(`/business-assets/${laptop.id}/depreciation/2025`));
    expect(early).toMatchObject({ status: 422, body: { code: 'asset.later_years' } });
    const res = await c.delete(url(`/business-assets/${laptop.id}/depreciation/2026`));
    expect(res.status).toBe(200);
    expect(res.body.schedule.find((s: any) => s.year === 2026).posted).toBe(false);
    expect(lineOf(await scheduleC(2026), '13')).toBeUndefined();
  });

  it('refuses changing the cost once depreciation is posted', async () => {
    const res = await c.patch(url(`/business-assets/${laptop.id}`), {
      cost: '900000',
      version: laptop.version,
    });
    expect(res).toMatchObject({ status: 422, body: { code: 'asset.depreciation_posted' } });
    const renamed = await c.patch(url(`/business-assets/${laptop.id}`), {
      name: 'Workstation',
      version: laptop.version,
    });
    expect(renamed.body).toMatchObject({ name: 'Workstation', cost: '1000000' });
    laptop = renamed.body;
  });

  it('takes Section 179 in the first year', async () => {
    const press = await spend('-1000000', 'Supplies', '2025-02-01');
    const a = (
      await c.post(url('/business-assets'), {
        entityId: biz,
        name: 'Press',
        category: 'equipment',
        cost: '1000000',
        inServiceDate: '2025-02-01',
        method: 'macrs_half_year',
        section179: '400000',
        transactionId: press.id,
      })
    ).body;
    // 4,000 under Section 179, then 7-year MACRS on 6,000: 14.29% = 857.40.
    expect(a.schedule[0]).toEqual({ year: 2025, amount: '485740', posted: false });
    expect(a.schedule.reduce((t: bigint, s: any) => t + BigInt(s.amount), 0n)).toBe(1_000_000n);
    expect((await c.delete(url(`/business-assets/${a.id}`))).status).toBe(204);
  });
});

describe('assets assigned to people (BIZ-17)', () => {
  let held: any;

  it('assigns an asset to one person at a time and lists it on their page', async () => {
    const res = await c.post(url(`/business-assets/${laptop.id}/assignments`), {
      personId: employee.id,
      assignedOn: '2024-03-04',
      note: 'With charger',
    });
    expect(res.status).toBe(201);
    held = res.body.assignedTo;
    expect(held).toMatchObject({ personName: 'Casey Example', assignedOn: '2024-03-04', returnedOn: null });
    const twice = await c.post(url(`/business-assets/${laptop.id}/assignments`), {
      personId: employee.id,
      assignedOn: '2024-03-05',
    });
    expect(twice).toMatchObject({ status: 422, body: { code: 'asset.assigned' } });
    const mine = (await c.get(url(`/business-assets?entityId=${biz}&personId=${employee.id}`))).body;
    expect(mine.assets.map((a: any) => a.id)).toEqual([laptop.id]);
  });

  it('needs it returned before the person’s end date is saved', async () => {
    const person = (await c.get(url(`/payroll/people/${employee.id}`))).body;
    const leave = await c.patch(url(`/payroll/people/${employee.id}`), {
      endDate: today,
      version: person.version,
    });
    expect(leave).toMatchObject({ status: 409, body: { code: 'payroll.assets_held' } });
    expect(leave.body.detail ?? leave.body.title).toContain('Workstation');
    const early = await c.post(url(`/asset-assignments/${held.id}/return`), {
      returnedOn: '2024-03-01',
      version: held.version,
    });
    expect(early).toMatchObject({ status: 422, body: { code: 'asset.return_date' } });
    const back = await c.post(url(`/asset-assignments/${held.id}/return`), {
      returnedOn: today,
      version: held.version,
    });
    expect(back.status).toBe(200);
    expect(back.body.assignedTo).toBeNull();
    expect(back.body.assignments).toMatchObject([{ id: held.id, returnedOn: today }]);
    const left = await c.patch(url(`/payroll/people/${employee.id}`), {
      endDate: today,
      version: person.version,
    });
    expect(left.status).toBe(200);
    // Reopened for the trips below.
    await c.patch(url(`/payroll/people/${employee.id}`), { endDate: null, version: left.body.version });
  });
});

describe('disposal (BIZ-16)', () => {
  it('needs the years before it posted', async () => {
    const res = await c.post(url(`/business-assets/${laptop.id}/disposal`), {
      date: '2026-06-30',
      proceeds: '0',
      version: laptop.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.disposal).toBeTruthy();
    await c.delete(url(`/business-assets/${laptop.id}/disposal`));
    await c.delete(url(`/business-assets/${laptop.id}/depreciation/2025`));
    laptop = (await c.get(url(`/business-assets/${laptop.id}`))).body;
    const missing = await c.post(url(`/business-assets/${laptop.id}/disposal`), {
      date: '2026-06-30',
      proceeds: '0',
      version: laptop.version,
    });
    expect(missing).toMatchObject({ status: 422, body: { code: 'asset.missing_years' } });
    await c.post(url('/business-assets/depreciation'), { entityId: biz, throughYear: 2026 });
    laptop = (await c.get(url(`/business-assets/${laptop.id}`))).body;
  });

  it('writes off book value, records the proceeds and shows the loss, off Schedule C', async () => {
    // 2026 was posted as a full year (1,920); the disposal year gets half of it.
    const res = await c.post(url(`/business-assets/${laptop.id}/disposal`), {
      date: '2026-06-30',
      proceeds: '300000',
      note: 'Sold to a student',
      payment: { accountId: checking },
      version: laptop.version,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accumulated: '616000', bookValue: '0' });
    expect(res.body.disposal).toMatchObject({ date: '2026-06-30', proceeds: '300000', gain: '-84000' });
    expect(await balance('Equipment and fixed assets')).toBe('0');
    expect(await balance('Accumulated depreciation')).toBe('0');
    expect(await balance('Gain or loss on assets sold')).toBe('84000');
    expect(await postings(res.body.disposal.transactionId)).toEqual({
      'Gain or loss on assets sold': '-300000',
      'Studio checking': '300000',
    });
    const s = await scheduleC(2026);
    expect(s.assetSales).toBe('-84000');
    expect(lineOf(s, '13').amount).toBe('96000');
    const pnl = (await c.get(url(`/reports/pnl?entityId=${biz}&from=2026-01-01&to=2026-12-31`))).body;
    expect(pnl.income.find((l: any) => l.name === 'Gain or loss on assets sold').amount).toBe('-84000');
  });

  it('undoes a disposal: the deposit and the write-off go', async () => {
    const sale = (await c.get(url(`/business-assets/${laptop.id}`))).body.disposal.transactionId;
    const res = await c.delete(url(`/business-assets/${laptop.id}/disposal`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ disposal: null, accumulated: '520000', bookValue: '480000' });
    expect(await balance('Gain or loss on assets sold')).toBe('0');
    expect((await c.get(url(`/transactions/${sale}`))).body.status).toBe('void');
    laptop = res.body;
  });
});

describe('expense details (BIZ-18)', () => {
  let lunch: any;
  let customer: any;

  it('marks a meal and hints until it has attendees and a purpose', async () => {
    lunch = await spend('-8400', 'Meals', today, 'BISTRO');
    expect(lunch.expenseDetail).toMatchObject({
      entityId: biz,
      isMeal: true,
      needsMealDetail: true,
      spentBy: null,
      attendees: [],
      version: 0,
    });
    customer = (await c.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Northwind Co' }))
      .body;
    const res = await c.put(url(`/transactions/${lunch.id}/expense-detail`), {
      entityId: biz,
      spentBy: { kind: 'person', personId: employee.id },
      attendees: [{ partyId: customer.id }, { name: 'Jordan from Northwind' }],
      businessPurpose: 'Kick-off for the spring catalog',
      version: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      spentBy: 'person',
      spentByName: 'Casey Example',
      attendees: [
        { partyId: customer.id, name: 'Northwind Co' },
        { partyId: null, name: 'Jordan from Northwind' },
      ],
      needsMealDetail: false,
      version: 1,
    });
    const stale = await c.put(url(`/transactions/${lunch.id}/expense-detail`), {
      entityId: biz,
      spentBy: { kind: 'owner' },
      attendees: [],
      businessPurpose: null,
      version: 0,
    });
    expect(stale.status).toBe(409);
    expect((await c.get(url(`/transactions/${lunch.id}`))).body.expenseDetail.spentByName).toBe(
      'Casey Example',
    );
  });

  it('has none on a personal purchase', async () => {
    const groceries = (await c.get(url('/categories'))).body.data.find((x: any) => x.name === 'Groceries');
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: checking,
        amount: usd('-1000'),
        categoryId: groceries.id,
      })
    ).body;
    expect(t.expenseDetail).toBeNull();
  });

  it('filters and adds up expenses by who spent', async () => {
    const supplies = await spend('-2000', 'Supplies');
    await c.put(url(`/transactions/${supplies.id}/expense-detail`), {
      entityId: biz,
      spentBy: { kind: 'owner' },
      attendees: [],
      businessPurpose: null,
      version: 0,
    });
    const byPerson = (await c.get(url(`/transactions?entityId=${biz}&spentBy=${employee.id}`))).body.data;
    expect(byPerson.map((t: any) => t.id)).toEqual([lunch.id]);
    const byOwner = (await c.get(url(`/transactions?entityId=${biz}&spentBy=owner`))).body.data;
    expect(byOwner.map((t: any) => t.id)).toEqual([supplies.id]);
    const report = (await c.get(url(`/reports/expenses-by-person?entityId=${biz}&from=${today}&to=${today}`)))
      .body;
    expect(report.rows).toEqual(
      expect.arrayContaining([
        { spentBy: 'person', personId: employee.id, name: 'Casey Example', amount: '8400', count: 1 },
        { spentBy: 'owner', personId: null, name: null, amount: '2000', count: 1 },
      ]),
    );
  });

  it('flags a large equipment purchase as a possible asset', async () => {
    const printer = await spend('-320000', 'Office expense', today, 'PRINTER WORLD');
    expect(printer.expenseDetail.assetCandidate).toBe(true);
    const list = (await c.get(url(`/business-assets?entityId=${biz}`))).body;
    expect(list.candidates.map((x: any) => x.transactionId)).toContain(printer.id);
    expect(list.deMinimis).toBe('250000');
    const missing = (await c.get(url(`/reports/missing-receipts?entityId=${biz}&year=${year}`))).body;
    expect(missing.rows.find((r: any) => r.transactionId === printer.id).assetCandidate).toBe(true);
    expect(missing.rows.find((r: any) => r.transactionId === lunch.id)?.assetCandidate ?? false).toBe(false);
  });
});

describe('mileage by driver (BIZ-19)', () => {
  let theirs: any;

  it('keeps an employee’s trip out of the owner’s deduction', async () => {
    const mine = (
      await c.post(url('/mileage-trips'), {
        entityId: biz,
        date: today,
        purpose: 'Client visit',
        miles: '10',
      })
    ).body;
    theirs = (
      await c.post(url('/mileage-trips'), {
        entityId: biz,
        date: today,
        purpose: 'Delivery',
        miles: '20',
        driverPersonId: employee.id,
      })
    ).body;
    expect(mine).toMatchObject({ driver: 'owner', driverName: null });
    expect(theirs).toMatchObject({
      driver: 'person',
      driverName: 'Casey Example',
      reimbursementStatus: null,
    });
    const summary = (await c.get(url(`/mileage-trips?entityId=${biz}&year=${year}`))).body;
    expect(summary.deduction).toBe(mine.deduction);
    expect(summary.miles).toBe('10');
    expect(summary.byDriver).toEqual([
      {
        driver: 'owner',
        personId: null,
        name: null,
        trips: 1,
        miles: '10',
        amount: mine.deduction,
        reimbursed: '0',
      },
      {
        driver: 'person',
        personId: employee.id,
        name: 'Casey Example',
        trips: 1,
        miles: '20',
        amount: theirs.deduction,
        reimbursed: '0',
      },
    ]);
    expect(lineOf(await scheduleC(year), '9').mileage).toBe(mine.deduction);
    const estimate = (await c.get(url(`/tax/estimates?entityId=${biz}&year=${year}`))).body;
    expect(estimate).toBeTruthy();
    const owner = await c.post(url(`/mileage-trips/${mine.id}/reimburse`));
    expect(owner).toMatchObject({ status: 422, body: { code: 'mileage.owner_trip' } });
  });

  it('reimburses an employee’s trip at the IRS rate through payroll', async () => {
    const res = await c.post(url(`/mileage-trips/${theirs.id}/reimburse`));
    expect(res.status).toBe(200);
    expect(res.body.reimbursementStatus).toBe('approved');
    const r = (await c.get(url(`/payroll/reimbursements/${res.body.reimbursementId}`))).body;
    expect(r).toMatchObject({
      amount: theirs.deduction,
      status: 'approved',
      payVia: 'pay_run',
      personId: employee.id,
    });
    const category = (await c.get(url('/categories'))).body.data.find(
      (x: any) => x.id === r.expenseAccountId,
    );
    expect(category).toMatchObject({ name: 'Mileage reimbursements' });
    const twice = await c.post(url(`/mileage-trips/${theirs.id}/reimburse`));
    expect(twice).toMatchObject({ status: 422, body: { code: 'mileage.reimbursed' } });
    const edit = await c.patch(url(`/mileage-trips/${theirs.id}`), {
      miles: '25',
      version: res.body.version,
    });
    expect(edit).toMatchObject({ status: 422, body: { code: 'mileage.reimbursed' } });
    expect((await c.delete(url(`/mileage-trips/${theirs.id}`))).body.code).toBe('mileage.reimbursed');
    const summary = (await c.get(url(`/mileage-trips?entityId=${biz}&year=${year}`))).body;
    expect(summary.byDriver[1].reimbursed).toBe(theirs.deduction);
  });

  it('doesn’t warn about actual car expenses for mileage paid back to staff', async () => {
    await c.post(url('/transactions'), {
      date: today,
      accountId: checking,
      amount: usd('-1500'),
      payee: 'Mileage paid back',
      categoryId: (await c.get(url('/categories'))).body.data.find(
        (x: any) => x.name === 'Mileage reimbursements',
      ).id,
    });
    expect((await scheduleC(year)).warnings).toEqual([]);
    await spend('-4000', 'Car & truck', today, 'GAS STATION');
    expect((await scheduleC(year)).warnings).toEqual(['mileage_and_actual_car']);
  });
});

describe('access (BIZ-16)', () => {
  it('lets a read-only accountant see the register but not change it', async () => {
    const list = await accountant.get(url(`/business-assets?entityId=${biz}`));
    expect(list.status).toBe(200);
    expect(list.body.assets.map((a: any) => a.id)).toContain(laptop.id);
    const res = await accountant.post(url('/business-assets'), {
      entityId: biz,
      name: 'Sneaky',
      category: 'other',
      cost: '100',
      inServiceDate: '2024-01-01',
      method: 'straight_line',
    });
    expect(res).toMatchObject({ status: 403, body: { code: 'business.read_only' } });
  });

  it('hides the register from someone outside the workspace', async () => {
    const res = await h.as(STRANGER).get(`/v1/workspaces/${wsId}/business-assets/${laptop.id}`);
    expect([403, 404]).toContain(res.status);
  });

  it('refuses un-posting depreciation in a closed period', async () => {
    expect((await c.put(url(`/entities/${biz}/period-lock`), { lockedThrough: '2025-12-31' })).status).toBe(
      200,
    );
    const closed = await c.delete(url(`/business-assets/${laptop.id}/depreciation/2025`));
    expect(closed).toMatchObject({ status: 409, body: { code: 'period.locked' } });
  });
});
