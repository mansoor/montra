/* eslint-disable @typescript-eslint/no-explicit-any -- test messages are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
let base: string;

beforeAll(async () => {
  h = await startHarness();
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.getHttpServer().address() as { port: number };
  base = `127.0.0.1:${address.port}`;
});
afterAll(() => h.close());

function connect(email: string): Promise<{ ws: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/v1/ws`, { headers: { authorization: `Bearer dev:${email}` } });
    const queue: any[] = [];
    const waiters: ((m: any) => void)[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    const next = () =>
      new Promise<any>((res, rej) => {
        const m = queue.shift();
        if (m) return res(m);
        const t = setTimeout(() => rej(new Error('no message within 2s')), 2000);
        waiters.push((x) => {
          clearTimeout(t);
          res(x);
        });
      });
    ws.on('open', () => resolve({ ws, next }));
    ws.on('error', reject);
  });
}

describe('real-time push (PLT-06)', () => {
  it('notifies subscribers within seconds of a commit, and only members', async () => {
    const alice = h.as('rt-alice@example.com');
    const ws = (await alice.post('/v1/workspaces', { name: 'RT', baseCurrency: 'USD' })).body;
    const cats = (await alice.get(`/v1/workspaces/${ws.id}/categories`)).body.data;
    const checking = (
      await alice.post(`/v1/workspaces/${ws.id}/accounts`, { name: 'Checking', kind: 'checking' })
    ).body.id;

    const a = await connect('rt-alice@example.com');
    a.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: ws.id }));
    expect(await a.next()).toEqual({ type: 'subscribed', workspaceId: ws.id });

    const m = await connect('rt-mallory@example.com');
    m.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: ws.id }));
    expect(await m.next()).toMatchObject({ type: 'error', code: 'forbidden' });

    const started = Date.now();
    await alice.post(`/v1/workspaces/${ws.id}/transactions`, {
      date: '2026-10-30',
      accountId: checking,
      amount: { amount: '-500', currency: 'USD' },
      categoryId: cats.find((c: any) => c.name === 'Groceries').id,
    });
    expect(await a.next()).toEqual({ type: 'changes', workspaceId: ws.id });
    expect(Date.now() - started).toBeLessThan(5000);

    a.ws.close();
    m.ws.close();
  });

  it('rejects unauthenticated subscriptions', async () => {
    const anon = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://${base}/v1/ws`);
      ws.on('open', () => resolve(ws));
    });
    const reply = new Promise<any>((resolve) => anon.on('message', (d) => resolve(JSON.parse(d.toString()))));
    anon.send(JSON.stringify({ type: 'subscribe', workspaceId: '00000000-0000-7000-8000-000000000000' }));
    expect(await reply).toEqual({ type: 'error', code: 'unauthenticated' });
    anon.close();
  });
});
