/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// REC-06: subscriptions the person may not be using, from their own spending (no usage data from the services):
// other spending at the merchant stopped, or several similar subscriptions in one category. Keeping one stops it
// coming back; the thresholds are planning settings.
const EMAIL = 'unused-subs@example.com';
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');

let h: Harness;
let c: Client;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;
const subs: Record<string, string> = {};

const rec06 = async () =>
  ((await c.get(url('/recommendations'))).body.data as any[]).filter((r) => r.type === 'REC-06');

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Subs', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const personal = ws.entities[0].id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('500000'),
      openingDate: addMonths(today, -14),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === personal)?.id;
  expect((await c.post(url('/budgets'), { entityId: personal, name: 'Household' })).status).toBe(201);

  // Rides beside the ride pass, the last one five months ago.
  for (const [months, amount] of [
    [-8, '-2350'],
    [-5, '-1800'],
  ] as const) {
    const t = await c.post(url('/transactions'), {
      date: addMonths(today, months),
      accountId: checking,
      amount: usd(amount),
      payee: 'UBER TRIP',
      categoryId: cat('Public transit & rideshare'),
    });
    expect(t.status).toBe(201);
  }
  for (const [name, payee, amount] of [
    ['Uber One', 'UBER ONE', '-999'],
    ['Netflix', 'NETFLIX COM', '-1549'],
    ['Hulu', 'HULU', '-799'],
  ] as const) {
    const r = await c.post(url('/recurring'), {
      name,
      accountId: checking,
      amount: usd(amount),
      payee,
      categoryId: cat('Subscriptions'),
      cadence: 'monthly',
      startDate: addMonths(today, -6),
    });
    expect(r.status).toBe(201);
    subs[name] = r.body.id;
  }
});

afterAll(async () => {
  await admin?.end();
  await h?.close();
});

describe('subscriptions you may not be using (REC-06)', () => {
  it('has default thresholds in the planning settings, and refuses a minimum of 1', async () => {
    expect((await c.get(url('/planning/settings'))).body).toMatchObject({
      unusedSubscriptionMonths: 3,
      similarSubscriptionsMin: 2,
    });
    expect((await c.patch(url('/planning/settings'), { similarSubscriptionsMin: 1 })).status).toBe(400);
    expect((await c.patch(url('/planning/settings'), { unusedSubscriptionMonths: -1 })).status).toBe(400);
  });

  it('suggests a review, saying "may", linked to the subscriptions', async () => {
    expect((await c.post(url('/recommendations/refresh'))).status).toBe(200);
    const recs = await rec06();
    expect(recs).toHaveLength(2);
    const idle = recs.find((r) => r.payload.subjects.length === 1);
    expect(idle).toMatchObject({
      title: `You may not be using Uber One: no other spending there since ${addMonths(today, -5)}`,
      payload: {
        figures: {
          lastOtherSpendingThere: addMonths(today, -5),
          monthsWithoutOtherSpending: '3 months',
          charge: '999',
          costPerYear: '11988',
        },
        subjects: [{ id: subs['Uber One'], name: 'Uber One', amount: '999' }],
        actions: [{ kind: 'review_subscription', recurringItemId: subs['Uber One'] }],
      },
    });
    // Netflix and Hulu: never any other spending there, so no "idle" hint; but both are streaming.
    const similar = recs.find((r) => r.payload.subjects.length === 2);
    expect(similar.title).toMatch(
      /^You pay for 2 similar subscriptions \((Netflix, Hulu|Hulu, Netflix)\); you may not need them all$/,
    );
    expect(similar.payload.figures).toEqual({
      similarSubscriptions: '2',
      combinedCostPerYear: String((1549 + 799) * 12),
    });
    expect(similar.payload.actions.map((a: any) => a.recurringItemId).sort()).toEqual(
      [subs.Netflix, subs.Hulu].sort(),
    );
    // The same period: not again.
    expect((await c.post(url('/recommendations/refresh'))).body.created).toBe(0);
  });

  it('does not suggest a kept subscription again; an ignored one comes back next period', async () => {
    const idle = (await rec06()).find((r) => r.payload.subjects.length === 1);
    expect((await c.post(url(`/recommendations/${idle.id}/dismiss`))).body.status).toBe('dismissed');
    // As if both were from last period: the ignored one expired then.
    await admin.query(
      `update app.recommendation
          set dedupe_key = regexp_replace(dedupe_key, ':[0-9-]+$', ':2000-01-01'), period_start = '2000-01-01',
              status = case when status = 'open' then 'expired' else status end
        where workspace_id = $1 and type = 'REC-06'`,
      [wsId],
    );
    expect((await c.post(url('/recommendations/refresh'))).body.created).toBe(1);
    const recs = await rec06();
    expect(recs).toHaveLength(1);
    expect(recs[0].payload.subjects).toHaveLength(2);
  });

  it('follows the settings: 0 turns each hint off', async () => {
    await admin.query(`delete from app.recommendation where workspace_id = $1 and type = 'REC-06'`, [wsId]);
    const res = await c.patch(url('/planning/settings'), {
      unusedSubscriptionMonths: 0,
      similarSubscriptionsMin: 0,
    });
    expect(res.body).toMatchObject({ unusedSubscriptionMonths: 0, similarSubscriptionsMin: 0 });
    await c.post(url('/recommendations/refresh'));
    expect(await rec06()).toEqual([]);

    // 7 months: the last ride (5 months ago) is inside the window. 4 months: it isn't, so Uber One shows.
    await c.patch(url('/planning/settings'), { unusedSubscriptionMonths: 7 });
    await c.post(url('/recommendations/refresh'));
    expect(await rec06()).toEqual([]);
    await c.patch(url('/planning/settings'), { unusedSubscriptionMonths: 4 });
    await c.post(url('/recommendations/refresh'));
    expect((await rec06()).map((r) => r.payload.subjects[0].name)).toEqual(['Uber One']);
  });

  it('leaves ended subscriptions alone', async () => {
    await admin.query(`delete from app.recommendation where workspace_id = $1 and type = 'REC-06'`, [wsId]);
    await c.patch(url('/planning/settings'), { unusedSubscriptionMonths: 3, similarSubscriptionsMin: 2 });
    expect((await c.patch(url(`/recurring/${subs['Uber One']}`), { status: 'ended' })).status).toBe(200);
    expect((await c.patch(url(`/recurring/${subs.Hulu}`), { status: 'ended' })).status).toBe(200);
    await c.post(url('/recommendations/refresh'));
    expect(await rec06()).toEqual([]);
  });
});
