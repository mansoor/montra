/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfMonth, startOfMonth, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Home for another period (FLOW-01): the income, spending and budget figures follow ?period=; the rest stays today.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
const thisMonth = startOfMonth(today);
const lastMonth = addMonths(thisMonth, -1);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let personal: string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('dashboard-period@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Months', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities[0].id;
  const checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('1000000'),
      openingDate: addDays(lastMonth, -40),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (name: string) => cats.find((x: any) => x.name === name && x.entityId === personal)?.id;
  const post = (date: string, amount: string, category: string) =>
    c.post(url('/transactions'), {
      date,
      accountId: checking,
      amount: usd(amount),
      payee: 'X',
      categoryId: cat(category),
    });
  await post(lastMonth, '500000', 'Salary');
  await post(addDays(lastMonth, 3), '-30000', 'Groceries');
  await post(addDays(lastMonth, 8), '-12000', 'Dining out');
  await post(thisMonth, '-4000', 'Dining out');
});

afterAll(async () => {
  await h?.close();
});

describe('Home for another period (FLOW-01)', () => {
  it('shows the current month by default, with only a way back', async () => {
    const d = (await c.get(url('/dashboard'))).body;
    expect(d).toMatchObject({
      period: { start: thisMonth, end: endOfMonth(thisMonth) },
      current: true,
      nav: { previous: addDays(thisMonth, -1), next: null, nextIsCurrent: false },
      income: { amount: '0' },
      spent: { amount: '4000' },
    });
  });

  it('shows last month’s money in and out for any date in it, pointing back to now', async () => {
    const d = (await c.get(url(`/dashboard?period=${addDays(lastMonth, 10)}`))).body;
    expect(d).toMatchObject({
      period: { start: lastMonth, end: endOfMonth(lastMonth) },
      current: false,
      nav: { previous: addDays(lastMonth, -1), next: thisMonth, nextIsCurrent: true },
      income: { amount: '500000', drill: { from: lastMonth, to: endOfMonth(lastMonth) } },
      spent: { amount: '42000', drill: { from: lastMonth, to: endOfMonth(lastMonth) } },
    });
  });

  it('follows the budget’s periods, with no pace for a past one', async () => {
    const budget = (await c.post(url('/budgets'), { entityId: personal, name: 'Household' })).body;
    const d = (await c.get(url(`/dashboard?period=${lastMonth}`))).body;
    expect(d).toMatchObject({
      budgetId: budget.id,
      period: { start: lastMonth, end: endOfMonth(lastMonth) },
      current: false,
      income: { amount: '500000' },
      spent: { amount: '42000' },
      pace: [],
    });
    expect(d.leftToAssign).not.toBeNull();
    const now = (await c.get(url('/dashboard'))).body;
    expect(now).toMatchObject({ budgetId: budget.id, current: true, spent: { amount: '4000' } });
  });

  it('shows the current period for a later date, and refuses a malformed one', async () => {
    const d = (await c.get(url(`/dashboard?period=${addMonths(thisMonth, 3)}`))).body;
    expect(d).toMatchObject({ period: { start: thisMonth }, current: true, nav: { next: null } });
    expect((await c.get(url('/dashboard?period=last-month'))).status).toBe(400);
  });
});
