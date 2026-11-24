/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Education tax helpers (FAM-10): categories marked as education expenses, 529 withdrawals, per student and tax year.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'education@example.test';
const VIEWER = 'education-viewer@example.test';
const OTHER = 'education-other@example.test';
const TZ = 'Pacific/Kiritimati';

let h: Harness;
let c: Client;
let viewer: Client;
let other: Client;
let url: (p: string) => string;
let checking: string;
let plan: string;
let maya: string;
let leo: string;
let cats: any[];
const cat = (name: string) => cats.find((x) => x.name === name).id as string;
const summary = async (who: Client = c, year: number | null = 2025) =>
  who.get(url(`/reports/education${year === null ? '' : `?year=${year}`}`));
const transfer = async (date: string, fromAccountId: string, toAccountId: string, amount: string) => {
  const res = await c.post(url('/transactions/transfer'), { date, fromAccountId, toAccountId, amount: usd(amount) });
  expect(res.status).toBe(201);
  return res.body;
};
const mark = (who: Client, id: string, educationExpenseType: string | null) =>
  who.patch(url(`/categories/${id}`), { educationExpenseType });
const spend = async (date: string, amount: string, categoryId: string, memberId?: string, accountId = checking) => {
  const res = await c.post(url('/transactions'), {
    date,
    accountId,
    amount: usd(amount),
    payee: 'Payee',
    categoryId,
    ...(memberId ? { memberId } : {}),
  });
  expect(res.status).toBe(201);
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  viewer = h.as(VIEWER);
  other = h.as(OTHER);
  const ws = (
    await c.post('/v1/workspaces', {
      name: 'Education',
      baseCurrency: 'USD',
      timeZone: TZ,
      template: 'household',
    })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('5000000'),
      openingDate: '2024-12-01',
    })
  ).body.id;
  maya = (
    await c.post(url('/family-members'), {
      name: 'Maya',
      relationship: 'child',
      birthDate: '2006-04-02',
      isDependent: true,
    })
  ).body.id;
  leo = (await c.post(url('/family-members'), { name: 'Leo', relationship: 'child' })).body.id;
  // Maya's 529: its default member is the beneficiary.
  const res = await c.post(url('/accounts'), {
    name: 'Maya 529',
    kind: 'investment',
    planType: '529',
    defaultMemberId: maya,
    openingBalance: usd('2000000'),
    openingDate: '2024-12-01',
  });
  expect(res.status).toBe(201);
  plan = res.body.id;
  const personal = (await c.get(url('/entities'))).body.data[0].id;
  await c.post(url('/categories'), { entityId: personal, name: 'Tuition', type: 'expense' });
  await c.post(url('/categories'), { entityId: personal, name: 'Dorm', type: 'expense' });
  cats = (await c.get(url('/categories'))).body.data;
  const invite = await c.post(url('/sharing/invites'), { email: VIEWER, role: 'viewer' });
  await viewer.post(`/v1/invites/${invite.body.token}/accept`);
  await other.post('/v1/workspaces', { name: 'Other', baseCurrency: 'USD', template: 'household' });
});

afterAll(async () => {
  await h.close();
});

describe('marking a category as an education expense', () => {
  it('marks a spending category with a kind and clears it again', async () => {
    const res = await mark(c, cat('Tuition'), 'tuition_fees');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Tuition', educationExpenseType: 'tuition_fees' });
    expect((await mark(c, cat('Dorm'), 'room_board')).body.educationExpenseType).toBe('room_board');
    expect((await mark(c, cat('Education'), 'books_supplies')).status).toBe(200);
    expect((await mark(c, cat('Electronics'), 'computer')).status).toBe(200);
    expect((await mark(c, cat('Electronics'), null)).body.educationExpenseType).toBeNull();
    const listed = (await c.get(url('/categories'))).body.data.find((x: any) => x.id === cat('Tuition'));
    expect(listed.educationExpenseType).toBe('tuition_fees');
  });

  it('refuses income, unknown kinds and a viewer', async () => {
    expect((await mark(c, cat('Salary'), 'tuition_fees')).body.code).toBe('category.education_type');
    expect((await mark(c, cat('Tuition'), 'pizza')).status).toBe(400);
    expect((await mark(viewer, cat('Tuition'), 'room_board')).status).toBe(403);
  });
});

describe('the summary per student (FAM-10)', () => {
  beforeAll(async () => {
    // 2025 for Maya: tuition, books and a refund of part of the books; one book bought for no one in particular.
    await spend('2025-01-01', '-300000', cat('Tuition'), maya);
    await spend('2025-08-20', '-12000', cat('Education'), maya);
    await spend('2025-09-02', '2000', cat('Education'), maya);
    await spend('2025-12-31', '-150000', cat('Dorm'), maya);
    await spend('2025-03-03', '-5000', cat('Education'));
    // Leo's tuition is on the year boundary, so it belongs to 2026. Not marked: groceries.
    await spend('2026-01-01', '-80000', cat('Tuition'), leo);
    await spend('2025-06-01', '-9999', cat('Groceries'), leo);
    // Money out of the 529: a transfer to checking (Maya by the plan's member), and tuition paid from the plan for Leo.
    await transfer('2025-08-15', plan, checking, '400000');
    await spend('2025-09-10', '-100000', cat('Tuition'), leo, plan);
    // Not withdrawals: money put in, a fall in market value, and a withdrawal deleted later.
    await transfer('2025-02-01', checking, plan, '50000');
    const v = await c.post(url(`/accounts/${plan}/valuations`), {
      values: [{ date: '2025-10-01', value: '1000000' }],
    });
    expect(v.status).toBe(201);
    const gone = await transfer('2025-11-01', plan, checking, '70000');
    expect((await c.delete(url(`/transactions/${gone.id}`))).status).toBeLessThan(300);
    // Withdrawn on the last day of 2024: not this year.
    await transfer('2024-12-31', plan, checking, '11100');
  });

  it('adds up expenses by kind and 529 withdrawals for each member in the calendar year', async () => {
    const res = await summary();
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r).toMatchObject({ year: 2025, from: '2025-01-01', to: '2025-12-31', currency: 'USD', has529: true });
    expect(r.categories.map((x: any) => [x.name, x.type])).toEqual([
      ['Dorm', 'room_board'],
      ['Education', 'books_supplies'],
      ['Tuition', 'tuition_fees'],
    ]);
    // Members by name, then what has no member.
    expect(r.students.map((s: any) => s.name)).toEqual(['Leo', 'Maya', 'Household']);
    const [l, m, none] = r.students;
    expect(m).toMatchObject({
      memberId: maya,
      relationship: 'child',
      isDependent: true,
      birthDate: '2006-04-02',
      expenseTotal: '460000',
      withdrawals529: '400000',
      plans: [{ accountId: plan, name: 'Maya 529', amount: '400000' }],
    });
    expect(m.expenses).toEqual([
      { type: 'tuition_fees', amount: '300000' },
      { type: 'books_supplies', amount: '10000' },
      { type: 'room_board', amount: '150000' },
      { type: 'computer', amount: '0' },
    ]);
    // Tuition paid straight from the plan is both an expense and a withdrawal, for the member on it.
    expect(l).toMatchObject({ memberId: leo, isDependent: false, expenseTotal: '100000', withdrawals529: '100000' });
    expect(none).toMatchObject({ memberId: null, expenseTotal: '5000', withdrawals529: '0', plans: [] });
  });

  it('puts a date in the year it falls in', async () => {
    const next = (await summary(c, 2026)).body;
    expect(next.students.map((s: any) => [s.name, s.expenseTotal, s.withdrawals529])).toEqual([
      ['Leo', '80000', '0'],
    ]);
    const before = (await summary(c, 2024)).body;
    expect(before.students.map((s: any) => [s.name, s.expenseTotal, s.withdrawals529])).toEqual([
      ['Maya', '0', '11100'],
    ]);
  });

  it('defaults to this year in the workspace’s time zone', async () => {
    const year = Number(todayIn(TZ).slice(0, 4));
    const r = (await summary(c, null)).body;
    expect(r).toMatchObject({ year, from: `${year}-01-01`, to: `${year}-12-31` });
    expect((await c.get(url('/reports/education?year=1999'))).status).toBe(400);
  });

  it('a viewer reads it; another workspace sees none of it', async () => {
    expect((await summary(viewer)).body.students).toHaveLength(3);
    const res = await summary(other);
    expect([403, 404]).toContain(res.status);
    const own = (await other.get('/v1/workspaces')).body.data.find((w: any) => w.name === 'Other');
    const theirs = (await other.get(`/v1/workspaces/${own.id}/reports/education?year=2025`)).body;
    expect(theirs).toMatchObject({ has529: false, categories: [], students: [] });
  });
});
