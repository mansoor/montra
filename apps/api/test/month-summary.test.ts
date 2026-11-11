/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfMonth, startOfMonth, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Month in review (FLOW-01, AIA-01): computed figures for one month, worded by the (fake) AI or in plain sentences.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
const thisMonth = startOfMonth(today);
const month = (back: number) => addMonths(thisMonth, -back);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let personal: string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('month-review@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Review', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities[0].id;
  const checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('2000000'),
      openingDate: addDays(month(5), -1),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === personal)?.id;
  const post = (date: string, amount: string, category: string, payee: string) =>
    c.post(url('/transactions'), {
      date,
      accountId: checking,
      amount: usd(amount),
      payee,
      categoryId: cat(category),
    });

  // Three usual months (4, 3 and 2 back), then last month with more dining out and a big TV.
  for (const back of [4, 3, 2]) {
    await post(month(back), '500000', 'Salary', 'ACME PAYROLL');
    await post(addDays(month(back), 3), '-40000', 'Groceries', 'Whole Foods');
    await post(addDays(month(back), 6), '-10000', 'Dining out', 'Bistro');
    await post(addDays(month(back), 8), '-6000', 'Fuel & transport', 'Shell');
  }
  await post(month(1), '500000', 'Salary', 'ACME PAYROLL');
  await post(addDays(month(1), 3), '-42000', 'Groceries', 'Whole Foods');
  await post(addDays(month(1), 6), '-30000', 'Dining out', 'Bistro');
  await post(addDays(month(1), 9), '-1000', 'Fuel & transport', 'Shell');
  await post(addDays(month(1), 12), '-120000', 'Household', 'Best Buy');
});

afterAll(async () => {
  await h?.close();
});

describe('Month in review (FLOW-01, AIA-01)', () => {
  it('reviews last month by default: money in and out, usual, changes and the biggest purchases', async () => {
    const r = await c.get(url('/summary/month'));
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d).toMatchObject({
      month: { start: month(1), end: endOfMonth(month(1)) },
      complete: true,
      nav: { previous: month(2), next: thisMonth },
      income: '500000',
      spent: '193000',
      left: '307000',
      keptPercent: 61,
      previous: { income: '500000', spent: '56000' },
      usual: { income: '500000', spent: '56000', months: 3 },
      needsReview: 0,
    });
    expect(d.categories.map((x: any) => [x.name, x.spent, x.usual])).toEqual([
      ['Household', '120000', '0'],
      ['Groceries', '42000', '40000'],
      ['Dining out', '30000', '10000'],
      ['Fuel & transport', '1000', '6000'],
    ]);
    // New spending (Household had none before) is the biggest change; groceries moved too little to say.
    expect(d.changes.up.map((x: any) => [x.name, x.change])).toEqual([
      ['Household', '120000'],
      ['Dining out', '20000'],
    ]);
    expect(d.changes.down.map((x: any) => [x.name, x.change])).toEqual([['Fuel & transport', '-5000']]);
    expect(d.largest[0]).toMatchObject({ payee: 'Best Buy', categoryName: 'Household', amount: '120000' });
    expect(d.budget).toBeNull();
  });

  it('suggests this month’s budget from the last three months, and words it all through the AI', async () => {
    const d = (await c.get(url('/summary/month'))).body;
    expect(d.suggestions.period).toEqual({ start: thisMonth, end: endOfMonth(thisMonth) });
    const groceries = d.suggestions.lines.find((l: any) => l.name === 'Groceries');
    expect(groceries).toMatchObject({ current: null, suggested: '40000' });
    // The fake provider restates the figures it was given, so the story only holds computed numbers.
    expect(d.story.by).toBe('ai');
    expect(d.story.headline).toContain('Your ');
    expect(d.story.points.join(' ')).toContain('$5,000.00');
    expect(d.story.budgetNote).toContain('suggested: Groceries');
  });

  it('compares with the budget when there is one', async () => {
    const budget = (await c.post(url('/budgets'), { entityId: personal, name: 'Household' })).body;
    const start = month(1);
    await c.put(url(`/budgets/${budget.id}/periods/${start}/lines/${cat('Dining out')}`), {
      assigned: '15000',
      version: budget.version,
    });
    const d = (await c.get(url(`/summary/month?month=${start}`))).body;
    expect(d.budget).toMatchObject({ budgetId: budget.id });
    expect(d.budget.over).toEqual([
      expect.objectContaining({ name: 'Dining out', assigned: '15000', spent: '30000', overBy: '15000' }),
    ]);
  });

  it('says so in plain sentences when AI is off, and marks this month as so far', async () => {
    expect((await c.patch(url('/ai/settings'), { mode: 'off' })).status).toBeLessThan(300);
    const d = (await c.get(url(`/summary/month?month=${addMonths(thisMonth, 2)}`))).body;
    expect(d).toMatchObject({
      month: { start: thisMonth },
      complete: false,
      nav: { next: null },
      suggestions: null,
    });
    expect(d.story.by).toBe('plain');
    expect(d.story.headline).toMatch(/^So far in /);
    const last = (await c.get(url('/summary/month'))).body;
    expect(last.story).toMatchObject({ by: 'plain' });
    expect(last.story.headline).toContain('you kept $3,070.00 of the $5,000.00 that came in');
    expect(last.story.points).toContain('Dining out: $300.00, $200.00 more than usual.');
    expect(last.story.points).toContain('Biggest purchase: Best Buy, $1,200.00.');
  });

  it('refuses a malformed month', async () => {
    expect((await c.get(url('/summary/month?month=last'))).status).toBe(400);
  });
});
