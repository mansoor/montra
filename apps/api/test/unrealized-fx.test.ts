/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { FxRatesService } from '../src/fx/fx.service.js';
import { ADMIN_URL } from './env.js';
import { fixtureHttp } from './fx-fixtures.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Unrealized FX gain or loss on net worth (CUR-06; ADR-0010 §6). Fixture rates: EUR→USD 1.0875 (Oct 28), 1.0912 (Oct 30).
let h: Harness;
let c: Client;
let admin: pg.Client;
let url: (p: string) => string;
let wsId: string;
let eurAccount: string;
let usdChecking: string;

beforeAll(async () => {
  h = await startHarness();
  c = h.as('unrealized-fx@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await new FxRatesService(
    h.app.get(Db),
    { ...h.app.get(CONFIG), OXR_APP_ID: undefined },
    fixtureHttp().get,
  ).refresh('daily');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Holdings', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  usdChecking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: { amount: '50000', currency: 'USD' },
      openingDate: '2026-10-28',
    })
  ).body.id;
  // €1,000.00 booked at 1.0875: carried at $1,087.50.
  eurAccount = (
    await c.post(url('/accounts'), {
      name: 'Euro account',
      kind: 'checking',
      currency: 'EUR',
      openingBalance: { amount: '100000', currency: 'EUR' },
      openingDate: '2026-10-28',
    })
  ).body.id;
  // €100.00 spent on Oct 30 leaves at carrying value ($108.75); its $0.37 realized gain is booked, not unrealized.
  const spend = await c.post(url('/transactions'), {
    date: '2026-10-30',
    accountId: eurAccount,
    amount: { amount: '-10000', currency: 'EUR' },
    payee: 'Monoprix',
    categoryId: cats.find((x: any) => x.name === 'Groceries').id,
  });
  expect(spend.status).toBe(201);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('unrealized FX on net worth (CUR-06)', () => {
  it('revalues the foreign balance and shows the gain against its carrying value', async () => {
    const res = await c.get(url('/net-worth?date=2026-10-30&months=1'));
    expect(res.status).toBe(200);
    const n = res.body;
    // €900.00 carried at $978.75 (1,087.50 − 108.75) is worth $982.08 at 1.0912: a $3.33 gain.
    const eur = n.accounts.find((a: any) => a.accountId === eurAccount);
    expect(eur).toMatchObject({
      balance: '90000',
      accountCurrency: 'EUR',
      value: '98208',
      unrealizedFx: '333',
    });
    expect(n.accounts.find((a: any) => a.accountId === usdChecking).unrealizedFx).toBeNull();
    expect(n.unrealizedFx).toBe('333');
    expect(n.netWorth).toBe(String(50000n + 98208n));
    expect(n.trend.at(-1)).toMatchObject({ date: '2026-10-30', unrealizedFx: '333' });
    expect(n.trend[0]).toMatchObject({ date: '2026-09-30', unrealizedFx: '0' });
  });

  it('uses each date’s rate: at Oct 28 the balance is still at its booked value', async () => {
    const n = (await c.get(url('/net-worth?date=2026-10-28&months=1'))).body;
    expect(n.unrealizedFx).toBe('0');
    expect(n.accounts.find((a: any) => a.accountId === eurAccount).unrealizedFx).toBe('0');
  });

  it('adds an unrealized FX column and note to the net worth report', async () => {
    const res = await c.get(url('/reports/catalog/net-worth?from=2026-10-01&to=2026-10-30'));
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.columns.map((col: any) => col.key)).toEqual([
      'date',
      'assets',
      'liabilities',
      'net_worth',
      'unrealized_fx',
    ]);
    expect(r.rows.at(-1).cells).toMatchObject({
      date: '2026-10-30',
      net_worth: '148208',
      unrealized_fx: '333',
    });
    expect(r.notes).toContain('unrealized_fx');
    const csv = await h.app.inject({
      method: 'GET',
      url: url('/reports/catalog/net-worth/export?format=csv&from=2026-10-01&to=2026-10-30'),
      headers: { authorization: 'Bearer dev:unrealized-fx@example.com' },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\r\n')[0]).toBe('Date,Assets,Liabilities,Net worth,Unrealized FX');
    expect(csv.body).toContain(',3.33');
  });

  it('books nothing: no revaluation entry, and only the realized gain in fx_gain_loss', async () => {
    const { rows } = await admin.query<{ kind: string; n: string }>(
      `select kind, count(*)::text as n from app.journal_entry where workspace_id = $1 group by kind`,
      [wsId],
    );
    expect(rows.find((r) => r.kind === 'fx_revaluation')).toBeUndefined();
    const fx = await admin.query<{ v: string }>(
      `select coalesce(sum(p.functional_amount_minor), 0)::text as v
         from app.posting p join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
        where p.workspace_id = $1 and a.system_role = 'fx_gain_loss'`,
      [wsId],
    );
    expect(fx.rows[0]!.v).toBe('-37');
  });

  it('leaves the column out when every account is in its books’ currency', async () => {
    const other = h.as('home-only@example.com');
    const ws = (
      await other.post('/v1/workspaces', { name: 'Home', baseCurrency: 'USD', template: 'household' })
    ).body;
    await other.post(`/v1/workspaces/${ws.id}/accounts`, { name: 'Checking', kind: 'checking' });
    const r = (await other.get(`/v1/workspaces/${ws.id}/reports/catalog/net-worth?to=2026-10-30`)).body;
    expect(r.columns.map((col: any) => col.key)).not.toContain('unrealized_fx');
    expect(r.notes).not.toContain('unrealized_fx');
    const n = (await other.get(`/v1/workspaces/${ws.id}/net-worth?date=2026-10-30`)).body;
    expect(n.unrealizedFx).toBe('0');
    expect(n.accounts[0].unrealizedFx).toBeNull();
  });
});
