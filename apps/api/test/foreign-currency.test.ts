/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { FxRatesService } from '../src/fx/fx.service.js';
import { ADMIN_URL } from './env.js';
import { fixtureHttp } from './fx-fixtures.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Foreign-currency accounts and foreign spending (ACC-04, CUR-03, CUR-05, CUR-07, CUR-08; ADR-0010).
// Fixture rates: EUR→USD 1.0875 (Oct 28), 1.0897 (Oct 29), 1.0912 (Oct 30).
const usd = (amount: string) => ({ amount, currency: 'USD' });
const eur = (amount: string) => ({ amount, currency: 'EUR' });

let h: Harness;
let c: Client;
let admin: pg.Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let eurAccount: string;
let usdChecking: string;
let usdCard: string;

/** The account's balance in its own currency and in the functional currency (USD). */
const carrying = async (accountId: string) => {
  const { rows } = await admin.query<{ foreign: string; functional: string }>(
    `select coalesce(sum(amount_minor), 0)::text as foreign, coalesce(sum(functional_amount_minor), 0)::text as functional
       from app.posting where ledger_account_id = $1`,
    [accountId],
  );
  return { foreign: rows[0]!.foreign, functional: rows[0]!.functional };
};
/** Functional (USD) amounts of a transaction's lines in minor units, by category name or system role. */
const lines = async (transactionId: string) => {
  const { rows } = await admin.query<{ k: string; v: string }>(
    `select coalesce(a.system_role, a.name) as k, sum(p.functional_amount_minor)::text as v
       from app.posting p
       join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
       join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
      where je.transaction_id = $1
      group by 1`,
    [transactionId],
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
};

beforeAll(async () => {
  h = await startHarness();
  c = h.as('abroad@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await new FxRatesService(
    h.app.get(Db),
    { ...h.app.get(CONFIG), OXR_APP_ID: undefined },
    fixtureHttp().get,
  ).refresh('daily');
  const ws = (await c.post('/v1/workspaces', { name: 'Abroad', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  usdChecking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
  usdCard = (await c.post(url('/accounts'), { name: 'Card', kind: 'credit_card', last4: '4242' })).body.id;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('a EUR account in a USD household (ACC-04, CUR-07)', () => {
  let spendId: string;

  it('opens at the opening date’s reference rate', async () => {
    const res = await c.post(url('/accounts'), {
      name: 'Euro account',
      kind: 'checking',
      currency: 'EUR',
      openingBalance: eur('100000'),
      openingDate: '2026-10-28',
    });
    expect(res.status).toBe(201);
    eurAccount = res.body.id;
    expect(res.body.balance).toEqual(eur('100000'));
    expect(await carrying(eurAccount)).toEqual({ foreign: '100000', functional: '108750' }); // × 1.0875
  });

  it('spends at carrying value and books the realized FX gain', async () => {
    const res = await c.post(url('/transactions'), {
      date: '2026-10-30',
      accountId: eurAccount,
      amount: eur('-10000'),
      payee: 'Monoprix',
      categoryId: cat('Groceries'),
    });
    expect(res.status).toBe(201);
    spendId = res.body.id;
    // €100 cost $108.75 when bought and is worth $109.12 today: a $0.37 gain.
    expect(await lines(res.body.id)).toEqual({
      'Euro account': '-10875',
      Groceries: '10912',
      fx_gain_loss: '-37',
    });
    expect(res.body.foreign).toEqual({
      original: eur('-10000'),
      rate: '1.0912',
      rateSource: 'reference',
      fee: null,
    });
  });

  it('takes a rate override and re-posts, then goes back to the reference rate (CUR-05)', async () => {
    const overridden = await c.patch(url(`/transactions/${spendId}`), { fxRate: '1.10' });
    expect(overridden.status).toBe(200);
    expect(await lines(overridden.body.id)).toEqual({
      'Euro account': '-10875',
      Groceries: '11000',
      fx_gain_loss: '-125',
    });
    expect(overridden.body.foreign).toMatchObject({ rate: '1.1', rateSource: 'user' });

    const cleared = await c.patch(url(`/transactions/${spendId}`), { fxRate: null });
    expect(await lines(cleared.body.id)).toMatchObject({ Groceries: '10912', fx_gain_loss: '-37' });
    expect(cleared.body.foreign).toMatchObject({ rate: '1.0912', rateSource: 'reference' });
  });

  it('asks for a rate when none is published, and accepts one', async () => {
    const body = {
      date: '2026-12-15',
      accountId: eurAccount,
      amount: eur('-500'),
      categoryId: cat('Groceries'),
    };
    const missing = await c.post(url('/transactions'), body);
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('fx.no_rate');
    const given = await c.post(url('/transactions'), { ...body, fxRate: '1.05' });
    expect(given.status).toBe(201);
    expect(given.body.foreign).toMatchObject({ rate: '1.05', rateSource: 'user' });
    await c.delete(url(`/transactions/${given.body.id}`));
  });

  it('rejects a rate on a home-currency account', async () => {
    const res = await c.post(url('/transactions'), {
      date: '2026-10-30',
      accountId: usdChecking,
      amount: usd('-1000'),
      categoryId: cat('Groceries'),
      fxRate: '1.2',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('fx.not_foreign');
  });
});

describe('transfers between currencies (CUR-08)', () => {
  it('needs the amount that arrived', async () => {
    const res = await c.post(url('/transactions/transfer'), {
      date: '2026-10-30',
      fromAccountId: usdChecking,
      toAccountId: eurAccount,
      amount: usd('110000'),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('fx.amount_in_required');
  });

  it('buys EUR at the rate the two amounts imply', async () => {
    const res = await c.post(url('/transactions/transfer'), {
      date: '2026-10-30',
      fromAccountId: usdChecking,
      toAccountId: eurAccount,
      amount: usd('110000'),
      amountIn: eur('100000'),
    });
    expect(res.status).toBe(201);
    expect(await lines(res.body.id)).toEqual({ 'Euro account': '110000', Checking: '-110000' });
    expect(await carrying(eurAccount)).toEqual({ foreign: '190000', functional: '207875' });
  });

  it('sells EUR back at carrying value and books the gain', async () => {
    // €200 carried at 207,875 × 200 / 1,900 = $218.82 sells for $230.00.
    const res = await c.post(url('/transactions/transfer'), {
      date: '2026-10-30',
      fromAccountId: eurAccount,
      toAccountId: usdChecking,
      amount: eur('20000'),
      amountIn: usd('23000'),
    });
    expect(res.status).toBe(201);
    expect(await lines(res.body.id)).toEqual({
      Checking: '23000',
      'Euro account': '-21882',
      fx_gain_loss: '-1118',
    });
  });

  it('empties the account to exactly $0', async () => {
    const res = await c.post(url('/transactions'), {
      date: '2026-10-30',
      accountId: eurAccount,
      amount: eur('-170000'),
      categoryId: cat('Groceries'),
    });
    expect(res.status).toBe(201);
    expect(await carrying(eurAccount)).toEqual({ foreign: '0', functional: '0' });
  });

  it('adjusts a foreign balance at the day’s rate', async () => {
    const res = await c.post(url(`/accounts/${eurAccount}/balance-adjustments`), {
      date: '2026-10-30',
      balance: eur('5000'),
      note: 'Cash count',
    });
    expect(res.status).toBe(201);
    expect(await carrying(eurAccount)).toEqual({ foreign: '5000', functional: '5456' }); // × 1.0912
  });
});

describe('spending abroad on a home-currency card (CUR-03)', () => {
  it('stores the four values and posts the fee to Bank fees', async () => {
    // Receipt €40.00; statement $44.91 including a $1.31 foreign transaction fee.
    const res = await c.post(url('/transactions'), {
      date: '2026-10-30',
      accountId: usdCard,
      amount: usd('-4491'),
      payee: 'Le Petit Bistro',
      categoryId: cat('Dining out'),
      foreign: { original: eur('4000'), fee: usd('131') },
    });
    expect(res.status).toBe(201);
    expect(await lines(res.body.id)).toEqual({ Card: '-4491', 'Dining out': '4360', bank_fees: '131' });
    expect(res.body.foreign).toEqual({
      original: eur('-4000'),
      rate: '1.09',
      rateSource: 'implied',
      fee: usd('131'),
    });
  });

  it('keeps a rate the user entered', async () => {
    const res = await c.post(url('/transactions'), {
      date: '2026-10-30',
      accountId: usdCard,
      amount: usd('-2200'),
      categoryId: cat('Dining out'),
      foreign: { original: eur('2000'), rate: '1.0950' },
    });
    expect(res.body.foreign).toEqual({
      original: eur('-2000'),
      rate: '1.095',
      rateSource: 'user',
      fee: null,
    });
  });

  it('rejects a foreign amount in the account currency and fees on money in', async () => {
    const base = { date: '2026-10-30', accountId: usdCard, categoryId: cat('Dining out') };
    const same = await c.post(url('/transactions'), {
      ...base,
      amount: usd('-1000'),
      foreign: { original: usd('1000') },
    });
    expect(same.body.code).toBe('fx.same_currency');
    const refundFee = await c.post(url('/transactions'), {
      ...base,
      amount: usd('1000'),
      foreign: { original: eur('900'), fee: usd('30') },
    });
    expect(refundFee.body.code).toBe('fx.invalid_fee');
  });

  it('rejects a CUR-03 foreign amount on a foreign-currency account', async () => {
    const res = await c.post(url('/transactions'), {
      date: '2026-10-30',
      accountId: eurAccount,
      amount: eur('-1000'),
      categoryId: cat('Groceries'),
      foreign: { original: usd('1100') },
    });
    expect(res.body.code).toBe('fx.foreign_on_foreign_account');
  });
});
