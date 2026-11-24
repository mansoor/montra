/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { FxRatesService } from '../src/fx/fx.service.js';
import { ADMIN_URL } from './env.js';
import { fixtureHttp } from './fx-fixtures.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The translation adjustment on net worth (ADR-0010 §7). Fixture rates, dollars per euro: 1.0875 (Oct 28),
// 1.0897 (Oct 29), 1.0912 (Oct 30).
let h: Harness;
let c: Client;
let admin: pg.Client;
let url: (p: string) => string;
let wsId: string;
let euroBooksAccount: string;
let personalEuroAccount: string;

beforeAll(async () => {
  h = await startHarness();
  c = h.as('translation@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await new FxRatesService(
    h.app.get(Db),
    { ...h.app.get(CONFIG), OXR_APP_ID: undefined },
    fixtureHttp().get,
  ).refresh('daily');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Two currencies', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  await c.post(url('/accounts'), {
    name: 'Checking',
    kind: 'checking',
    openingBalance: { amount: '50000', currency: 'USD' },
    openingDate: '2026-10-28',
  });
  // CUR-06's case, in the USD books: €1,000.00 carried at $1,087.50 is $1,091.20 on Oct 30, $3.70 unrealized.
  personalEuroAccount = (
    await c.post(url('/accounts'), {
      name: 'Euro savings',
      kind: 'savings',
      currency: 'EUR',
      openingBalance: { amount: '100000', currency: 'EUR' },
      openingDate: '2026-10-28',
    })
  ).body.id;
  // Books kept in EUR: €1,000.00 on Oct 28 ($1,087.50 then), €200.00 earned on Oct 29 ($217.94 then).
  const books = await c.post(url('/entities'), {
    type: 'business',
    name: 'Paris studio',
    functionalCurrency: 'EUR',
  });
  expect(books.status).toBe(201);
  euroBooksAccount = (
    await c.post(url('/accounts'), {
      entityId: books.body.id,
      name: 'Studio account',
      kind: 'checking',
      openingBalance: { amount: '100000', currency: 'EUR' },
      openingDate: '2026-10-28',
    })
  ).body.id;
  const cats = (await c.get(url(`/categories?entityId=${books.body.id}`))).body.data;
  const income = await c.post(url('/transactions'), {
    date: '2026-10-29',
    accountId: euroBooksAccount,
    amount: { amount: '20000', currency: 'EUR' },
    payee: 'Client',
    categoryId: cats.find((x: any) => x.type === 'income').id,
  });
  expect(income.status).toBe(201);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('translation adjustment on net worth (ADR-0010 §7)', () => {
  it('is the closing-rate net assets less what they were worth on the days they came in', async () => {
    const res = await c.get(url('/net-worth?date=2026-10-30&months=1'));
    expect(res.status).toBe(200);
    const n = res.body;
    // €1,200.00 at 1.0912 is $1,309.44; at their own days' rates they were $1,087.50 + $217.94 = $1,305.44.
    const books = n.accounts.find((a: any) => a.accountId === euroBooksAccount);
    expect(books).toMatchObject({ value: '130944', translationAdjustment: '400', unrealizedFx: null });
    expect(n.translationAdjustment).toBe('400');
    expect(n.trend.at(-1)).toMatchObject({ date: '2026-10-30', translationAdjustment: '400' });
    expect(n.trend[0]).toMatchObject({ date: '2026-09-30', translationAdjustment: '0' });
    // Oct 28, before the rate moved: nothing.
    const first = (await c.get(url('/net-worth?date=2026-10-28&months=1'))).body;
    expect(first.translationAdjustment).toBe('0');
  });

  it("doesn't double-count with unrealized FX", async () => {
    const n = (await c.get(url('/net-worth?date=2026-10-30&months=1'))).body;
    const personal = n.accounts.find((a: any) => a.accountId === personalEuroAccount);
    // The USD books' euro account has unrealized FX and no translation; the EUR books' account the other way round.
    expect(personal).toMatchObject({ value: '109120', unrealizedFx: '370', translationAdjustment: null });
    expect(n.unrealizedFx).toBe('370');
    expect(n.translationAdjustment).toBe('400');
    // Net worth less everything at the rates it was booked at is exactly the two, each counted once.
    const booked = 50000n + 108750n + (108750n + 21794n);
    expect(BigInt(n.netWorth) - booked).toBe(370n + 400n);
  });

  it('adds a translation adjustment column and note to the net worth report, and to its export', async () => {
    const r = (await c.get(url('/reports/catalog/net-worth?from=2026-10-01&to=2026-10-30'))).body;
    expect(r.columns.map((col: any) => col.key)).toEqual([
      'date',
      'assets',
      'liabilities',
      'net_worth',
      'unrealized_fx',
      'translation_adjustment',
    ]);
    expect(r.rows.at(-1).cells).toMatchObject({
      date: '2026-10-30',
      unrealized_fx: '370',
      translation_adjustment: '400',
    });
    expect(r.notes).toEqual(['unrealized_fx', 'translation_adjustment']);
    const csv = await h.app.inject({
      method: 'GET',
      url: url('/reports/catalog/net-worth/export?format=csv&from=2026-10-01&to=2026-10-30'),
      headers: { authorization: 'Bearer dev:translation@example.com' },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\r\n')[0]).toBe(
      'Date,Assets,Liabilities,Net worth,Unrealized FX,Translation adjustment',
    );
    expect(csv.body).toContain(',3.70,4.00');
  });

  it('books nothing', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from app.journal_entry where workspace_id = $1 and kind = 'fx_revaluation'`,
      [wsId],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('leaves it out when every set of books is in the base currency', async () => {
    const other = h.as('one-currency@example.com');
    const ws = (
      await other.post('/v1/workspaces', { name: 'Home', baseCurrency: 'USD', template: 'household' })
    ).body;
    // A foreign account in USD books still gets unrealized FX, but no translation.
    await other.post(`/v1/workspaces/${ws.id}/accounts`, {
      name: 'Euro savings',
      kind: 'savings',
      currency: 'EUR',
      openingBalance: { amount: '100000', currency: 'EUR' },
      openingDate: '2026-10-28',
    });
    const n = (await other.get(`/v1/workspaces/${ws.id}/net-worth?date=2026-10-30`)).body;
    expect(n.translationAdjustment).toBe('0');
    expect(n.accounts[0]).toMatchObject({ unrealizedFx: '370', translationAdjustment: null });
    const r = (await other.get(`/v1/workspaces/${ws.id}/reports/catalog/net-worth?to=2026-10-30`)).body;
    expect(r.columns.map((col: any) => col.key)).toContain('unrealized_fx');
    expect(r.columns.map((col: any) => col.key)).not.toContain('translation_adjustment');
    expect(r.notes).not.toContain('translation_adjustment');
  });
});
