/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, statementCycle, todayIn, type CalendarDate } from '@montra/domain';
import { startHarness, type Client, type Harness } from './harness.js';

// Card and line-of-credit statements, what's due, and how it's paid (ADR-0026). Dates follow today, so nothing here
// depends on the day of the month the tests run.
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
// Closed three days ago; due in about two weeks.
const statementDay = Number(addDays(today, -3).slice(8));
const dueDay = Number(addDays(today, 15).slice(8));
const cycle = statementCycle(today, statementDay, dueDay);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let checking: string;

const statementOf = async (id: string) => (await c.get(url(`/accounts/${id}/statement`))).body.data;

/** A card with $500.00 charged before the close, $200.00 paid and $70.00 charged since. */
const card = async (name: string, kind = 'credit_card', extra: object = {}) => {
  const res = await c.post(url('/accounts'), {
    name,
    kind,
    creditLimit: '500000',
    minPayment: '3500',
    openingDate: addDays(cycle.lastClose, -20),
    statementDay,
    dueDay,
    ...extra,
  });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  const charge = (date: CalendarDate, amount: string) =>
    c.post(url('/transactions'), { date, accountId: id, amount: usd(`-${amount}`), payee: 'Shop' });
  expect((await charge(addDays(cycle.lastClose, -2), '50000')).status).toBe(201);
  const paid = await c.post(url('/transactions/transfer'), {
    date: addDays(cycle.lastClose, 1),
    fromAccountId: checking,
    toAccountId: id,
    amount: usd('20000'),
  });
  expect(paid.status).toBe(201);
  expect((await charge(today, '7000')).status).toBe(201);
  return id;
};

beforeAll(async () => {
  h = await startHarness();
  c = h.as('cards@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Cards', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Everyday',
      kind: 'checking',
      openingBalance: usd('1000000'),
      openingDate: addDays(today, -60),
    })
  ).body.id;
});

afterAll(async () => {
  await h.close();
});

describe('the latest statement', () => {
  it('is what was owed at the close, less what’s been paid since', async () => {
    const id = await card('Visa');
    expect(await statementOf(id)).toMatchObject({
      accountId: id,
      name: 'Visa',
      lastClose: cycle.lastClose,
      dueDate: cycle.dueDate,
      nextClose: cycle.nextClose,
      nextDueDate: cycle.nextDueDate,
      statementBalance: '50000',
      paidSince: '20000',
      due: '30000',
      minimumDue: '3500',
      owed: '37000',
      sinceStatement: '7000',
      limit: '500000',
      available: '463000',
      utilizationBps: 740,
      planned: null,
    });
  });

  it('is nothing more once the statement is paid in full', async () => {
    const id = await card('Paid off');
    await c.post(url('/transactions/transfer'), {
      date: today,
      fromAccountId: checking,
      toAccountId: id,
      amount: usd('30000'),
    });
    expect(await statementOf(id)).toMatchObject({ due: '0', minimumDue: '0', owed: '7000' });
  });

  it('isn’t there until both days are set, and isn’t for other kinds', async () => {
    const id = (await c.post(url('/accounts'), { name: 'No days', kind: 'credit_card', statementDay: 5 }))
      .body.id;
    expect(await statementOf(id)).toBeNull();
    expect((await c.get(url(`/accounts/${checking}/statement`))).body.code).toBe('card.kind');
    const list = (await c.get(url('/card-statements'))).body.data;
    expect(list.map((s: any) => s.name)).not.toContain('No days');
  });
});

describe('how it’s paid', () => {
  it('plans the payment by its rule, from its account', async () => {
    const id = await card('Ruled', 'credit_card', { payFromAccountId: checking, payRule: 'statement' });
    expect((await statementOf(id)).planned).toEqual({
      date: cycle.dueDate,
      amount: '30000',
      fromAccountId: checking,
    });
    await c.patch(url(`/accounts/${id}`), { payRule: 'minimum' });
    expect((await statementOf(id)).planned.amount).toBe('3500');
    await c.patch(url(`/accounts/${id}`), { payRule: 'fixed', payFixed: '10000' });
    expect((await statementOf(id)).planned.amount).toBe('10000');
    const back = await c.patch(url(`/accounts/${id}`), { payRule: null, payFixed: null });
    expect(back.status).toBe(200);
    expect(back.body.cycle).toMatchObject({ payRule: null, payFixed: null, payFromAccountId: checking });
  });

  it('refuses a rule that can’t work', async () => {
    const code = async (body: object) =>
      (await c.post(url('/accounts'), { name: 'Bad', kind: 'credit_card', ...body })).body.code;
    expect(await code({ payRule: 'statement' })).toBe('card.pay_from');
    expect(await code({ payRule: 'fixed', payFromAccountId: checking })).toBe('card.pay_fixed');
    expect(await code({ payRule: 'statement', payFromAccountId: checking, payFixed: '100' })).toBe(
      'card.pay_fixed',
    );
    const other = (await c.post(url('/accounts'), { name: 'Other card', kind: 'credit_card' })).body.id;
    expect(await code({ payRule: 'statement', payFromAccountId: other })).toBe('card.pay_from');
    expect(
      (await c.post(url('/accounts'), { name: 'Bad checking', kind: 'checking', statementDay: 5 })).body.code,
    ).toBe('card.kind');
  });
});

describe('calendar, forecast and Upcoming', () => {
  it('shows what’s due, and the next one from what’s been charged since', async () => {
    const id = await card('Calendar card', 'credit_card', {
      payFromAccountId: checking,
      payRule: 'statement',
    });
    const items = (await c.get(url(`/calendar?from=${today}&to=${addDays(today, 60)}`))).body.items.filter(
      (i: any) => i.sourceId === id,
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'card_due',
        date: cycle.dueDate,
        amount: '-30000',
        status: 'upcoming',
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'card_due', date: cycle.nextDueDate, amount: '-7000' }),
    );

    const f = (await c.get(url('/flow/forecast?days=60'))).body;
    const inChecking = f.accounts
      .find((a: any) => a.accountId === checking)
      .items.filter((i: any) => i.sourceId === id);
    expect(inChecking).toContainEqual(
      expect.objectContaining({ kind: 'card_payment', date: cycle.dueDate, amount: '-30000' }),
    );
    const onCard = f.accounts.find((a: any) => a.accountId === id);
    expect(onCard.kind).toBe('card');
    expect(onCard.items).toContainEqual(
      expect.objectContaining({ kind: 'card_payment', date: cycle.dueDate, amount: '30000' }),
    );
    expect(onCard.items).toContainEqual(
      expect.objectContaining({ kind: 'card_payment', date: cycle.nextDueDate, amount: '7000' }),
    );

    const list = (await c.get(url('/card-statements'))).body.data;
    expect(list.find((s: any) => s.accountId === id)).toMatchObject({ due: '30000' });
  });

  it('treats a line of credit the same way', async () => {
    const id = await card('Home equity line', 'line_of_credit', {
      payFromAccountId: checking,
      payRule: 'minimum',
    });
    expect(await statementOf(id)).toMatchObject({ due: '30000', minimumDue: '3500', available: '463000' });
    const f = (await c.get(url('/flow/forecast?days=30'))).body;
    const line = f.accounts.find((a: any) => a.accountId === id);
    expect(line).toMatchObject({ kind: 'card', threshold: '-500000' });
  });

  it('leaves another workspace’s cards alone', async () => {
    const other = h.as('cards-other@example.com');
    const theirs = (
      await other.post('/v1/workspaces', { name: 'Theirs', baseCurrency: 'USD', template: 'household' })
    ).body;
    expect((await other.get(`/v1/workspaces/${theirs.id}/card-statements`)).body.data).toEqual([]);
  });
});
