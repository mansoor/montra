/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// The last per-type details (ADR-0027): a home's purchase and loan, money owed outside a bank and when it's due, and
// interest earned on savings.
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });

let h: Harness;
let c: Client;
let url: (p: string) => string;
let checking: string;
let cats: any[];

const accountOf = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id);

beforeAll(async () => {
  h = await startHarness();
  c = h.as('details@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Details', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Everyday',
      kind: 'checking',
      openingBalance: usd('500000'),
      openingDate: addDays(today, -30),
    })
  ).body.id;
  cats = (await c.get(url('/categories'))).body.data;
});

afterAll(async () => {
  await h.close();
});

describe('a home or car', () => {
  it('keeps what it cost and the loan against it', async () => {
    const loan = (
      await c.post(url('/accounts'), {
        name: 'Car loan',
        kind: 'loan',
        openingBalance: usd('1200000'),
        openingDate: addDays(today, -30),
      })
    ).body.id;
    const res = await c.post(url('/accounts'), {
      name: 'Family car',
      kind: 'asset',
      openingBalance: usd('1800000'),
      openingDate: addDays(today, -30),
      purchasePrice: '2500000',
      purchaseDate: addDays(today, -400),
      loanAccountId: loan,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      purchasePrice: '2500000',
      purchaseDate: addDays(today, -400),
      loanAccountId: loan,
    });
    const cleared = await c.patch(url(`/accounts/${res.body.id}`), {
      loanAccountId: null,
      purchasePrice: null,
    });
    expect(cleared.body).toMatchObject({ loanAccountId: null, purchasePrice: null });
  });

  it('refuses details that don’t belong to it', async () => {
    const code = async (body: object) => (await c.post(url('/accounts'), { name: 'Bad', ...body })).body.code;
    expect(await code({ kind: 'checking', purchasePrice: '100' })).toBe('account.detail_kind');
    expect(await code({ kind: 'asset', dueDate: today })).toBe('account.detail_kind');
    expect(await code({ kind: 'asset', loanAccountId: checking })).toBe('account.loan');
    const asset = (await c.post(url('/accounts'), { name: 'House', kind: 'asset' })).body.id;
    expect((await c.patch(url(`/accounts/${asset}`), { loanAccountId: asset })).body.code).toBe(
      'account.loan',
    );
  });
});

describe('money owed outside a bank', () => {
  it('shows on the calendar on its due date while any is owed', async () => {
    const due = addDays(today, 10);
    const res = await c.post(url('/accounts'), {
      name: 'Owed to Sam',
      kind: 'liability',
      institution: 'Sam',
      openingBalance: usd('40000'),
      openingDate: addDays(today, -5),
      dueDate: due,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dueDate: due, institution: 'Sam' });
    const items = async () =>
      (await c.get(url(`/calendar?from=${today}&to=${addDays(today, 30)}`))).body.items.filter(
        (i: any) => i.sourceId === res.body.id,
      );
    expect(await items()).toEqual([
      expect.objectContaining({ kind: 'bill', date: due, amount: '-40000', status: 'upcoming' }),
    ]);
    // Paid back, it's off the calendar.
    await c.post(url('/transactions/transfer'), {
      date: today,
      fromAccountId: checking,
      toAccountId: res.body.id,
      amount: usd('40000'),
    });
    expect(await items()).toEqual([]);
  });

  it('is only for that kind', async () => {
    expect(
      (await c.post(url('/accounts'), { name: 'Bad card', kind: 'credit_card', dueDate: today })).body.code,
    ).toBe('account.detail_kind');
  });
});

describe('savings interest', () => {
  it('counts interest paid in this year, and nothing else', async () => {
    const savings = (
      await c.post(url('/accounts'), {
        name: 'Rainy day',
        kind: 'savings',
        interestRateBps: 425,
        openingBalance: usd('1000000'),
        openingDate: addDays(today, -60),
      })
    ).body.id;
    const interest = cats.find((x: any) => x.name === 'Interest income').id;
    const salary = cats.find((x: any) => x.name === 'Salary').id;
    const post = (amount: string, categoryId: string) =>
      c.post(url('/transactions'), {
        date: today,
        accountId: savings,
        amount: usd(amount),
        payee: 'Bank',
        categoryId,
      });
    await post('3500', interest);
    await post('3600', interest);
    await post('50000', salary);
    // A transfer in isn't interest.
    await c.post(url('/transactions/transfer'), {
      date: today,
      fromAccountId: checking,
      toAccountId: savings,
      amount: usd('10000'),
    });
    const res = await c.get(url(`/accounts/${savings}/interest-earned`));
    expect(res.body).toMatchObject({
      accountId: savings,
      from: `${today.slice(0, 4)}-01-01`,
      to: today,
      amount: '7100',
      currency: 'USD',
    });
    expect((await accountOf(savings)).planning.interestRateBps).toBe(425);
  });
});
