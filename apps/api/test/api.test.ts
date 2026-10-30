import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let alice: Client;
let ws: string;
let personalId: string;
let businessId: string;
let checking: string;
let card: string;
let savings: string;
let cat: Record<string, string>;

const usd = (amount: string) => ({ amount, currency: 'USD' });

beforeAll(async () => {
  h = await startHarness();
  alice = h.as('alice@example.com');
});
afterAll(() => h.close());

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await alice.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await alice.get('/readyz')).body).toEqual({ status: 'ok', database: 'ok' });
  });
});

describe('walking skeleton: workspace → accounts → transactions → register', () => {
  it('rejects unauthenticated requests with a problem document', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/workspaces' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(res.body)).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('creates a hybrid workspace with seeded charts (UP-03)', async () => {
    const res = await alice.post('/v1/workspaces', {
      name: 'Alice household',
      baseCurrency: 'usd',
      timeZone: 'America/New_York',
      template: 'freelancer',
      businessName: 'Alice Design LLC',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Alice household', baseCurrency: 'USD', role: 'owner' });
    expect(res.body.entities.map((e: { type: string }) => e.type)).toEqual(['personal', 'business']);
    ws = res.body.id;
    personalId = res.body.entities[0].id;
    businessId = res.body.entities[1].id;

    const cats = await alice.get(`/v1/workspaces/${ws}/categories`);
    const find = (entityId: string, name: string) =>
      cats.body.data.find(
        (c: { entityId: string; name: string }) => c.entityId === entityId && c.name === name,
      ).id;
    cat = {
      groceries: find(personalId, 'Groceries'),
      salary: find(personalId, 'Salary'),
      office: find(businessId, 'Office expense'),
      interest: find(personalId, 'Interest & finance charges'),
    };
    expect(cats.body.data.find((c: { id: string }) => c.id === cat.office).taxLineCode).toBe('US_SCH_C_L18');
  });

  it('creates accounts with opening balances (ACC-05)', async () => {
    const a = await alice.post(`/v1/workspaces/${ws}/accounts`, {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('250000'),
      openingDate: '2026-10-01',
    });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ type: 'asset', currency: 'USD', balance: usd('250000') });
    checking = a.body.id;

    const c = await alice.post(`/v1/workspaces/${ws}/accounts`, {
      name: 'Visa',
      kind: 'credit_card',
      last4: '1005',
      openingBalance: usd('50000'),
      openingDate: '2026-10-01',
    });
    expect(c.body).toMatchObject({ type: 'liability', balance: usd('50000') });
    card = c.body.id;

    savings = (await alice.post(`/v1/workspaces/${ws}/accounts`, { name: 'Savings', kind: 'savings' })).body
      .id;
  });

  it('records an expense, income and a split across entities (TXN-01..03, DE-05)', async () => {
    const e = await alice.post(`/v1/workspaces/${ws}/transactions`, {
      date: '2026-10-05',
      accountId: card,
      amount: usd('-8400'),
      payee: 'Trader Joes',
      categoryId: cat.groceries,
      tags: ['food'],
    });
    expect(e.status).toBe(201);
    expect(e.body.entries).toHaveLength(1);
    expect(e.body.entries[0].postings).toEqual([
      expect.objectContaining({ accountName: 'Visa', credit: '8400', debit: null }),
      expect.objectContaining({ accountName: 'Groceries', debit: '8400', credit: null }),
    ]);

    await alice.post(`/v1/workspaces/${ws}/transactions`, {
      date: '2026-10-15',
      accountId: checking,
      amount: usd('320000'),
      payee: 'Employer Inc',
      categoryId: cat.salary,
    });

    const split = await alice.post(`/v1/workspaces/${ws}/transactions`, {
      date: '2026-10-20',
      accountId: card,
      amount: usd('-12000'),
      payee: 'Costco',
      splits: [
        { accountId: cat.groceries, amount: usd('-8000') },
        { accountId: cat.office, amount: usd('-4000'), memo: 'printer paper' },
      ],
    });
    expect(split.status).toBe(201);
    const [personal, business] = split.body.entries;
    expect(personal.entityId).toBe(personalId);
    expect(business.entityId).toBe(businessId);
    expect(personal.postings.map((p: { accountName: string }) => p.accountName)).toContain(
      'Transfers with Alice Design LLC',
    );
    expect(business.postings).toEqual([
      expect.objectContaining({ accountName: 'Office expense', debit: '4000' }),
      expect.objectContaining({ accountName: 'Owner contribution', credit: '4000' }),
    ]);
  });

  it('flags uncategorized transactions for review', async () => {
    const res = await alice.post(`/v1/workspaces/${ws}/transactions`, {
      date: '2026-10-21',
      accountId: checking,
      amount: usd('-1999'),
      payee: 'SQ *MYSTERY 0423',
    });
    expect(res.body.reviewState).toBe('needs_review');
    expect(res.body.entries[0].postings[1].accountName).toBe('Uncategorized expense');
  });

  it('transfers and pays the card, which never counts as income or expense (TXN-04)', async () => {
    const t = await alice.post(`/v1/workspaces/${ws}/transactions/transfer`, {
      date: '2026-10-22',
      fromAccountId: checking,
      toAccountId: savings,
      amount: usd('50000'),
    });
    expect(t.status).toBe(201);
    expect(t.body.entries[0].kind).toBe('transfer');
    const pay = await alice.post(`/v1/workspaces/${ws}/transactions/transfer`, {
      date: '2026-10-25',
      fromAccountId: checking,
      toAccountId: card,
      amount: usd('70400'),
      description: 'Visa payment',
    });
    expect(pay.status).toBe(201);
  });

  it('shows correct balances and a running-balance register (DE-06)', async () => {
    const accounts = (await alice.get(`/v1/workspaces/${ws}/accounts`)).body.data;
    const bal = (id: string) => accounts.find((a: { id: string }) => a.id === id).balance.amount;
    // 2,500.00 + 3,200.00 − 19.99 − 500.00 − 704.00
    expect(bal(checking)).toBe('447601');
    // owed: 500.00 + 84.00 + 120.00 − 704.00
    expect(bal(card)).toBe('0');
    expect(bal(savings)).toBe('50000');

    const reg = await alice.get(`/v1/workspaces/${ws}/accounts/${card}/register?view=ledger`);
    expect(reg.body.data.map((l: { runningBalance: string }) => l.runningBalance)).toEqual([
      '50000',
      '58400',
      '70400',
      '0',
    ]);
    expect(reg.body.data[1]).toMatchObject({ credit: '8400', debit: null, description: 'Trader Joes' });

    const simple = await alice.get(`/v1/workspaces/${ws}/accounts/${checking}/register?view=simple`);
    expect(simple.body.data.map((l: { amount: string }) => l.amount)).toEqual([
      '250000',
      '320000',
      '-1999',
      '-50000',
      '-70400',
    ]);
  });

  it('lists transactions newest first', async () => {
    const res = await alice.get(`/v1/workspaces/${ws}/transactions?from=2026-10-20`);
    expect(res.body.data.map((t: { date: string }) => t.date)).toEqual([
      '2026-10-25',
      '2026-10-22',
      '2026-10-21',
      '2026-10-20',
    ]);
  });
});

describe('validation, errors and idempotency', () => {
  it('rejects splits that do not add up', async () => {
    const res = await alice.post(`/v1/workspaces/${ws}/transactions`, {
      date: '2026-10-26',
      accountId: checking,
      amount: usd('-1000'),
      splits: [{ accountId: cat.groceries, amount: usd('-999') }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ledger.splits_mismatch');
  });

  it('returns field errors for invalid input', async () => {
    const res = await alice.post(`/v1/workspaces/${ws}/transactions`, {
      date: '2026-02-30',
      accountId: checking,
      amount: { amount: '12.50', currency: 'USD' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['amount.amount', 'date']);
  });

  it('replays a POST with the same Idempotency-Key instead of posting twice', async () => {
    const body = { date: '2026-10-27', accountId: checking, amount: usd('-500'), categoryId: cat.groceries };
    const headers = { 'idempotency-key': 'coffee-2026-10-27-a' };
    const first = await alice.post(`/v1/workspaces/${ws}/transactions`, body, headers);
    const second = await alice.post(`/v1/workspaces/${ws}/transactions`, body, headers);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const reused = await alice.post(
      `/v1/workspaces/${ws}/transactions`,
      { ...body, amount: usd('-600') },
      headers,
    );
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('idempotency.key_reused');
  });

  it("does not reveal another user's workspace", async () => {
    const mallory = h.as('mallory@example.com');
    const res = await mallory.get(`/v1/workspaces/${ws}/accounts`);
    expect(res.status).toBe(403);
    const missing = await mallory.get(`/v1/workspaces/00000000-0000-7000-8000-000000000000/accounts`);
    expect(missing.status).toBe(403);
  });
});
