/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// What each account type holds, and each account's balance over time (ADR-0023).
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });

let h: Harness;
let c: Client;
let url: (p: string) => string;

const history = async (id: string, range?: string) =>
  (await c.get(url(`/accounts/${id}/balance-history${range ? `?range=${range}` : ''}`))).body;

beforeAll(async () => {
  h = await startHarness();
  c = h.as('account-types@example.com');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Account types', baseCurrency: 'USD', template: 'household' })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
});

afterAll(async () => {
  await h.close();
});

describe('details when adding an account', () => {
  it('keeps what its type holds', async () => {
    const res = await c.post(url('/accounts'), {
      name: 'Visa',
      kind: 'credit_card',
      creditLimit: '500000',
      interestRateBps: 1999,
      minPayment: '3500',
    });
    expect(res.status).toBe(201);
    expect(res.body.planning).toEqual({
      creditLimit: '500000',
      interestRateBps: 1999,
      minPayment: '3500',
      lowBalance: '0',
    });
  });

  it('leaves them empty when none are given', async () => {
    const res = await c.post(url('/accounts'), { name: 'Plain', kind: 'checking', lowBalance: '-5000' });
    expect(res.body.planning).toEqual({
      creditLimit: null,
      interestRateBps: null,
      minPayment: null,
      lowBalance: '-5000',
    });
  });

  it('refuses a rate over 100%', async () => {
    const res = await c.post(url('/accounts'), { name: 'Bad', kind: 'loan', interestRateBps: 10_001 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('balance history', () => {
  it('follows the account from its first day to today, ending on its balance', async () => {
    const opened = addDays(today, -10);
    const id = (
      await c.post(url('/accounts'), {
        name: 'Everyday',
        kind: 'checking',
        openingBalance: usd('100000'),
        openingDate: opened,
      })
    ).body.id;
    expect(
      (
        await c.post(url('/transactions'), {
          date: addDays(today, -5),
          accountId: id,
          amount: usd('-2500'),
          payee: 'Cafe',
        })
      ).status,
    ).toBe(201);
    // Not on the chart until it happens.
    expect(
      (
        await c.post(url('/transactions'), {
          date: addDays(today, 5),
          accountId: id,
          amount: usd('-999'),
          payee: 'Later',
        })
      ).status,
    ).toBe(201);

    const h1 = await history(id);
    expect(h1).toMatchObject({ accountId: id, currency: 'USD', range: '1y' });
    expect(h1.points[0]).toEqual({ date: opened, balance: '100000' });
    expect(h1.points).toContainEqual({ date: addDays(today, -6), balance: '100000' });
    expect(h1.points).toContainEqual({ date: addDays(today, -5), balance: '97500' });
    expect(h1.points[h1.points.length - 1]).toEqual({ date: today, balance: '97500' });
    expect(h1.points).toHaveLength(11);
  });

  it('shows money owed as a positive amount, going down as it’s repaid', async () => {
    const id = (
      await c.post(url('/accounts'), {
        name: 'Car loan',
        kind: 'loan',
        openingBalance: usd('2000000'),
        openingDate: addDays(today, -3),
      })
    ).body.id;
    const checking = (
      await c.post(url('/accounts'), {
        name: 'Paying from',
        kind: 'checking',
        openingBalance: usd('100000'),
        openingDate: addDays(today, -3),
      })
    ).body.id;
    const paid = await c.post(url('/transactions/transfer'), {
      date: addDays(today, -1),
      fromAccountId: checking,
      toAccountId: id,
      amount: usd('30000'),
    });
    expect(paid.status).toBe(201);
    const { points } = await history(id);
    expect(points[0].balance).toBe('2000000');
    expect(points[points.length - 1].balance).toBe('1970000');
    const account = (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id);
    expect(account.balance.amount).toBe('1970000');
  });

  it('covers the period asked for', async () => {
    const id = (
      await c.post(url('/accounts'), {
        name: 'Long held',
        kind: 'savings',
        openingBalance: usd('5000'),
        openingDate: addDays(today, -500),
      })
    ).body.id;
    expect((await history(id, '3m')).points[0].date).toBe(addDays(today, -91));
    expect((await history(id, '6m')).points[0].date).toBe(addDays(today, -182));
    expect((await history(id, '1y')).points[0].date).toBe(addDays(today, -365));
    const all = (await history(id, 'all')).points;
    expect(all[0]).toEqual({ date: addDays(today, -500), balance: '5000' });
    expect(all[all.length - 1]).toEqual({ date: today, balance: '5000' });
  });

  it('is empty for an account with no history', async () => {
    const id = (await c.post(url('/accounts'), { name: 'New', kind: 'cash' })).body.id;
    expect((await history(id)).points).toEqual([]);
  });

  it('refuses a period it doesn’t know, and another workspace’s account', async () => {
    const id = (await c.post(url('/accounts'), { name: 'Mine', kind: 'cash' })).body.id;
    const bad = await c.get(url(`/accounts/${id}/balance-history?range=5y`));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);

    const other = h.as('account-types-other@example.com');
    const theirs = (
      await other.post('/v1/workspaces', { name: 'Theirs', baseCurrency: 'USD', template: 'household' })
    ).body;
    expect((await other.get(`/v1/workspaces/${theirs.id}/accounts/${id}/balance-history`)).status).toBe(404);
    expect((await other.get(url(`/accounts/${id}/balance-history`))).status).toBeGreaterThanOrEqual(403);
  });

  it('isn’t a way to read something that isn’t an account', async () => {
    const category = (await c.get(url('/categories'))).body.data[0].id;
    expect((await c.get(url(`/accounts/${category}/balance-history`))).status).toBe(404);
  });
});
