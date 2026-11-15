/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { BillingService } from '../src/ops/billing.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Managing accounts: suspending, trials, given plans, coupons and closing on request (ADR-0049 §4).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const DAY = 86_400_000;

let admin: pg.Client;
let h: Harness;
let owner: Client;
let adminStaff: Client;
let support: Client;
const stripe = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const realFetch = globalThis.fetch;

const userId = async (email: string) =>
  (await admin.query(`select id from app.app_user where email = $1`, [email])).rows[0].id as string;
const outbox = () => h.app.get<MemoryMail>(MAIL_PORT).outbox;

async function staff(email: string, role: string) {
  const c = h.as(email);
  await c.get('/v1/me');
  await admin.query(
    `insert into app.staff_user (user_id, role) values ($1, $2) on conflict (user_id) do update set role = $2`,
    [await userId(email), role],
  );
  return c;
}

async function newWorkspace(c: Client, name = 'Accounts test') {
  const res = await c.post('/v1/workspaces', {
    name,
    type: 'household',
    baseCurrency: 'USD',
    timeZone: 'UTC',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({
    BILLING_MODE: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_accounts_only',
    STRIPE_WEBHOOK_SECRET: 'whsec_accounts_only',
    SUPPORT_EMAIL: 'help@example.test',
  });
  owner = await staff('accounts-owner@example.test', 'owner');
  adminStaff = await staff('accounts-admin@example.test', 'admin');
  support = await staff('accounts-support@example.test', 'support');
  stripe.mockImplementation(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) =>
    String(url).startsWith('https://api.stripe.com') ? stripe(String(url), init) : realFetch(url, init),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h.close();
  await admin.end();
});
afterEach(() => stripe.mockClear());

describe('suspending and restoring (ADR-0049 §4)', () => {
  const person = 'accounts-suspended@example.test';
  const partner = 'accounts-partner@example.test';
  let c: Client;
  let p: Client;
  let ws: string;
  let id: string;

  beforeAll(async () => {
    c = h.as(person);
    ws = await newWorkspace(c);
    id = await userId(person);
    p = h.as(partner);
    await p.get('/v1/me');
    await admin.query(
      `insert into app.workspace_member (workspace_id, user_id, role, status) values ($1, $2, 'partner', 'active')`,
      [ws, await userId(partner)],
    );
  });

  it('is for admins and owners, with a reason', async () => {
    const body = { kind: 'abuse', reason: 'Sending spam invites' };
    expect((await support.post(`/v1/admin/accounts/${id}/suspend`, body)).status).toBe(403);
    expect(
      (await adminStaff.post(`/v1/admin/accounts/${id}/suspend`, { kind: 'abuse', reason: '' })).status,
    ).toBe(400);
    expect(
      (await adminStaff.post(`/v1/admin/accounts/${id}/suspend`, { kind: 'late', reason: 'x' })).status,
    ).toBe(400);
  });

  it('stops them, closes what they own to every member, keeps the data, and tells them', async () => {
    const before = outbox().length;
    const res = await adminStaff.post(`/v1/admin/accounts/${id}/suspend`, {
      kind: 'abuse',
      reason: 'Sending spam invites',
    });
    expect(res.status).toBe(204);
    const me = await c.get('/v1/me');
    expect(me.status).toBe(403);
    expect(me.body.code).toBe('account.suspended');
    const shared = await p.get(`/v1/workspaces/${ws}/billing`);
    expect(shared.status).toBe(403);
    expect(shared.body.code).toBe('workspace.suspended');
    expect(shared.body.detail ?? shared.body.message ?? JSON.stringify(shared.body)).toMatch(
      /help@example.test/,
    );
    const told = outbox()
      .slice(before)
      .filter((m) => m.to === person);
    expect(told).toHaveLength(1);
    expect(told[0]!.text).not.toMatch(/spam/);
    const found = (await support.get(`/v1/admin/accounts?q=accounts-suspended`)).body.data[0];
    expect(found.suspension).toMatchObject({ kind: 'abuse', reason: 'Sending spam invites' });
    const kept = await admin.query(
      `select count(*)::int as n from app.workspace where id = $1 and deleted_at is null`,
      [ws],
    );
    expect(kept.rows[0].n).toBe(1);
  });

  it('restores all of it', async () => {
    expect((await adminStaff.post(`/v1/admin/accounts/${id}/restore`)).status).toBe(204);
    expect((await c.get('/v1/me')).status).toBe(200);
    expect((await p.get(`/v1/workspaces/${ws}/billing`)).status).toBe(200);
    expect((await adminStaff.post(`/v1/admin/accounts/${id}/restore`)).status).toBe(404);
    const log = await admin.query(`select action from app.admin_log where subject = $1 order by at`, [id]);
    expect(log.rows.map((r) => r.action)).toEqual(['account.suspend', 'account.restore']);
    const events = (await c.get('/v1/me/security-activity')).body.data.map((e: any) => e.kind);
    expect(events).toEqual(expect.arrayContaining(['account_suspended', 'account_restored']));
  });

  it('doesn’t email the person under a legal hold', async () => {
    const before = outbox().length;
    await adminStaff.post(`/v1/admin/accounts/${id}/suspend`, {
      kind: 'legal_hold',
      reason: 'Court order 123',
    });
    expect(
      outbox()
        .slice(before)
        .filter((m) => m.to === person),
    ).toHaveLength(0);
    await adminStaff.post(`/v1/admin/accounts/${id}/restore`);
  });
});

describe('trials, given plans and coupons (ADR-0049 §4)', () => {
  let c: Client;
  let ws: string;
  const billing = async () => (await c.get(`/v1/workspaces/${ws}/billing`)).body;

  beforeAll(async () => {
    c = h.as('accounts-plans@example.test');
    ws = await newWorkspace(c);
  });

  it('extends a trial up to 30 days at a time, in Stripe first', async () => {
    const end = new Date(Date.now() + 3 * DAY);
    await admin.query(
      `insert into app.subscription (workspace_id, plan, plan_version_id, status, provider, customer_ref, subscription_ref, trial_end)
       select $1, 'pro', v.id, 'trialing', 'stripe', 'cus_trial', 'sub_trial', $2
         from app.plan_version v where v.plan_key = 'pro' and v.version = 1`,
      [ws, end],
    );
    expect(
      (await adminStaff.post(`/v1/admin/workspaces/${ws}/trial`, { days: 31, reason: 'Asked' })).status,
    ).toBe(400);
    const res = await adminStaff.post(`/v1/admin/workspaces/${ws}/trial`, {
      days: 10,
      reason: 'Needed more time',
    });
    expect(res.status).toBe(201);
    expect(Date.parse(res.body.trialEnd) - end.getTime()).toBe(10 * DAY);
    const [url, init] = stripe.mock.calls[0]!;
    expect(url).toContain('/v1/subscriptions/sub_trial');
    const form = new URLSearchParams(String(init!.body));
    expect(Number(form.get('trial_end')) * 1000).toBe(
      Math.trunc(Date.parse(res.body.trialEnd) / 1000) * 1000,
    );
    expect((await billing()).trialEnd).toBe(res.body.trialEnd);
    const row = (
      await support.get(`/v1/admin/accounts/${await userId('accounts-plans@example.test')}/workspaces`)
    ).body.data[0];
    expect(row).toMatchObject({ planName: 'Pro', trialEnd: res.body.trialEnd });
  });

  it('gives a coupon, not a given plan, to a workspace paying through Stripe', async () => {
    await admin.query(`update app.subscription set status = 'active' where workspace_id = $1`, [ws]);
    const given = await adminStaff.put(`/v1/admin/workspaces/${ws}/plan`, {
      plan: 'pro',
      reason: 'Thanks',
      until: '2099-01-01',
    });
    expect(given.status).toBe(422);
    expect(given.body.code).toBe('billing.provider_managed');
    expect(
      (
        await adminStaff.post(`/v1/admin/workspaces/${ws}/coupon`, {
          coupon: 'BETA50',
          reason: 'Beta tester',
        })
      ).status,
    ).toBe(204);
    const form = new URLSearchParams(String(stripe.mock.calls[0]![1]!.body));
    expect(form.get('discounts[0][coupon]')).toBe('BETA50');
  });

  it('gives a plan until a date, which ends by the clock and then by the sweep', async () => {
    const other = await newWorkspace(c, 'Given');
    const needsDate = await adminStaff.put(`/v1/admin/workspaces/${other}/plan`, {
      plan: 'pro',
      reason: 'Partner',
    });
    expect(needsDate.body.code).toBe('plan.until_required');
    const coupon = await adminStaff.post(`/v1/admin/workspaces/${other}/coupon`, {
      coupon: 'X',
      reason: 'Nope',
    });
    expect(coupon.status).toBe(422);
    expect(
      (
        await adminStaff.put(`/v1/admin/workspaces/${other}/plan`, {
          plan: 'pro',
          reason: 'Partner',
          until: '2099-01-01',
        })
      ).status,
    ).toBe(204);
    const get = async () => (await c.get(`/v1/workspaces/${other}/billing`)).body;
    expect(await get()).toMatchObject({ plan: 'pro', status: 'active' });
    expect(stripe).not.toHaveBeenCalled();
    await admin.query(
      `update app.subscription set current_period_end = now() - interval '1 minute' where workspace_id = $1`,
      [other],
    );
    expect((await get()).plan).toBe('free');
    await h.app.get(BillingService).sweep();
    expect(await get()).toMatchObject({ plan: 'free', status: 'canceled' });
  });
});

describe('closing an account on request (ADR-0049 §4)', () => {
  const person = 'accounts-leaving@example.test';
  let c: Client;
  let id: string;

  beforeAll(async () => {
    c = h.as(person);
    await newWorkspace(c);
    id = await userId(person);
  });

  it('is the owner’s, and only for a request from the account’s own address', async () => {
    const body = { fromEmail: person, channel: 'email', note: 'Ticket 42' };
    expect((await adminStaff.post(`/v1/admin/accounts/${id}/close`, body)).status).toBe(403);
    const wrong = await owner.post(`/v1/admin/accounts/${id}/close`, {
      ...body,
      fromEmail: 'someone@example.test',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('account.email_mismatch');
  });

  it('starts the same deletion they could have, with 30 days to change their mind', async () => {
    const before = outbox().length;
    const res = await owner.post(`/v1/admin/accounts/${id}/close`, {
      fromEmail: person.toUpperCase(),
      channel: 'email',
      note: 'Ticket 42',
    });
    expect(res.status).toBe(201);
    const days = (Date.parse(res.body.purgeAfter) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(29.9);
    expect((await c.get('/v1/workspaces')).body.code).toBe('account.deleting');
    expect((await c.get('/v1/me/deletion')).body).toMatchObject({ requested: true });
    expect(
      outbox()
        .slice(before)
        .filter((m) => m.to === person),
    ).toHaveLength(1);
    const log = await admin.query(
      `select detail from app.admin_log where action = 'account.close' and subject = $1`,
      [id],
    );
    expect(log.rows[0].detail).toMatchObject({ from: person, channel: 'email', note: 'Ticket 42' });
    const ev = await admin.query(`select kind from app.security_event where user_id = $1`, [id]);
    expect(ev.rows.map((r) => r.kind)).toContain('deletion_requested_by_support');
    // They can still change their mind.
    expect((await c.delete('/v1/me/deletion')).status).toBeLessThan(300);
    expect((await support.get(`/v1/admin/accounts?q=accounts-leaving`)).body.data[0].purgeAfter).toBeNull();
  });
});
