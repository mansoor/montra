/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, calendarDate, startOfMonth, todayIn } from '@montra/domain';
import { RentalJobs } from '../src/rentals/rental-jobs.service.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Tracking payments on a loan or mortgage that isn't on a rental property (ADR-0024).
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
const ctx = () => ({ workspaceId, userId });

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;
let workspaceId: string;
let userId: string;

const owed = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;
const accountOf = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id);
const scheduleOf = async (id: string) => (await c.get(url(`/loans/${id}/schedule`))).body.data;
const loanOf = async (id: string) => (await c.get(url('/loans'))).body.data.find((l: any) => l.id === id);

/** A $200,000.00 mortgage at 6% over 30 years. */
const mortgage = async (overrides: object = {}, newAccount: object = {}) => {
  const res = await c.post(url('/loans'), {
    name: 'Home mortgage',
    newAccount: { kind: 'mortgage', ...newAccount },
    principal: '20000000',
    rateBps: 600,
    termMonths: 360,
    firstPaymentDate: addDays(today, 3),
    balanceAsOf: today,
    payingAccountId: checking,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
};

beforeAll(async () => {
  h = await startHarness();
  c = h.as('loans@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Loans', baseCurrency: 'USD', template: 'household' }))
    .body;
  workspaceId = ws.id;
  userId = (await c.get('/v1/me')).body.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Everyday',
      kind: 'checking',
      openingBalance: usd('5000000'),
      openingDate: addDays(today, -400),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
});

afterAll(async () => {
  await h.close();
});

describe('adding a tracked loan', () => {
  it('adds the account with it, owing the full amount when it’s new', async () => {
    const loan = await mortgage();
    expect(loan).toMatchObject({
      propertyId: null,
      payment: '119910',
      totalPayment: '119910',
      paymentsMade: 0,
      payingAccountId: checking,
      autoRecord: false,
      interestPaid: '0',
    });
    expect(loan.next).toMatchObject({
      number: 1,
      date: addDays(today, 3),
      interest: '100000',
      principal: '19910',
      total: '119910',
    });
    expect(await owed(loan.loanAccountId)).toBe('20000000');
    const account = await accountOf(loan.loanAccountId);
    expect(account).toMatchObject({ kind: 'mortgage', loanId: loan.id });
    // Debt payoff reads these from the account.
    expect(account.planning).toMatchObject({ interestRateBps: 600, minPayment: '119910' });
    expect(loan.payoffDate).toBe((await scheduleOf(loan.id))[359].date);
  });

  it('doesn’t ask for payments from before tracking began, on a loan years in', async () => {
    const first = calendarDate(addMonths(today, -24));
    const loan = await mortgage({ name: 'Older mortgage', firstPaymentDate: first }, { owed: '19000000' });
    // The first payment, and one each month for 24 months up to today, are already in the balance.
    expect(loan.next.number).toBe(26);
    expect(loan.next.date > today).toBe(true);
    expect(await owed(loan.loanAccountId)).toBe('19000000');
    // Interest follows what's owed, not the original amount.
    expect(loan.next.interest).toBe('95000');
    const cal = (await c.get(url(`/calendar?from=${first}&to=${today}`))).body.items;
    expect(cal.filter((i: any) => i.sourceId === loan.id)).toEqual([]);
  });

  it('estimates what’s owed from the terms when it’s left blank', async () => {
    const first = calendarDate(addMonths(today, -2));
    const loan = await mortgage({ name: 'Estimated', firstPaymentDate: first });
    const rows = (await scheduleOf(loan.id)) as any[];
    // Three payments are in the past: the two months and today.
    expect(loan.next.number).toBe(4);
    expect(rows[0].number).toBe(4);
    expect(BigInt(await owed(loan.loanAccountId))).toBeLessThan(20000000n);
    expect(BigInt(await owed(loan.loanAccountId))).toBeGreaterThan(19900000n);
  });

  it('starts tracking an account that only had a balance, once', async () => {
    const id = (
      await c.post(url('/accounts'), {
        name: 'Car loan',
        kind: 'loan',
        openingBalance: usd('1500000'),
        openingDate: addDays(today, -30),
      })
    ).body.id;
    const body = {
      name: 'Car loan',
      loanAccountId: id,
      principal: '2000000',
      rateBps: 500,
      termMonths: 60,
      firstPaymentDate: addDays(today, 5),
      balanceAsOf: today,
      payingAccountId: checking,
    };
    const res = await c.post(url('/loans'), body);
    expect(res.status).toBe(201);
    expect(res.body.next.interest).toBe('6250');
    expect(res.body.propertyId).toBeNull();
    const again = await c.post(url('/loans'), body);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('loan.exists');
  });

  it('refuses what can’t work', async () => {
    const base = {
      name: 'Bad',
      newAccount: { kind: 'loan' },
      principal: '100000',
      rateBps: 500,
      termMonths: 12,
      firstPaymentDate: addDays(today, 5),
    };
    const code = async (extra: object) => (await c.post(url('/loans'), { ...base, ...extra })).body.code;
    expect(await code({ autoRecord: true })).toBe('loan.auto_record');
    const card = (await c.post(url('/accounts'), { name: 'Card', kind: 'credit_card' })).body.id;
    expect(await code({ payingAccountId: card })).toBe('loan.paying_account');
    const { newAccount: _n, ...noAccount } = base;
    expect((await c.post(url('/loans'), noAccount)).status).toBeGreaterThanOrEqual(400);
    expect((await c.post(url('/loans'), { ...base, loanAccountId: card })).status).toBeGreaterThanOrEqual(
      400,
    );
    // A line of credit isn't an installment loan, and neither is a checking account.
    expect(await code({ newAccount: undefined, loanAccountId: checking })).toBe('loan.account');
    // Nothing partial stayed behind.
    const names = (await c.get(url('/accounts'))).body.data.map((a: any) => a.name);
    expect(names).not.toContain('Bad');
  });

  it('leaves its rate and payment to the loan', async () => {
    const loan = await mortgage({ name: 'Rate guard' });
    const res = await c.patch(url(`/accounts/${loan.loanAccountId}`), { interestRateBps: 100 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('loan.tracked');
    expect((await c.patch(url(`/accounts/${loan.loanAccountId}`), { name: 'Renamed' })).status).toBe(200);
  });
});

describe('recording payments', () => {
  it('splits a payment, and the balance and next interest follow', async () => {
    const loan = await mortgage({ name: 'Split one' });
    const before = BigInt((await accountOf(checking)).balance.amount);
    const res = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      accountId: checking,
      date: today,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ paymentsMade: 1, interestPaid: '100000' });
    expect(await owed(loan.loanAccountId)).toBe(String(20000000n - 19910n));
    expect(BigInt((await accountOf(checking)).balance.amount)).toBe(before - 119910n);
    expect(res.body.next.number).toBe(2);
    expect(res.body.next.interest).toBe('99900');

    const [paid] = await scheduleOf(loan.id);
    expect(paid).toMatchObject({ number: 1, interest: '100000', principal: '19910' });
    expect(paid.balance).toBe(String(20000000n - 19910n));
    const t = (await c.get(url(`/transactions/${paid.transactionId}`))).body;
    expect(t.splits.map((s: any) => s.accountId)).toContain(cat('Mortgage interest'));
    expect(t.splits.map((s: any) => s.accountId)).toContain(loan.loanAccountId);
    // It belongs to the loan now.
    const edit = await c.patch(url(`/transactions/${paid.transactionId}`), {
      version: t.version,
      description: 'x',
    });
    expect(edit.status).toBe(422);
    expect(edit.body.code).toBe('loan.managed');

    const undone = await c.delete(url(`/loans/${loan.id}/payments/1`));
    expect(undone.status).toBe(200);
    expect(undone.body.next).toMatchObject({ number: 1, interest: '100000' });
    expect(await owed(loan.loanAccountId)).toBe('20000000');
  });

  it('puts extra on principal, which ends the loan sooner', async () => {
    const loan = await mortgage({ name: 'Extra' });
    const res = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      accountId: checking,
      date: today,
      extraPrincipal: '1000000',
    });
    expect(res.status).toBe(201);
    expect(await owed(loan.loanAccountId)).toBe(String(20000000n - 19910n - 1000000n));
    expect(res.body.next.interest).toBe(String(94900n));
    expect(res.body.payoffDate < loan.payoffDate).toBe(true);
    expect(BigInt(res.body.interestRemaining)).toBeLessThan(BigInt(loan.interestRemaining));
    const tooMuch = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 2,
      accountId: checking,
      date: today,
      extraPrincipal: '99999999',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code).toBe('loan.extra');
  });

  it('follows money paid onto the loan some other way', async () => {
    const loan = await mortgage({ name: 'Transfer' });
    const res = await c.post(url('/transactions/transfer'), {
      date: today,
      fromAccountId: checking,
      toAccountId: loan.loanAccountId,
      amount: usd('2000000'),
    });
    expect(res.status).toBe(201);
    const after = await loanOf(loan.id);
    expect(after.scheduledBalance).toBe('18000000');
    expect(after.next.interest).toBe('90000');
    expect(after.payment).toBe('119910');
  });

  it('posts escrow to its categories', async () => {
    const loan = await mortgage({ name: 'Escrowed', escrowInsurance: '10000' });
    expect(loan.totalPayment).toBe('129910');
    const res = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      accountId: checking,
      date: today,
    });
    expect(res.status).toBe(201);
    const [paid] = await scheduleOf(loan.id);
    expect(paid.escrow).toBe('10000');
    const t = (await c.get(url(`/transactions/${paid.transactionId}`))).body;
    expect(t.splits.map((s: any) => s.accountId)).toContain(cat('Insurance'));
  });

  it('uses the loan’s own interest category for a car loan', async () => {
    const res = await c.post(url('/loans'), {
      name: 'Truck',
      newAccount: { kind: 'loan' },
      principal: '1200000',
      rateBps: 0,
      termMonths: 12,
      firstPaymentDate: addDays(today, 2),
      balanceAsOf: today,
    });
    expect(res.status).toBe(201);
    // No interest at 0%: it's all principal, and the last payment clears it.
    expect(res.body.next).toMatchObject({ interest: '0', principal: '100000' });
    const rows = await scheduleOf(res.body.id);
    expect(rows).toHaveLength(12);
    expect(rows[11].balance).toBe('0');
    expect(res.body.interestRemaining).toBe('0');
  });

  it('takes over a statement line by itself, on the account it’s paid from', async () => {
    const other = (
      await c.post(url('/accounts'), {
        name: 'Other',
        kind: 'checking',
        openingBalance: usd('1000000'),
        openingDate: addDays(today, -10),
      })
    ).body.id;
    const loan = await mortgage({ name: 'Matched', principal: '20100000' });
    const total = loan.next.total as string;
    const line = async (accountId: string) =>
      (
        await c.post(url('/transactions'), {
          date: today,
          accountId,
          amount: usd(`-${total}`),
          payee: 'BANK DEBIT',
          categoryId: cat('Utilities'),
        })
      ).body.id as string;
    const jobs = h.app.get(RentalJobs);
    // The right amount on another account isn't this loan's payment.
    await line(other);
    expect(await jobs.matchPayments(ctx())).toBe(0);
    const id = await line(checking);
    expect(await jobs.matchPayments(ctx())).toBe(1);
    const [paid] = await scheduleOf(loan.id);
    expect(paid.transactionId).toBe(id);
    expect(await owed(loan.loanAccountId)).toBe(String(20100000n - BigInt(loan.next.principal)));
  });

  it('accepts a line for another amount only when told to, and principal takes the difference', async () => {
    const loan = await mortgage({ name: 'Different line', principal: '20200000' });
    const add = async (amount: string) =>
      (
        await c.post(url('/transactions'), {
          date: today,
          accountId: checking,
          amount: usd(`-${amount}`),
          payee: 'LENDER',
          categoryId: cat('Utilities'),
        })
      ).body.id as string;
    const more = BigInt(loan.next.total) + 50000n;
    const id = await add(String(more));
    const strict = await c.post(url(`/loans/${loan.id}/payments`), { number: 1, transactionId: id });
    expect(strict.status).toBe(422);
    expect(strict.body.code).toBe('loan.amount');
    const short = await add('1000');
    const tooSmall = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      transactionId: short,
      adjustPrincipal: true,
    });
    expect(tooSmall.status).toBe(422);
    const ok = await c.post(url(`/loans/${loan.id}/payments`), {
      number: 1,
      transactionId: id,
      adjustPrincipal: true,
    });
    expect(ok.status).toBe(201);
    expect(await owed(loan.loanAccountId)).toBe(String(20200000n - BigInt(loan.next.principal) - 50000n));
  });

  it('records itself on its due date when asked to, and only then', async () => {
    const first = calendarDate(addDays(today, -1));
    const plain = await mortgage({
      name: 'Not auto',
      firstPaymentDate: first,
      balanceAsOf: addDays(today, -2),
    });
    const auto = await mortgage({
      name: 'Auto',
      firstPaymentDate: first,
      balanceAsOf: addDays(today, -2),
      autoRecord: true,
    });
    const jobs = h.app.get(RentalJobs);
    const { recorded } = await jobs.nightly(ctx());
    expect(recorded).toBe(1);
    expect((await loanOf(auto.id)).paymentsMade).toBe(1);
    expect((await loanOf(plain.id)).paymentsMade).toBe(0);
    // Nothing more is due, so it doesn't record again.
    expect((await jobs.nightly(ctx())).recorded).toBe(0);
    const stop = await c.patch(url(`/loans/${plain.id}`), {
      version: (await loanOf(plain.id)).version,
      payingAccountId: null,
      autoRecord: true,
    });
    expect(stop.status).toBe(422);
    expect(stop.body.code).toBe('loan.auto_record');
  });
});

describe('changing the rate', () => {
  it('applies from the next payment, re-levels what’s left, and leaves what was paid', async () => {
    const loan = await mortgage({ name: 'ARM' });
    await c.post(url(`/loans/${loan.id}/payments`), { number: 1, accountId: checking, date: today });
    const res = await c.patch(url(`/loans/${loan.id}`), {
      version: (await loanOf(loan.id)).version,
      rateBps: 700,
    });
    expect(res.status).toBe(200);
    expect(res.body.rateBps).toBe(700);
    expect(res.body.next.interest).toBe(String((BigInt(19980090) * 700n + 60000n) / 120000n));
    expect(BigInt(res.body.payment)).toBeGreaterThan(119910n);
    const rows = await scheduleOf(loan.id);
    expect(rows[0]).toMatchObject({ number: 1, interest: '100000', principal: '19910' });
    // The term stays: the last scheduled payment clears it.
    expect(rows[rows.length - 1].number).toBe(360);
    expect(rows[rows.length - 1].balance).toBe('0');
    expect((await accountOf(loan.loanAccountId)).planning.interestRateBps).toBe(700);
  });

  it('takes the lender’s figure with it, and can go back to the calculated one', async () => {
    const loan = await mortgage({ name: 'Lender figure', paymentAmount: '125000' });
    expect(loan.payment).toBe('125000');
    expect(loan.next.principal).toBe('25000');
    const v2 = await c.patch(url(`/loans/${loan.id}`), {
      version: loan.version,
      rateBps: 650,
      paymentAmount: '130000',
    });
    expect(v2.body.payment).toBe('130000');
    const v3 = await c.patch(url(`/loans/${loan.id}`), { version: v2.body.version, paymentAmount: null });
    expect(v3.body.payment).not.toBe('130000');
    const stale = await c.patch(url(`/loans/${loan.id}`), { version: loan.version, rateBps: 500 });
    expect(stale.status).toBe(409);
  });

  it('doesn’t loop forever on a payment too small to cover interest', async () => {
    const loan = await mortgage({ name: 'Too small', paymentAmount: '1000' });
    expect(loan.next.principal).toBe('0');
    const rows = await scheduleOf(loan.id);
    expect(rows).toHaveLength(360);
    expect(rows[359].balance).toBe('0');
  });
});

describe('recurring, calendar and forecast', () => {
  it('shows what’s due on the calendar and forecast, from the account it’s paid from', async () => {
    const savings = (
      await c.post(url('/accounts'), {
        name: 'Rainy day',
        kind: 'savings',
        openingBalance: usd('9000000'),
        openingDate: addDays(today, -10),
      })
    ).body.id;
    const date = addDays(today, 4);
    const loan = await mortgage({ name: 'Forecast me', payingAccountId: savings, firstPaymentDate: date });
    const items = (await c.get(url(`/calendar?from=${today}&to=${addDays(today, 10)}`))).body.items;
    expect(items.find((i: any) => i.sourceId === loan.id)).toMatchObject({
      kind: 'mortgage',
      date,
      amount: `-${loan.totalPayment}`,
      accountId: savings,
      status: 'upcoming',
    });
    const f = (await c.get(url('/flow/forecast?days=30'))).body;
    const inSavings = f.accounts.find((a: any) => a.accountId === savings).items;
    expect(inSavings).toContainEqual(
      expect.objectContaining({ kind: 'mortgage', amount: `-${loan.totalPayment}`, date }),
    );
    const inChecking = f.accounts.find((a: any) => a.accountId === checking).items;
    expect(inChecking.filter((i: any) => i.sourceId === loan.id)).toEqual([]);

    // Recorded, it's off the calendar and forecast, and the next one takes its place.
    await c.post(url(`/loans/${loan.id}/payments`), { number: 1, accountId: savings, date: today });
    const later = (await c.get(url(`/calendar?from=${today}&to=${addDays(today, 10)}`))).body.items;
    expect(later.filter((i: any) => i.sourceId === loan.id)).toEqual([]);
  });

  it('stops when tracking stops, and picks recorded payments back up if it starts again', async () => {
    const loan = await mortgage({ name: 'Stopped', firstPaymentDate: addDays(today, 4) });
    await c.post(url(`/loans/${loan.id}/payments`), { number: 1, accountId: checking, date: today });
    const stopped = await c.patch(url(`/loans/${loan.id}`), {
      version: (await loanOf(loan.id)).version,
      archived: true,
    });
    expect(stopped.status).toBe(200);
    expect(await loanOf(loan.id)).toBeUndefined();
    expect((await accountOf(loan.loanAccountId)).loanId).toBeNull();
    const items = (await c.get(url(`/calendar?from=${today}&to=${addDays(today, 60)}`))).body.items;
    expect(items.filter((i: any) => i.sourceId === loan.id)).toEqual([]);
    // Its rate is the account's to change again.
    expect((await c.patch(url(`/accounts/${loan.loanAccountId}`), { interestRateBps: 650 })).status).toBe(
      200,
    );

    const again = await c.post(url('/loans'), {
      name: 'Stopped',
      loanAccountId: loan.loanAccountId,
      principal: '20000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: addDays(today, 4),
    });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: loan.id, paymentsMade: 1 });
    expect(again.body.next.number).toBe(2);
  });

  it('lists every loan without an entity, and those of one with', async () => {
    const all = (await c.get(url('/loans'))).body.data;
    expect(all.length).toBeGreaterThan(1);
    const personal = (await c.get(url(`/loans?entityId=${all[0].entityId}`))).body.data;
    expect(personal.length).toBe(all.length);
    const other = h.as('loans-other@example.com');
    const theirs = (
      await other.post('/v1/workspaces', { name: 'Theirs', baseCurrency: 'USD', template: 'household' })
    ).body;
    expect((await other.get(`/v1/workspaces/${theirs.id}/loans`)).body.data).toEqual([]);
    expect((await other.get(`/v1/workspaces/${theirs.id}/loans/${all[0].id}/schedule`)).status).toBe(404);
  });

  it('keeps the first of a month’s due date through short months', async () => {
    const first = startOfMonth(addDays(startOfMonth(today), 40));
    const loan = await mortgage({ name: 'Monthly', firstPaymentDate: first });
    const rows = await scheduleOf(loan.id);
    expect(rows[1].date).toBe(addMonths(first, 1));
  });
});
