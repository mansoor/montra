/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Interest rates to a ten-thousandth of a percent (migration 0096, ADR-0024 "Rate precision"): ppm in and out, whole basis
// points still accepted from older clients and still written for older code.
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });

let h: Harness;
let c: Client;
let admin: pg.Client;
let url: (p: string) => string;
let personal: string;
let checking: string;

const accountOf = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id);
const loanOf = async (id: string) => (await c.get(url('/loans'))).body.data.find((l: any) => l.id === id);

/** A $941,000 mortgage over 30 years, with the rate given as the test says. */
const mortgage = async (name: string, rate: object) => {
  const res = await c.post(url('/loans'), {
    name,
    newAccount: { kind: 'mortgage' },
    principal: '94100000',
    termMonths: 360,
    firstPaymentDate: addDays(today, 3),
    balanceAsOf: today,
    payingAccountId: checking,
    ...rate,
  });
  return res;
};

const columns = async (loanId: string) =>
  (await admin.query(`select rate_bps, rate_ppm from app.loan_schedule where id = $1`, [loanId])).rows[0];
const accountColumns = async (accountId: string) =>
  (
    await admin.query(
      `select interest_rate_bps, interest_rate_ppm from app.bank_account where ledger_account_id = $1`,
      [accountId],
    )
  ).rows[0];

beforeAll(async () => {
  h = await startHarness();
  c = h.as('rates@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Rates', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities[0].id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Everyday',
      kind: 'checking',
      openingBalance: usd('5000000'),
      openingDate: addDays(today, -400),
    })
  ).body.id;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('a loan’s rate', () => {
  it('takes 5.625% exactly, and keeps writing it rounded to basis points', async () => {
    const res = await mortgage('Eighths', { ratePpm: 56_250 });
    expect(res.status).toBe(201);
    const loan = res.body;
    expect(loan).toMatchObject({ ratePpm: 56_250, rateBps: 563 });
    // P·r·(1+r)^n / ((1+r)^n − 1) with r = 3/640 a month, half up.
    const num = 94_100_000n * 3n * 643n ** 360n;
    const den = 640n * (643n ** 360n - 640n ** 360n);
    expect(loan.payment).toBe(String((2n * num + den) / (2n * den)));
    // The first month's interest: 941,000 × 5.625% ÷ 12 = 4,410.9375.
    expect(loan.next.interest).toBe('441094');
    expect(await columns(loan.id)).toEqual({ rate_bps: 563, rate_ppm: 56_250 });
    // Debt payoff reads the account's copy, in both units.
    expect((await accountOf(loan.loanAccountId)).planning).toMatchObject({
      interestRatePpm: 56_250,
      interestRateBps: 563,
    });
    expect(await accountColumns(loan.loanAccountId)).toEqual({
      interest_rate_bps: 563,
      interest_rate_ppm: 56_250,
    });
  });

  it('still takes whole basis points from an older client, and prefers ppm when both come', async () => {
    const old = await mortgage('Old phone', { rateBps: 600 });
    expect(old.status).toBe(201);
    expect(old.body).toMatchObject({ rateBps: 600, ratePpm: 60_000 });
    const both = await mortgage('Both', { rateBps: 600, ratePpm: 64_375 });
    expect(both.body).toMatchObject({ ratePpm: 64_375, rateBps: 644 });
    const none = await mortgage('None', {});
    expect(none.status).toBe(400);
    expect(none.body.errors).toContainEqual({ path: 'ratePpm', message: 'Enter the interest rate' });
    expect((await mortgage('Too high', { ratePpm: 500_001 })).status).toBe(400);
  });

  it('changes by ppm or by bps, re-levelling the payment either way', async () => {
    const loan = (await mortgage('ARM', { ratePpm: 60_000 })).body;
    const v2 = await c.patch(url(`/loans/${loan.id}`), { version: loan.version, ratePpm: 64_375 });
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ ratePpm: 64_375, rateBps: 644 });
    expect(BigInt(v2.body.payment)).toBeGreaterThan(BigInt(loan.payment));
    expect(await columns(loan.id)).toEqual({ rate_bps: 644, rate_ppm: 64_375 });
    // An older client's whole-bp rate.
    const v3 = await c.patch(url(`/loans/${loan.id}`), { version: v2.body.version, rateBps: 650 });
    expect(v3.body).toMatchObject({ ratePpm: 65_000, rateBps: 650 });
    expect((await accountOf(loan.loanAccountId)).planning.interestRatePpm).toBe(65_000);
  });

  it('follows an older API task that writes only basis points', async () => {
    const loan = (await mortgage('Old task', { ratePpm: 56_250 })).body;
    // Re-saving the same bps leaves the finer rate alone.
    await admin.query(`update app.loan_schedule set rate_bps = 563 where id = $1`, [loan.id]);
    expect((await columns(loan.id)).rate_ppm).toBe(56_250);
    // A new bps rate is taken as it is.
    await admin.query(`update app.loan_schedule set rate_bps = 700 where id = $1`, [loan.id]);
    expect(await columns(loan.id)).toEqual({ rate_bps: 700, rate_ppm: 70_000 });
    expect((await loanOf(loan.id)).ratePpm).toBe(70_000);
    // A row written with no ppm at all reads as bps × 100.
    await admin.query(`alter table app.loan_schedule disable trigger loan_schedule_rate_ppm`);
    try {
      await admin.query(`update app.loan_schedule set rate_ppm = null, rate_bps = 525 where id = $1`, [
        loan.id,
      ]);
    } finally {
      await admin.query(`alter table app.loan_schedule enable trigger loan_schedule_rate_ppm`);
    }
    expect(await loanOf(loan.id)).toMatchObject({ ratePpm: 52_500, rateBps: 525 });
  });
});

describe('an account’s rate', () => {
  it('takes four decimals, returns both units, and clears', async () => {
    const res = await c.post(url('/accounts'), {
      name: 'Store card',
      kind: 'credit_card',
      interestRatePpm: 249_875,
    });
    expect(res.status).toBe(201);
    expect((await accountOf(res.body.id)).planning).toMatchObject({
      interestRatePpm: 249_875,
      interestRateBps: 2499,
    });
    expect(await accountColumns(res.body.id)).toEqual({
      interest_rate_bps: 2499,
      interest_rate_ppm: 249_875,
    });

    // An older client sends basis points; ppm wins when both come.
    expect((await c.patch(url(`/accounts/${res.body.id}`), { interestRateBps: 1999 })).status).toBe(200);
    expect((await accountOf(res.body.id)).planning).toMatchObject({
      interestRatePpm: 199_900,
      interestRateBps: 1999,
    });
    await c.patch(url(`/accounts/${res.body.id}`), { interestRateBps: 1999, interestRatePpm: 199_875 });
    expect((await accountOf(res.body.id)).planning.interestRatePpm).toBe(199_875);
    // Changing something else leaves the rate.
    await c.patch(url(`/accounts/${res.body.id}`), { name: 'Store card 2' });
    expect((await accountOf(res.body.id)).planning.interestRatePpm).toBe(199_875);

    await c.patch(url(`/accounts/${res.body.id}`), { interestRatePpm: null });
    expect((await accountOf(res.body.id)).planning).toMatchObject({
      interestRatePpm: null,
      interestRateBps: null,
    });
    expect(
      (await c.post(url('/accounts'), { name: 'X', kind: 'credit_card', interestRatePpm: 1_000_001 })).status,
    ).toBe(400);
  });

  it('pays off a debt at its exact rate', async () => {
    const card = (
      await c.post(url('/accounts'), {
        name: 'Eighths card',
        kind: 'credit_card',
        openingBalance: usd('100000'),
        openingDate: addDays(today, -10),
        interestRatePpm: 56_250,
        minPayment: '200000',
      })
    ).body.id;
    const res = await c.post(url('/goals'), {
      entityId: personal,
      name: 'Pay the card',
      type: 'debt_payoff',
      strategy: 'avalanche',
      target: '100000',
      linkedAccountIds: [card],
    });
    expect(res.status).toBe(201);
    // $1,000 at 5.625% for a month: $4.6875, half up, then paid off by the $2,000 minimum.
    expect(res.body.payoff.debts).toEqual([
      expect.objectContaining({ accountId: card, ratePpm: 56_250, rateBps: 563, interest: '469' }),
    ]);
  });
});
