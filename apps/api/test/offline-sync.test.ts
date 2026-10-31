/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Client, type Harness } from './harness.js';

const usd = (amount: string) => ({ amount, currency: 'USD' });
let h: Harness;
let c: Client;

beforeAll(async () => {
  h = await startHarness();
  c = h.as('offline@example.com');
});
afterAll(() => h.close());

async function setup(name: string) {
  const ws = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (n: string) => cats.find((x: any) => x.name === n).id as string;
  const account = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id as string;
  return { ws, url, cat, account };
}

const today = () => new Date().toISOString().slice(0, 10);
const op = (kind: string, extra: Record<string, unknown>) => ({
  opId: randomUUID(),
  kind,
  changedAt: new Date().toISOString(),
  ...extra,
});

describe('offline sync: pull (ADR-0013)', () => {
  it('bootstraps reference data and recent transactions, then pulls only changes', async () => {
    const w = await setup('Pull');
    const t = await c.post(w.url('/transactions'), {
      date: today(),
      accountId: w.account,
      amount: usd('-1200'),
      payee: 'Grocer',
      categoryId: w.cat('Groceries'),
    });
    const boot = (await c.get(w.url('/sync/pull?since=0'))).body;
    expect(boot.full).toBe(true);
    expect(boot.transactions.map((x: any) => x.id)).toContain(t.body.id);
    expect(boot.accounts.some((a: any) => a.id === w.account)).toBe(true);
    expect(boot.categories.length).toBeGreaterThan(10);
    expect(boot.entities).toHaveLength(1);

    const empty = (await c.get(w.url(`/sync/pull?since=${boot.latestSeq}`))).body;
    expect(empty).toMatchObject({ full: false, transactions: [], removedTransactions: [], hasMore: false });

    await c.patch(w.url(`/transactions/${t.body.id}`), { memo: 'weekly shop' });
    const changed = (await c.get(w.url(`/sync/pull?since=${boot.latestSeq}`))).body;
    expect(changed.transactions.map((x: any) => x.id)).toEqual([t.body.id]);
    expect(changed.transactions[0].memo).toBe('weekly shop');
    expect(changed.accounts).toEqual([]);

    await c.delete(w.url(`/transactions/${t.body.id}`));
    const removed = (await c.get(w.url(`/sync/pull?since=${changed.latestSeq}`))).body;
    expect(removed.removedTransactions).toEqual([t.body.id]);
  });
});

describe('offline sync: push (ADR-0013)', () => {
  it('creates with the client id, and replays are no-ops', async () => {
    const w = await setup('Push create');
    const id = randomUUID();
    const create = op('transaction.create', {
      id,
      data: {
        date: today(),
        accountId: w.account,
        amount: usd('-450'),
        payee: 'Cafe',
        categoryId: w.cat('Dining out'),
      },
    });
    const first = await c.post(w.url('/sync/push'), { ops: [create] });
    expect(first.status).toBe(200);
    expect(first.body.results[0]).toMatchObject({ status: 'applied', transaction: { id } });
    const again = await c.post(w.url('/sync/push'), { ops: [create] });
    expect(again.body.results[0].status).toBe('duplicate');
    const sameId = await c.post(w.url('/sync/push'), { ops: [{ ...create, opId: randomUUID() }] });
    expect(sameId.body.results[0].status).toBe('duplicate');
    const list = (await c.get(w.url('/transactions'))).body.data.filter((t: any) => t.id === id);
    expect(list).toHaveLength(1);
  });

  it('merges concurrent edits per field group and reports conflicts', async () => {
    const w = await setup('Push merge');
    const t = (
      await c.post(w.url('/transactions'), {
        date: today(),
        accountId: w.account,
        amount: usd('-3000'),
        payee: 'Hardware store',
        categoryId: w.cat('Household'),
      })
    ).body;
    const base = t.version;
    const offlineAt = new Date(Date.now() - 60_000).toISOString(); // edited on the device a minute ago

    // Meanwhile on the web: a new memo and a new category.
    await c.patch(w.url(`/transactions/${t.id}`), { memo: 'from web', categoryId: w.cat('Electronics') });

    const res = await c.post(w.url('/sync/push'), {
      ops: [
        {
          opId: randomUUID(),
          kind: 'transaction.update',
          id: t.id,
          baseVersion: base,
          changedAt: offlineAt,
          // payee: untouched on the server → applies; ledger: the server's later change wins.
          data: { payee: 'Ace Hardware', categoryId: w.cat('Clothing') },
        },
      ],
    });
    const r = res.body.results[0];
    expect(r.status).toBe('merged');
    expect(r.conflicts).toEqual([expect.objectContaining({ group: 'ledger', winner: 'server' })]);
    expect(r.transaction.payee).toBe('Ace Hardware');
    expect(r.transaction.memo).toBe('from web');
    expect(r.transaction.splits[0].accountId).toBe(w.cat('Electronics'));

    // A later device edit to the same group wins over the earlier server change.
    const later = await c.post(w.url('/sync/push'), {
      ops: [
        {
          opId: randomUUID(),
          kind: 'transaction.update',
          id: t.id,
          baseVersion: base,
          changedAt: new Date().toISOString(),
          data: { memo: 'from phone' },
        },
      ],
    });
    expect(later.body.results[0].conflicts).toEqual([
      expect.objectContaining({ group: 'memo', winner: 'client' }),
    ]);
    expect(later.body.results[0].transaction.memo).toBe('from phone');
  });

  it('rejects an op the server cannot apply, without blocking the rest of the batch', async () => {
    const w = await setup('Push reject');
    const ok = randomUUID();
    const res = await c.post(w.url('/sync/push'), {
      ops: [
        op('transaction.create', {
          id: randomUUID(),
          data: { date: today(), accountId: randomUUID(), amount: usd('-100'), payee: 'Nowhere' },
        }),
        op('transaction.create', {
          id: ok,
          data: { date: today(), accountId: w.account, amount: usd('-100'), payee: 'Somewhere' },
        }),
      ],
    });
    expect(res.body.results.map((r: any) => r.status)).toEqual(['rejected', 'applied']);
    expect(res.body.results[0].error.code).toBeTruthy();
  });

  it('accepts and resolves review items from the outbox', async () => {
    const w = await setup('Push review');
    const t = (
      await c.post(w.url('/transactions'), {
        date: today(),
        accountId: w.account,
        amount: usd('-999'),
        payee: 'Zqx',
      })
    ).body;
    expect(t.reviewState).toBe('needs_review');
    const res = await c.post(w.url('/sync/push'), {
      ops: [op('review.resolve', { id: t.id, categoryId: w.cat('Hobbies') })],
    });
    expect(res.body.results[0]).toMatchObject({
      status: 'applied',
      transaction: { reviewState: 'reviewed' },
    });
  });
});

describe('push devices', () => {
  it('registers a device token, moves it to the latest user, and removes it', async () => {
    const token = `ExponentPushToken[${randomUUID()}]`;
    const reg = await c.post('/v1/me/push-devices', { token, platform: 'ios', deviceName: 'iPhone' });
    expect(reg.status).toBe(201);
    expect((await c.get('/v1/me/push-devices')).body.data).toHaveLength(1);
    const other = h.as('other-device-user@example.com');
    await other.post('/v1/me/push-devices', { token, platform: 'ios' });
    expect((await c.get('/v1/me/push-devices')).body.data).toHaveLength(0);
    expect((await other.get('/v1/me/push-devices')).body.data).toHaveLength(1);
    expect((await other.delete(`/v1/me/push-devices/${encodeURIComponent(token)}`)).status).toBe(204);
    expect((await other.get('/v1/me/push-devices')).body.data).toHaveLength(0);
  });
});
