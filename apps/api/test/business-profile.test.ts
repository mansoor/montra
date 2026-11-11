/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { PDFDocument, PDFName, type PDFDict } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, endOfMonth, startOfMonth, todayIn, type CalendarDate } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// A business's logo, domain and landing page (BIZ-01, BIZ-05, BIZ-10; ADR-0032).
const today = todayIn('UTC');
const thisMonth = startOfMonth(today);
const lastMonth = addMonths(thisMonth, -1);
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'biz-profile@example.test';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let url: (p: string) => string;
let biz: string;
let checking: string;
let savings: string;
let card: string;
let cat: (name: string) => string;

const upload = (email: string, path: string, bytes: Buffer, name: string, type: string) => {
  const boundary = '----montra-logo';
  return h.app.inject({
    method: 'POST',
    url: url(path),
    headers: {
      authorization: `Bearer dev:${email}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
};

const spend = (accountId: string, amount: string, category: string, date: string = today, payee = 'Shop') =>
  c.post(url('/transactions'), { date, accountId, amount: usd(amount), payee, categoryId: cat(category) });

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  partner = h.as('biz-profile-partner@example.test');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Books', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  biz = (
    await c.post(url('/entities'), { type: 'business', name: 'Rivera Studio', businessType: 'sole_prop' })
  ).body.id;
  const account = async (name: string, kind: string, opening: string) =>
    (
      await c.post(url('/accounts'), {
        name,
        kind,
        entityId: biz,
        openingBalance: usd(opening),
        openingDate: addMonths(thisMonth, -3),
      })
    ).body.id;
  checking = await account('Studio checking', 'checking', '100000');
  savings = await account('Studio savings', 'savings', '0');
  card = await account('Studio card', 'credit_card', '0');
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === biz).id;
  const invite = await c.post(url('/sharing/invites'), {
    email: 'biz-profile-partner@example.test',
    role: 'partner',
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('the domain', () => {
  it('keeps the host name of whatever was pasted', async () => {
    const res = await c.patch(url(`/businesses/${biz}`), { domain: 'https://www.Rivera.Studio/about?x=1' });
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe('www.rivera.studio');
    expect((await c.patch(url(`/businesses/${biz}`), { domain: 'hello@rivera.studio' })).body.domain).toBe(
      'rivera.studio',
    );
  });

  it('refuses what is not a domain, and clears with null', async () => {
    for (const domain of ['rivera', 'not a domain.com', 'rivera..studio', '-bad.com', 'rivera.123']) {
      const res = await c.patch(url(`/businesses/${biz}`), { domain });
      expect(res.status, domain).toBe(400);
    }
    expect((await c.patch(url(`/businesses/${biz}`), { domain: null })).body.domain).toBeNull();
    await c.patch(url(`/businesses/${biz}`), { domain: 'rivera.studio' });
  });
});

describe('the logo', () => {
  it('stores a PNG checked by its content, and serves it back', async () => {
    const res = await upload(EMAIL, `/businesses/${biz}/logo`, PNG, 'logo.png', 'image/png');
    expect(res.statusCode).toBe(200);
    const logo = JSON.parse(res.body);
    expect(logo).toMatchObject({ mediaType: 'image/png', width: 1, height: 1, bytes: PNG.length });
    expect((await c.get(url(`/businesses/${biz}`))).body.logoFileId).toBe(logo.fileId);
    const got = await h.app.inject({
      method: 'GET',
      url: url(`/businesses/${biz}/logo`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(got.rawPayload).equals(PNG)).toBe(true);
  });

  it('refuses anything else, whatever it is called', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await upload(EMAIL, `/businesses/${biz}/logo`, svg, 'logo.png', 'image/png');
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).code).toBe('logo.unsupported_type');
  });

  it('is private to whoever can read the business', async () => {
    const res = await upload(
      'biz-profile-partner@example.test',
      `/businesses/${biz}/logo`,
      PNG,
      'x.png',
      'image/png',
    );
    expect(res.statusCode).toBe(404);
    expect((await partner.get(url(`/businesses/${biz}/logo`))).status).toBe(404);
  });

  it('replaces the old file, and goes on the invoice PDF', async () => {
    const before = (await c.get(url(`/businesses/${biz}`))).body.logoFileId;
    await upload(EMAIL, `/businesses/${biz}/logo`, PNG, 'logo2.png', 'image/png');
    const after = (await c.get(url(`/businesses/${biz}`))).body.logoFileId;
    expect(after).not.toBe(before);
    const old = await admin.query('select deleted_at from app.file where id = $1', [before]);
    expect(old.rows[0].deleted_at).not.toBeNull();

    const party = (await c.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Bluebird Cafe' }))
      .body;
    const inv = (
      await c.post(url('/invoices'), {
        entityId: biz,
        partyId: party.id,
        issueDate: today,
        lines: [{ description: 'Design', quantity: '1', unitPrice: '10000' }],
      })
    ).body;
    const pdf = await h.app.inject({
      method: 'GET',
      url: url(`/invoices/${inv.id}/pdf`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(pdf.statusCode).toBe(200);
    const doc = await PDFDocument.load(pdf.rawPayload);
    const images = [...doc.context.enumerateIndirectObjects()].filter(
      ([, o]) =>
        'dict' in o && (o as { dict: PDFDict }).dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    );
    expect(images.length).toBeGreaterThan(0);
  });

  it('can be removed', async () => {
    expect((await c.delete(url(`/businesses/${biz}/logo`))).status).toBe(204);
    expect((await c.get(url(`/businesses/${biz}`))).body.logoFileId).toBeNull();
    expect((await c.get(url(`/businesses/${biz}/logo`))).status).toBe(404);
  });
});

describe('the landing page', () => {
  beforeAll(async () => {
    // Last month: card spending, then paying the card from checking (neither in nor out of the business).
    await spend(card, '-30000', 'Advertising', addDays(lastMonth, 4));
    await c.post(url('/transactions/transfer'), {
      date: addDays(lastMonth, 20),
      fromAccountId: checking,
      toAccountId: card,
      amount: usd('30000'),
    });
    // This month: income, and moving some to savings.
    await spend(checking, '120000', 'Other business income', thisMonth, 'Bluebird Cafe');
    await c.post(url('/transactions/transfer'), {
      date: thisMonth,
      fromAccountId: checking,
      toAccountId: savings,
      amount: usd('20000'),
    });
  });

  it('shows revenue and expenses exactly as the P&L, month by month', async () => {
    const d = (await c.get(url(`/businesses/${biz}/dashboard?months=3`))).body;
    expect(d).toMatchObject({ entityId: biz, currency: 'USD', months: 3, current: true });
    expect(d.monthly.map((m: any) => m.start)).toEqual([addMonths(thisMonth, -2), lastMonth, thisMonth]);
    for (const m of d.monthly) {
      const p = (await c.get(url(`/reports/pnl?entityId=${biz}&from=${m.start}&to=${m.end}`))).body;
      expect([m.revenue, m.expenses], m.start).toEqual([p.revenue, p.expenses]);
      expect(BigInt(m.profit)).toBe(BigInt(m.revenue) - BigInt(m.expenses));
    }
    expect(d.monthly[1]).toMatchObject({ revenue: '0', expenses: '30000', profit: '-30000' });
    expect(d.monthly[2]).toMatchObject({ revenue: '120000', expenses: '0' });
    expect(d.totals).toMatchObject({ revenue: '120000', expenses: '30000', profit: '90000' });
  });

  it('counts money through the business accounts, leaving out moves between them', async () => {
    const d = (await c.get(url(`/businesses/${biz}/dashboard?months=3`))).body;
    // The card purchase is money out when it's made; paying the card and topping up savings are neither.
    expect(d.monthly[1]).toMatchObject({ moneyIn: '0', moneyOut: '30000' });
    expect(d.monthly[2]).toMatchObject({ moneyIn: '120000', moneyOut: '0' });
    // Opening balances aren't money moving.
    expect(d.monthly[0]).toMatchObject({ moneyIn: '0', moneyOut: '0' });
    // Bank and cash at each month end: 1,000 opened, less 300 paid to the card, plus 1,200 in.
    expect(d.monthly.map((m: any) => m.cashOnHand)).toEqual(['100000', '70000', '190000']);
  });

  it('shows open invoices and bills as of today', async () => {
    await admin.query(`update app.invoice set status = 'void' where entity_id = $1`, [biz]);
    const party = (await c.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Late Payer' }))
      .body;
    const draft = (
      await c.post(url('/invoices'), {
        entityId: biz,
        partyId: party.id,
        issueDate: addDays(today, -40),
        dueDate: addDays(today, -10),
        lines: [{ description: 'Old work', quantity: '1', unitPrice: '25000' }],
      })
    ).body;
    await c.post(url(`/invoices/${draft.id}/send`), { version: draft.version, email: false });
    const vendor = (await c.post(url('/parties'), { entityId: biz, kind: 'vendor', name: 'Print Shop' }))
      .body;
    await c.post(url('/bills'), {
      entityId: biz,
      partyId: vendor.id,
      billDate: today,
      dueDate: addDays(today, 30),
      amount: '5000',
      expenseAccountId: cat('Advertising'),
    });
    const d = (await c.get(url(`/businesses/${biz}/dashboard`))).body;
    expect(d.openInvoices).toEqual({ count: 1, amount: '25000', overdueCount: 1, overdueAmount: '25000' });
    expect(d.openBills).toEqual({ count: 1, amount: '5000', overdueCount: 0, overdueAmount: '0' });
  });

  it('ends the period with a chosen month, and offers months back to the first activity', async () => {
    const d = (await c.get(url(`/businesses/${biz}/dashboard?months=6&month=${lastMonth}`))).body;
    expect(d.current).toBe(false);
    expect(d.month).toEqual({ start: lastMonth, end: endOfMonth(lastMonth) });
    expect(d.monthly).toHaveLength(6);
    expect(d.monthly.at(-1).start).toBe(lastMonth);
    expect(d.periods[0].start).toBe(thisMonth);
    expect(d.periods.at(-1).start).toBe(addMonths(thisMonth, -3) as CalendarDate);
    // A month in the future means this month.
    const future = (await c.get(url(`/businesses/${biz}/dashboard?month=${addMonths(thisMonth, 2)}`))).body;
    expect(future.month.start).toBe(thisMonth);
    expect((await c.get(url(`/businesses/${biz}/dashboard?months=5`))).status).toBe(400);
    expect((await c.get(url(`/businesses/${biz}/dashboard?month=${addDays(thisMonth, 3)}`))).status).toBe(
      400,
    );
  });

  it('is only for a business the login can read', async () => {
    expect((await partner.get(url(`/businesses/${biz}/dashboard`))).status).toBe(404);
  });
});
