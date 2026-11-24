/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';
import { PREFILTER } from '../src/common/list-filters.js';

// The web lists' filters (Transactions, Review, Receipts): a date window, merchant words, an amount range compared
// without the sign, and money in or out. Each narrows what the others leave.
let h: Harness;
let c: Client;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
const usd = (amount: string) => ({ amount, currency: 'USD' });

const payees = (r: any): string[] => r.body.data.map((t: any) => t.payee || t.description).sort();
const list = async (query: string) => {
  const r = await c.get(url(`/transactions?limit=200&${query}`));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return payees(r);
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as('list-filters@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Filters', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
  const savings = (await c.post(url('/accounts'), { name: 'Savings', kind: 'savings' })).body.id;
  const add = async (date: string, amount: string, payee: string) => {
    const r = await c.post(url('/transactions'), { date, accountId: checking, amount: usd(amount), payee });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  await add('2026-11-01', '-450', 'Blue Bottle Coffee');
  await add('2026-10-15', '-4500', 'Fresh Mart');
  await add('2026-06-01', '-15000', 'Fresh Mart');
  await add('2026-11-10', '5000', 'Acme Payroll');
  await add('2026-11-05', '2500', 'Fresh Mart refund');
  const transfer = await c.post(url('/transactions/transfer'), {
    date: '2026-11-02',
    fromAccountId: checking,
    toAccountId: savings,
    amount: usd('3000'),
    description: 'To savings',
  });
  expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('transactions', () => {
  it('compares the amount without its sign: spending and income both fall in "20 to 50"', async () => {
    expect(await list('amountMin=2000&amountMax=5000')).toEqual([
      'Acme Payroll',
      'Fresh Mart',
      'Fresh Mart refund',
      'To savings',
    ]);
    expect(await list('amountMin=10000')).toEqual(['Fresh Mart']);
    expect(await list('amountMax=450')).toEqual(['Blue Bottle Coffee']);
  });

  it('narrows to money out or money in; a transfer is neither', async () => {
    expect(await list('amountMin=2000&amountMax=5000&direction=out')).toEqual(['Fresh Mart']);
    expect(await list('direction=in')).toEqual(['Acme Payroll', 'Fresh Mart refund']);
    expect(await list('direction=out')).toEqual(['Blue Bottle Coffee', 'Fresh Mart', 'Fresh Mart']);
  });

  it('finds the start of words in the payee or description', async () => {
    expect(await list('merchant=fresh')).toEqual(['Fresh Mart', 'Fresh Mart', 'Fresh Mart refund']);
    expect(await list('merchant=bottle%20cof')).toEqual(['Blue Bottle Coffee']);
    expect(await list('merchant=savings')).toEqual(['To savings']);
    expect(await list('merchant=ottle')).toEqual([]);
  });

  it('combines the date window, merchant, amount and direction, each narrowing the rest', async () => {
    expect(await list('from=2026-10-01')).toHaveLength(5);
    expect(await list('from=2026-10-01&merchant=fresh')).toEqual(['Fresh Mart', 'Fresh Mart refund']);
    expect(await list('from=2026-10-01&merchant=fresh&amountMax=3000')).toEqual(['Fresh Mart refund']);
    expect(await list('from=2026-10-01&merchant=fresh&amountMax=3000&direction=out')).toEqual([]);
    expect(await list('from=2026-11-01&to=2026-11-05&amountMin=1000')).toEqual([
      'Fresh Mart refund',
      'To savings',
    ]);
  });

  it('keeps the search syntax working, alone and with the filters', async () => {
    expect(await list(`q=${encodeURIComponent('fresh >40')}`)).toEqual(['Fresh Mart', 'Fresh Mart']);
    expect(await list(`q=${encodeURIComponent('fresh >40')}&from=2026-10-01`)).toEqual(['Fresh Mart']);
  });

  it('refuses a signed or fractional amount bound', async () => {
    expect((await c.get(url('/transactions?amountMin=-5'))).status).toBe(400);
    expect((await c.get(url('/transactions?amountMax=12.5'))).status).toBe(400);
    expect((await c.get(url('/transactions?direction=sideways'))).status).toBe(400);
  });
});

describe('review queue', () => {
  beforeAll(async () => {
    await admin.query(
      `update app.transaction set review_state = 'needs_review'
        where workspace_id = $1 and spec->>'type' = 'standard'`,
      [wsId],
    );
  });
  const queue = async (query: string) => {
    const r = await c.get(url(`/review?${query}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { payees: r.body.items.map((i: any) => i.payee).sort(), total: r.body.total };
  };

  it('filters by date window, merchant, amount and direction, and counts what is left', async () => {
    expect((await queue('')).total).toBe(5);
    expect(await queue('from=2026-10-01')).toMatchObject({ total: 4 });
    expect(await queue('merchant=fresh&from=2026-10-01')).toEqual({
      payees: ['Fresh Mart', 'Fresh Mart refund'],
      total: 2,
    });
    expect(await queue('amountMin=2000&amountMax=5000')).toEqual({
      payees: ['Acme Payroll', 'Fresh Mart', 'Fresh Mart refund'],
      total: 3,
    });
    expect(await queue('amountMin=2000&amountMax=5000&direction=in&to=2026-11-06')).toEqual({
      payees: ['Fresh Mart refund'],
      total: 1,
    });
    expect((await c.get(url('/review?from=yesterday'))).status).toBe(400);
  });

  it('"accept all above" takes only what the filters show', async () => {
    const r = await c.post(url('/review/accept'), { minConfidence: 0, merchant: 'coffee' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Nothing was suggested for it, so it is skipped; the other four were never considered.
    expect(r.body.accepted + r.body.skipped).toBe(1);
    expect((await queue('')).total).toBe(5 - r.body.accepted);
  });
});

describe('receipts', () => {
  beforeAll(async () => {
    const entity = (
      await admin.query(`select id from app.entity where workspace_id = $1 order by created_at limit 1`, [
        wsId,
      ])
    ).rows[0].id;
    const insert = (
      merchant: string | null,
      date: string | null,
      currency: string | null,
      total: number | null,
    ) =>
      admin.query(
        `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor)
         values ($1, $2, 'inbox', $3, $4, $5, $6)`,
        [wsId, entity, merchant, date, currency, total],
      );
    await insert('Walmart Supercenter', '2026-11-01', 'USD', 2871);
    await insert('Target', '2026-08-01', 'USD', 12000);
    await insert('Café de Paris', '2026-11-03', 'EUR', 4000);
    await insert('Tokyo Mart', '2026-11-04', 'JPY', 3000);
    await insert('Walmart', '2026-11-06', 'USD', -1500); // a return
    await insert(null, null, null, null); // not read yet: it counts by the day it arrived
  });
  const receipts = async (query: string) => {
    const r = await c.get(url(`/receipts?limit=200&${query}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data.map((x: any) => x.merchant ?? '(unread)').sort();
  };

  it('matches the merchant anywhere in its name', async () => {
    expect(await receipts('merchant=walm')).toEqual(['Walmart', 'Walmart Supercenter']);
    expect(await receipts('merchant=mart')).toEqual(['Tokyo Mart', 'Walmart', 'Walmart Supercenter']);
    expect(await receipts('merchant=100%25')).toEqual([]);
  });

  it('takes a date window on the receipt date, or the arrival day for one without a date', async () => {
    expect(await receipts('from=2026-10-01&to=2026-11-03')).toEqual(['Café de Paris', 'Walmart Supercenter']);
    expect(await receipts('from=2026-10-01')).toContain('(unread)');
    expect(await receipts('to=2026-10-01')).toEqual(['Target']);
  });

  it('compares the total without its sign, by its face value in its own currency', async () => {
    expect(await receipts('amountMin=1500&amountMax=5000')).toEqual([
      'Café de Paris',
      'Walmart',
      'Walmart Supercenter',
    ]);
    // ¥3,000 is 3000.00 by face value, far above $50.
    expect(await receipts('amountMin=100000&amountMax=400000')).toEqual(['Tokyo Mart']);
  });

  it('combines merchant, dates, amount and the existing search', async () => {
    expect(await receipts('merchant=walmart&amountMin=2000')).toEqual(['Walmart Supercenter']);
    expect(await receipts('merchant=walmart&from=2026-11-05')).toEqual(['Walmart']);
    expect(await receipts('q=walmart&amountMax=2000&status=inbox')).toEqual(['Walmart']);
  });
});

describe('paging through a filtered list', () => {
  let page: (p: string) => string;
  /** The 250 that match, newest first, then by id: the order the list pages in. */
  let expected: string[];

  beforeAll(async () => {
    const ws = (
      await c.post('/v1/workspaces', { name: 'Paging', baseCurrency: 'USD', template: 'household' })
    ).body;
    page = (p) => `/v1/workspaces/${ws.id}${p}`;
    const account = (await c.post(page('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
    const entity = (
      await admin.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [ws.id])
    ).rows[0].id;
    // 25 days with 10 matching rows each, so most rows share their date with others, plus rows the filters leave out:
    // too small, money in, and another payee. Written straight to the table: 325 posts take minutes on a busy machine,
    // and the list reads only the transaction rows.
    const { rows: made } = await admin.query<{ id: string; date: string; match: boolean }>(
      `with spec (n, amount, payee, match) as (
         select n, -(1000 + n), 'Corner Grocer', true from generate_series(0, 9) n
         union all values (10, -100, 'Corner Grocer', false), (11, 2000, 'Corner Grocer refund', false),
                          (12, -3000, 'Fuel Stop', false)),
       rows as (
         select gen_random_uuid() as id, ('2026-09-01'::date + d) as date, s.*
           from generate_series(0, 24) d cross join spec s)
       insert into app.transaction (workspace_id, id, primary_entity_id, txn_date, description, payee_raw, status,
                                    review_state, source, posted_at, spec)
       select $1, r.id, $2, r.date, r.payee, r.payee, 'posted', 'reviewed', 'import', now(),
              jsonb_build_object('type', 'standard', 'accountId', $3::uuid, 'amount', r.amount::text,
                                 'currency', 'USD', 'description', r.payee, 'memberId', null,
                                 'uncategorized', true, 'splits', '[]'::jsonb)
         from rows r
       returning id, txn_date::text as date,
                 (payee_raw = 'Corner Grocer' and (spec ->> 'amount')::int <= -1000) as match`,
      [ws.id, entity, account],
    );
    expected = made
      .filter((m) => m.match)
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? 1 : -1))
      .map((m) => m.id);
    expect(expected).toHaveLength(250);
  }, 120_000);

  const FILTERS = 'merchant=corner%20grocer&amountMin=500&direction=out&from=2026-09-01&to=2026-09-30';
  const pageThrough = async (path: string, rows: (body: any) => string[]) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await c.get(
        page(`${path}?${FILTERS}&limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      seen.push(...rows(r.body));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    return { seen, pages };
  };
  const transactions = () => pageThrough('/transactions', (b) => b.data.map((t: any) => t.id));

  it('returns every matching row exactly once, in order, across pages', async () => {
    const { seen, pages } = await transactions();
    expect(pages).toBe(7);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
  });

  it('pages the same with too many candidates to look them up first, on every page or on some', async () => {
    const before = PREFILTER.max;
    try {
      // Never looked up first: every page reads the filters under RLS.
      PREFILTER.max = 10;
      expect((await transactions()).seen).toEqual(expected);
      // The first pages have too many candidates; later ones, ending on the cursor's day, few enough.
      PREFILTER.max = 100;
      expect((await transactions()).seen).toEqual(expected);
    } finally {
      PREFILTER.max = before;
    }
  });

  it('gives no cursor on the last page, and refuses a cursor it did not make', async () => {
    const one = await c.get(page('/transactions?merchant=fuel&limit=200'));
    expect(one.body.data).toHaveLength(25);
    expect(one.body.nextCursor).toBeNull();
    expect((await c.get(page(`/transactions?${FILTERS}&cursor=${'x'.repeat(10)}`))).status).toBe(400);
  });

  it('pages the review queue the same way, with the filtered total on every page', async () => {
    await admin.query(
      `update app.transaction set review_state = 'needs_review'
        where workspace_id = (select workspace_id from app.transaction where id = $1)`,
      [expected[0]],
    );
    const { seen } = await pageThrough('/review', (b) => {
      expect(b.total).toBe(250);
      return b.items.map((i: any) => i.transactionId);
    });
    expect(seen).toEqual(expected);
  });
});
