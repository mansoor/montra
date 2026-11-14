/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, fromParts, parts, todayIn } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Billers on the budget and their next bills in upcoming, the calendar and the forecast (ADR-0048 §4).
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
/** The 20th of the month `n` months from this one. */
const the20th = (n: number) => {
  const m = parts(addMonths(today, n));
  return fromParts(m.year, m.month, 20);
};
/** The next 20th on or after today: when SDG&E's next bill is due. */
const nextDue = today <= the20th(0) ? the20th(0) : the20th(1);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('billers@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Billers', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('500000'),
      openingDate: addDays(the20th(-5), -1),
    })
  ).body.id;
  // Three months of the electricity bill, paid a day before it's due.
  for (const [n, amount] of [
    [-3, '-9000'],
    [-2, '-8000'],
    [-1, '-8500'],
  ] as const) {
    const res = await c.post(url('/transactions'), {
      date: addDays(the20th(n), -1),
      accountId: checking,
      amount: usd(amount),
      payee: 'SDG&E WEB PAYMENT',
      categoryId: cat('Utilities'),
    });
    expect(res.status).toBe(201);
  }
});
afterAll(() => h.close());

describe('billers (ADR-0048 §4)', () => {
  let sdge: any;

  it('names a provider on a budget category, and estimates its next bill from its payments', async () => {
    const res = await c.post(url('/billers'), { categoryId: cat('Utilities'), name: 'SDG&E', dueDay: 20 });
    expect(res.status).toBe(201);
    sdge = res.body;
    expect(sdge).toMatchObject({
      categoryId: cat('Utilities'),
      name: 'SDG&E',
      dueDay: 20,
      cadence: 'monthly',
      archived: false,
      next: { date: nextDue, amount: '8500', currency: 'USD', estimated: true, basedOn: 3 },
    });
    expect((await c.get(url('/billers'))).body.data.map((b: any) => b.name)).toEqual(['SDG&E']);
    // A new provider with no payments has nothing to go on yet.
    const water = (await c.post(url('/billers'), { categoryId: cat('Utilities'), name: 'City Water' })).body;
    expect(water.next).toBeNull();
    // A biller belongs to a spending category, and a name is used once per books.
    expect((await c.post(url('/billers'), { categoryId: checking, name: 'X' })).status).toBe(422);
    expect((await c.post(url('/billers'), { categoryId: cat('Utilities'), name: 'sdg&e' })).status).toBe(422);
  });

  it('shows the estimated bill in the calendar, upcoming and the forecast', async () => {
    const cal = (await c.get(url(`/calendar?from=${today}&to=${addDays(nextDue, 1)}`))).body;
    expect(cal.items).toContainEqual(
      expect.objectContaining({
        date: nextDue,
        kind: 'bill',
        name: 'SDG&E',
        amount: '-8500',
        variable: true,
        sourceId: sdge.id,
      }),
    );
    const f = (await c.get(url('/flow/forecast?days=60'))).body;
    // Paid from the books' main account.
    expect(f.accounts.find((a: any) => a.accountId === checking).items).toContainEqual(
      expect.objectContaining({ kind: 'bill', name: 'SDG&E', amount: '-8500', date: nextDue }),
    );
  });

  it('leaves the estimate out where a recurring item already shows the payee, and when archived', async () => {
    const rec = await c.post(url('/recurring'), {
      name: 'SDG&E',
      accountId: checking,
      amount: usd('-8500'),
      payee: 'SDG&E WEB PAYMENT',
      categoryId: cat('Utilities'),
      cadence: 'monthly',
      startDate: nextDue,
    });
    expect(rec.status).toBe(201);
    const calItems = async () =>
      (await c.get(url(`/calendar?from=${today}&to=${addDays(nextDue, 1)}`))).body.items.filter(
        (i: any) => i.sourceId === sdge.id,
      );
    expect(await calItems()).toEqual([]);
    const archived = await c.patch(url(`/billers/${sdge.id}`), { archived: true, version: sdge.version });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, next: null });
    expect(await calItems()).toEqual([]);
    // A stale version is refused.
    expect((await c.patch(url(`/billers/${sdge.id}`), { dueDay: 5, version: sdge.version })).status).toBe(
      409,
    );
  });
});
