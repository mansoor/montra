/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfMonth, startOfMonth, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Explore spending (FLOW-01, RPT-03): the picked categories month by month, with purchases and top places.
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

const post = async (date: string, amount: string, category: string, payee: string) =>
  (
    await c.post(url('/transactions'), {
      date,
      accountId: checking,
      amount: usd(amount),
      payee,
      categoryId: cat(category),
    })
  ).body;

let voidMe: any;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('explore@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Explore', baseCurrency: 'USD', template: 'household' }))
    .body;
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

  // Two months back to last month: salary; dining out twice at Bistro and once at Cafe; groceries; a fuel stop.
  for (const back of [2, 1]) {
    await post(month(back), '500000', 'Salary', 'ACME PAYROLL');
    await post(addDays(month(back), 2), '-4000', 'Dining out', 'Bistro');
    await post(addDays(month(back), 9), '-6000', 'Dining out', 'Bistro');
    await post(addDays(month(back), 12), '-2000', 'Dining out', 'Cafe');
    await post(addDays(month(back), 5), '-30000', 'Groceries', 'Whole Foods');
    await post(addDays(month(back), 7), '-5000', 'Fuel & transport', 'Shell');
  }
  await post(addDays(month(1), 1), '-150000', 'Rent', 'Oak Street Apartments');
  await post(thisMonth, '-3000', 'Dining out', 'Cafe');
  voidMe = await post(thisMonth, '-9900', 'Dining out', 'Steakhouse');
});

afterAll(async () => {
  await h?.close();
});

describe('Explore spending (FLOW-01)', () => {
  it('picks the three biggest everyday categories by default, with all spending and income per month', async () => {
    const r = await c.get(url('/spending/explore?months=3'));
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.periods).toEqual([2, 1, 0].map((b) => ({ start: month(b), end: endOfMonth(month(b)) })));
    expect(d.categories.map((x: any) => x.name)).toEqual(['Groceries', 'Dining out', 'Fuel & transport']);
    expect(d.income).toEqual(['500000', '500000', '0']);
    // Rent is the biggest, but a bill: it's a choice, not a default pick.
    expect(d.spending).toEqual(['47000', '197000', '12900']);
    expect(d.choices.map((x: any) => [x.name, x.total])).toEqual([
      ['Rent', '150000'],
      ['Groceries', '60000'],
      ['Dining out', '36900'],
      ['Fuel & transport', '10000'],
    ]);
  });

  it('gives a category’s months, purchases and top places, and its transactions to drill into', async () => {
    const d = (await c.get(url(`/spending/explore?months=3&categoryIds=${cat('Dining out')}`))).body;
    expect(d.categories).toHaveLength(1);
    const dining = d.categories[0];
    expect(dining).toMatchObject({
      name: 'Dining out',
      group: 'Daily living',
      monthly: ['12000', '12000', '12900'],
      counts: [3, 3, 2],
    });
    expect(dining.topPlaces).toEqual([
      { name: 'Bistro', amount: '20000', count: 4 },
      { name: 'Steakhouse', amount: '9900', count: 1 },
      { name: 'Cafe', amount: '7000', count: 3 },
    ]);
    expect(dining.drill).toEqual({
      entityId: personal,
      categoryIds: [cat('Dining out')],
      from: month(2),
      to: endOfMonth(thisMonth),
    });
  });

  it('stops counting a purchase once it’s deleted', async () => {
    expect((await c.delete(url(`/transactions/${voidMe.id}`))).status).toBeLessThan(300);
    const dining = (await c.get(url(`/spending/explore?months=3&categoryIds=${cat('Dining out')}`))).body
      .categories[0];
    expect(dining.monthly[2]).toBe('3000');
    expect(dining.counts[2]).toBe(1);
    expect(dining.topPlaces.map((p: any) => p.name)).toEqual(['Bistro', 'Cafe']);
  });

  it('ignores categories that aren’t spending, and refuses more than eight or an unknown period', async () => {
    const d = (await c.get(url(`/spending/explore?categoryIds=${cat('Salary')},${cat('Groceries')}`))).body;
    expect(d.categories.map((x: any) => x.name)).toEqual(['Groceries']);
    const nine = Array.from({ length: 9 }, () => cat('Groceries')).join(',');
    expect((await c.get(url(`/spending/explore?categoryIds=${nine}`))).status).toBe(400);
    expect((await c.get(url('/spending/explore?months=5'))).status).toBe(400);
  });
});

describe('Explore spending: make this my budget (FLOW-01, BUD-01)', () => {
  it('creates the budget when there is none, then updates the line and says what it replaced', async () => {
    const before = (await c.get(url(`/spending/explore?categoryIds=${cat('Groceries')}`))).body;
    expect(before.categories[0].assigned).toBeNull();

    const first = await c.post(url('/budgets/set-category'), {
      categoryId: cat('Groceries'),
      assigned: '24000',
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      categoryId: cat('Groceries'),
      previous: null,
      assigned: '24000',
      created: before.budget === null,
    });
    expect(first.body.period.start <= today && today <= first.body.period.end).toBe(true);

    const second = (
      await c.post(url('/budgets/set-category'), { categoryId: cat('Groceries'), assigned: '21000' })
    ).body;
    expect(second).toMatchObject({
      budgetId: first.body.budgetId,
      previous: '24000',
      assigned: '21000',
      created: false,
    });

    const after = (await c.get(url(`/spending/explore?categoryIds=${cat('Groceries')}`))).body;
    expect(after.budget).toEqual({ budgetId: first.body.budgetId, period: first.body.period });
    expect(after.categories[0].assigned).toBe('21000');
    const period = (await c.get(url(`/budgets/${first.body.budgetId}/periods/${first.body.period.start}`)))
      .body;
    const line = period.groups
      .flatMap((g: any) => g.lines)
      .find((l: any) => l.categoryId === cat('Groceries'));
    expect(line.assigned).toBe('21000');
  });

  it('refuses a negative amount', async () => {
    const r = await c.post(url('/budgets/set-category'), { categoryId: cat('Groceries'), assigned: '-1' });
    expect(r.status).toBe(400);
  });
});
