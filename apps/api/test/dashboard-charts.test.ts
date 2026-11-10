/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfMonth, spendingPace, startOfMonth, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// The Home charts (FLOW-01, FAM-09): money in and out and net worth per month, the budget so far, where the money
// went this month, and last month's biggest changes from the three before.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
const thisMonth = startOfMonth(today);
const month = (back: number) => addMonths(thisMonth, -back);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let personal: string;
let checking: string;

const post = (date: string, amount: string, category: string, payee = 'Store') =>
  c.post(url('/transactions'), {
    date,
    accountId: checking,
    amount: usd(amount),
    payee,
    categoryId: cat(category),
  });

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('insights@example.com');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Insights', baseCurrency: 'USD', template: 'household' })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities[0].id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('1000000'),
      openingDate: addDays(month(6), -1),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === personal)?.id;

  // Four months back to last month: salary every month; groceries 300 then a 600 spike last month; dining out
  // 100 a month, then none last month. This month: salary, 200 groceries, 50 dining, an 80 utility bill.
  for (const back of [4, 3, 2, 1]) {
    await post(month(back), '500000', 'Salary', 'ACME PAYROLL');
    await post(addDays(month(back), 3), back === 1 ? '-60000' : '-30000', 'Groceries');
    if (back !== 1) await post(addDays(month(back), 5), '-10000', 'Dining out', 'Bistro');
  }
  await post(thisMonth, '500000', 'Salary', 'ACME PAYROLL');
  await post(thisMonth, '-20000', 'Groceries');
  await post(thisMonth, '-5000', 'Dining out', 'Bistro');
  await post(thisMonth, '-8000', 'Utilities', 'City Power');
});

afterAll(async () => {
  await h?.close();
});

describe('Home charts (FLOW-01)', () => {
  it('gives money in and out and net worth for each month, the current month last', async () => {
    const r = await c.get(url('/dashboard/charts?months=6'));
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.months).toBe(6);
    expect(d.monthly).toHaveLength(6);
    expect(d.monthly.map((m: any) => m.start)).toEqual([5, 4, 3, 2, 1, 0].map(month));
    expect(d.monthly[5].end).toBe(endOfMonth(thisMonth));
    expect(d.monthly.slice(1).map((m: any) => [m.income, m.spending, m.net])).toEqual([
      ['500000', '40000', '460000'],
      ['500000', '40000', '460000'],
      ['500000', '40000', '460000'],
      ['500000', '60000', '440000'],
      ['500000', '33000', '467000'],
    ]);
    expect(d.monthly[0]).toMatchObject({ income: '0', spending: '0', net: '0' });

    // The last point is today's net worth; the rest are month ends, and they move with the money.
    const nw = (await c.get(url('/net-worth?months=1'))).body;
    expect(d.monthly[5].netWorth).toBe(nw.netWorth);
    const worth = d.monthly.map((m: any) => BigInt(m.netWorth));
    expect(worth[2]! - worth[1]!).toBe(460000n);
  });

  it('offers 3, 6, 12 and 24 months, and refuses others', async () => {
    expect((await c.get(url('/dashboard/charts?months=3'))).body.monthly).toHaveLength(3);
    expect((await c.get(url('/dashboard/charts?months=24'))).body.monthly).toHaveLength(24);
    expect((await c.get(url('/dashboard/charts'))).body.months).toBe(6);
    expect((await c.get(url('/dashboard/charts?months=7'))).status).toBe(400);
  });

  it('shows where the money went this month, biggest first, each drilling to its transactions', async () => {
    const { topSpending } = (await c.get(url('/dashboard/charts?months=3'))).body;
    expect(topSpending.period).toEqual({ start: thisMonth, end: endOfMonth(thisMonth) });
    expect(topSpending.total).toBe('33000');
    expect(topSpending.rows.map((r: any) => [r.name, r.amount])).toEqual([
      ['Groceries', '20000'],
      ['Utilities', '8000'],
      ['Dining out', '5000'],
    ]);
    expect(topSpending.rows[0].drill).toEqual({
      entityId: personal,
      categoryIds: [cat('Groceries')],
      from: thisMonth,
      to: endOfMonth(thisMonth),
    });
  });

  it('compares last month with the three before it, biggest change first', async () => {
    const { changes } = (await c.get(url('/dashboard/charts?months=3'))).body;
    expect(changes.period).toEqual({ start: month(1), end: endOfMonth(month(1)) });
    expect(changes.rows.map((r: any) => [r.name, r.amount, r.usual, r.difference])).toEqual([
      ['Groceries', '60000', '30000', '30000'],
      ['Dining out', '0', '10000', '-10000'],
    ]);
  });

  it('has no budget section without a budget', async () => {
    expect((await c.get(url('/dashboard/charts'))).body.budget).toBeNull();
  });

  it('shows the budget so far: day-to-day spending against its pace, bills only when over', async () => {
    const budget = (await c.post(url('/budgets'), { entityId: personal, name: 'Household' })).body;
    const assign = async (name: string, assigned: string) => {
      const version = (await c.get(url('/budgets'))).body.data.find((b: any) => b.id === budget.id).version;
      const res = await c.put(url(`/budgets/${budget.id}/periods/${thisMonth}/lines/${cat(name)}`), {
        assigned,
        version,
      });
      expect(res.status).toBe(200);
    };
    await assign('Groceries', '100000');
    await assign('Utilities', '5000');
    await assign('Rent', '150000');

    const d = (await c.get(url('/dashboard/charts'))).body;
    expect(d.budget.budgetId).toBe(budget.id);
    const rows = d.budget.rows as any[];
    const by = (name: string) => rows.find((r) => r.name === name);
    // A bill over its budget: the whole overspend.
    expect(by('Utilities')).toMatchObject({
      assigned: '5000',
      spent: '8000',
      expected: '5000',
      difference: '3000',
    });
    // Rent isn't paid yet: a bill under budget isn't news.
    expect(by('Rent')).toBeUndefined();
    // Groceries against where the budget expects it today.
    const pace = spendingPace(d.budget.period, today, 100000n, 20000n)!;
    expect(by('Groceries')).toMatchObject({
      assigned: '100000',
      spent: '20000',
      expected: String(pace.expectedByToday),
      difference: String(20000n - pace.expectedByToday),
    });
    for (const r of rows) expect(BigInt(r.difference)).toBe(BigInt(r.spent) - BigInt(r.expected));
    const sizes = rows.map((r) => (BigInt(r.difference) < 0n ? -BigInt(r.difference) : BigInt(r.difference)));
    expect([...sizes].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))).toEqual(sizes);
    expect(rows.length).toBeLessThanOrEqual(5);
  });
});
