/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfMonth, startOfMonth, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Phase 6 end to end: budgets, goals, expected income, dashboard, flow and recommendations (BUD, FLOW, REC).
// Dates are relative to today (the engine uses the workspace's today), in UTC.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
const thisMonth = startOfMonth(today);
const lastMonth = addMonths(thisMonth, -1);
const nextMonth = addMonths(thisMonth, 1);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let personal: string;
let checking: string;
let card: string;
let budget: any;

const spend = (date: string, amount: string, categoryId: string, accountId = checking, payee = 'Store') =>
  c.post(url('/transactions'), { date, accountId, amount: usd(amount), payee, categoryId });

const period = async (start = thisMonth) => (await c.get(url(`/budgets/${budget.id}/periods/${start}`))).body;
const version = async () =>
  (await c.get(url('/budgets'))).body.data.find((b: any) => b.id === budget.id).version as number;
const assign = async (start: string, name: string, assigned: string, extra: object = {}) => {
  const res = await c.put(url(`/budgets/${budget.id}/periods/${start}/lines/${cat(name)}`), {
    assigned,
    version: await version(),
    ...extra,
  });
  expect(res.status).toBe(200);
  return res.body;
};
const line = (p: any, name: string) =>
  p.groups.flatMap((g: any) => g.lines).find((l: any) => l.categoryId === cat(name));

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('planner@example.com');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Planning', baseCurrency: 'USD', template: 'household' })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities[0].id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('100000'),
      openingDate: addDays(lastMonth, -1),
    })
  ).body.id;
  card = (
    await c.post(url('/accounts'), {
      name: 'Visa',
      kind: 'credit_card',
      openingBalance: usd('200000'),
      openingDate: addDays(lastMonth, -1),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === personal)?.id;

  // Last month: salary and groceries. This month: a larger salary, groceries and dining.
  await c.post(url('/transactions'), {
    date: lastMonth,
    accountId: checking,
    amount: usd('500000'),
    payee: 'ACME PAYROLL',
    categoryId: cat('Salary'),
  });
  await spend(addDays(lastMonth, 4), '-35000', cat('Groceries'));
  await c.post(url('/transactions'), {
    date: thisMonth,
    accountId: checking,
    amount: usd('510000'),
    payee: 'ACME PAYROLL',
    categoryId: cat('Salary'),
  });
  await spend(thisMonth, '-30000', cat('Groceries'));
  await spend(thisMonth, '-5000', cat('Dining out'), card, 'Bistro');
  const income = await c.post(url('/expected-income'), {
    entityId: personal,
    name: 'ACME salary',
    sourceType: 'salary',
    amount: '500000',
    currency: 'USD',
    cadence: 'monthly',
    nextDate: lastMonth,
    accountId: checking,
    payee: 'ACME PAYROLL',
  });
  expect(income.status).toBe(201);
});
afterAll(() => h.close());

describe('budgets (BUD-01, BUD-03, BUD-06, BUD-09, BUD-10)', () => {
  it('creates one budget per entity', async () => {
    const res = await c.post(url('/budgets'), { entityId: personal, name: 'Household' });
    expect(res.status).toBe(201);
    budget = res.body;
    expect(budget).toMatchObject({
      method: 'zero_based',
      periodType: 'monthly',
      currency: 'USD',
      version: 1,
    });
    expect((await c.post(url('/budgets'), { entityId: personal, name: 'Again' })).status).toBe(409);
  });

  it('computes carried-in, available and left to assign across periods', async () => {
    await assign(lastMonth, 'Groceries', '40000');
    await assign(thisMonth, 'Groceries', '40000');
    const p = await assign(thisMonth, 'Dining out', '10000');
    // Income: the expected salary is replaced by the deposit that matched it.
    expect(p.income).toMatchObject({ expected: '500000', actual: '510000', budgeted: '510000' });
    expect(p.income.items).toEqual([
      expect.objectContaining({ name: 'ACME salary', date: thisMonth, expected: '500000', actual: '510000' }),
    ]);
    expect(line(p, 'Groceries')).toMatchObject({
      carriedIn: '5000',
      assigned: '40000',
      activity: '30000',
      available: '15000',
      rolloverMode: 'carry_surplus',
    });
    expect(line(p, 'Dining out')).toMatchObject({ assigned: '10000', activity: '5000', available: '5000' });
    expect(p.carriedUnassigned).toBe('460000');
    expect(p.leftToAssign).toBe('920000');
    // Exit criterion: left to assign agrees with the lines, and money is conserved.
    const lines = p.groups.flatMap((g: any) => g.lines);
    const sum = (k: string) => lines.reduce((t: bigint, l: any) => t + BigInt(l[k]), 0n);
    expect(BigInt(p.leftToAssign)).toBe(
      BigInt(p.income.budgeted) + BigInt(p.carriedUnassigned) - sum('assigned') - sum('moved'),
    );
    expect(BigInt(p.leftToAssign) + sum('available')).toBe(1_010_000n - 70_000n);
    expect(p.fiftyThirtyTwenty.needs.amount).toBe('50000');
  });

  it('moves money between categories with history, and rejects a stale version', async () => {
    const v = await version();
    const res = await c.post(url(`/budgets/${budget.id}/periods/${thisMonth}/moves`), {
      from: cat('Groceries'),
      to: cat('Dining out'),
      amount: '5000',
      note: 'Dinner out',
      version: v,
    });
    expect(res.status).toBe(200);
    expect(line(res.body, 'Groceries')).toMatchObject({ moved: '-5000', available: '10000' });
    expect(line(res.body, 'Dining out')).toMatchObject({ moved: '5000', available: '10000' });
    expect(res.body.leftToAssign).toBe('920000');
    const moves = (await c.get(url(`/budgets/${budget.id}/periods/${thisMonth}/moves`))).body.data;
    expect(moves).toEqual([expect.objectContaining({ amount: '5000', note: 'Dinner out' })]);
    const stale = await c.post(url(`/budgets/${budget.id}/periods/${thisMonth}/moves`), {
      from: null,
      to: cat('Groceries'),
      amount: '100',
      version: v,
    });
    expect(stale.status).toBe(409);
  });

  it('copies last period into the next one and validates period starts', async () => {
    const res = await c.post(url(`/budgets/${budget.id}/periods/${nextMonth}/copy`), {
      from: 'last',
      version: await version(),
    });
    expect(res.status).toBe(200);
    expect(line(res.body, 'Groceries')).toMatchObject({ assigned: '40000', carriedIn: '10000' });
    expect(line(res.body, 'Dining out')).toMatchObject({ assigned: '10000', carriedIn: '10000' });
    expect(res.body.current).toBe(false);
    expect((await c.get(url(`/budgets/${budget.id}/periods/${addDays(thisMonth, 1)}`))).status).toBe(422);
    const current = (await c.get(url(`/budgets/${budget.id}/periods/current`))).body;
    expect(current.start).toBe(thisMonth);
  });

  it('drafts a budget from history with an AI explanation of the numbers', async () => {
    const res = await c.post(url('/budgets/draft'), { entityId: personal, months: 1 });
    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([lastMonth]);
    expect(res.body.lines).toEqual([
      expect.objectContaining({
        name: 'Groceries',
        suggested: '35000',
        history: ['35000'],
        source: 'history',
      }),
    ]);
    expect(res.body.expectedIncome).toBe('500000');
    expect(res.body.explanation).toContain('$350.00');
  });
});

describe('goals (BUD-07, BUD-08)', () => {
  it('gives a sinking fund its own category and a monthly contribution', async () => {
    const res = await c.post(url('/goals'), {
      entityId: personal,
      name: 'Car insurance',
      type: 'sinking_fund',
      target: '120000',
      dueDate: addDays(addMonths(thisMonth, 2), 14),
    });
    expect(res.status).toBe(201);
    expect(res.body.categoryId).toBeTruthy();
    expect(res.body.progress).toMatchObject({ saved: '0', percent: 0, monthlyNeeded: '40000' });
    const cats = (await c.get(url('/categories'))).body.data;
    expect(cats.find((x: any) => x.id === res.body.categoryId)).toMatchObject({
      name: 'Car insurance',
      group: 'Savings goals',
    });
    const p = await period();
    const l = p.groups.find((g: any) => g.kind === 'savings').lines[0];
    expect(l.goal).toEqual({ goalId: res.body.id, monthlyNeeded: '40000' });
  });

  it('simulates debt payoff from the linked accounts', async () => {
    expect(
      (await c.patch(url(`/accounts/${card}`), { interestRateBps: 2400, minPayment: '5000' })).status,
    ).toBe(200);
    const res = await c.post(url('/goals'), {
      entityId: personal,
      name: 'Debt free',
      type: 'debt_payoff',
      strategy: 'avalanche',
      target: '200000',
      linkedAccountIds: [card],
      extraPayment: '10000',
    });
    expect(res.status).toBe(201);
    // The card also carries this month's dining.
    expect(res.body.payoff.debts).toEqual([
      expect.objectContaining({ accountId: card, balance: '205000', rateBps: 2400, minPayment: '5000' }),
    ]);
    expect(res.body.payoff.monthlyPayment).toBe('15000');
    expect(res.body.payoff.months).toBeGreaterThan(12);
    expect(res.body.categoryId).toBeNull();
    const bad = await c.post(url('/goals'), {
      entityId: personal,
      name: 'X',
      type: 'debt_payoff',
      strategy: 'snowball',
      linkedAccountIds: [checking],
    });
    expect(bad.status).toBe(422);
  });
});

describe('money flow (FLOW-01..07)', () => {
  it('shows the dashboard numbers, each drilling down to its transactions', async () => {
    const d = (await c.get(url('/dashboard'))).body;
    expect(d).toMatchObject({
      entityId: personal,
      budgetId: budget.id,
      period: { start: thisMonth, end: endOfMonth(thisMonth) },
      income: { amount: '510000' },
      spent: { amount: '35000' },
      leftToAssign: '920000',
    });
    const q = new URLSearchParams({
      entityId: d.spent.drill.entityId,
      categoryIds: d.spent.drill.categoryIds.join(','),
      from: d.spent.drill.from,
      to: d.spent.drill.to,
      limit: '200',
    });
    const txns = (await c.get(url(`/transactions?${q}`))).body.data;
    const ids = new Set(d.spent.drill.categoryIds);
    const total = txns
      .flatMap((t: any) => t.splits)
      .filter((s: any) => ids.has(s.accountId))
      .reduce((t: bigint, s: any) => t - BigInt(s.amount), 0n);
    expect(total).toBe(35000n);
    expect(BigInt(d.netWorth.current)).toBe(100000n + 500000n - 35000n + 510000n - 30000n - 205000n);
  });

  it('draws the Sankey from income to categories', async () => {
    const s = (await c.get(url(`/flow/sankey?entityId=${personal}`))).body;
    const node = (id: string) => s.nodes.find((n: any) => n.id === id);
    expect(node(`income:${cat('Salary')}`)).toMatchObject({ kind: 'income', value: '510000' });
    expect(node(`category:${cat('Groceries')}`)).toMatchObject({
      value: '30000',
      drill: { categoryIds: [cat('Groceries')] },
    });
    expect(node(`unspent:${personal}`)).toMatchObject({ value: '475000' });
    expect(s.links).toContainEqual({
      source: `income:${cat('Salary')}`,
      target: `entity:${personal}`,
      value: '510000',
    });
  });

  it('forecasts balances with schedules and warns about low balances', async () => {
    const rent = await c.post(url('/recurring'), {
      name: 'Rent',
      accountId: checking,
      amount: usd('-150000'),
      payee: 'Landlord',
      categoryId: cat('Rent'),
      cadence: 'monthly',
      startDate: addDays(nextMonth, 2),
    });
    expect(rent.status).toBe(201);
    expect((await c.patch(url(`/accounts/${checking}`), { lowBalance: '2000000' })).status).toBe(200);
    const f = (await c.get(url('/flow/forecast?days=60'))).body;
    const a = f.accounts.find((x: any) => x.accountId === checking);
    expect(a.start).toBe(String(100000n + 500000n - 35000n + 510000n - 30000n));
    expect(a.balances).toHaveLength(60);
    expect(a.items).toContainEqual(
      expect.objectContaining({ name: 'Rent', amount: '-150000', date: addDays(nextMonth, 2) }),
    );
    expect(a.items).toContainEqual(
      expect.objectContaining({ kind: 'income', name: 'ACME salary', amount: '500000', date: nextMonth }),
    );
    expect(a.lowBalance).toMatchObject({ date: f.from });
    const d = (await c.get(url('/dashboard'))).body;
    expect(d.lowBalance).toContainEqual(expect.objectContaining({ accountId: checking }));
    await c.patch(url(`/accounts/${checking}`), { lowBalance: '0' });
  });

  it('lists bills and paydays on the calendar', async () => {
    const cal = (await c.get(url(`/calendar?from=${nextMonth}&to=${endOfMonth(nextMonth)}`))).body;
    expect(cal.items).toContainEqual(
      expect.objectContaining({
        kind: 'payday',
        name: 'ACME salary',
        date: nextMonth,
        amount: '500000',
        status: 'upcoming',
      }),
    );
    expect(cal.items).toContainEqual(
      expect.objectContaining({ kind: 'bill', name: 'Rent', amount: '-150000' }),
    );
    const past = (await c.get(url(`/calendar?from=${thisMonth}&to=${addDays(thisMonth, 1)}`))).body;
    expect(past.items).toContainEqual(
      expect.objectContaining({ name: 'ACME salary', status: 'paid', amount: '510000' }),
    );
  });

  it('values net worth with a monthly trend', async () => {
    const n = (await c.get(url('/net-worth?months=3'))).body;
    expect(n.liabilities).toBe('205000');
    expect(BigInt(n.netWorth)).toBe(BigInt(n.assets) - 205000n);
    expect(n.trend).toHaveLength(4);
    expect(n.trend.at(-1).netWorth).toBe(n.netWorth);
  });
});

describe('recommendations (REC-01, AIA-05)', () => {
  it('proposes cuts when the plan exceeds income, worded from the computed figures', async () => {
    await assign(thisMonth, 'Entertainment', '1000000');
    expect((await period()).leftToAssign).toBe('-80000');
    const run = await c.post(url('/recommendations/refresh'));
    expect(run.status).toBe(200);
    expect(run.body.created).toBeGreaterThanOrEqual(1);
    expect((await c.post(url('/recommendations/refresh'))).body.created).toBe(0);
    const recs = (await c.get(url('/recommendations'))).body.data;
    const rec = recs.find((r: any) => r.type === 'REC-01');
    expect(rec).toMatchObject({
      budgetId: budget.id,
      periodStart: thisMonth,
      title: 'Your plan is $800.00 more than your income',
      payload: { figures: { overAssigned: '80000', stillOverAfterCuts: '0' } },
    });
    expect(rec.payload.actions).toEqual([
      { kind: 'assign', categoryId: cat('Entertainment'), from: '1000000', to: '920000' },
    ]);
    expect(rec.wording).toContain('$800.00');
  });

  it('applies accepted actions to the budget', async () => {
    const rec = (await c.get(url('/recommendations'))).body.data.find((r: any) => r.type === 'REC-01');
    const before = await version();
    const res = await c.post(url(`/recommendations/${rec.id}/accept`), {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(await version()).toBe(before + 1);
    const p = await period();
    expect(p.leftToAssign).toBe('0');
    expect(line(p, 'Entertainment').assigned).toBe('920000');
    expect((await c.post(url(`/recommendations/${rec.id}/dismiss`))).status).toBe(422);
  });

  it('keeps planning settings', async () => {
    // The receipt reminder (UP-09) is off until set.
    expect((await c.get(url('/planning/settings'))).body).toEqual({
      categoryPriorities: {},
      highInterestBps: 800,
      receiptReminderMinor: null,
    });
    const res = await c.patch(url('/planning/settings'), {
      highInterestBps: 1000,
      categoryPriorities: { [cat('Groceries')]: 5 },
    });
    expect(res.body).toEqual({
      categoryPriorities: { [cat('Groceries')]: 5 },
      highInterestBps: 1000,
      receiptReminderMinor: null,
    });
  });
});

// Last, so the extra goals and their categories don't change the figures the tests above pin.
describe('editing and archiving goals (BUD-07, BUD-08)', () => {
  const patch = (id: string, body: object) => c.patch(url(`/goals/${id}`), body);

  it('edits the target and due date, and refuses a stale version', async () => {
    const created = (
      await c.post(url('/goals'), {
        entityId: personal,
        name: 'Holiday',
        type: 'sinking_fund',
        target: '60000',
        dueDate: addDays(addMonths(thisMonth, 2), 14),
      })
    ).body;
    expect(created.progress.monthlyNeeded).toBe('20000');

    const target = await patch(created.id, { target: '90000', version: created.version });
    expect(target.status).toBe(200);
    expect(target.body).toMatchObject({ target: '90000', version: created.version + 1 });
    expect(target.body.progress.monthlyNeeded).toBe('30000');

    const due = addDays(addMonths(thisMonth, 5), 14);
    const moved = await patch(created.id, {
      dueDate: due,
      name: 'Summer holiday',
      version: target.body.version,
    });
    expect(moved.status).toBe(200);
    // Fields left out of the patch keep their values.
    expect(moved.body).toMatchObject({
      name: 'Summer holiday',
      target: '90000',
      dueDate: due,
      categoryId: created.categoryId,
    });
    expect(moved.body.progress.monthlyNeeded).toBe('15000');

    const stale = await patch(created.id, { target: '1000', version: created.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version.conflict');
    expect((await c.get(url(`/goals/${created.id}`))).body.target).toBe('90000');

    // A sinking fund keeps its target and due date.
    const noDue = await patch(created.id, { dueDate: null, version: moved.body.version });
    expect(noDue.status).toBe(422);
    expect(noDue.body.code).toBe('goal.sinking_fund');
    // Its funding category must be a spending category.
    const income = await patch(created.id, { categoryId: cat('Salary'), version: moved.body.version });
    expect(income.status).toBe(422);
    expect(income.body.code).toBe('goal.category');
  });

  it('archives a goal out of the budget and restores it', async () => {
    const goal = (await c.get(url('/goals'))).body.data.find((g: any) => g.name === 'Summer holiday');
    const goalLines = async () =>
      (await period()).groups
        .flatMap((g: any) => g.lines)
        .filter((l: any) => l.goal)
        .map((l: any) => l.goal.goalId);
    expect(await goalLines()).toContain(goal.id);

    const archived = await patch(goal.id, { archived: true, version: goal.version });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, target: '90000', categoryId: goal.categoryId });
    expect(await goalLines()).not.toContain(goal.id);
    const list = (await c.get(url('/goals'))).body.data;
    expect(list[list.length - 1]).toMatchObject({ id: goal.id, archived: true }); // archived goals list last

    const restored = await patch(goal.id, { archived: false, version: archived.body.version });
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
    expect(await goalLines()).toContain(goal.id);
  });

  it('keeps a debt payoff strategy, and funds a goal through the budget once its accounts are unlinked', async () => {
    const debt = (await c.get(url('/goals'))).body.data.find((g: any) => g.type === 'debt_payoff');
    const noStrategy = await patch(debt.id, { strategy: null, version: debt.version });
    expect(noStrategy.status).toBe(422);
    expect(noStrategy.body.code).toBe('goal.strategy');
    const snowball = await patch(debt.id, {
      strategy: 'snowball',
      extraPayment: '20000',
      version: debt.version,
    });
    expect(snowball.status).toBe(200);
    expect(snowball.body.linkedAccountIds).toEqual([card]);
    expect(snowball.body.payoff).toMatchObject({ strategy: 'snowball', monthlyPayment: '25000' });

    const savings = (
      await c.post(url('/goals'), {
        entityId: personal,
        name: 'Rainy day',
        type: 'emergency_fund',
        target: '300000',
        linkedAccountIds: [checking],
      })
    ).body;
    expect(savings.categoryId).toBeNull();
    const unlinked = await patch(savings.id, { linkedAccountIds: [], version: savings.version });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ linkedAccountIds: [], target: '300000' });
    expect(unlinked.body.categoryId).toBeTruthy();
    const cats = (await c.get(url('/categories'))).body.data;
    expect(cats.find((x: any) => x.id === unlinked.body.categoryId)).toMatchObject({
      name: 'Rainy day',
      group: 'Savings goals',
    });
  });
});
