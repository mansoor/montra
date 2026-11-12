/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotificationJobs } from '../src/notifications/notification-jobs.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// A business's legal and tax setup and its registrations (BIZ-21..26; ADR-0037). Made-up numbers only.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const EMAIL = 'biz-registration@example.test';
const PARTNER = 'biz-registration-partner@example.test';

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
let biz: string;
let checking: string;
let cat: (name: string) => string;

const usd = (amount: string) => ({ amount, currency: 'USD' });
const business = async (id = biz) => (await c.get(url(`/businesses/${id}`))).body;
const income = (date: string, amount: string) =>
  c.post(url('/transactions'), {
    date,
    accountId: checking,
    amount: usd(amount),
    payee: 'CLIENT',
    categoryId: cat('Other business income'),
  });

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Registrations', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (
    await c.post(url('/entities'), { type: 'business', name: 'Harbor Kites', businessType: 'sole_prop' })
  ).body.id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Kites checking',
      kind: 'checking',
      entityId: biz,
      openingBalance: usd('0'),
      openingDate: '2025-01-01',
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === biz).id;
  const invite = await c.post(url('/sharing/invites'), {
    email: PARTNER,
    role: 'partner',
    entityGrants: [{ entityId: biz, access: 'write' }],
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('entity type and fiscal year (BIZ-21)', () => {
  it('derives the federal return from the entity type', async () => {
    expect(await business()).toMatchObject({ businessType: 'sole_prop', returnForm: 'schedule_c' });
    const res = await c.patch(url(`/businesses/${biz}`), {
      businessType: 'single_member_llc_s_corp',
      sCorpElectionDate: '2026-01-01',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      businessType: 'single_member_llc_s_corp',
      returnForm: 'form_1120s',
      sCorpElectionDate: '2026-01-01',
    });
    for (const [type, form] of [
      ['multi_member_llc', 'form_1065'],
      ['c_corp', 'form_1120'],
      ['sole_prop', 'schedule_c'],
    ]) {
      expect((await c.patch(url(`/businesses/${biz}`), { businessType: type })).body.returnForm).toBe(form);
    }
    // The old types can't be chosen any more, but a business that has one keeps it.
    expect((await c.patch(url(`/businesses/${biz}`), { businessType: 'llc' })).status).toBe(400);
    await admin.query(`update app.entity set business_type = 'llc' where id = $1`, [biz]);
    expect(await business()).toMatchObject({ businessType: 'llc', returnForm: null });
    await c.patch(url(`/businesses/${biz}`), { businessType: 'sole_prop' });
  });

  it('lets only an owner change the type or fiscal year', async () => {
    const refused = await partner.patch(url(`/businesses/${biz}`), { fiscalYearStartMonth: 4 });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('business.owner_only');
    // The rest of the settings are the partner's to change.
    expect((await partner.patch(url(`/businesses/${biz}`), { irsName: 'HARBOR KITES' })).status).toBe(200);
  });

  it('runs the P&L year to date and the Schedule C summary on the fiscal year', async () => {
    for (const [date, amount] of [
      ['2025-06-15', '10000'], // fiscal 2024
      ['2025-08-01', '20000'], // fiscal 2025
      ['2026-03-01', '30000'], // fiscal 2025
      ['2026-07-02', '40000'], // fiscal 2026
    ] as const) {
      expect((await income(date, amount)).status).toBe(201);
    }
    const calendar = (await c.get(url(`/reports/schedule-c?entityId=${biz}&year=2025`))).body;
    expect(calendar).toMatchObject({
      year: 2025,
      from: '2025-01-01',
      to: '2025-12-31',
      grossReceipts: '30000',
    });

    expect(
      (await c.patch(url(`/businesses/${biz}`), { fiscalYearStartMonth: 7 })).body.fiscalYearStartMonth,
    ).toBe(7);
    const fy = (await c.get(url(`/reports/schedule-c?entityId=${biz}&year=2025`))).body;
    expect(fy).toMatchObject({ year: 2025, from: '2025-07-01', to: '2026-06-30', grossReceipts: '50000' });
    const pnl = (await c.get(url(`/reports/pnl?entityId=${biz}`))).body;
    expect(pnl.from).toMatch(/^\d{4}-07-01$/);
    expect(pnl.from <= pnl.to).toBe(true);
    // Without a year, the summary is the fiscal year today is in.
    const current = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(current.from).toBe(pnl.from);
    await c.patch(url(`/businesses/${biz}`), { fiscalYearStartMonth: 1 });
  });
});

describe('registrations (BIZ-22..24, BIZ-26)', () => {
  it('keeps federal, state and local numbers, masking the tax account numbers', async () => {
    const res = await c.patch(url(`/businesses/${biz}`), {
      ein: '12-3456789',
      irsName: 'HARBOR KITES',
      naicsCode: '451110',
      formationState: 'ca',
      sosEntityNumber: '202612345678',
      formationDate: '2026-01-02',
      ftbEntityId: '7654321',
      caEmployerAccount: '123-4567-8',
      cdtfaPermit: '102-345678',
      registeredAgentName: 'Pat Agent',
      registeredAgentAddress: '1 Main St, Monterey, CA 93940',
      dbaName: 'Kite Shack',
      dbaCounty: 'Monterey',
      dbaExpiresOn: '2031-01-02',
      cityLicenseNumber: 'BL-2026-77',
      cityLicenseExpiresOn: '2026-12-31',
      filingAddress: { line1: '1 Harbor Rd', city: 'Monterey', state: 'CA', zip: '93940-1234' },
    });
    expect(res.status).toBe(200);
    expect(res.body.registrations).toEqual({
      einMasked: '••-•••6789',
      irsName: 'HARBOR KITES',
      naicsCode: '451110',
      formationState: 'CA',
      sosEntityNumber: '202612345678',
      formationDate: '2026-01-02',
      ftbEntityIdMasked: '•••4321',
      caEmployerAccountMasked: '••••5678',
      cdtfaPermitMasked: '••••••5678',
      registeredAgentName: 'Pat Agent',
      registeredAgentAddress: '1 Main St, Monterey, CA 93940',
      dbaName: 'Kite Shack',
      dbaCounty: 'Monterey',
      dbaExpiresOn: '2031-01-02',
      cityLicenseNumber: 'BL-2026-77',
      cityLicenseExpiresOn: '2026-12-31',
      filingAddress: { line1: '1 Harbor Rd', line2: null, city: 'Monterey', state: 'CA', zip: '939401234' },
      other: [],
    });
    // The full EIN never comes back from a read.
    expect(JSON.stringify(await business())).not.toContain('123456789');
    for (const body of [{ ein: '12-345' }, { caEmployerAccount: '1234' }, { naicsCode: 'retail' }]) {
      expect((await c.patch(url(`/businesses/${biz}`), body)).status).toBe(400);
    }
  });

  it('shows one full number on request and logs it', async () => {
    const res = await c.post(url(`/businesses/${biz}/reveal`), { field: 'ein' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ field: 'ein', value: '123456789' });
    const { rows } = await admin.query(
      `select subject_id, diff from app.audit_log where workspace_id = $1 and action = 'business.revealed'`,
      [wsId],
    );
    expect(rows).toEqual([{ subject_id: biz, diff: { field: 'ein' } }]);
    expect((await c.post(url(`/businesses/${biz}/reveal`), { field: 'irsName' })).status).toBe(400);
  });

  it('adds, changes and removes other registrations', async () => {
    const add = await c.post(url(`/businesses/${biz}/registrations`), {
      label: 'County health permit',
      number: 'HP-1',
      issuer: 'Monterey County',
      expiresOn: '2026-11-30',
    });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ label: 'County health permit', expiresOn: '2026-11-30', version: 1 });
    const changed = await c.patch(url(`/businesses/${biz}/registrations/${add.body.id}`), {
      number: 'HP-2',
      version: 1,
    });
    expect(changed.body).toMatchObject({ number: 'HP-2', issuer: 'Monterey County', version: 2 });
    const stale = await c.patch(url(`/businesses/${biz}/registrations/${add.body.id}`), {
      number: 'HP-3',
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect((await business()).registrations.other.map((o: any) => o.number)).toEqual(['HP-2']);
    const temp = await c.post(url(`/businesses/${biz}/registrations`), { label: 'Temporary' });
    expect((await c.delete(url(`/businesses/${biz}/registrations/${temp.body.id}`))).status).toBe(204);
    expect((await business()).registrations.other).toHaveLength(1);
  });

  it('reminds to renew 30 days before a registration expires', async () => {
    // The DBA expires in 2031 and the city licence on 2026-12-31; the health permit on 2026-11-30.
    const jobs = h.app.get(NotificationJobs);
    await jobs.nightly(wsId, new Date('2026-11-11T18:00:00Z'));
    const titles = async () =>
      (await c.get(url('/notifications'))).body.data
        .filter((n: any) => n.type === 'reminder')
        .map((n: any) => n.title)
        .sort();
    expect(await titles()).toEqual(['Harbor Kites: renew County health permit by 2026-11-30']);
    await jobs.nightly(wsId, new Date('2026-12-02T18:00:00Z'));
    expect(await titles()).toEqual([
      'Harbor Kites: renew City business licence by 2026-12-31',
      'Harbor Kites: renew County health permit by 2026-11-30',
    ]);
    // Once a night is enough: running again adds nothing.
    await jobs.nightly(wsId, new Date('2026-12-03T18:00:00Z'));
    expect(await titles()).toHaveLength(2);
  });
});

describe('one source of truth for the employer (BIZ-23)', () => {
  it('payroll reads the EIN, EDD account and filing address from the business', async () => {
    const settings = (await c.get(url(`/payroll/settings?entityId=${biz}`))).body;
    expect(settings).toMatchObject({
      einMasked: '••-•••6789',
      caEmployerAccountMasked: '••••5678',
      filingAddress: { line1: '1 Harbor Rd', city: 'Monterey', state: 'CA', zip: '939401234' },
    });
    const w941 = (await c.get(url(`/payroll/worksheets/941?entityId=${biz}&year=2026&quarter=4`))).body;
    expect(w941.employer).toMatchObject({ ein: '12-3456789' });
    const de9 = (await c.get(url(`/payroll/worksheets/de9?entityId=${biz}&year=2026&quarter=4`))).body;
    expect(de9.employer.caEmployerAccount).toBe('123-4567-8');
    await c.patch(url(`/businesses/${biz}`), { ein: '98-7654321' });
    const after = (await c.get(url(`/payroll/year-end?entityId=${biz}&year=2026`))).body;
    expect(after.employer).toMatchObject({ ein: '98-7654321', caEmployerAccount: '123-4567-8' });
    // Payroll no longer takes them: they're set in Business → Settings.
    await c.put(url(`/payroll/settings?entityId=${biz}`), { ein: '11-1111111', version: 0 });
    expect((await c.get(url(`/payroll/settings?entityId=${biz}`))).body.einMasked).toBe('••-•••4321');
  });

  it('copies what payroll had into the business when migrating (0037)', async () => {
    const make = async (name: string) =>
      (await c.post(url('/entities'), { type: 'business', name, businessType: 'partnership' })).body.id;
    const fresh = await make('Old Payroll Co');
    const kept = await make('Already Set Co');
    await c.patch(url(`/businesses/${kept}`), { ein: '22-2222222' });
    for (const [entity, ein] of [
      [fresh, '333333333'],
      [kept, '444444444'],
    ]) {
      await admin.query(
        `insert into app.payroll_settings (workspace_id, entity_id, ein, ca_employer_account, filing_line1,
                                           filing_city, filing_state, filing_zip)
         values ($1, $2, $3, '87654321', '9 Wharf St', 'Santa Cruz', 'CA', '95060')`,
        [wsId, entity, ein],
      );
    }
    const sql = readFileSync(
      new URL('../../../packages/db/migrations/0037_business_registration.sql', import.meta.url),
      'utf8',
    );
    const backfill = sql.slice(
      sql.indexOf('insert into app.business_profile'),
      sql.indexOf(';', sql.indexOf('insert into app.business_profile')),
    );
    await admin.query(backfill);

    expect((await business(fresh)).registrations).toMatchObject({
      einMasked: '••-•••3333',
      caEmployerAccountMasked: '••••4321',
      filingAddress: { line1: '9 Wharf St', line2: null, city: 'Santa Cruz', state: 'CA', zip: '95060' },
    });
    // What the business already had wins.
    expect((await business(kept)).registrations.einMasked).toBe('••-•••2222');
    const w = (await c.get(url(`/payroll/worksheets/941?entityId=${fresh}&year=2026&quarter=1`))).body;
    expect(w.employer.ein).toBe('33-3333333');
  });
});

describe('the owner on payroll (BIZ-25)', () => {
  it('warns when the entity type means the owner is not an employee', async () => {
    const owner = await c.post(url('/payroll/people'), {
      entityId: biz,
      kind: 'employee',
      firstName: 'Pat',
      lastName: 'Owner',
      isOwner: true,
    });
    expect(owner.status).toBe(201);
    expect(owner.body).toMatchObject({ isOwner: true, ownerNote: 'not_an_employee_draws' });
    const staff = await c.post(url('/payroll/people'), {
      entityId: biz,
      kind: 'employee',
      firstName: 'Sam',
      lastName: 'Staff',
    });
    expect(staff.body).toMatchObject({ isOwner: false, ownerNote: null });

    const note = async () => (await c.get(url(`/payroll/people/${owner.body.id}`))).body.ownerNote;
    await c.patch(url(`/businesses/${biz}`), { businessType: 's_corp' });
    expect(await note()).toBe('reasonable_salary');
    await c.patch(url(`/businesses/${biz}`), { businessType: 'partnership' });
    expect(await note()).toBe('not_an_employee_partner');
    await c.patch(url(`/businesses/${biz}`), { businessType: 'c_corp' });
    expect(await note()).toBeNull();
    await c.patch(url(`/businesses/${biz}`), { businessType: 'sole_prop' });
  });
});
