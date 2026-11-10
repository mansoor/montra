/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayIn } from '@montra/domain';
import { loadConfig } from '../src/config.js';
import { AwsKms } from '../src/crypto/crypto.service.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { verifyStripeSignature } from '../src/ops/billing.port.js';
import { BillingService } from '../src/ops/billing.service.js';
import { scrubEvent } from '../src/ops/errors.js';
import { AppVersionInterceptor } from '../src/ops/metrics.js';
import { OpsJobs } from '../src/ops/ops-jobs.js';
import { StatusService, workerStates } from '../src/ops/support.service.js';
import { OwnershipService } from '../src/data/ownership.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Running the service (UP-12, OPS-01..09, NFR-13; ADR-0020).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
const WEBHOOK_SECRET = 'whsec_test_secret_only_used_here';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/iZvQWQAAAABJRU5ErkJggg==',
  'base64',
);

let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});
afterAll(() => admin.end());

async function newWorkspace(c: Client, type: 'household' | 'freelancer' = 'household') {
  const res = await c.post('/v1/workspaces', {
    name: 'Ops test',
    type,
    baseCurrency: 'USD',
    timeZone: 'UTC',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const userId = async (email: string) =>
  (await admin.query(`select id from app.app_user where email = $1`, [email])).rows[0].id as string;

async function makeStaff(c: Client, email: string, role: 'support' | 'admin') {
  await c.get('/v1/me');
  await admin.query(`insert into app.staff_user (user_id, role) values ($1, $2) on conflict do nothing`, [
    await userId(email),
    role,
  ]);
}

describe('plans switched off (self-hosted, development)', () => {
  let h: Harness;
  let c: Client;
  let ws: string;

  beforeAll(async () => {
    h = await startHarness();
    c = h.as('off@example.com');
    ws = await newWorkspace(c);
  });
  afterAll(() => h.close());

  it('lets everyone have everything', async () => {
    const billing = (await c.get(`/v1/workspaces/${ws}/billing`)).body;
    expect(billing).toMatchObject({
      mode: 'off',
      plan: 'free',
      features: { businessEntities: true, rentalEntities: true },
      canManage: true,
    });
    const entity = await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name: 'Allowed' });
    expect(entity.status).toBe(201);
  });

  it('has no way to buy anything', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { interval: 'month' });
    expect(res.status).toBe(404);
  });
});

describe('plans and billing (UP-12, OPS-08)', () => {
  let h: Harness;
  let c: Client;
  let ws: string;
  const stripe = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  let subscription: Record<string, unknown>;
  const realFetch = globalThis.fetch;
  let eventNo = 0;

  /** Signed exactly as the provider signs it. */
  const deliver = async (
    type: string,
    object: Record<string, unknown>,
    opts: { secret?: string; id?: string } = {},
  ) => {
    const body = JSON.stringify({ id: opts.id ?? `evt_${++eventNo}`, type, data: { object } });
    const t = Math.trunc(Date.now() / 1000);
    const sig = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET)
      .update(`${t}.${body}`)
      .digest('hex');
    return h.app.inject({
      method: 'POST',
      url: '/v1/billing/stripe/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` },
      payload: body,
    });
  };

  const paid = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    trial_end: null,
    metadata: { workspace_id: ws },
    items: {
      data: [{ current_period_end: 1_900_000_000, price: { recurring: { interval: 'month' } } }],
    },
    ...over,
  });

  beforeAll(async () => {
    h = await startHarness({
      BILLING_MODE: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_only_used_here',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_PRO_MONTHLY: 'price_month',
      STRIPE_PRICE_PRO_YEARLY: 'price_year',
    });
    c = h.as('paying@example.com');
    ws = await newWorkspace(c);
    subscription = paid();
    stripe.mockImplementation(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/checkout/sessions') {
        return new Response(JSON.stringify({ url: 'https://checkout.example/session' }), { status: 200 });
      }
      if (path === '/v1/billing_portal/sessions') {
        return new Response(JSON.stringify({ url: 'https://portal.example/session' }), { status: 200 });
      }
      return new Response(JSON.stringify(subscription), { status: 200 });
    });
    // Everything else, such as the local database, doesn't go through fetch.
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) =>
      String(url).startsWith('https://api.stripe.com') ? stripe(String(url), init) : realFetch(url, init),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await h.close();
  });
  afterEach(() => stripe.mockClear());

  const billing = async () => (await c.get(`/v1/workspaces/${ws}/billing`)).body;
  const quota = async () =>
    (await admin.query(`select storage_quota_bytes from app.workspace where id = $1`, [ws])).rows[0]
      .storage_quota_bytes as string;

  it('starts free: personal books yes, business and rental books no', async () => {
    expect(await billing()).toMatchObject({
      mode: 'stripe',
      plan: 'free',
      features: { businessEntities: false, rentalEntities: false },
    });
    for (const type of ['business', 'rental']) {
      const res = await c.post(`/v1/workspaces/${ws}/entities`, { type, name: 'Not yet' });
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('plan.required');
    }
  });

  it('sends the owner to checkout, with a trial, and no card details come near us', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { interval: 'year' });
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://checkout.example/session');
    const form = new URLSearchParams(String(stripe.mock.calls[0]![1]!.body));
    expect(form.get('line_items[0][price]')).toBe('price_year');
    expect(form.get('subscription_data[trial_period_days]')).toBe('14');
    expect(form.get('subscription_data[metadata][workspace_id]')).toBe(ws);
    expect(form.get('customer_email')).toBe('paying@example.com');
  });

  it('refuses a webhook with the wrong signature, and an old one', async () => {
    const bad = await deliver('customer.subscription.updated', paid(), { secret: 'whsec_wrong' });
    expect(bad.statusCode).toBe(400);
    expect((await billing()).plan).toBe('free');
    const body = Buffer.from('{}');
    const old = Math.trunc(Date.now() / 1000) - 3600;
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${old}.`).update(body).digest('hex');
    expect(() => verifyStripeSignature(body, `t=${old},v1=${sig}`, WEBHOOK_SECRET)).toThrow();
    expect(() => verifyStripeSignature(body, undefined, WEBHOOK_SECRET)).toThrow();
    expect(() => verifyStripeSignature(body, 't=abc,v1=00', WEBHOOK_SECRET)).toThrow();
  });

  it('turns Pro on from a signed event, reading the current state back from the provider', async () => {
    const res = await deliver('customer.subscription.created', paid({ status: 'incomplete' }));
    expect(res.statusCode).toBe(200);
    // The event said incomplete, but the provider now says active, which is what counts.
    expect(stripe.mock.calls[0]![0]).toContain('/v1/subscriptions/sub_1');
    expect(await billing()).toMatchObject({
      plan: 'pro',
      status: 'active',
      provider: 'stripe',
      interval: 'month',
      features: { businessEntities: true, rentalEntities: true },
    });
    expect(String(await quota())).toBe(String(50n * 1024n * 1024n * 1024n));
    const entity = await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name: 'Now allowed' });
    expect(entity.status).toBe(201);
  });

  it('handles each event once', async () => {
    subscription = paid({ status: 'past_due' });
    await deliver('invoice.payment_failed', { subscription: 'sub_1' }, { id: 'evt_once' });
    const first = (await billing()).graceUntil as string;
    expect(first).toBeTruthy();
    subscription = paid({ status: 'active' });
    await deliver('invoice.paid', { subscription: 'sub_1' }, { id: 'evt_once' });
    expect((await billing()).status).toBe('past_due');
  });

  it('gives a failed payment 14 days, keeps them when it fails again, and clears them when paid', async () => {
    const before = (await billing()).graceUntil as string;
    const days = (Date.parse(before) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect((await billing()).plan).toBe('pro');
    subscription = paid({ status: 'past_due' });
    await deliver('invoice.payment_failed', { subscription: 'sub_1' });
    expect((await billing()).graceUntil).toBe(before);
    subscription = paid({ status: 'active' });
    await deliver('invoice.paid', { subscription: 'sub_1' });
    expect(await billing()).toMatchObject({ status: 'active', graceUntil: null });
  });

  it('notices a lapse by itself if the grace runs out with no word from the provider', async () => {
    subscription = paid({ status: 'past_due' });
    await deliver('invoice.payment_failed', { subscription: 'sub_1' });
    await admin.query(
      `update app.subscription set grace_until = now() - interval '1 hour' where workspace_id = $1`,
      [ws],
    );
    // The clock alone is enough, before the sweep has run.
    expect((await billing()).plan).toBe('free');
    expect(await h.app.get(BillingService).sweep()).toBe(1);
    expect(await billing()).toMatchObject({ plan: 'free', status: 'canceled' });
    expect(String(await quota())).toBe(String(5n * 1024n * 1024n * 1024n));
  });

  it('leaves books already there alone when a plan lapses', async () => {
    const entities = (await c.get(`/v1/workspaces/${ws}/entities`)).body.data;
    const business = entities.find((e: any) => e.type === 'business');
    expect(business.name).toBe('Now allowed');
    const account = await c.post(`/v1/workspaces/${ws}/accounts`, {
      name: 'Still works',
      kind: 'checking',
      entityId: business.id,
      openingBalance: usd('100'),
      openingDate: today,
    });
    expect(account.status).toBe(201);
    const more = await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name: 'One more' });
    expect(more.status).toBe(402);
  });

  it('keeps a backup possible on a lapsed plan', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/backups`, {});
    expect(res.status).toBe(201);
  });

  it('gives a workspace only one trial', async () => {
    await c.post(`/v1/workspaces/${ws}/billing/checkout`, { interval: 'month' });
    const form = new URLSearchParams(String(stripe.mock.calls[0]![1]!.body));
    expect(form.get('subscription_data[trial_period_days]')).toBeNull();
    expect(form.get('customer')).toBe('cus_1');
  });

  it('opens the portal for invoices and cancelling', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/billing/portal`);
    expect(res.body.url).toBe('https://portal.example/session');
  });

  it('stops at the limit, even on Pro', async () => {
    subscription = paid({ status: 'active' });
    await deliver('customer.subscription.updated', paid());
    for (let i = 0; i < 9; i++) {
      await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name: `Biz ${i}` });
    }
    const res = await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name: 'Too many' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('plan.limit');
  });

  it('lets only the owner manage it', async () => {
    const partnerEmail = 'partner-billing@example.com';
    const partner = h.as(partnerEmail);
    await partner.get('/v1/me');
    await admin.query(
      `insert into app.workspace_member (workspace_id, user_id, role, status) values ($1, $2, 'partner', 'active')`,
      [ws, await userId(partnerEmail)],
    );
    expect((await partner.get(`/v1/workspaces/${ws}/billing`)).body.canManage).toBe(false);
    expect((await partner.post(`/v1/workspaces/${ws}/billing/checkout`, { interval: 'month' })).status).toBe(
      403,
    );
    expect((await partner.post(`/v1/workspaces/${ws}/billing/portal`)).status).toBe(403);
  });

  it('ignores a subscription it can’t attach to anything', async () => {
    subscription = paid({ id: 'sub_stranger', customer: 'cus_stranger', metadata: {} });
    const res = await deliver('customer.subscription.created', subscription);
    expect(res.statusCode).toBe(200);
    const row = await admin.query(`select 1 from app.subscription where subscription_ref = 'sub_stranger'`);
    expect(row.rows).toEqual([]);
  });
});

describe('the staff console (OPS-01, ADR-0020)', () => {
  let h: Harness;
  let staff: Client;
  let adminStaff: Client;
  let owner: Client;
  let ws: string;
  let ownerId: string;

  beforeAll(async () => {
    h = await startHarness();
    staff = h.as('support-staff@example.com');
    adminStaff = h.as('admin-staff@example.com');
    owner = h.as('console-owner@example.com');
    ws = await newWorkspace(owner);
    ownerId = await userId('console-owner@example.com');
    await makeStaff(staff, 'support-staff@example.com', 'support');
    await makeStaff(adminStaff, 'admin-staff@example.com', 'admin');
  });
  afterAll(() => h.close());

  it('doesn’t exist for anyone else', async () => {
    for (const path of ['me', 'accounts?q=console', 'flags', `support/${ws}`]) {
      const res = await owner.get(`/v1/admin/${path}`);
      expect(res.status).toBe(404);
    }
    const unsigned = await h.app.inject({ method: 'GET', url: '/v1/admin/me' });
    expect(unsigned.statusCode).toBe(401);
  });

  it('finds an account: people and plans, and nothing about money', async () => {
    expect((await staff.get('/v1/admin/me')).body.role).toBe('support');
    const found = (await staff.get('/v1/admin/accounts?q=console-owner')).body.data;
    expect(found).toEqual([
      expect.objectContaining({
        id: ownerId,
        email: 'console-owner@example.com',
        workspaces: 1,
        deletedAt: null,
      }),
    ]);
    const workspaces = (await staff.get(`/v1/admin/accounts/${ownerId}/workspaces`)).body.data;
    expect(workspaces[0]).toMatchObject({
      id: ws,
      plan: 'free',
      role: 'owner',
      members: 1,
      supportUntil: null,
    });
    expect(JSON.stringify(workspaces)).not.toMatch(/balance|amount|payee/i);
  });

  it('treats search wildcards as text', async () => {
    expect((await staff.get(`/v1/admin/accounts?q=${encodeURIComponent('%%')}`)).body.data).toEqual([]);
    expect((await staff.get(`/v1/admin/accounts?q=${encodeURIComponent('__')}`)).body.data).toEqual([]);
  });

  it('keeps changes to the admin role, and logs them', async () => {
    const set = { plan: 'pro', reason: 'Beta tester' };
    expect((await staff.put(`/v1/admin/workspaces/${ws}/plan`, set)).status).toBe(403);
    expect((await adminStaff.put(`/v1/admin/workspaces/${ws}/plan`, set)).status).toBe(204);
    const row = (await staff.get(`/v1/admin/accounts/${ownerId}/workspaces`)).body.data[0];
    expect(row).toMatchObject({ plan: 'pro', status: 'active', provider: 'staff' });
    const log = await admin.query(`select action, detail from app.admin_log where subject = $1`, [ws]);
    expect(log.rows[0]).toMatchObject({ action: 'plan.set', detail: { plan: 'pro', reason: 'Beta tester' } });
    expect(
      (await adminStaff.put(`/v1/admin/workspaces/${ws}/plan`, { plan: 'pro', reason: 'x' })).status,
    ).toBe(400);
  });

  it('won’t override a plan someone is paying for', async () => {
    const paying = await newWorkspace(owner);
    await admin.query(
      `insert into app.subscription (workspace_id, plan, status, provider, subscription_ref)
       values ($1, 'pro', 'active', 'stripe', $2)`,
      [paying, `sub_${paying}`],
    );
    const res = await adminStaff.put(`/v1/admin/workspaces/${paying}/plan`, {
      plan: 'free',
      reason: 'Trying it',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('billing.provider_managed');
  });

  it('runs feature flags, with overrides reaching the workspace', async () => {
    const flag = { key: 'new.thing', enabled: true, rollout: 100, note: 'Testing' };
    expect((await staff.put('/v1/admin/flags', flag)).status).toBe(403);
    expect((await adminStaff.put('/v1/admin/flags', flag)).status).toBe(204);
    expect((await staff.get('/v1/admin/flags')).body.data).toEqual([
      expect.objectContaining({ key: 'new.thing' }),
    ]);
    expect((await owner.get(`/v1/workspaces/${ws}/billing`)).body.flags['new.thing']).toBe(true);
    await admin.query(
      `insert into app.feature_flag_override (key, workspace_id, enabled) values ('new.thing', $1, false)`,
      [ws],
    );
    expect((await owner.get(`/v1/workspaces/${ws}/billing`)).body.flags['new.thing']).toBe(false);
    expect((await adminStaff.delete('/v1/admin/flags/new.thing')).status).toBe(204);
    expect((await owner.get(`/v1/workspaces/${ws}/billing`)).body.flags['new.thing']).toBeUndefined();
  });

  it('shows import failures by bank format, with nothing about whose they were', async () => {
    const res = await staff.get('/v1/admin/analytics/imports?days=30');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect((await staff.get('/v1/admin/analytics/imports?days=9999')).status).toBe(400);
    expect((await staff.get('/v1/admin/analytics/ai')).status).toBe(200);
  });

  it('edits reference data without a release (OPS-05)', async () => {
    const merchant = {
      id: 'test-cafe',
      displayName: 'Test Cafe',
      matchKey: 'test cafe',
      categoryHint: 'Dining out',
    };
    expect((await staff.put('/v1/admin/reference/merchants', merchant)).status).toBe(403);
    expect((await adminStaff.put('/v1/admin/reference/merchants', merchant)).status).toBe(204);
    await adminStaff.put('/v1/admin/reference/merchants', { ...merchant, displayName: 'Test Café' });
    const rows = (await staff.get('/v1/admin/reference/merchants?q=test%20caf')).body.data;
    expect(rows).toEqual([
      expect.objectContaining({ displayName: 'Test Café', matchKey: 'TEST CAFE', version: 2 }),
    ]);
    const rate = { country: 'US', effectiveFrom: '2030-01-01', tenthsOfCent: 800, source: 'Test' };
    expect((await adminStaff.put('/v1/admin/reference/mileage-rates', rate)).status).toBe(204);
    const rates = (await staff.get('/v1/admin/reference/mileage-rates')).body.data;
    expect(rates).toEqual(
      expect.arrayContaining([expect.objectContaining({ effectiveFrom: '2030-01-01', tenthsOfCent: 800 })]),
    );
    await admin.query(`delete from ref.merchant where id = 'test-cafe'`);
    await admin.query(`delete from ref.mileage_rate where effective_from = '2030-01-01'`);
  });

  describe('support access (OPS-02)', () => {
    const view = () => staff.get(`/v1/admin/support/${ws}`);
    const events = async () =>
      (await owner.get('/v1/me/security-activity')).body.data.filter((e: any) => e.kind === 'support_access');

    it('is refused until the owner allows it, with the same answer as no such workspace', async () => {
      const res = await view();
      expect(res.status).toBe(404);
      expect((await staff.get(`/v1/admin/support/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
      expect(await events()).toEqual([]);
    });

    it('lasts 72 hours by default and is the owner’s to give', async () => {
      const partnerEmail = 'console-partner@example.com';
      const partner = h.as(partnerEmail);
      await partner.get('/v1/me');
      await admin.query(
        `insert into app.workspace_member (workspace_id, user_id, role, status) values ($1, $2, 'partner', 'active')`,
        [ws, await userId(partnerEmail)],
      );
      expect((await partner.post(`/v1/workspaces/${ws}/support-grants`, {})).status).toBe(403);
      const grant = await owner.post(`/v1/workspaces/${ws}/support-grants`, { reason: 'Import trouble' });
      expect(grant.status).toBe(201);
      const hours = (Date.parse(grant.body.expiresAt) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThanOrEqual(72);
      expect((await owner.post(`/v1/workspaces/${ws}/support-grants`, { hours: 1000 })).status).toBe(400);
      expect((await partner.get(`/v1/workspaces/${ws}/support-grants`)).body.data[0].active).toBe(true);
    });

    it('shows what helps with a problem, not the money, and tells the owner each time', async () => {
      const entities = (await owner.get(`/v1/workspaces/${ws}/entities`)).body.data;
      const account = await owner.post(`/v1/workspaces/${ws}/accounts`, {
        name: 'Private savings',
        kind: 'checking',
        entityId: entities[0].id,
        openingBalance: usd('987654'),
        openingDate: today,
      });
      await owner.post(`/v1/workspaces/${ws}/transactions`, {
        date: today,
        accountId: account.body.id,
        amount: usd('-123456'),
        payee: 'Very Private Payee',
        memo: 'A private note',
      });
      const res = await view();
      expect(res.status).toBe(200);
      expect(res.body.workspace.id).toBe(ws);
      expect(res.body.entities.length).toBeGreaterThan(0);
      const seen = JSON.stringify(res.body);
      for (const secret of ['987654', '123456', 'Very Private Payee', 'A private note', 'Private savings']) {
        expect(seen).not.toContain(secret);
      }
      expect(await events()).toHaveLength(1);
      const log = await admin.query(
        `select action from app.admin_log where action = 'support.view' and subject = $1`,
        [ws],
      );
      expect(log.rows).toHaveLength(1);
    });

    it('ends when the owner says, and when the time’s up', async () => {
      const list = (await owner.get(`/v1/workspaces/${ws}/support-grants`)).body.data;
      expect((await owner.delete(`/v1/workspaces/${ws}/support-grants/${list[0].id}`)).status).toBe(204);
      expect((await view()).status).toBe(404);
      expect((await owner.delete(`/v1/workspaces/${ws}/support-grants/${list[0].id}`)).status).toBe(404);
      await owner.post(`/v1/workspaces/${ws}/support-grants`, {});
      expect((await view()).status).toBe(200);
      await admin.query(
        `update app.support_grant set expires_at = now() - interval '1 minute' where workspace_id = $1`,
        [ws],
      );
      expect((await view()).status).toBe(404);
      expect((await owner.get(`/v1/workspaces/${ws}/support-grants`)).body.data[0].active).toBe(false);
    });

    it('stops if whoever granted it is no longer the owner', async () => {
      await owner.post(`/v1/workspaces/${ws}/support-grants`, {});
      expect((await view()).status).toBe(200);
      await admin.query(
        `update app.workspace_member set role = 'partner' where workspace_id = $1 and user_id = $2`,
        [ws, ownerId],
      );
      expect((await view()).status).toBe(404);
      await admin.query(
        `update app.workspace_member set role = 'owner' where workspace_id = $1 and user_id = $2`,
        [ws, ownerId],
      );
    });
  });
});

describe('notices, status and the app version (OPS-03, OPS-04)', () => {
  let h: Harness;
  let staff: Client;
  const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

  beforeAll(async () => {
    h = await startHarness();
    staff = h.as('notice-staff@example.com');
    await makeStaff(staff, 'notice-staff@example.com', 'admin');
    await admin.query(`delete from app.system_notice`);
  });
  afterAll(async () => {
    await admin.query(`delete from app.system_notice`);
    await admin.query(`update app.system_setting set value = '0.0.0' where key like 'min_app_version%'`);
    await h.close();
  });

  const status = async () => {
    h.app.get(StatusService).forget();
    const res = await h.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  };

  it('answers anyone, signed in or not', async () => {
    expect(await status()).toMatchObject({ status: 'operational', notices: [] });
  });

  it('won’t take planned maintenance announced less than 48 hours ahead', async () => {
    const soon = await staff.post('/v1/admin/notices', {
      kind: 'maintenance',
      title: 'Soon',
      startsAt: inHours(24),
    });
    expect(soon.status).toBe(422);
    expect(soon.body.code).toBe('notice.too_soon');
    const open = await staff.post('/v1/admin/notices', { kind: 'maintenance', title: 'When?' });
    expect(open.body.code).toBe('notice.starts_required');
    const ok = await staff.post('/v1/admin/notices', {
      kind: 'maintenance',
      title: 'Database upgrade',
      startsAt: inHours(49),
      endsAt: inHours(50),
    });
    expect(ok.status).toBe(201);
    const s = await status();
    expect(s.status).toBe('operational');
    expect(s.notices).toEqual([expect.objectContaining({ title: 'Database upgrade', kind: 'maintenance' })]);
    expect((await staff.post(`/v1/admin/notices/${ok.body.id}/end`)).status).toBe(204);
    expect((await status()).notices).toEqual([]);
  });

  it('holds back a notice until it’s time to show it', async () => {
    const later = await staff.post('/v1/admin/notices', {
      kind: 'info',
      title: 'Later',
      showFrom: inHours(5),
    });
    expect((await status()).notices).toEqual([]);
    await staff.post(`/v1/admin/notices/${later.body.id}/end`);
  });

  it('says when a worker isn’t picking up work, such as no doc-worker running', async () => {
    const { rows } = await admin.query(
      `insert into app.job (queue, type, run_after) values ('doc', 'test.nobody_home', now() - interval '10 minutes')
       returning id`,
    );
    try {
      expect((await status()).workers).toMatchObject({ documents: 'delayed' });
    } finally {
      await admin.query(`delete from app.job where id = $1`, [rows[0].id]);
    }
    // Which worker, judged by how long the oldest ready job has waited.
    expect(workerStates([])).toEqual({ documents: 'ok', jobs: 'ok' });
    expect(
      workerStates([
        { queue: 'doc', lag_seconds: 30 },
        { queue: 'ai', lag_seconds: 600 },
      ]),
    ).toEqual({ documents: 'ok', jobs: 'delayed' });
    expect(workerStates([{ queue: 'doc', lag_seconds: 600 }])).toEqual({ documents: 'delayed', jobs: 'ok' });
  });

  it('says so when something’s wrong', async () => {
    const incident = await staff.post('/v1/admin/notices', { kind: 'incident', title: 'Imports are slow' });
    expect(incident.status).toBe(201);
    expect((await status()).status).toBe('incident');
    await staff.post(`/v1/admin/notices/${incident.body.id}/end`);
    expect((await status()).status).toBe('operational');
  });

  it('turns away a phone app that’s too old, and nothing else', async () => {
    const res = await staff.put('/v1/admin/app-versions', { ios: '2.0.0', android: '1.5.0' });
    expect(res.status).toBe(204);
    h.app.get(AppVersionInterceptor).forget();
    const asPhone = (platform: string, version: string) =>
      h.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: {
          authorization: 'Bearer dev:notice-staff@example.com',
          'x-app-platform': platform,
          'x-app-version': version,
        },
      });
    const old = await asPhone('ios', '1.9.9');
    expect(old.statusCode).toBe(426);
    expect(JSON.parse(old.body).code).toBe('app.update_required');
    expect((await asPhone('ios', '2.0.0')).statusCode).toBe(200);
    expect((await asPhone('android', '1.9.9')).statusCode).toBe(200);
    expect((await asPhone('android', '1.4.0')).statusCode).toBe(426);
    expect((await staff.get('/v1/me')).status).toBe(200);
    expect((await staff.put('/v1/admin/app-versions', { ios: 'soon', android: '1.0.0' })).status).toBe(400);
  });
});

describe('help (OPS-09)', () => {
  let h: Harness;
  let c: Client;
  let staff: Client;
  let ws: string;

  beforeAll(async () => {
    h = await startHarness({ SUPPORT_EMAIL: 'support@example.com' });
    c = h.as('asking@example.com');
    staff = h.as('help-staff@example.com');
    ws = await newWorkspace(c);
    await makeStaff(staff, 'help-staff@example.com', 'support');
  });
  afterAll(() => h.close());

  it('takes a bug report with a screenshot and logs, and staff can read it', async () => {
    const res = await c.post('/v1/support/requests', {
      kind: 'bug',
      subject: 'Import button does nothing',
      body: 'I pressed it and nothing happened.',
      workspaceId: ws,
      context: { path: '/w/x/imports', appVersion: '1.0.0', logs: ['clicked import'] },
      screenshot: PNG.toString('base64'),
    });
    expect(res.status).toBe(201);
    const open = (await staff.get('/v1/admin/support-requests')).body.data;
    const row = open.find((r: any) => r.id === res.body.id);
    expect(row).toMatchObject({
      email: 'asking@example.com',
      kind: 'bug',
      hasScreenshot: true,
      status: 'open',
      workspaceId: ws,
    });
    const shot = await h.app.inject({
      method: 'GET',
      url: `/v1/admin/support-requests/${res.body.id}/screenshot`,
      headers: { authorization: 'Bearer dev:help-staff@example.com' },
    });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    expect(shot.headers['content-disposition']).toContain('attachment');
    expect(shot.rawPayload.equals(PNG)).toBe(true);
    expect((await staff.post(`/v1/admin/support-requests/${res.body.id}/close`)).status).toBe(204);
    expect((await staff.get('/v1/admin/support-requests')).body.data.map((r: any) => r.id)).not.toContain(
      res.body.id,
    );
    expect((await c.get('/v1/support/requests')).body.data[0]).toMatchObject({
      id: res.body.id,
      status: 'closed',
    });
  });

  it('tells support there’s something to read, without what it says', async () => {
    const mail = h.app.get<MemoryMail>(MAIL_PORT).outbox;
    const before = mail.length;
    await c.post('/v1/support/requests', {
      kind: 'question',
      subject: 'A private subject',
      body: 'A private question',
    });
    const sent = mail.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('support@example.com');
    expect(JSON.stringify(sent[0])).not.toContain('private');
  });

  it('won’t take something that isn’t an image', async () => {
    const res = await c.post('/v1/support/requests', {
      kind: 'bug',
      subject: 'x',
      body: 'y',
      screenshot: Buffer.from('<script>alert(1)</script>').toString('base64'),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('support.bad_screenshot');
  });

  it('won’t attach a request to someone else’s workspace', async () => {
    const other = await newWorkspace(h.as('other-help@example.com'));
    const res = await c.post('/v1/support/requests', {
      kind: 'question',
      subject: 'x',
      body: 'y',
      workspaceId: other,
    });
    expect(res.status).toBe(404);
  });

  it('shows people only their own', async () => {
    const other = h.as('other-help@example.com');
    expect((await other.get('/v1/support/requests')).body.data).toEqual([]);
  });

  it('slows down someone sending too many', async () => {
    const pest = h.as('pest@example.com');
    for (let i = 0; i < 20; i++) {
      await pest.post('/v1/support/requests', { kind: 'question', subject: `Q${i}`, body: 'Again' });
    }
    const res = await pest.post('/v1/support/requests', {
      kind: 'question',
      subject: 'One more',
      body: 'Again',
    });
    expect(res.status).toBe(429);
  });

  it('goes when the person does (BAK-09)', async () => {
    const leaving = 'leaving-help@example.com';
    const l = h.as(leaving);
    await newWorkspace(l);
    await l.post('/v1/support/requests', { kind: 'question', subject: 'Before I go', body: 'Bye' });
    const id = await userId(leaving);
    await admin.query(
      `update app.app_user set purge_after = now() - interval '1 hour', deleted_at = now() where id = $1`,
      [id],
    );
    await admin.query(
      `update app.workspace set purge_after = now() - interval '1 hour', deleted_at = now()
        where id in (select workspace_id from app.workspace_member where user_id = $1)`,
      [id],
    );
    await h.app.get(OwnershipService).retention();
    const rows = await admin.query(`select 1 from app.support_request where user_id = $1`, [id]);
    expect(rows.rows).toEqual([]);
  });

  it('takes client errors from people signed in, and only them', async () => {
    const error = { message: 'Boom', source: 'web', path: '/w/x?secret=1' };
    expect((await c.post('/v1/client-errors', error)).status).toBe(204);
    const anon = await h.app.inject({ method: 'POST', url: '/v1/client-errors', payload: error });
    expect(anon.statusCode).toBe(401);
    expect((await c.post('/v1/client-errors', { message: 'x'.repeat(501), source: 'web' })).status).toBe(400);
  });
});

describe('metrics and reconciliation (NFR-13, OPS-07)', () => {
  const TOKEN = randomBytes(24).toString('hex');
  let h: Harness;
  let c: Client;
  let ws: string;

  beforeAll(async () => {
    h = await startHarness({ METRICS_TOKEN: TOKEN });
    c = h.as('metrics@example.com');
    ws = await newWorkspace(c);
  });
  afterAll(() => h.close());

  const scrape = (token?: string) =>
    h.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  it('doesn’t answer without the token', async () => {
    expect((await scrape()).statusCode).toBe(404);
    expect((await scrape('wrong')).statusCode).toBe(404);
  });

  it('doesn’t answer at all when no token is set', async () => {
    const other = await startHarness();
    const res = await other.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: 'Bearer undefined' },
    });
    expect(res.statusCode).toBe(404);
    await other.close();
  });

  it('reports what the dashboards and alerts read, with routes and not ids', async () => {
    await c.get(`/v1/workspaces/${ws}/accounts`);
    const res = await scrape(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'montra_http_request_duration_seconds',
      'montra_http_requests_total',
      'montra_job_queue_lag_seconds',
      'montra_job_failures_total',
      'montra_ai_calls_total',
      'montra_ai_suggestions_accepted_ratio',
      'montra_import_failures_total',
      'montra_import_parse_p95_seconds',
      'montra_reconciliation_failures',
      'montra_backup_job_failures_total',
    ]) {
      expect(res.body).toContain(name);
    }
    expect(res.body).toContain('route="/v1/workspaces/:workspaceId/accounts"');
    expect(res.body).not.toContain(ws);
    expect(res.body).not.toContain('metrics@example.com');
  });

  it('finds healthy books healthy', async () => {
    const entities = (await c.get(`/v1/workspaces/${ws}/entities`)).body.data;
    await c.post(`/v1/workspaces/${ws}/accounts`, {
      name: 'Reconciled',
      kind: 'checking',
      entityId: entities[0].id,
      openingBalance: usd('5000'),
      openingDate: today,
    });
    const result = await h.app.get(OpsJobs).reconcile();
    expect(result).toMatchObject({ unbalanced_entries: 0, read_model_gaps: 0 });
  });

  it('notices a read model that’s drifted from the postings, and reports only ids', async () => {
    const { rows } = await admin.query(
      `select ledger_account_id, date from app.account_balance_daily where workspace_id = $1 limit 1`,
      [ws],
    );
    await admin.query(
      `update app.account_balance_daily set delta_minor = delta_minor + 1 where workspace_id = $1 and ledger_account_id = $2 and date = $3`,
      [ws, rows[0].ledger_account_id, rows[0].date],
    );
    const result = await h.app.get(OpsJobs).reconcile();
    expect(result.read_model_gaps).toBe(1);
    expect(result.sample).toEqual([{ kind: 'account', workspace: ws, id: rows[0].ledger_account_id }]);
    expect((await scrape(TOKEN)).body).toMatch(/montra_reconciliation_failures 1/);
    await admin.query(
      `update app.account_balance_daily set delta_minor = delta_minor - 1 where workspace_id = $1 and ledger_account_id = $2 and date = $3`,
      [ws, rows[0].ledger_account_id, rows[0].date],
    );
    expect((await h.app.get(OpsJobs).reconcile()).read_model_gaps).toBe(0);
  });

  it('sends security headers', async () => {
    const res = await c.get('/v1/me');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('production settings (NFR-01)', () => {
  const prod = {
    NODE_ENV: 'production',
    AUTH_MODE: 'kratos',
    KRATOS_PUBLIC_URL: 'http://kratos:4433',
    ADMIN_DATABASE_URL: 'postgres://a',
    SUPPORT_DATABASE_URL: 'postgres://b',
  };

  it('needs a real key, and the staff connections', () => {
    expect(() => loadConfig(prod)).toThrow(/KMS_MODE=aws/);
    expect(() => loadConfig({ ...prod, KMS_MODE: 'aws' })).toThrow(/AWS_KMS_KEY_ID/);
    expect(() =>
      loadConfig({ ...prod, KMS_MODE: 'aws', AWS_KMS_KEY_ID: 'key', ADMIN_DATABASE_URL: undefined }),
    ).toThrow(/ADMIN_DATABASE_URL/);
    expect(loadConfig({ ...prod, KMS_MODE: 'aws', AWS_KMS_KEY_ID: 'key' }).KMS_MODE).toBe('aws');
  });

  it('won’t turn billing on without its secrets', () => {
    expect(() => loadConfig({ BILLING_MODE: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('wraps data keys through KMS with a fixed context', async () => {
    const kms = new AwsKms(loadConfig({ KMS_MODE: 'aws', AWS_KMS_KEY_ID: 'alias/test' }));
    const send = vi.fn(async (command: any) =>
      command.input.Plaintext
        ? { CiphertextBlob: Buffer.from('sealed') }
        : { Plaintext: Buffer.from('plain') },
    );
    (kms as any).client = { send };
    expect((await kms.wrap(Buffer.from('plain'))).toString()).toBe('sealed');
    expect((await kms.unwrap(Buffer.from('sealed'))).toString()).toBe('plain');
    for (const [command] of send.mock.calls) {
      expect(command.input).toMatchObject({
        KeyId: 'alias/test',
        EncryptionContext: { purpose: 'montra:dek' },
      });
    }
  });

  it('keeps request details out of what goes to the error tracker', () => {
    const event = scrubEvent({
      message: 'Boom',
      request: { data: { amount: 5 }, url: 'https://x/?a=1' },
      breadcrumbs: [{ message: 'SELECT amount' }],
      user: { id: 'u1', email: 'a@example.com', ip_address: '1.2.3.4' },
    });
    expect(event.request).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.user).toEqual({ id: 'u1' });
  });
});
