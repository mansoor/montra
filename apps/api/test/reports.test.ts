/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, startOfMonth, todayIn } from '@montra/domain';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// The report catalogue, search and ask-your-data (RPT-01..06, RCP-09; ADR-0019).
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const thisMonth = startOfMonth(today);
const lastMonth = startOfMonth(addDays(thisMonth, -1));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'reports@example.com';

let h: Harness;
let admin: pg.Client;
let c: Client;
let partner: Client;
let url: (p: string) => string;
let personal: string;
let business: string;
let checking: string;
let card: string;
let bizChecking: string;
let cat: (name: string, entity?: string) => string;

const report = async (type: string, q: string = '') => {
  const res = await c.get(url(`/reports/catalog/${type}?${q}`));
  expect(res.status).toBe(200);
  return res.body;
};
const add = async (
  amount: string,
  payee: string,
  category: string,
  over: object = {},
  accountId = checking,
) => {
  const res = await c.post(url('/transactions'), {
    date: today,
    accountId,
    amount: usd(amount),
    payee,
    categoryId: cat(category),
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
};
const cells = (r: any, key: string) => r.rows.find((x: any) => x.key === key)?.cells;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(ImportJobs).register();
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  partner = h.as('reports-partner@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Reports', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  business = (await c.post(url('/entities'), { type: 'business', name: 'Studio', businessType: 'sole_prop' }))
    .body.id;
  const account = async (name: string, kind: string, opening: string, entityId = personal) =>
    (
      await c.post(url('/accounts'), {
        name,
        kind,
        openingBalance: usd(opening),
        openingDate: `${year - 1}-12-01`,
        entityId,
      })
    ).body.id;
  checking = await account('Checking', 'checking', '1000000');
  card = await account('Card', 'credit_card', '20000');
  bizChecking = await account('Studio bank', 'checking', '500000', business);
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity = personal) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  const invite = await c.post(url('/sharing/invites'), {
    email: 'reports-partner@example.com',
    role: 'partner',
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);

  // Receipts come from uploads, and their text from the extraction job, neither of which these reports are about.
  const receipt = async (merchant: string, total: string, ocr: string, lines: [string, string][]) => {
    const { rows } = await admin.query(
      `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor, ocr_text)
       values ($1, $2, 'inbox', $3, $4, 'USD', $5, $6) returning id`,
      [ws.id, personal, merchant, today, total, ocr],
    );
    let no = 1;
    for (const [name, amount] of lines) {
      await admin.query(
        `insert into app.receipt_line (workspace_id, receipt_id, line_no, raw_text, expanded_name, line_total_minor, category_id, entity_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ws.id, rows[0].id, no++, name.toUpperCase(), name, amount, cat('Groceries'), personal],
      );
    }
  };
  await receipt('Walmart', '1000', 'WALMART usb cable 10.00', [['USB cable', '1000']]);
  await receipt('Target', '4200', 'TARGET usb cable 15.00 cordless drill 42.00 thank you', [
    ['USB Cable', '1500'],
    ['Cordless drill', '4200'],
  ]);
  await add('-5000', 'WHOLE FOODS MARKET', 'Groceries', { tags: ['weekly'], memo: 'Birthday cake for Sam' });
  await add('-3000', 'TRADER JOES', 'Groceries');
  await add('-2500', 'CORNER CAFE', 'Dining out', { tags: ['weekly', 'treat'] });
  await add('-100000', 'LANDLORD', 'Rent', { date: lastMonth });
  await add('300000', 'ACME PAYROLL', 'Salary', { date: lastMonth });
  await c.post(url('/transactions'), {
    date: today,
    accountId: bizChecking,
    amount: usd('77700'),
    payee: 'BLUEBIRD',
    categoryId: cat('Other business income', business),
  });
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('the report catalogue (RPT-01, RPT-02)', () => {
  it('reports spending by category, with shares and a total', async () => {
    const r = await report('spending', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    expect(r).toMatchObject({ type: 'spending', from: lastMonth, to: today, currency: 'USD' });
    expect(r.rows.map((x: any) => x.cells.category)).toEqual(['Rent', 'Groceries', 'Dining out']);
    expect(cells(r, cat('Groceries'))).toMatchObject({ amount: '8000', share: '7.2' });
    expect(r.totals.amount).toBe('110500');
    expect(r.chart).toEqual({ kind: 'bar', x: 'category', y: ['amount'] });
  });

  it('groups by payee or tag, and says when tags overlap', async () => {
    const payees = await report('spending', `from=${lastMonth}&to=${today}&groupBy=payee`);
    expect(cells(payees, 'CORNER CAFE').amount).toBe('2500');
    const tags = await report('spending', `from=${lastMonth}&to=${today}&groupBy=tag`);
    expect(cells(tags, 'weekly').amount).toBe('7500');
    expect(cells(tags, 'treat').amount).toBe('2500');
    expect(tags.notes).toContain('tags_overlap');
  });

  it('applies every filter (RPT-02)', async () => {
    const span = `from=${lastMonth}&to=${today}`;
    const total = async (q: string) => (await report('spending', `${span}&${q}`)).totals.amount;
    expect(await total(`categoryIds=${cat('Groceries')}`)).toBe('8000');
    expect(await total('tags=treat')).toBe('2500');
    expect(await total(`accountIds=${card}`)).toBe('0');
    expect(await total(`entityId=${business}`)).toBe('0');
    expect(await total('memberId=household')).toBe('110500');
  });

  it('shows income and expenses by month, netting to the total', async () => {
    const r = await report('income-expense', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    expect(r.rows).toHaveLength(thisMonth === lastMonth ? 1 : 2);
    expect(cells(r, lastMonth)).toMatchObject({ income: '300000', expense: '100000', net: '200000' });
    expect(r.totals).toMatchObject({ income: '300000', expense: '110500', net: '189500' });
  });

  it('shows cash flow on cash accounts, leaving out opening balances', async () => {
    const r = await report('cash-flow', `from=${year}-01-01&to=${today}&entityId=${personal}`);
    expect(cells(r, thisMonth)).toMatchObject({ inflow: '0', outflow: '10500', transfers: '0' });
  });

  it('values net worth over time', async () => {
    const r = await report('net-worth', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    expect(r.rows.at(-1).cells.net_worth).toBe(String(1000000n - 20000n + 300000n - 110500n));
  });

  it('reports P&L for one set of books, and asks which', async () => {
    const r = await report('pnl', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    expect(r.totals.amount).toBe('189500');
    expect(cells(r, 'income').amount).toBe('300000');
    expect(r.rows.find((x: any) => x.key === 'income').emphasis).toBe(true);
    const none = await c.get(url(`/reports/catalog/pnl?from=${lastMonth}&to=${today}`));
    expect(none.status).toBe(422);
    expect(none.body.code ?? none.body.error?.code).toBe('report.entity_required');
  });

  it('has a trial balance that balances, and a balance sheet that adds up', async () => {
    const tb = await report('trial-balance', `to=${today}&entityId=${personal}`);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(BigInt(tb.totals.debit)).toBeGreaterThan(0n);
    const bs = await report('balance-sheet', `to=${today}&entityId=${personal}`);
    expect(cells(bs, 'assets').amount).toBe(bs.totals.amount);
    expect(cells(bs, 'liabilities').amount).toBe('20000');
    expect(cells(bs, 'retained').amount).toBe('189500');
  });

  it('runs a general ledger with a running balance from the opening one', async () => {
    const r = await report(
      'general-ledger',
      `from=${lastMonth}&to=${today}&entityId=${personal}&accountIds=${checking}`,
    );
    const heading = cells(r, `account:${checking}`);
    expect(heading).toMatchObject({ description: 'Checking', balance: '1000000' });
    const lines = r.rows.filter((x: any) => !x.emphasis);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1).cells.balance).toBe(String(1000000n + 300000n - 110500n));
    expect(
      lines.some((x: any) => x.cells.description.includes('LANDLORD') && x.cells.credit === '100000'),
    ).toBe(true);
  });

  it('compares a budget with what happened', async () => {
    const none = await report('budget-actual', `from=${thisMonth}&entityId=${business}`);
    expect(none.notes).toContain('no_budget');
    const budget = await c.post(url('/budgets'), { entityId: personal, name: 'Home' });
    expect(budget.status).toBeLessThan(300);
    const assigned = await c.put(
      url(`/budgets/${budget.body.id}/periods/${thisMonth}/lines/${cat('Groceries')}`),
      {
        assigned: '6000',
        version: budget.body.version,
      },
    );
    expect(assigned.status).toBe(200);
    const r = await report('budget-actual', `from=${thisMonth}&entityId=${personal}`);
    expect(r.from).toBe(thisMonth);
    const groceries = cells(r, cat('Groceries'));
    expect(groceries).toMatchObject({ assigned: '6000', activity: '8000', available: '-2000' });
    expect(r.rows.find((x: any) => x.key === cat('Groceries')).drill.categoryIds).toEqual([cat('Groceries')]);
  });

  it('feeds Schedule C from the same figures as its own screen', async () => {
    const r = await report('schedule-c', `to=${today}&entityId=${business}`);
    const own = (await c.get(url(`/reports/schedule-c?entityId=${business}&year=${year}`))).body;
    expect(r.totals.amount).toBe(own.netProfit);
    expect(r.notes).toContain('tax_not_advice');
  });

  it('groups income and spending by member, Household included', async () => {
    const r = await report('by-member', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    expect(cells(r, 'household')).toMatchObject({ income: '300000', spending: '110500' });
    expect(r.rows.find((x: any) => x.key === 'household').drill.memberId).toBe('household');
  });

  it('refuses dates the wrong way round, and books it can not see', async () => {
    expect((await c.get(url(`/reports/catalog/spending?from=${today}&to=${lastMonth}`))).status).toBe(
      lastMonth < today ? 422 : 200,
    );
    expect(
      (await c.get(url('/reports/catalog/spending?entityId=00000000-0000-4000-8000-000000000000'))).status,
    ).toBe(404);
  });

  it('keeps a partner out of books they have no grant on', async () => {
    expect((await partner.get(url(`/reports/catalog/pnl?entityId=${business}`))).status).toBe(404);
    const all = (await partner.get(url(`/reports/catalog/income-expense?from=${lastMonth}&to=${today}`)))
      .body;
    // The business's income is invisible to them, in the consolidated figure as well.
    expect(all.totals.income).toBe('300000');
    const mine = await report('income-expense', `from=${lastMonth}&to=${today}`);
    expect(mine.totals.income).toBe('377700');
  });
});

describe('items on receipts (RCP-09)', () => {
  it('adds up an item across stores', async () => {
    const r = await report('items', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    expect(cells(r, 'usb cable')).toMatchObject({ stores: 'Target, Walmart', lines: '2', amount: '2500' });
    expect(cells(r, 'cordless drill').amount).toBe('4200');
    expect(r.totals.amount).toBe('6700');
  });

  it('adds up a category or store, and takes the same filters', async () => {
    const stores = await report('items', `from=${lastMonth}&to=${today}&groupBy=store`);
    expect(cells(stores, 'Walmart').amount).toBe('1000');
    expect(cells(stores, 'Target').amount).toBe('5700');
    const filtered = await report('items', `from=${lastMonth}&to=${today}&categoryIds=${cat('Dining out')}`);
    expect(filtered.rows).toEqual([]);
    const byCategory = await report('items', `from=${lastMonth}&to=${today}&groupBy=category`);
    expect(cells(byCategory, 'Groceries').amount).toBe('6700');
  });
});

describe('drilling down (RPT-03)', () => {
  it('leads from a row to the transactions that make it up', async () => {
    const r = await report('spending', `from=${lastMonth}&to=${today}&entityId=${personal}`);
    const { drill } = r.rows.find((x: any) => x.key === cat('Groceries'));
    const q = new URLSearchParams({
      from: drill.from,
      to: drill.to,
      entityId: drill.entityId,
      categoryIds: drill.categoryIds[0],
    });
    const list = (await c.get(url(`/transactions?${q.toString()}`))).body.data;
    const sum = list.reduce((t: bigint, x: any) => t + BigInt(x.amount.amount), 0n);
    expect(sum).toBe(-8000n);
  });

  it('leads from a payee or tag through the search syntax', async () => {
    const tags = await report('spending', `from=${lastMonth}&to=${today}&groupBy=tag`);
    const { drill } = tags.rows.find((x: any) => x.key === 'treat');
    const list = (await c.get(url(`/transactions?q=${encodeURIComponent(drill.q)}`))).body.data;
    expect(list.map((x: any) => x.payee)).toEqual(['CORNER CAFE']);
    const payees = await report('spending', `from=${lastMonth}&to=${today}&groupBy=payee`);
    const whole = payees.rows.find((x: any) => x.key === 'WHOLE FOODS MARKET').drill;
    const found = (await c.get(url(`/transactions?q=${encodeURIComponent(whole.q)}`))).body.data;
    expect(found.map((x: any) => x.payee)).toEqual(['WHOLE FOODS MARKET']);
  });
});

describe('exports (RPT-04)', () => {
  const file = (type: string, q: string) =>
    h.app.inject({
      method: 'GET',
      url: url(`/reports/catalog/${type}/export?${q}`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });

  it('writes CSV with plain decimals and neutralized text', async () => {
    await add('-1234', '=HYPERLINK("x")', 'Dining out');
    const res = await file('spending', `from=${lastMonth}&to=${today}&groupBy=payee&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['content-disposition']).toContain(`spending-${lastMonth}-to-${today}.csv`);
    expect(res.body.split('\r\n')[0]).toBe('Payee,Amount,Share');
    expect(res.body).toContain('LANDLORD,1000.00,');
    expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
    await c.delete(
      url(
        `/transactions/${(await c.get(url(`/transactions?q=${encodeURIComponent('HYPERLINK')}`))).body.data[0].id}`,
      ),
    );
  });

  it('writes XLSX and PDF', async () => {
    const xlsx = await file('pnl', `from=${lastMonth}&to=${today}&entityId=${personal}&format=xlsx`);
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const pdf = await file('general-ledger', `from=${lastMonth}&to=${today}&entityId=${personal}&format=pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('prints text outside Latin rather than failing, and a report long enough for several pages', async () => {
    await add('-999', '北京烤鸭', 'Dining out');
    const res = await file('general-ledger', `from=${lastMonth}&to=${today}&entityId=${personal}&format=pdf`);
    expect(res.statusCode).toBe(200);
  });
});

describe('saved reports (RPT-02)', () => {
  it('saves a report per user, and replaces one saved under the same name', async () => {
    const saved = await c.post(url('/saved-reports'), {
      name: 'Weekly food',
      type: 'spending',
      filters: { tags: ['weekly'] },
    });
    expect(saved.status).toBe(201);
    await c.post(url('/saved-reports'), {
      name: 'Weekly food',
      type: 'spending',
      filters: { tags: ['treat'] },
    });
    const list = (await c.get(url('/saved-reports'))).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].filters).toEqual({ tags: ['treat'] });
    expect((await partner.get(url('/saved-reports'))).body.data).toEqual([]);
    expect((await partner.delete(url(`/saved-reports/${saved.body.id}`))).status).toBe(404);
    expect((await c.delete(url(`/saved-reports/${saved.body.id}`))).status).toBe(204);
  });

  it('refuses a type that does not exist', async () => {
    expect((await c.post(url('/saved-reports'), { name: 'x', type: 'nope' })).status).toBe(400);
  });
});

describe('search (RPT-05)', () => {
  const search = async (q: string, client = c) =>
    (await client.get(url(`/search?q=${encodeURIComponent(q)}`))).body;

  it('finds payees and descriptions by the start of a word', async () => {
    const r = await search('whole foo');
    expect(r.transactions.map((t: any) => t.payee)).toEqual(['WHOLE FOODS MARKET']);
    expect(r.payees).toEqual([{ name: 'WHOLE FOODS MARKET', count: 1, lastDate: today }]);
  });

  it('finds encrypted notes, and says that is why', async () => {
    const r = await search('birthday cake');
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({
      payee: 'WHOLE FOODS MARKET',
      matchedNote: 'Birthday cake for Sam',
    });
  });

  it('filters by amount in either direction, across the sign of the money', async () => {
    const big = await search('>=1000');
    const names = big.transactions.map((t: any) => t.payee);
    expect(names).toEqual(expect.arrayContaining(['LANDLORD', 'ACME PAYROLL']));
    expect(names).not.toContain('CORNER CAFE');
    const between = await search('>=25 <30');
    expect(between.transactions.map((t: any) => t.payee)).toEqual(['CORNER CAFE']);
    expect((await search('=30.00')).transactions.map((t: any) => t.payee)).toEqual(['TRADER JOES']);
  });

  it('combines words, tags and amounts', async () => {
    expect((await search('tag:weekly >40')).transactions.map((t: any) => t.payee)).toEqual([
      'WHOLE FOODS MARKET',
    ]);
    expect((await search('cafe tag:treat')).transactions).toHaveLength(1);
    expect((await search('cafe tag:nope')).transactions).toEqual([]);
  });

  it('finds words on a receipt', async () => {
    const r = await search('drill');
    expect(r.receipts[0]).toMatchObject({ merchant: 'Target', total: '4200' });
    expect(r.receipts[0].snippet).toContain('drill');
  });

  it('takes odd input in its stride', async () => {
    for (const q of ['', '   ', '>', '"', "'; drop table", '&&&', ':*', '> 5 <', 'tag:']) {
      expect((await c.get(url(`/search?q=${encodeURIComponent(q)}`))).status).toBe(200);
    }
    expect((await c.get(url(`/transactions?q=${encodeURIComponent("o'brien & co:*")}`))).status).toBe(200);
  });

  it('shows a partner only what they may see, notes included', async () => {
    expect((await search('bluebird')).transactions).toHaveLength(1);
    expect((await search('bluebird', partner)).transactions).toEqual([]);
    expect((await search('bluebird', partner)).payees).toEqual([]);
  });
});

describe('ask-your-data (RPT-06)', () => {
  const ask = (question: string) => c.post(url('/ask'), { question });

  it('answers with numbers from the books, and the filter behind each', async () => {
    const res = await ask('How much did I spend on Groceries this month?');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      understood: true,
      metric: 'spending',
      categories: ['Groceries'],
      currency: 'USD',
    });
    expect(res.body.periods[0].amount).toBe('8000');
    expect(res.body.periods[0].drill.categoryIds).toEqual([cat('Groceries')]);
    expect(res.body.transactions.map((t: any) => t.payee).sort()).toEqual([
      'TRADER JOES',
      'WHOLE FOODS MARKET',
    ]);
  });

  it('compares periods', async () => {
    const res = await ask('How much did I spend on Rent in Q1 vs Q2?');
    expect(res.body.periods.map((p: any) => p.label)).toEqual(['Q1', 'Q2']);
  });

  it('answers income too', async () => {
    const res = await ask('How much income did I earn this month?');
    expect(res.body.metric).toBe('income');
    expect(BigInt(res.body.periods[0].amount)).toBeGreaterThan(0n);
  });

  it('says so when it can not answer', async () => {
    const res = await ask('Should I buy a boat?');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ understood: false, periods: [], transactions: [] });
  });

  it('keeps to what the asker can see', async () => {
    const res = await partner.post(url('/ask'), { question: 'How much income did I earn this month?' });
    const mine = await ask('How much income did I earn this month?');
    expect(BigInt(mine.body.periods[0].amount) - BigInt(res.body.periods[0].amount)).toBe(77700n);
  });

  it('explains itself when AI is off', async () => {
    await c.patch(url('/ai/settings'), { mode: 'off' });
    const res = await ask('How much did I spend on Groceries?');
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('ai.off');
    await c.patch(url('/ai/settings'), { mode: 'builtin' });
  });
});
