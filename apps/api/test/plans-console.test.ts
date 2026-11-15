/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { BillingService } from '../src/ops/billing.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The platform owner, staff management, the plans editor and the plan picker (ADR-0049 §1, §3).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const WEBHOOK_SECRET = 'whsec_console_test_only';
const DAY = 86_400_000;

const ENT = {
  businessBooks: 3,
  rentalPortfolios: 1,
  storageBytes: String(20n * 1024n ** 3n),
  familyLogins: 4,
  aiMonthlyMicroUsd: '2000000',
  smsMonthly: 0,
  features: ['payroll', 'scans'],
};

let admin: pg.Client;
let h: Harness;
let owner: Client;
let adminStaff: Client;
let support: Client;
let customer: Client;
const realFetch = globalThis.fetch;
let subscription: Record<string, unknown> = {};

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

const deliver = async (type: string, object: Record<string, unknown>) => {
  const body = JSON.stringify({ id: `evt_console_${Math.random()}`, type, data: { object } });
  const t = Math.trunc(Date.now() / 1000);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return h.app.inject({
    method: 'POST',
    url: '/v1/billing/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` },
    payload: body,
  });
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({
    BILLING_MODE: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_console_only',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  owner = await staff('console-owner@example.test', 'owner');
  adminStaff = await staff('console-admin@example.test', 'admin');
  support = await staff('console-support@example.test', 'support');
  customer = h.as('console-customer@example.test');
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) =>
    String(url).startsWith('https://api.stripe.com')
      ? Promise.resolve(new Response(JSON.stringify(subscription), { status: 200 }))
      : realFetch(url, init),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h.close();
  await admin.end();
});

describe('staff, managed by owners (ADR-0049 §3)', () => {
  it('is the owner’s alone', async () => {
    expect((await owner.get('/v1/admin/me')).body.role).toBe('owner');
    for (const c of [adminStaff, support]) {
      expect((await c.get('/v1/admin/staff')).status).toBe(403);
      expect((await c.put('/v1/admin/staff', { email: 'x@example.test', role: 'support' })).status).toBe(403);
    }
    const list = (await owner.get('/v1/admin/staff')).body.data;
    expect(list.map((s: any) => s.email)).toEqual(
      expect.arrayContaining(['console-owner@example.test', 'console-admin@example.test']),
    );
  });

  it('adds someone who has signed in, and tells every owner', async () => {
    await h.as('console-new@example.test').get('/v1/me');
    const before = outbox().length;
    expect(
      (await owner.put('/v1/admin/staff', { email: 'Console-New@example.test', role: 'support' })).status,
    ).toBe(204);
    const sent = outbox().slice(before);
    expect(sent.map((m) => m.to)).toContain('console-owner@example.test');
    expect(sent[0]!.subject).toMatch(/console-new@example.test is now support/);
    const row = (await owner.get('/v1/admin/staff')).body.data.find(
      (s: any) => s.email === 'console-new@example.test',
    );
    expect(row).toMatchObject({ role: 'support', addedBy: 'console-owner@example.test' });
    const log = await admin.query(`select action, detail from app.admin_log where action = 'staff.set'`);
    expect(log.rows.some((r) => r.detail.email === 'console-new@example.test')).toBe(true);
  });

  it('can’t add someone without an account', async () => {
    const res = await owner.put('/v1/admin/staff', { email: 'nobody-here@example.test', role: 'admin' });
    expect(res.status).toBe(404);
  });

  it('lets admins do what admins did, and owners too', async () => {
    const flag = { key: 'console.thing', enabled: true, rollout: 100, note: '' };
    expect((await adminStaff.put('/v1/admin/flags', flag)).status).toBe(204);
    expect((await owner.delete('/v1/admin/flags/console.thing')).status).toBe(204);
  });

  it('always keeps an owner', async () => {
    const me = await userId('console-owner@example.test');
    // Other test files may have owners of their own, so this one checks against the rule, not a count.
    const owners = await admin.query(`select count(*)::int as n from app.staff_user where role = 'owner'`);
    if (owners.rows[0].n === 1) {
      const demote = await owner.put('/v1/admin/staff', {
        email: 'console-owner@example.test',
        role: 'admin',
      });
      expect(demote.status).toBe(422);
      expect(demote.body.code).toBe('staff.last_owner');
      expect((await owner.delete(`/v1/admin/staff/${me}`)).status).toBe(422);
    }
    // And in the database, whoever asks.
    await expect(
      admin.query(`select app.admin_set_staff($1, 'console-admin@example.test', 'owner')`, [
        await userId('console-admin@example.test'),
      ]),
    ).rejects.toThrow(/owner role/);
  });

  it('removes staff, and tells every owner', async () => {
    const id = await userId('console-new@example.test');
    const before = outbox().length;
    expect((await owner.delete(`/v1/admin/staff/${id}`)).status).toBe(204);
    expect(outbox().slice(before)[0]!.subject).toMatch(/was removed/);
    expect((await owner.delete(`/v1/admin/staff/${id}`)).status).toBe(404);
  });

  it('keeps the AI ceiling to owners', async () => {
    expect((await adminStaff.put('/v1/admin/ai-ceiling', { ceilingUsd: 900_000 })).status).toBe(403);
    expect((await owner.put('/v1/admin/ai-ceiling', { ceilingUsd: null })).status).toBe(204);
  });
});

describe('the plans editor (ADR-0049 §1)', () => {
  let v1: string;
  let ws: string;

  const plan = async () =>
    (await adminStaff.get('/v1/admin/plans')).body.data.find((p: any) => p.key === 'team');
  const billing = async () => (await customer.get(`/v1/workspaces/${ws}/billing`)).body;

  beforeAll(async () => {
    const res = await customer.post('/v1/workspaces', {
      name: 'Console customer',
      type: 'household',
      baseCurrency: 'USD',
      timeZone: 'UTC',
    });
    ws = res.body.id;
  });

  it('lets owners make a plan, its versions and prices; admins only look', async () => {
    const save = { key: 'team', name: 'Team', description: 'For teams', sortOrder: 30, offered: true };
    expect((await adminStaff.put('/v1/admin/plans', save)).status).toBe(403);
    expect((await owner.put('/v1/admin/plans', save)).status).toBe(204);
    const created = await owner.post('/v1/admin/plans/team/versions', { entitlements: ENT });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);
    v1 = created.body.id;
    const price = { interval: 'month', priceRef: 'price_team_m1', amountMinor: '1900', currency: 'usd' };
    expect((await owner.post(`/v1/admin/plan-versions/${v1}/prices`, price)).status).toBe(201);
    expect(await plan()).toMatchObject({
      name: 'Team',
      offered: true,
      versions: [
        {
          version: 1,
          subscribers: 0,
          entitlements: { businessBooks: 3, features: ['payroll', 'scans'] },
          prices: [{ priceRef: 'price_team_m1', amountMinor: '1900', currency: 'USD', active: true }],
        },
      ],
    });
  });

  it('refuses entitlements outside the schema', async () => {
    const res = await owner.post('/v1/admin/plans/team/versions', {
      entitlements: { ...ENT, features: ['teleport'] },
    });
    expect(res.status).toBe(400);
  });

  it('offers the plan in the picker, with its price, to anyone signed in', async () => {
    const offers = (await customer.get('/v1/plans')).body.data;
    expect(offers.find((o: any) => o.key === 'team')).toMatchObject({
      name: 'Team',
      entitlements: { businessBooks: 3 },
      prices: [{ interval: 'month', amountMinor: '1900', currency: 'USD' }],
    });
    expect(offers.some((o: any) => o.key === 'free')).toBe(true);
  });

  it('a new price replaces the one new customers get, and the old one still names its subscribers', async () => {
    subscription = {
      id: `sub_${ws}`,
      customer: `cus_${ws}`,
      status: 'active',
      cancel_at_period_end: false,
      trial_end: null,
      metadata: { workspace_id: ws },
      items: {
        data: [
          {
            current_period_end: 1_900_000_000,
            price: { id: 'price_team_m1', recurring: { interval: 'month' } },
          },
        ],
      },
    };
    await deliver('customer.subscription.created', subscription);
    expect((await billing()).plan).toBe('team');
    await owner.post(`/v1/admin/plan-versions/${v1}/prices`, {
      interval: 'month',
      priceRef: 'price_team_m2',
      amountMinor: '2400',
      currency: 'USD',
    });
    const prices = (await plan()).versions[0].prices;
    expect(prices.map((p: any) => [p.priceRef, p.active])).toEqual([
      ['price_team_m1', false],
      ['price_team_m2', true],
    ]);
    await deliver('invoice.paid', { subscription: subscription.id });
    expect((await billing()).plan).toBe('team');
  });

  it('moves subscribers at once to a version that gives more, and the webhook keeps them there', async () => {
    const v2 = (
      await owner.post('/v1/admin/plans/team/versions', { entitlements: { ...ENT, businessBooks: 5 } })
    ).body.id;
    expect((await adminStaff.post('/v1/admin/plans/move', { from: v1, to: v2 })).status).toBe(403);
    const moved = await owner.post('/v1/admin/plans/move', { from: v1, to: v2 });
    expect(moved.body).toEqual({ moved: 1, when: 'now' });
    expect((await billing()).entitlements.businessBooks).toBe(5);
    // Stripe still has them on version 1's price.
    await deliver('invoice.paid', { subscription: subscription.id });
    expect((await billing()).entitlements.businessBooks).toBe(5);
  });

  it('gives 30 days’ notice and the next renewal for a version that gives less, and tells each customer', async () => {
    const versions = (await plan()).versions;
    const v2 = versions[0].id;
    const tooSoon = await owner.post('/v1/admin/plans/team/versions', {
      entitlements: { ...ENT, businessBooks: 1 },
    });
    expect(tooSoon.status).toBe(422);
    expect(tooSoon.body.code).toBe('plan.notice_required');
    const later = new Date(Date.now() + 31 * DAY).toISOString();
    const v3 = (
      await owner.post('/v1/admin/plans/team/versions', {
        entitlements: { ...ENT, businessBooks: 1 },
        effectiveFrom: later,
      })
    ).body.id;
    // Not current until it starts: the picker still shows version 2.
    const offer = (await customer.get('/v1/plans')).body.data.find((o: any) => o.key === 'team');
    expect(offer.entitlements.businessBooks).toBe(5);

    expect((await owner.post('/v1/admin/plans/move', { from: v2, to: v3 })).body.code).toBe(
      'plan.notice_required',
    );
    const moved = await owner.post('/v1/admin/plans/move', { from: v2, to: v3, after: later });
    expect(moved.body).toEqual({ moved: 1, when: 'renewal' });
    const sub = await admin.query(
      `select pending_version_id, pending_from from app.subscription where workspace_id = $1`,
      [ws],
    );
    expect(sub.rows[0].pending_version_id).toBe(v3);
    // The first renewal on or after the date, stepped from the period end Stripe gave.
    expect(sub.rows[0].pending_from.getTime()).toBeGreaterThanOrEqual(Date.parse(later));
    expect((await billing()).entitlements.businessBooks).toBe(5);

    const before = outbox().length;
    expect(await h.app.get(BillingService).sendPlanNotices()).toBeGreaterThanOrEqual(1);
    const told = outbox()
      .slice(before)
      .filter((m) => m.to === 'console-customer@example.test');
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toMatch(/Team plan changes on/);
    expect(await h.app.get(BillingService).sendPlanNotices()).toBe(0);

    // Once its date has come, the hourly sweep applies it.
    await admin.query(
      `update app.subscription set pending_from = now() - interval '1 minute' where workspace_id = $1`,
      [ws],
    );
    await h.app.get(BillingService).sweep();
    expect((await billing()).entitlements.businessBooks).toBe(1);
  });

  it('never lets Free be withdrawn or priced', async () => {
    const free = (await adminStaff.get('/v1/admin/plans')).body.data.find((p: any) => p.key === 'free');
    expect(
      (
        await owner.put('/v1/admin/plans', {
          key: 'free',
          name: 'Free',
          description: '',
          sortOrder: 0,
          offered: false,
        })
      ).status,
    ).toBe(422);
    const priced = await owner.post(`/v1/admin/plan-versions/${free.versions[0].id}/prices`, {
      interval: 'month',
      priceRef: 'price_free_never',
      amountMinor: '100',
      currency: 'USD',
    });
    expect(priced.status).toBe(422);
  });

  it('keeps every plan change in the staff log', async () => {
    const log = await admin.query(
      `select action from app.admin_log where action like 'plan.%' and staff_id = $1 order by at`,
      [await userId('console-owner@example.test')],
    );
    expect(new Set(log.rows.map((r) => r.action))).toEqual(
      new Set(['plan.save', 'plan.version', 'plan.price', 'plan.move']),
    );
  });
});
