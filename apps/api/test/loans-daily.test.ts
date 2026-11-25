/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  dailyInterest,
  interestDays,
  loanPaymentDate,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import { RentalJobs } from '../src/rentals/rental-jobs.service.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Daily simple interest, the lender's own split, editable dates, and grace periods and late fees (ADR-0024 §13, §14).
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
const scheduleOf = async (id: string) => (await c.get(url(`/loans/${id}/schedule`))).body.data;
const loanOf = async (id: string) => (await c.get(url('/loans'))).body.data.find((l: any) => l.id === id);
const totalOf = (t: any) => t.splits.reduce((s: bigint, x: any) => s + BigInt(x.amount), 0n) as bigint;
const pay = (id: string, body: object) => c.post(url(`/loans/${id}/payments`), body);
const line = async (date: CalendarDate, amount: bigint | string) =>
  (
    await c.post(url('/transactions'), {
      date,
      accountId: checking,
      amount: usd(`-${amount}`),
      payee: 'AUTO LENDER',
      categoryId: cat('Utilities'),
    })
  ).body.id as string;

// $15,000 at 7.56% over 60 months at $301, financed 60 days ago, the first payment due 29 days later (a real auto loan).
const start = addDays(today, -60);
const first = addDays(start, 29);

/** An auto loan charging daily simple interest. */
const autoLoan = async (overrides: object = {}) => {
  const res = await c.post(url('/loans'), {
    name: 'Auto loan',
    newAccount: { kind: 'loan' },
    interestMethod: 'daily',
    startDate: start,
    principal: '1500000',
    rateBps: 756,
    termMonths: 60,
    firstPaymentDate: first,
    paymentAmount: '30100',
    payingAccountId: checking,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
};

beforeAll(async () => {
  h = await startHarness();
  c = h.as('loans-daily@example.test');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Daily loans', baseCurrency: 'USD', template: 'household' })
  ).body;
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

describe('daily simple interest', () => {
  it('runs the first payment from the start date to its due date', async () => {
    const loan = await autoLoan();
    expect(loan).toMatchObject({ interestMethod: 'daily', startDate: start, payment: '30100' });
    // 29 days: $90.10.
    expect(loan.next).toMatchObject({
      number: 1,
      date: first,
      interest: '9010',
      principal: '21090',
      accruesFrom: start,
    });
  });

  it('charges interest to the day it’s paid, and goes on from there', async () => {
    const loan = await autoLoan({ name: 'Paid a day late' });
    const paidOn = addDays(start, 30);
    const res = await pay(loan.id, { number: 1, accountId: checking, date: paidOn });
    expect(res.status).toBe(201);
    // 30 days: $93.21, and the level payment's rest is principal.
    const [one] = await scheduleOf(loan.id);
    expect(one).toMatchObject({ number: 1, date: paidOn, interest: '9321', principal: '20779' });
    const left = 1500000n - 20779n;
    expect(await owed(loan.loanAccountId)).toBe(String(left));
    // The next runs from the day this one was paid, on what's really owed.
    const due2 = loanPaymentDate(first, 2);
    expect(res.body.next).toMatchObject({
      number: 2,
      date: due2,
      interest: String(dailyInterest(left, 756, interestDays(paidOn, due2))),
    });
    const t = (await c.get(url(`/transactions/${one.transactionId}`))).body;
    expect(totalOf(t)).toBe(-30100n);
  });

  it('needs a start date on or before the first payment', async () => {
    const base = {
      name: 'No start',
      newAccount: { kind: 'loan' },
      interestMethod: 'daily',
      principal: '100000',
      rateBps: 500,
      termMonths: 12,
      firstPaymentDate: first,
    };
    expect((await c.post(url('/loans'), base)).status).toBe(400);
    const late = await c.post(url('/loans'), { ...base, startDate: addDays(first, 1) });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('loan.start_date');
  });

  it('leaves a loan made without a method monthly', async () => {
    const res = await c.post(url('/loans'), {
      name: 'Old client',
      newAccount: { kind: 'loan' },
      principal: '1500000',
      rateBps: 756,
      termMonths: 60,
      firstPaymentDate: addDays(today, 5),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      interestMethod: 'monthly',
      graceDays: 0,
      lateFee: null,
      lateFeeBps: null,
    });
    // 15,000 × 7.56% ÷ 12.
    expect(res.body.next.interest).toBe('9450');
  });
});

describe('the lender’s split', () => {
  it('posts and keeps the lender’s figures when recording a payment', async () => {
    const loan = await autoLoan({ name: 'Lender split' });
    const res = await pay(loan.id, {
      number: 1,
      accountId: checking,
      date: addDays(start, 30),
      interest: '9320',
      principal: '20780',
    });
    expect(res.status).toBe(201);
    expect(res.body.interestPaid).toBe('9320');
    const [one] = await scheduleOf(loan.id);
    expect(one).toMatchObject({ interest: '9320', principal: '20780' });
    expect(await owed(loan.loanAccountId)).toBe(String(1500000n - 20780n));
    const t = (await c.get(url(`/transactions/${one.transactionId}`))).body;
    expect(totalOf(t)).toBe(-30100n);
  });

  it('takes a statement line split the lender’s way, when it adds up', async () => {
    const loan = await autoLoan({ name: 'Line split' });
    const id = await line(addDays(start, 30), '30100');
    const wrong = await pay(loan.id, { number: 1, transactionId: id, interest: '9320', principal: '20000' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('loan.split');
    const tooMuch = await pay(loan.id, {
      number: 1,
      transactionId: id,
      interest: '0',
      principal: '1600000',
    });
    expect(tooMuch.body.code).toBe('loan.split');
    const half = await pay(loan.id, { number: 1, transactionId: id, interest: '9320' });
    expect(half.status).toBe(400);
    const ok = await pay(loan.id, { number: 1, transactionId: id, interest: '9320', principal: '20780' });
    expect(ok.status).toBe(201);
    const [one] = await scheduleOf(loan.id);
    expect(one).toMatchObject({ interest: '9320', principal: '20780', transactionId: id });
  });

  it('works out a daily loan’s line to the line’s own date without one', async () => {
    const loan = await autoLoan({ name: 'Line daily' });
    const id = await line(addDays(start, 30), '30100');
    expect((await pay(loan.id, { number: 1, transactionId: id })).status).toBe(201);
    const [one] = await scheduleOf(loan.id);
    expect(one).toMatchObject({ interest: '9321', principal: '20779' });
  });
});

describe('editing the dates and method', () => {
  it('switches a loan to daily from the next payment, keeping what was recorded', async () => {
    const res = await c.post(url('/loans'), {
      name: 'Switched',
      newAccount: { kind: 'loan' },
      principal: '1500000',
      rateBps: 756,
      termMonths: 60,
      firstPaymentDate: first,
      paymentAmount: '30100',
    });
    const loan = res.body;
    await pay(loan.id, { number: 1, accountId: checking, date: first });
    const [monthly] = await scheduleOf(loan.id);
    expect(monthly.interest).toBe('9450');
    const v = (await loanOf(loan.id)).version;
    const noStart = await c.patch(url(`/loans/${loan.id}`), { version: v, interestMethod: 'daily' });
    expect(noStart.status).toBe(422);
    expect(noStart.body.code).toBe('loan.start_date');
    const ok = await c.patch(url(`/loans/${loan.id}`), {
      version: v,
      interestMethod: 'daily',
      startDate: start,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ interestMethod: 'daily', startDate: start });
    const due2 = loanPaymentDate(first, 2);
    const left = 1500000n - (30100n - 9450n);
    expect(ok.body.next.interest).toBe(String(dailyInterest(left, 756, interestDays(first, due2))));
    // Payment 1 keeps what it was charged.
    expect((await scheduleOf(loan.id))[0]).toMatchObject({ interest: '9450', principal: '20650' });
    // The first payment's date is fixed once one is recorded.
    const moved = await c.patch(url(`/loans/${loan.id}`), {
      version: ok.body.version,
      firstPaymentDate: addDays(first, 1),
    });
    expect(moved.status).toBe(422);
    expect(moved.body.code).toBe('loan.first_payment_locked');
  });

  it('moves the first payment while nothing is recorded', async () => {
    const loan = await autoLoan({ name: 'Moved' });
    const later = addDays(first, 1);
    const res = await c.patch(url(`/loans/${loan.id}`), { version: loan.version, firstPaymentDate: later });
    expect(res.status).toBe(200);
    // 30 days now.
    expect(res.body.next).toMatchObject({ date: later, interest: '9321' });
  });
});

describe('grace periods and late fees', () => {
  it('keeps the terms and says what the next payment’s fee would be', async () => {
    const loan = await autoLoan({ name: 'Fees', graceDays: 10, lateFee: '1500', lateFeeBps: 500 });
    expect(loan).toMatchObject({ graceDays: 10, lateFee: '1500', lateFeeBps: 500 });
    // The greater of $15.00 and 5% of $301.00. The first payment was due 31 days ago.
    expect(loan.next).toMatchObject({ lateFee: '1505', late: true });
    const edited = await c.patch(url(`/loans/${loan.id}`), {
      version: loan.version,
      graceDays: 40,
      lateFee: null,
      lateFeeBps: null,
    });
    expect(edited.body).toMatchObject({ graceDays: 40, lateFee: null, lateFeeBps: null });
    expect(edited.body.next).toMatchObject({ lateFee: '0', late: false });
  });

  it('takes a late line for the payment and its fee, the fee to Bank fees', async () => {
    const loan = await autoLoan({ name: 'Late line', graceDays: 10, lateFee: '1500', lateFeeBps: 500 });
    const paidOn = addDays(first, 15);
    const id = await line(paidOn, 30100n + 1505n);
    const res = await pay(loan.id, { number: 1, transactionId: id });
    expect(res.status).toBe(201);
    const [one] = await scheduleOf(loan.id);
    const interest = dailyInterest(1500000n, 756, interestDays(start, paidOn));
    expect(one).toMatchObject({
      lateFee: '1505',
      interest: String(interest),
      principal: String(30100n - interest),
    });
    const t = (await c.get(url(`/transactions/${id}`))).body;
    const fee = t.splits.find((s: any) => s.amount === '-1505');
    expect(fee).toBeDefined();
    expect(fee.accountId).not.toBe(loan.loanAccountId);
    expect(t.splits.filter((s: any) => s.accountId === fee.accountId)).toHaveLength(1);
    expect(await owed(loan.loanAccountId)).toBe(String(1500000n - 30100n + interest));
  });

  it('adds a fee entered when recording to the payment', async () => {
    const loan = await autoLoan({ name: 'Late entered', graceDays: 10, lateFee: '2500' });
    const res = await pay(loan.id, {
      number: 1,
      accountId: checking,
      date: addDays(first, 12),
      lateFee: '2500',
    });
    expect(res.status).toBe(201);
    const [one] = await scheduleOf(loan.id);
    expect(one.lateFee).toBe('2500');
    const t = (await c.get(url(`/transactions/${one.transactionId}`))).body;
    expect(totalOf(t)).toBe(-32600n);
  });

  it('matches a bank line up to the grace period after the due date', async () => {
    const due = addDays(today, -8);
    const make = async (name: string, principal: string, graceDays: number) =>
      (
        await c.post(url('/loans'), {
          name,
          newAccount: { kind: 'loan' },
          principal,
          rateBps: 0,
          termMonths: 10,
          firstPaymentDate: due,
          payingAccountId: checking,
          graceDays,
        })
      ).body;
    const graced = await make('Graced', '1000010', 10);
    const strict = await make('Strict', '1000020', 0);
    await line(today, graced.next.total);
    await line(today, strict.next.total);
    expect(await h.app.get(RentalJobs).matchPayments(ctx())).toBe(1);
    expect((await loanOf(graced.id)).paymentsMade).toBe(1);
    expect((await loanOf(strict.id)).paymentsMade).toBe(0);
  });
});
