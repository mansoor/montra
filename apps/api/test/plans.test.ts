/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { createHmac, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, setContext, type Database } from '@montra/db';
import { parseEntitlements, PRO_STORAGE_BYTES, FREE_STORAGE_BYTES } from '@montra/domain';
import { AiService } from '../src/ai/ai.service.js';
import { Db } from '../src/db/database.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Plans as data and the AI allowance (ADR-0049 §1, §2).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const WEBHOOK_SECRET = 'whsec_plans_test_only';
const GB = 1024n ** 3n;
const month = () => `${new Date().toISOString().slice(0, 7)}-01`;

const PLUS = {
  businessBooks: 2,
  rentalPortfolios: 0,
  storageBytes: Number(100n * GB),
  familyLogins: 2,
  aiMonthlyMicroUsd: 1_000_000,
  smsMonthly: 50,
  features: ['payroll', 'voice'],
};

let admin: pg.Client;
let h: Harness;
let plusVersion: string;
const stripe = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let subscription: Record<string, unknown>;
const realFetch = globalThis.fetch;
let eventNo = 0;

const userId = async (email: string) =>
  (await admin.query(`select id from app.app_user where email = $1`, [email])).rows[0].id as string;

async function newWorkspace(c: Client) {
  const res = await c.post('/v1/workspaces', {
    name: 'Plans test',
    type: 'household',
    baseCurrency: 'USD',
    timeZone: 'UTC',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Signed exactly as the provider signs it. */
const deliver = async (type: string, object: Record<string, unknown>) => {
  const body = JSON.stringify({ id: `evt_plans_${++eventNo}`, type, data: { object } });
  const t = Math.trunc(Date.now() / 1000);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return h.app.inject({
    method: 'POST',
    url: '/v1/billing/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` },
    payload: body,
  });
};

const onPrice = (ws: string, price: string, over: Record<string, unknown> = {}) => ({
  id: `sub_${ws}`,
  customer: `cus_${ws}`,
  status: 'active',
  cancel_at_period_end: false,
  trial_end: null,
  metadata: { workspace_id: ws },
  items: {
    data: [{ current_period_end: 1_900_000_000, price: { id: price, recurring: { interval: 'month' } } }],
  },
  ...over,
});

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({
    BILLING_MODE: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_plans_only',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    AI_PROVIDER: 'fake',
  });
  // A third tier, as the owner would add it in the console.
  await admin.query(
    `insert into app.plan (key, name, description, sort_order) values ('plus', 'Plus', 'For testing', 20)
     on conflict do nothing`,
  );
  plusVersion = (
    await admin.query(
      `insert into app.plan_version (plan_key, version, entitlements) values ('plus', 1, $1)
       on conflict (plan_key, version) do update set plan_key = excluded.plan_key returning id`,
      [JSON.stringify(PLUS)],
    )
  ).rows[0].id;
  await admin.query(
    `insert into app.plan_price (plan_version_id, provider, billing_interval, price_ref, amount_minor, currency)
     values ($1, 'stripe', 'month', 'price_plus_month', 1500, 'USD'), ($1, 'stripe', 'year', 'price_plus_year', 15000, 'USD')
     on conflict do nothing`,
    [plusVersion],
  );
  stripe.mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/v1/checkout/sessions') {
      return new Response(JSON.stringify({ url: 'https://checkout.example/session' }), { status: 200 });
    }
    return new Response(JSON.stringify(subscription), { status: 200 });
  });
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

describe('plans as data (ADR-0049 §1)', () => {
  let c: Client;
  let ws: string;
  const billing = async () => (await c.get(`/v1/workspaces/${ws}/billing`)).body;

  beforeAll(async () => {
    c = h.as('plans-owner@example.test');
    ws = await newWorkspace(c);
  });

  it('seeds Free and Pro with exactly what they allowed before', async () => {
    const { rows } = await admin.query(
      `select plan_key, entitlements from app.plan_version where version = 1 and plan_key in ('free', 'pro')`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.plan_key, parseEntitlements(r.entitlements)]));
    const all = ['payroll', 'staffTime', 'scans', 'voice', 'ownStorage'];
    expect(by.free).toEqual({
      businessBooks: 0,
      rentalPortfolios: 0,
      storageBytes: FREE_STORAGE_BYTES,
      familyLogins: null,
      aiMonthlyMicroUsd: null,
      smsMonthly: 0,
      features: all,
    });
    expect(by.pro).toEqual({
      ...by.free,
      businessBooks: 10,
      rentalPortfolios: 10,
      storageBytes: PRO_STORAGE_BYTES,
    });
    expect(await billing()).toMatchObject({
      plan: 'free',
      planName: 'Free',
      entitlements: { businessBooks: 0 },
    });
  });

  it('checks out by plan key and interval, at the price on the plan’s latest version', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'plus', interval: 'year' });
    expect(res.status).toBe(201);
    const form = new URLSearchParams(String(stripe.mock.calls[0]![1]!.body));
    expect(form.get('line_items[0][price]')).toBe('price_plus_year');
    for (const plan of ['free', 'nothing']) {
      const none = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan, interval: 'month' });
      expect(none.status).toBe(404);
      expect(none.body.code).toBe('billing.no_price');
    }
  });

  it('doesn’t sell a plan that’s been withdrawn', async () => {
    await admin.query(`update app.plan set offered = false where key = 'plus'`);
    try {
      const res = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'plus', interval: 'month' });
      expect(res.status).toBe(404);
    } finally {
      await admin.query(`update app.plan set offered = true where key = 'plus'`);
    }
  });

  it('finds the version from the price id, and takes the quota from it', async () => {
    subscription = onPrice(ws, 'price_plus_month');
    expect((await deliver('customer.subscription.created', subscription)).statusCode).toBe(200);
    expect(await billing()).toMatchObject({
      plan: 'plus',
      planName: 'Plus',
      status: 'active',
      entitlements: {
        businessBooks: 2,
        rentalPortfolios: 0,
        familyLogins: 2,
        aiMonthlyMicroUsd: '1000000',
        smsMonthly: 50,
        features: ['payroll', 'voice'],
        storageBytes: String(100n * GB),
      },
      features: { businessEntities: true, rentalEntities: false, maxBusinesses: 2 },
    });
    const row = await admin.query(
      `select s.plan_version_id, w.storage_quota_bytes from app.subscription s join app.workspace w on w.id = s.workspace_id
        where s.workspace_id = $1`,
      [ws],
    );
    expect(row.rows[0]).toMatchObject({
      plan_version_id: plusVersion,
      storage_quota_bytes: 100n * GB,
    });
  });

  it('leaves a workspace as it was when the price is on no plan', async () => {
    subscription = onPrice(ws, 'price_nobody_added');
    expect((await deliver('customer.subscription.updated', subscription)).statusCode).toBe(200);
    expect((await billing()).plan).toBe('plus');
  });

  it('won’t sell a second subscription on top of a paid one', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'pro', interval: 'month' });
    expect(res.status).toBe(409);
  });

  it('adds books up to the plan’s count, and none it doesn’t include', async () => {
    for (const name of ['One', 'Two']) {
      expect((await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name })).status).toBe(201);
    }
    const third = await c.post(`/v1/workspaces/${ws}/entities`, { type: 'business', name: 'Three' });
    expect(third.status).toBe(422);
    expect(third.body.code).toBe('plan.limit');
    const rental = await c.post(`/v1/workspaces/${ws}/entities`, { type: 'rental', name: 'Flat' });
    expect(rental.status).toBe(402);
  });

  it('refuses adding with a feature the plan doesn’t have', async () => {
    const res = await c.post(`/v1/workspaces/${ws}/scans`, { kind: 'payslip', fileIds: [randomUUID()] });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('plan.required');
  });

  it('limits how many people can sign in, counting open invites', async () => {
    const first = await c.post(`/v1/workspaces/${ws}/sharing/invites`, {
      email: 'plans-partner@example.test',
      role: 'partner',
    });
    expect(first.status).toBe(201);
    const second = await c.post(`/v1/workspaces/${ws}/sharing/invites`, {
      email: 'plans-another@example.test',
      role: 'partner',
    });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('plan.limit');
  });

  it('never changes a version someone is subscribed to; a new version is the way', async () => {
    await expect(
      admin.query(
        `update app.plan_version set entitlements = entitlements || '{"businessBooks": 5}' where id = $1`,
        [plusVersion],
      ),
    ).rejects.toThrow(/has subscribers/);
    const draft = await admin.query(
      `insert into app.plan_version (plan_key, version, entitlements) values ('plus', 2, $1) returning id`,
      [JSON.stringify(PLUS)],
    );
    await admin.query(
      `update app.plan_version set entitlements = entitlements || '{"businessBooks": 5}' where id = $1`,
      [draft.rows[0].id],
    );
    // Existing subscribers stay on their version.
    expect((await billing()).entitlements.businessBooks).toBe(2);
    await admin.query(`delete from app.plan_version where id = $1`, [draft.rows[0].id]);
  });

  it('keeps Free offered', async () => {
    await expect(admin.query(`update app.plan set offered = false where key = 'free'`)).rejects.toThrow(
      /check/,
    );
  });

  it('goes back to Free’s current version when the subscription ends', async () => {
    subscription = onPrice(ws, 'price_plus_month', { status: 'canceled' });
    await deliver('customer.subscription.deleted', subscription);
    expect(await billing()).toMatchObject({
      plan: 'free',
      status: 'canceled',
      entitlements: { businessBooks: 0 },
    });
  });
});

describe('the AI allowance (ADR-0049 §2)', () => {
  let c: Client;
  let ws: string;
  let owner: string;
  let ai: AiService;
  let db: Db;
  const runtime = () =>
    db.run({ workspaceId: ws, userId: owner }, (trx) => ai.runtime(trx, { workspaceId: ws, userId: owner }));
  const spend = (micro: number) =>
    admin.query(
      `insert into app.ai_usage (workspace_id, month, calls, cost_micro_usd, builtin_micro_usd) values ($1, $2, 1, $3, $3)
       on conflict (workspace_id, month) do update set cost_micro_usd = $3, builtin_micro_usd = $3`,
      [ws, month(), micro],
    );
  const settings = async () => (await c.get(`/v1/workspaces/${ws}/ai/settings`)).body;
  const allowanceNotices = async () =>
    (await c.get(`/v1/workspaces/${ws}/notifications?limit=50`)).body.data.filter(
      (n: any) => n.type === 'ai_allowance',
    );

  beforeAll(async () => {
    c = h.as('plans-ai@example.test');
    ws = await newWorkspace(c);
    owner = await userId('plans-ai@example.test');
    ai = h.app.get(AiService);
    db = h.app.get(Db);
    await admin.query(
      `select app.apply_plan_version($1, $2, 'active', 'staff', null, null, null, null, null, null, false)`,
      [ws, plusVersion],
    );
  });

  it('applies the plan’s allowance to built-in AI, and the customer can only lower it', async () => {
    expect((await runtime()).ctx.budget).toMatchObject({ monthlyUsd: null, planMicroUsd: 1_000_000n });
    await spend(250_000);
    expect((await settings()).usage).toMatchObject({ planAllowance: true, share: 0.25, state: 'ok' });
    await c.patch(`/v1/workspaces/${ws}/ai/settings`, { monthlyBudgetUsd: 0.5 });
    expect((await settings()).usage).toMatchObject({ share: 0.5 });
    // A budget above the plan's allowance changes nothing.
    await c.patch(`/v1/workspaces/${ws}/ai/settings`, { monthlyBudgetUsd: 50 });
    expect((await settings()).usage).toMatchObject({ share: 0.25 });
    await c.patch(`/v1/workspaces/${ws}/ai/settings`, { monthlyBudgetUsd: null });
  });

  it('leaves a customer’s own model to their own budget', async () => {
    await c.patch(`/v1/workspaces/${ws}/ai/settings`, {
      mode: 'local',
      endpoint: 'http://localhost:11434/v1',
    });
    try {
      expect((await runtime()).ctx.budget.planMicroUsd).toBeNull();
      expect((await settings()).usage).toMatchObject({ planAllowance: false, share: null });
    } finally {
      await c.patch(`/v1/workspaces/${ws}/ai/settings`, { mode: 'builtin' });
    }
  });

  it('tells the owners at 80% and at 100%, once each', async () => {
    await spend(850_000);
    const r = await runtime();
    await r.ctx.store.addUsage(0n, 1);
    await r.ctx.store.addUsage(0n, 1);
    expect((await allowanceNotices()).map((n: any) => n.title)).toEqual([
      'You’ve used 80% of this month’s AI',
    ]);
    expect((await settings()).usage.state).toBe('downgraded');
    await spend(1_000_000);
    await (await runtime()).ctx.store.addUsage(0n, 1);
    const titles = (await allowanceNotices()).map((n: any) => n.title);
    expect(titles).toContain('This month’s AI is used up');
    expect(titles).toHaveLength(2);
    expect((await settings()).usage).toMatchObject({ state: 'exhausted', share: 1 });
    await spend(0);
  });

  it('counts only built-in AI towards what the service pays for', async () => {
    await c.patch(`/v1/workspaces/${ws}/ai/settings`, {
      mode: 'local',
      endpoint: 'http://localhost:11434/v1',
    });
    try {
      await (await runtime()).ctx.store.addUsage(5n, 1);
    } finally {
      await c.patch(`/v1/workspaces/${ws}/ai/settings`, { mode: 'builtin' });
    }
    await (await runtime()).ctx.store.addUsage(7n, 1);
    const row = await admin.query(
      `select cost_micro_usd, builtin_micro_usd from app.ai_usage where workspace_id = $1`,
      [ws],
    );
    expect(row.rows[0]).toEqual({ cost_micro_usd: 12n, builtin_micro_usd: 7n });
  });

  it('stops built-in AI everywhere at the operator’s ceiling, and tells staff once', async () => {
    const staff = h.as('plans-staff@example.test');
    await staff.get('/v1/me');
    await admin.query(
      `insert into app.staff_user (user_id, role) values ($1, 'admin') on conflict do nothing`,
      [await userId('plans-staff@example.test')],
    );
    // The ceiling is the whole service's, so it's set only inside a transaction that's rolled back: other test
    // files share this database.
    const owner$ = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: createPool(ADMIN_URL, { max: 1 }) }),
    });
    const rollback = new Error('rollback');
    try {
      await owner$
        .transaction()
        .execute(async (trx) => {
          await setContext(trx, { workspaceId: ws, userId: owner });
          await trx
            .insertInto('app.system_setting')
            .values({ key: 'ai_monthly_ceiling_micro_usd', value: '0' })
            .onConflict((oc) => oc.column('key').doUpdateSet({ value: '0' }))
            .execute();
          expect((await ai.runtime(trx, { workspaceId: ws, userId: owner })).ctx.budget.planMicroUsd).toBe(
            0n,
          );
          throw rollback;
        })
        .catch((e) => {
          if (e !== rollback) throw e;
        });
    } finally {
      await owner$.destroy();
    }
    const outbox = h.app.get<MemoryMail>(MAIL_PORT).outbox;
    await vi.waitFor(() =>
      expect(
        outbox.filter((m) => m.to === 'plans-staff@example.test' && /built-in AI is stopped/.test(m.subject)),
      ).toHaveLength(1),
    );
    // Nothing else changed: the next workspace's AI runs.
    expect((await runtime()).ctx.budget.planMicroUsd).toBe(1_000_000n);
  });

  it('lets admin staff set the ceiling, and shows the service’s spend', async () => {
    const staff = h.as('plans-staff@example.test');
    expect((await staff.get('/v1/admin/ai-ceiling')).body).toMatchObject({
      ceilingUsd: null,
      reached: false,
    });
    // High enough that no other test file's AI could reach it.
    expect((await staff.put('/v1/admin/ai-ceiling', { ceilingUsd: 900_000 })).status).toBe(204);
    expect((await staff.get('/v1/admin/ai-ceiling')).body).toMatchObject({
      ceilingUsd: 900_000,
      reached: false,
    });
    expect((await staff.put('/v1/admin/ai-ceiling', { ceilingUsd: null })).status).toBe(204);
    expect((await staff.get('/v1/admin/ai-ceiling')).body.ceilingUsd).toBeNull();
    const log = await admin.query(
      `select count(*)::int as n from app.admin_log where action = 'ai_ceiling.save'`,
    );
    expect(log.rows[0].n).toBe(2);
  });
});
