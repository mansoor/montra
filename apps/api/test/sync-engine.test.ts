/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import { FetchTransport, MemoryStore, SyncEngine } from '@montra/sync';
import { startHarness, type Client, type Harness } from './harness.js';

/**
 * The shared offline engine (packages/sync) against the real API (ADR-0013): two devices, offline edits,
 * replay and a field-group conflict.
 */
let h: Harness;
let c: Client;
const EMAIL = 'two-devices@example.com';

beforeAll(async () => {
  h = await startHarness();
  c = h.as(EMAIL);
});
afterAll(() => h.close());

/** Routes the transport's fetch calls into the in-process app (no listening socket in tests). */
const injectFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const res = await h.app.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST',
    url: url.pathname + url.search,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    ...(init?.body ? { payload: String(init.body) } : {}),
  });
  return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

function device(workspaceId: string) {
  const store = new MemoryStore();
  const engine = new SyncEngine({
    store,
    transport: new FetchTransport({
      baseUrl: 'http://api.test',
      workspaceId,
      token: async () => `dev:${EMAIL}`,
      fetch: injectFetch,
    }),
    newId: randomUUID,
  });
  return { store, engine };
}

describe('SyncEngine against the API', () => {
  it('creates offline, syncs, sees the other device, and merges a conflict per field group', async () => {
    const ws = (
      await c.post('/v1/workspaces', { name: 'Devices', baseCurrency: 'USD', template: 'household' })
    ).body;
    const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
    const account = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
    const cats = (await c.get(url('/categories'))).body.data;
    const cat = (n: string) => cats.find((x: any) => x.name === n).id;

    const phone = device(ws.id);
    const tablet = device(ws.id);
    await phone.engine.bootstrap();
    await tablet.engine.bootstrap();
    expect((await phone.store.getReference('accounts')).map((a) => a.id)).toContain(account);

    // Offline on the phone: the row exists locally right away, marked pending.
    phone.engine.setOnline(false);
    const local = await phone.engine.createTransaction({
      date: calendarDate(new Date().toISOString().slice(0, 10)),
      accountId: account,
      amount: { amount: '-2500', currency: 'USD' },
      payee: 'Farmers market',
      categoryId: cat('Groceries'),
    });
    expect(local.pending).toBe(true);
    expect((await phone.engine.state()).pending).toBe(1);

    // Back online: pushed with the client id, acknowledged, no longer pending.
    phone.engine.setOnline(true);
    await phone.engine.sync();
    const synced = await phone.store.getTransaction(local.id);
    expect(synced).toMatchObject({ pending: false, categoryId: cat('Groceries') });
    expect((await c.get(url(`/transactions/${local.id}`))).status).toBe(200);

    // The tablet pulls it.
    await tablet.engine.sync();
    expect(await tablet.store.getTransaction(local.id)).toMatchObject({ payee: 'Farmers market' });

    // Both edit offline: the tablet the memo, the phone the payee — different groups, both survive.
    tablet.engine.setOnline(false);
    phone.engine.setOnline(false);
    await tablet.engine.updateTransaction(local.id, { memo: 'tomatoes' });
    await phone.engine.updateTransaction(local.id, { payee: 'Saturday market' });
    tablet.engine.setOnline(true);
    phone.engine.setOnline(true);
    await tablet.engine.sync();
    await phone.engine.sync();
    await tablet.engine.sync();
    const server = (await c.get(url(`/transactions/${local.id}`))).body;
    expect(server).toMatchObject({ payee: 'Saturday market', memo: 'tomatoes' });
    expect(await tablet.store.getTransaction(local.id)).toMatchObject({
      payee: 'Saturday market',
      memo: 'tomatoes',
    });

    // Same group on both: the later edit wins and the other device gets a conflict notice.
    tablet.engine.setOnline(false);
    phone.engine.setOnline(false);
    await phone.engine.updateTransaction(local.id, { memo: 'from phone (earlier)' });
    await new Promise((r) => setTimeout(r, 20));
    await tablet.engine.updateTransaction(local.id, { memo: 'from tablet (later)' });
    tablet.engine.setOnline(true);
    await tablet.engine.sync();
    phone.engine.setOnline(true);
    await phone.engine.sync();
    expect((await c.get(url(`/transactions/${local.id}`))).body.memo).toBe('from tablet (later)');
    const notices = await phone.store.conflicts();
    expect(notices.at(-1)?.conflicts).toEqual([expect.objectContaining({ group: 'memo', winner: 'server' })]);
    expect((await phone.store.getTransaction(local.id))?.memo).toBe('from tablet (later)');

    // Sign-out wipes the device (BAK-10).
    await phone.engine.signOut();
    expect(await phone.store.getTransaction(local.id)).toBeNull();
  });
});
