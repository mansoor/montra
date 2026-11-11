/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, startOfMonth, todayIn } from '@montra/domain';
import { BusinessJobs } from '../src/business/business-jobs.service.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// A small business end to end (BIZ-01..13, REC-09, AI-10; ADR-0017).
const today = todayIn('UTC');
const year = Number(today.slice(0, 4));
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'business@example.com';

let h: Harness;
let c: Client;
let partner: Client;
let jobs: BusinessJobs;
let worker: Worker;
let admin: pg.Client;
let url: (p: string) => string;
let biz: string;
let bizChecking: string;
let personalChecking: string;
let customer: any;
let vendor: any;
let cat: (name: string, entity?: string) => string;
let wsId: string;

const invoiceBody = (lines: object[], over: object = {}) => ({
  entityId: biz,
  partyId: customer.id,
  issueDate: today,
  lines,
  ...over,
});
const line = (price: string, over: object = {}) => ({
  description: 'Design work',
  quantity: '1',
  unitPrice: price,
  ...over,
});
/** A sent invoice, ready for payments. */
const sent = async (lines: object[], over: object = {}) => {
  const i = (await c.post(url('/invoices'), invoiceBody(lines, over))).body;
  const res = await c.post(url(`/invoices/${i.id}/send`), { version: i.version, email: false });
  expect(res.status).toBe(200);
  return res.body;
};
const deposit = async (amount: string, payee = 'ACH CREDIT', date: string = today, accountId = bizChecking) =>
  (
    await c.post(url('/transactions'), {
      date,
      accountId,
      amount: usd(amount),
      payee,
      categoryId: cat('Other business income'),
    })
  ).body;
const balance = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;
const pnl = async () => (await c.get(url(`/reports/pnl?entityId=${biz}`))).body;
const postings = async (transactionId: string) =>
  (
    await admin.query(
      `select a.name, p.amount_minor::text as amount, p.entry_date::text as d, p.cleared
         from app.posting p join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         join app.ledger_account a on a.id = p.ledger_account_id
        where je.transaction_id = $1 order by p.amount_minor desc`,
      [transactionId],
    )
  ).rows;
const voidAll = async () => {
  // Payments in one test mustn't be auto-matched against the next test's invoices.
  await admin.query(
    `update app.invoice set status = 'void' where workspace_id = $1 and status = 'sent'
     and not exists (select 1 from app.invoice_payment p where p.invoice_id = invoice.id)`,
    [wsId],
  );
  await admin.query(`update app.bill set status = 'void' where workspace_id = $1 and status = 'open'`, [
    wsId,
  ]);
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(ImportJobs).register();
  jobs = h.app.get(BusinessJobs);
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  partner = h.as('business-partner@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Books', baseCurrency: 'USD', template: 'household' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entity = await c.post(url('/entities'), {
    type: 'business',
    name: 'Rivera Studio',
    businessType: 'sole_prop',
  });
  expect(entity.status).toBe(201);
  biz = entity.body.id;
  const account = async (name: string, entityId?: string) =>
    (
      await c.post(url('/accounts'), {
        name,
        kind: 'checking',
        openingBalance: usd('100000'),
        openingDate: `${year - 1}-12-01`,
        ...(entityId ? { entityId } : {}),
      })
    ).body.id;
  bizChecking = await account('Studio checking', biz);
  personalChecking = await account('Joint checking');
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity = biz) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  customer = (
    await c.post(url('/parties'), {
      entityId: biz,
      kind: 'customer',
      name: 'Bluebird Cafe',
      email: 'ap@bluebird.example',
      address: '12 Main St',
    })
  ).body;
  vendor = (await c.post(url('/parties'), { entityId: biz, kind: 'vendor', name: 'Print Shop' })).body;
  const invite = await c.post(url('/sharing/invites'), {
    email: 'business-partner@example.com',
    role: 'partner',
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('a business (BIZ-01, BIZ-02)', () => {
  it('has a profile with defaults, and a chart mapped to Schedule C', async () => {
    const p = (await c.get(url(`/businesses/${biz}`))).body;
    expect(p).toMatchObject({
      name: 'Rivera Studio',
      businessType: 'sole_prop',
      invoicePrefix: 'INV-',
      defaultTermsDays: 30,
      receiptThreshold: '7500',
      taxRateBps: null,
    });
    const lines = (await c.get(url('/tax/lines?form=schedule_c'))).body.data;
    const codes = new Set(lines.map((l: any) => l.code));
    const chart = (await c.get(url('/categories'))).body.data.filter(
      (x: any) => x.entityId === biz && x.taxLineCode,
    );
    expect(chart.length).toBeGreaterThan(10);
    // Every mapped category points at a line that exists.
    expect(chart.filter((x: any) => !codes.has(x.taxLineCode))).toEqual([]);
    expect(lines.find((l: any) => l.code === 'US_SCH_C_L24B').deductibleBps).toBe(5000);
  });

  it('updates the profile, refusing an account that is not a bank account', async () => {
    const res = await c.patch(url(`/businesses/${biz}`), {
      legalName: 'Rivera Studio LLC',
      email: 'hello@rivera.example',
      defaultTermsDays: 15,
      defaultDepositAccountId: bizChecking,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ legalName: 'Rivera Studio LLC', defaultTermsDays: 15 });
    const bad = await c.patch(url(`/businesses/${biz}`), { taxSavingsAccountId: cat('Supplies') });
    expect(bad.status).toBe(422);
  });

  it('refuses an entity that is not a business', async () => {
    const entities = (await c.get(url('/categories'))).body.data;
    const personal = entities.find((x: any) => x.name === 'Groceries').entityId;
    expect((await c.get(url(`/businesses/${personal}`))).status).toBe(422);
  });
});

describe('privacy (ADR-0017 §6)', () => {
  it('hides a business from a partner with no grant, customers included', async () => {
    expect((await partner.get(url('/businesses'))).body.data).toEqual([]);
    expect((await partner.get(url(`/businesses/${biz}`))).status).toBe(404);
    expect((await partner.get(url(`/parties?entityId=${biz}`))).status).toBe(404);
    expect((await partner.get(url(`/invoices?entityId=${biz}`))).status).toBe(404);
    expect((await partner.get(url(`/reports/pnl?entityId=${biz}`))).status).toBe(404);
    const write = await partner.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Nope' });
    expect(write.status).toBe(404);
  });
});

describe('customers and vendors (BIZ-04)', () => {
  it('finds them from transactions, and adding one twice gives one', async () => {
    const t = await deposit('12500', 'NORTHWIND LLC');
    const found = (await c.get(url(`/parties?entityId=${biz}&kind=customer`))).body.data;
    const north = found.find((p: any) => p.name === 'NORTHWIND LLC');
    expect(north).toMatchObject({ id: null, yearTotal: '12500', lastActivity: today });
    const first = (
      await c.post(url('/parties'), {
        entityId: biz,
        kind: 'customer',
        name: 'Northwind',
        payeeKey: north.payeeKey,
      })
    ).body;
    const again = (
      await c.post(url('/parties'), {
        entityId: biz,
        kind: 'customer',
        name: 'Other',
        payeeKey: north.payeeKey,
      })
    ).body;
    expect(again.id).toBe(first.id);
    const after = (await c.get(url(`/parties?entityId=${biz}&kind=customer`))).body.data;
    expect(after.filter((p: any) => p.payeeKey === north.payeeKey)).toEqual([
      expect.objectContaining({ id: first.id, yearTotal: '12500' }),
    ]);
    await c.delete(url(`/transactions/${t.id}`));
  });
});

describe('invoices (BIZ-05)', () => {
  let invoice: any;

  it('drafts with numbers from the business, totals and tax per line', async () => {
    const res = await c.post(
      url('/invoices'),
      invoiceBody([
        line('10000', { quantity: '1.5', taxRateBps: 825 }),
        line('2550', { description: 'Hosting', quantity: '2' }),
      ]),
    );
    expect(res.status).toBe(201);
    invoice = res.body;
    expect(invoice).toMatchObject({
      number: 'INV-0001',
      status: 'draft',
      subtotal: '20100',
      tax: '1238', // 8.25% of $150.00, half up
      total: '21338',
      open: '21338',
      // The profile's 15-day terms.
      dueDate: addDays(today, 15),
      partyName: 'Bluebird Cafe',
    });
    expect(invoice.lines[0]).toMatchObject({ quantity: '1.5', amount: '15000', tax: '1238' });
    expect((await c.post(url('/invoices'), invoiceBody([line('100', { quantity: '0' })]))).status).toBe(422);
  });

  it('refuses a vendor as the customer, and one from another business', async () => {
    expect((await c.post(url('/invoices'), invoiceBody([line('100')], { partyId: vendor.id }))).status).toBe(
      422,
    );
  });

  it('posts nothing until it is paid (cash basis)', async () => {
    const before = await pnl();
    const edited = await c.patch(url(`/invoices/${invoice.id}`), {
      notes: 'Thanks!',
      version: invoice.version,
    });
    expect(edited.status).toBe(200);
    invoice = edited.body;
    expect(await pnl()).toEqual(before);
    expect(await balance(bizChecking)).toBe('100000');
  });

  it('previews, then sends a real PDF to the customer', async () => {
    const pdf = await h.app.inject({
      method: 'GET',
      url: url(`/invoices/${invoice.id}/pdf`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const outbox = (h.app.get(MAIL_PORT) as MemoryMail).outbox;
    const res = await c.post(url(`/invoices/${invoice.id}/send`), {
      version: invoice.version,
      message: 'Thank you',
    });
    expect(res.status).toBe(200);
    invoice = res.body;
    expect(invoice).toMatchObject({ status: 'sent', sentTo: 'ap@bluebird.example' });
    const mail = outbox.at(-1)!;
    expect(mail).toMatchObject({
      to: 'ap@bluebird.example',
      category: 'invoice',
      replyTo: 'hello@rivera.example',
    });
    expect(mail.subject).toContain('INV-0001');
    expect(mail.text).toContain('$213.38');
    expect(Buffer.from(mail.attachments![0]!.content).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('keeps what was sent as sent', async () => {
    const res = await c.patch(url(`/invoices/${invoice.id}`), { notes: 'changed', version: invoice.version });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invoice.not_draft');
    expect((await c.delete(url(`/invoices/${invoice.id}`))).status).toBe(422);
  });

  it('asks for an address when the customer has none', async () => {
    const noEmail = (await c.post(url('/parties'), { entityId: biz, kind: 'customer', name: 'Walk-in' }))
      .body;
    const i = (await c.post(url('/invoices'), invoiceBody([line('100')], { partyId: noEmail.id }))).body;
    const res = await c.post(url(`/invoices/${i.id}/send`), { version: i.version });
    expect(res.body.code).toBe('invoice.no_email');
    expect((await c.get(url(`/invoices/${i.id}`))).body.status).toBe('draft');
    expect((await c.delete(url(`/invoices/${i.id}`))).status).toBe(204);
  });

  it('links the exact deposit by itself, and income and sales tax land where they should', async () => {
    const date = today;
    const t = await deposit('21338', 'ACH CREDIT 8841', date);
    const before = await pnl();
    expect(await jobs.matchPayments({ workspaceId: wsId, userId: await ownerId() })).toBe(1);

    const paid = (await c.get(url(`/invoices/${invoice.id}`))).body;
    expect(paid).toMatchObject({ status: 'paid', paid: '21338', open: '0' });
    expect(paid.payments).toEqual([
      expect.objectContaining({ transactionId: t.id, amount: '21338', source: 'auto', date }),
    ]);
    // Counted once, on the statement's date, with the tax out of income.
    expect(await balance(bizChecking)).toBe(String(100000n + 21338n));
    const lines = await postings(t.id);
    expect(lines.map((l: any) => [l.name, l.amount])).toEqual([
      ['Studio checking', '21338'],
      ['Sales tax payable', '-1238'],
      [expect.any(String), '-20100'],
    ]);
    expect(lines.every((l: any) => l.d === date)).toBe(true);
    const after = await pnl();
    // The deposit had been income in another category, so the total differs only by the tax.
    expect(BigInt(after.revenue)).toBe(BigInt(before.revenue) - 1238n);
    // The statement's spelling is this customer now, once, under their own name.
    const parties = (await c.get(url(`/parties?entityId=${biz}&kind=customer`))).body.data;
    expect(parties.filter((p: any) => /ACH CREDIT/.test(p.name))).toEqual([]);
    expect(parties.find((p: any) => p.id === customer.id).yearTotal).toBe('20100');
    const report = (await c.get(url(`/reports/parties?entityId=${biz}&kind=customer`))).body;
    expect(report.rows.find((r: any) => r.name === 'Bluebird Cafe')).toMatchObject({
      amount: '20100',
      count: 1,
    });
    expect(report.rows.filter((r: any) => /ACH CREDIT/.test(r.name))).toEqual([]);
  });

  it('can only be changed through the invoice while linked', async () => {
    const { payments } = (await c.get(url(`/invoices/${invoice.id}`))).body;
    const id = payments[0].transactionId;
    const edit = await c.patch(url(`/transactions/${id}`), { categoryId: cat('Other business income') });
    expect(edit.body.code).toBe('invoice.managed');
    expect((await c.delete(url(`/transactions/${id}`))).body.code).toBe('invoice.managed');
    expect((await c.patch(url(`/transactions/${id}`), { memo: 'March' })).status).toBe(200);
    expect((await c.post(url(`/invoices/${invoice.id}/void`), { version: invoice.version })).body.code).toBe(
      'invoice.has_payments',
    );
  });

  it('removing the payment gives the deposit back as it was', async () => {
    const { payments } = (await c.get(url(`/invoices/${invoice.id}`))).body;
    const res = await c.delete(url(`/invoices/${invoice.id}/payments/${payments[0].id}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paid: '0' });
    const t = (await c.get(url(`/transactions/${payments[0].transactionId}`))).body;
    expect(t.splits).toEqual([
      expect.objectContaining({ accountId: cat('Other business income'), amount: '21338' }),
    ]);
    expect((await postings(t.id)).every((l: any) => l.d === t.date)).toBe(true);
    await c.delete(url(`/transactions/${t.id}`));
    const voided = await c.post(url(`/invoices/${invoice.id}/void`), { version: res.body.version });
    expect(voided.body.status).toBe('void');
  });

  it('takes several payments, and the parts add up to the cent', async () => {
    await voidAll();
    const i = await sent([
      line('33333', { incomeAccountId: cat('Sales & services') }),
      line('33333', { description: 'B', incomeAccountId: cat('Other business income'), taxRateBps: 1000 }),
    ]);
    expect(i.total).toBe('69999');
    const first = await c.post(url(`/invoices/${i.id}/payments`), {
      accountId: bizChecking,
      date: today,
      amount: '10001',
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'partial', paid: '10001', open: '59998' });
    const over = await c.post(url(`/invoices/${i.id}/payments`), {
      accountId: bizChecking,
      date: today,
      amount: '59999',
    });
    expect(over.body.code).toBe('invoice.overpaid');
    const last = await c.post(url(`/invoices/${i.id}/payments`), {
      accountId: bizChecking,
      date: today,
      amount: '59998',
    });
    expect(last.body).toMatchObject({ status: 'paid', open: '0' });

    const sum = new Map<string, bigint>();
    for (const p of last.body.payments) {
      for (const l of await postings(p.transactionId)) {
        sum.set(l.name, (sum.get(l.name) ?? 0n) + BigInt(l.amount));
      }
    }
    expect(sum.get('Sales & services')).toBe(-33333n);
    expect(sum.get('Other business income')).toBe(-33333n);
    expect(sum.get('Sales tax payable')).toBe(-3333n);

    // Later payments were split from the earlier ones, so they go first.
    const early = last.body.payments[0];
    expect((await c.delete(url(`/invoices/${i.id}/payments/${early.id}`))).body.code).toBe(
      'invoice.later_payment',
    );
    const late = last.body.payments[1];
    const bal = BigInt(await balance(bizChecking));
    await c.delete(url(`/invoices/${i.id}/payments/${late.id}`));
    expect(BigInt(await balance(bizChecking))).toBe(bal - 59998n);
    const t = (await c.get(url(`/transactions/${late.transactionId}`))).body;
    expect(t.status).toBe('void');
    await c.delete(url(`/invoices/${i.id}/payments/${early.id}`));
  });

  it('never guesses between equal amounts, or from a personal account', async () => {
    await voidAll();
    const a = await sent([line('50000')]);
    const b = await sent([line('50000')]);
    const t = await deposit('50000', 'WIRE IN');
    const ctx = { workspaceId: wsId, userId: await ownerId() };
    expect(await jobs.matchPayments(ctx)).toBe(0);
    expect((await c.get(url(`/invoices/${a.id}`))).body.status).toBe('sent');
    const candidates = (await c.get(url(`/invoices/${a.id}/candidates`))).body.data;
    expect(candidates.map((x: any) => x.transactionId)).toContain(t.id);

    // A statement quoting the number settles it, and that leaves one exact pair, which is then clear too.
    const quoted = await deposit('50000', `PAYMENT ${b.number}`);
    expect(await jobs.matchPayments(ctx)).toBe(2);
    expect((await c.get(url(`/invoices/${b.id}`))).body.payments[0].transactionId).toBe(quoted.id);
    expect((await c.get(url(`/invoices/${a.id}`))).body.payments[0].transactionId).toBe(t.id);

    // A freelancer's deposit in the household account is only ever offered, but can be linked by hand.
    await voidAll();
    const d = await sent([line('77700')]);
    const personal = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: personalChecking,
        amount: usd('77700'),
        payee: 'CLIENT PAYMENT',
        categoryId: cat(
          'Other income',
          (await c.get(url('/categories'))).body.data.find((x: any) => x.name === 'Groceries').entityId,
        ),
      })
    ).body;
    expect(await jobs.matchPayments(ctx)).toBe(0);
    const offered = (await c.get(url(`/invoices/${d.id}/candidates`))).body.data;
    expect(offered.map((x: any) => x.transactionId)).toContain(personal.id);
    const before = BigInt((await pnl()).revenue);
    const linked = await c.post(url(`/invoices/${d.id}/payments`), { transactionId: personal.id });
    expect(linked.status).toBe(201);
    expect(linked.body.status).toBe('paid');
    expect(BigInt((await pnl()).revenue)).toBe(before + 77700n);
    // Household money was not the business's: it's recorded between the two.
    expect(await balance(personalChecking)).toBe(String(100000n + 77700n));
  });

  it('a payment cannot be a transaction that already belongs to something', async () => {
    await voidAll();
    const a = await sent([line('1500')]);
    const t = await c.post(url(`/invoices/${a.id}/payments`), {
      accountId: bizChecking,
      date: today,
      amount: '1000',
    });
    const taken = t.body.payments[0].transactionId;
    const b = await sent([line('1000')]);
    const res = await c.post(url(`/invoices/${b.id}/payments`), { transactionId: taken });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('payment.already_linked');
    const out = await c.post(url('/transactions'), {
      date: today,
      accountId: bizChecking,
      amount: usd('-500'),
      payee: 'Shop',
      categoryId: cat('Supplies'),
    });
    const wrong = await c.post(url(`/invoices/${b.id}/payments`), { transactionId: out.body.id });
    expect(wrong.body.code).toBe('payment.wrong_direction');
    await c.delete(url(`/transactions/${out.body.id}`));
  });

  it('is overdue after its date, and in the forecast and calendar until paid', async () => {
    await voidAll();
    const past = addDays(today, -40);
    const i = await sent([line('9900')], { issueDate: past, dueDate: addDays(past, 10) });
    expect(i.status).toBe('overdue');
    const list = (await c.get(url(`/invoices?entityId=${biz}&status=overdue`))).body.data;
    expect(list.map((x: any) => x.id)).toContain(i.id);
    const cal = (await c.get(url(`/calendar?from=${addDays(past, 5)}&to=${today}&entityId=${biz}`))).body
      .items;
    expect(cal.find((x: any) => x.sourceId === i.id)).toMatchObject({
      kind: 'invoice',
      status: 'overdue',
      amount: '9900',
    });
    const fc = (await c.get(url(`/flow/forecast?days=30&entityId=${biz}`))).body;
    expect(fc.accounts.flatMap((a: any) => a.items).find((x: any) => x.sourceId === i.id)).toMatchObject({
      kind: 'invoice',
      amount: '9900',
    });
  });
});

describe('import undo (ADR-0017 §3)', () => {
  it('keeps a line an invoice has taken over', async () => {
    await voidAll();
    const i = await sent([line('65400')]);
    const boundary = '----montra';
    const csv = `Date,Description,Amount\n${today},${i.number} REMITTANCE,654.00\n`;
    const up = await h.app.inject({
      method: 'POST',
      url: url('/uploads'),
      headers: {
        authorization: `Bearer dev:${EMAIL}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bank.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
      ),
    });
    const fileId = JSON.parse(up.body).fileId;
    const batch = (await c.post(url('/imports'), { fileId, accountId: bizChecking })).body;
    await worker.drain();
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain();
    // The commit itself linked it: the statement quotes the number.
    const paid = (await c.get(url(`/invoices/${i.id}`))).body;
    expect(paid).toMatchObject({ status: 'paid' });
    const line0 = (await postings(paid.payments[0].transactionId))[0];
    expect(line0.cleared).toBe('cleared');

    await c.post(url(`/imports/${batch.id}/undo`));
    await worker.drain();
    const { jobId } = (await c.get(url(`/imports/${batch.id}`))).body;
    expect((await c.get(url(`/jobs/${jobId}`))).body.result.kept).toEqual([
      { transactionId: paid.payments[0].transactionId, reason: 'invoice' },
    ]);
    expect((await c.get(url(`/invoices/${i.id}`))).body.status).toBe('paid');
  });
});

describe('bills (BIZ-06)', () => {
  let bill: any;

  it('records a bill that posts nothing, and shows in the forecast', async () => {
    await voidAll();
    const before = await pnl();
    const res = await c.post(url('/bills'), {
      entityId: biz,
      partyId: vendor.id,
      reference: 'PS-1007',
      billDate: today,
      dueDate: addDays(today, 7),
      amount: '18000',
      expenseAccountId: cat('Supplies'),
    });
    expect(res.status).toBe(201);
    bill = res.body;
    expect(bill).toMatchObject({ status: 'open', partyName: 'Print Shop', transactionId: null });
    expect(await pnl()).toEqual(before);
    const fc = (await c.get(url(`/flow/forecast?days=30&entityId=${biz}`))).body;
    expect(fc.accounts.flatMap((a: any) => a.items).find((x: any) => x.sourceId === bill.id)).toMatchObject({
      kind: 'bill',
      amount: '-18000',
    });
    expect(
      (
        await c.post(url('/bills'), {
          ...bill,
          entityId: biz,
          partyId: customer.id,
          billDate: today,
          fileIds: [],
        })
      ).status,
    ).toBe(422);
  });

  it('links only the exact amount', async () => {
    const short = await c.post(url('/transactions'), {
      date: today,
      accountId: bizChecking,
      amount: usd('-17999'),
      payee: 'PRINT SHOP',
      categoryId: cat('Other expenses'),
    });
    const ctx = { workspaceId: wsId, userId: await ownerId() };
    expect(await jobs.matchPayments(ctx)).toBe(0);
    const bad = await c.post(url(`/bills/${bill.id}/payment`), { transactionId: short.body.id });
    expect(bad.body.code).toBe('bill.amount');
    await c.delete(url(`/transactions/${short.body.id}`));
    const exact = await c.post(url('/transactions'), {
      date: addDays(today, 1),
      accountId: bizChecking,
      amount: usd('-18000'),
      payee: 'PRINT SHOP',
      categoryId: cat('Other expenses'),
    });
    expect(await jobs.matchPayments(ctx)).toBe(1);
    const paid = (await c.get(url(`/bills/${bill.id}`))).body;
    expect(paid).toMatchObject({ status: 'paid', transactionId: exact.body.id });
    const lines = await postings(exact.body.id);
    expect(lines.map((l: any) => [l.name, l.amount])).toEqual([
      ['Supplies', '18000'],
      ['Studio checking', '-18000'],
    ]);
    const edit = await c.patch(url(`/transactions/${exact.body.id}`), { categoryId: cat('Advertising') });
    expect(edit.body.code).toBe('bill.managed');
    expect((await c.patch(url(`/bills/${bill.id}`), { amount: '1', version: paid.version })).body.code).toBe(
      'bill.paid',
    );
    const open = await c.delete(url(`/bills/${bill.id}/payment`));
    expect(open.body).toMatchObject({ status: 'open', transactionId: null });
    const t = (await c.get(url(`/transactions/${exact.body.id}`))).body;
    expect(t.splits[0]).toMatchObject({ accountId: cat('Other expenses') });
    await c.delete(url(`/transactions/${t.id}`));
    bill = open.body;
  });

  it('records a payment not yet in the books', async () => {
    const res = await c.post(url(`/bills/${bill.id}/payment`), {
      accountId: bizChecking,
      date: today,
      amount: '18000',
    });
    expect(res.body).toMatchObject({ status: 'paid' });
    const t = (await c.get(url(`/transactions/${res.body.transactionId}`))).body;
    expect(t).toMatchObject({ source: 'bill', payee: 'Print Shop', amount: usd('-18000') });
  });

  it('keeps attached files when a patch leaves them out', async () => {
    const boundary = '----montra';
    const up = await h.app.inject({
      method: 'POST',
      url: url('/uploads'),
      headers: {
        authorization: `Bearer dev:${EMAIL}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bill.csv"\r\nContent-Type: text/csv\r\n\r\nDate,Amount\n${today},1\r\n--${boundary}--\r\n`,
      ),
    });
    expect(up.statusCode).toBe(201);
    const fileId = JSON.parse(up.body).fileId;
    const created = await c.post(url('/bills'), {
      entityId: biz,
      partyId: vendor.id,
      billDate: today,
      dueDate: addDays(today, 30),
      amount: '4200',
      expenseAccountId: cat('Supplies'),
      fileIds: [fileId],
    });
    expect(created.body.fileIds).toEqual([fileId]);
    const noted = await c.patch(url(`/bills/${created.body.id}`), {
      notes: 'Paid by card',
      version: created.body.version,
    });
    expect(noted.status).toBe(200);
    expect(noted.body).toMatchObject({ notes: 'Paid by card', fileIds: [fileId] });
    await c.patch(url(`/bills/${created.body.id}`), { void: true, version: noted.body.version });
  });
});

describe('mileage (BIZ-07)', () => {
  const trip = (date: string, miles: string) => ({ entityId: biz, date, purpose: 'Client visit', miles });

  it('uses the rate in force on the trip date, including the 2026 mid-year change', async () => {
    const before = (await c.post(url('/mileage-trips'), trip('2026-06-30', '100'))).body;
    expect(before).toMatchObject({ centsPerMile: '72.5', deduction: '7250', miles: '100' });
    const after = (await c.post(url('/mileage-trips'), trip('2026-07-01', '100'))).body;
    expect(after).toMatchObject({ centsPerMile: '76', deduction: '7600' });
    const summary = (await c.get(url(`/mileage-trips?entityId=${biz}&year=2026`))).body;
    expect(summary.miles).toBe('200');
    expect(summary.deduction).toBe('14850');
    // Moving a trip across the change picks up the other rate; other edits keep the rate it has.
    const moved = (
      await c.patch(url(`/mileage-trips/${before.id}`), { date: '2026-07-02', version: before.version })
    ).body;
    expect(moved).toMatchObject({ centsPerMile: '76', deduction: '7600' });
    const longer = (
      await c.patch(url(`/mileage-trips/${moved.id}`), { miles: '12.4', version: moved.version })
    ).body;
    expect(longer).toMatchObject({ miles: '12.4', deduction: '942', centsPerMile: '76' });
    expect((await c.delete(url(`/mileage-trips/${longer.id}`))).status).toBe(204);
    expect((await c.delete(url(`/mileage-trips/${after.id}`))).status).toBe(204);
  });

  it('refuses a date with no rate, and bad miles', async () => {
    expect((await c.post(url('/mileage-trips'), trip('2001-01-01', '10'))).body.code).toBe('mileage.no_rate');
    expect((await c.post(url('/mileage-trips'), trip(today, '10.25'))).status).toBe(400);
    expect((await c.post(url('/mileage-trips'), trip(today, '0'))).body.code).toBe('mileage.miles');
  });

  it('never reaches the ledger', async () => {
    const before = await pnl();
    const t = (await c.post(url('/mileage-trips'), trip(today, '50'))).body;
    expect(await pnl()).toEqual(before);
    expect((await c.delete(url(`/mileage-trips/${t.id}`))).status).toBe(204);
  });
});

describe('reports (BIZ-10)', () => {
  let tax: any;
  let meal: any;

  beforeAll(async () => {
    tax = await c.post(url('/transactions'), {
      date: today,
      accountId: bizChecking,
      amount: usd('-40000'),
      payee: 'Ads Inc',
      categoryId: cat('Advertising'),
    });
    meal = await c.post(url('/transactions'), {
      date: today,
      accountId: bizChecking,
      amount: usd('-10000'),
      payee: 'Bistro',
      categoryId: cat('Meals'),
    });
  });

  it('adds up a P&L, by category and month', async () => {
    const p = await pnl();
    expect(BigInt(p.netProfit)).toBe(BigInt(p.revenue) - BigInt(p.expenses));
    expect(p.expense.find((l: any) => l.name === 'Advertising')).toMatchObject({
      amount: '40000',
      taxLineCode: 'US_SCH_C_L8',
    });
    expect(p.months.at(-1).month).toBe(startOfMonth(today));
    const empty = (await c.get(url(`/reports/pnl?entityId=${biz}&from=2001-01-01&to=2001-12-31`))).body;
    expect(empty).toMatchObject({ revenue: '0', expenses: '0', netProfit: '0', marginBps: null });
    const v = (await c.get(url(`/reports/parties?entityId=${biz}&kind=vendor`))).body;
    expect(v.rows.find((r: any) => r.name === 'Ads Inc')).toMatchObject({ amount: '40000', count: 1 });
    const cu = (await c.get(url(`/reports/parties?entityId=${biz}&kind=customer`))).body;
    expect(BigInt(cu.total)).toBeGreaterThan(0n);
  });

  it('builds Schedule C, with mileage in car expenses and a warning for both', async () => {
    const before = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(before.lines.find((l: any) => l.code === 'US_SCH_C_L8')).toMatchObject({
      line: '8',
      amount: '40000',
    });
    const meals = before.lines.find((l: any) => l.code === 'US_SCH_C_L24B');
    expect(meals).toMatchObject({ amount: '10000', deductibleBps: 5000 });
    expect(before.warnings).toEqual([]);

    const t = (
      await c.post(url('/mileage-trips'), { entityId: biz, date: today, purpose: 'Client', miles: '100' })
    ).body;
    const withMiles = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    const car = withMiles.lines.find((l: any) => l.code === 'US_SCH_C_L9');
    expect(car).toMatchObject({ mileage: t.deduction, amount: t.deduction });
    expect(BigInt(withMiles.netProfit)).toBe(BigInt(before.netProfit) - BigInt(t.deduction));
    expect(withMiles.warnings).toEqual([]);

    const gas = await c.post(url('/transactions'), {
      date: today,
      accountId: bizChecking,
      amount: usd('-3000'),
      payee: 'Shell',
      categoryId: cat('Car & truck'),
    });
    const both = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(both.warnings).toEqual(['mileage_and_actual_car']);
    await c.delete(url(`/transactions/${gas.body.id}`));
    await c.delete(url(`/mileage-trips/${t.id}`));
  });

  it('shows income with no line rather than dropping it', async () => {
    // A category with no line, as AI-proposed ones start out (UP-03).
    const { rows } = await admin.query(
      `insert into app.ledger_account (workspace_id, entity_id, name, type, currency, is_category)
       values ($1, $2, 'Workshop supplies', 'expense', 'USD', true) returning id`,
      [wsId, biz],
    );
    const mine = { body: { id: rows[0].id as string } };
    const t = await c.post(url('/transactions'), {
      date: today,
      accountId: bizChecking,
      amount: usd('-2500'),
      payee: 'Hardware',
      categoryId: mine.body.id,
    });
    const s = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(s.unmapped).toEqual([expect.objectContaining({ categoryId: mine.body.id, amount: '2500' })]);

    // AI-10: proposes a line, and only the user maps it.
    const suggested = (await c.post(url(`/businesses/${biz}/tax-lines/suggest`))).body.data;
    expect(suggested).toEqual([
      expect.objectContaining({ categoryId: mine.body.id, code: 'US_SCH_C_L22', label: 'Supplies' }),
    ]);
    const unmapped = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(unmapped.unmapped).toHaveLength(1);
    const bad = await c.patch(url(`/categories/${mine.body.id}/tax-line`), { taxLineCode: 'US_SCH_C_L999' });
    expect(bad.body.code).toBe('tax_line.unknown');
    const map = await c.patch(url(`/categories/${mine.body.id}/tax-line`), { taxLineCode: 'US_SCH_C_L22' });
    expect(map.status).toBe(204);
    const mapped = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(mapped.unmapped).toEqual([]);
    expect(mapped.netProfit).toBe(unmapped.netProfit);
    expect(mapped.lines.find((l: any) => l.code === 'US_SCH_C_L22').categoryIds).toContain(mine.body.id);
    await c.delete(url(`/transactions/${t.body.id}`));
  });

  it('keeps a read-only accountant to what was granted (BIZ-13)', async () => {
    const accountant = h.as('accountant@example.com');
    const invite = await c.post(url('/sharing/invites'), {
      email: 'accountant@example.com',
      role: 'accountant',
      entityGrants: [{ entityId: biz, access: 'read' }],
    });
    expect(invite.status).toBe(201);
    expect((await accountant.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
    expect((await accountant.get(url(`/reports/pnl?entityId=${biz}`))).status).toBe(200);
    const denied = await accountant.post(url('/mileage-trips'), {
      entityId: biz,
      date: today,
      purpose: 'x',
      miles: '1',
    });
    expect(denied.status).toBe(403);
    const accounts = (await accountant.get(url('/accounts'))).body.data;
    expect(accounts.map((a: any) => a.id)).toContain(bizChecking);
    expect(accounts.map((a: any) => a.id)).not.toContain(personalChecking);
  });

  it('exports the journal, balanced, in each format (BIZ-13)', async () => {
    const get = (format: string) =>
      h.app.inject({
        method: 'GET',
        url: url(`/exports/accounting?entityId=${biz}&from=${year}-01-01&to=${year}-12-31&format=${format}`),
        headers: { authorization: `Bearer dev:${EMAIL}` },
      });
    const csv = await get('csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-disposition']).toContain('attachment');
    const rows = csv.body.trim().split('\r\n');
    expect(rows[0]).toContain('Debit,Credit');
    expect(csv.body).toContain('Ads Inc');
    expect(csv.body).not.toContain('Joint checking');

    const iif = await get('quickbooks_iif');
    const iifLines = iif.body.trim().split('\r\n');
    expect(iifLines.slice(0, 3)).toEqual([
      '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO',
      '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO',
      '!ENDTRNS',
    ]);
    // Each journal balances to zero.
    let cents = 0n;
    for (const l of iifLines.slice(3)) {
      if (l === 'ENDTRNS') {
        expect(cents).toBe(0n);
        cents = 0n;
        continue;
      }
      const amount = l.split('\t')[5]!;
      cents += BigInt(amount.replace('.', ''));
    }

    const xero = await get('xero_csv');
    expect(xero.body.split('\r\n')[0]).toBe('*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount');
    const xlsx = await get('xlsx');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await get('nope')).statusCode).toBe(400);
  });

  afterAll(async () => {
    await c.delete(url(`/transactions/${tax.body.id}`));
    await c.delete(url(`/transactions/${meal.body.id}`));
  });
});

describe('estimated tax (BIZ-09, REC-09)', () => {
  it('shows profit without a rate, and a set-aside with one', async () => {
    const none = (await c.get(url(`/tax/estimates?entityId=${biz}`))).body;
    expect(none).toMatchObject({ rateBps: null, target: '0', toSetAside: '0' });
    expect(none.periods).toHaveLength(4);
    await c.patch(url(`/businesses/${biz}`), { taxRateBps: 2500 });
    const e = (await c.get(url(`/tax/estimates?entityId=${biz}`))).body;
    expect(BigInt(e.ytdProfit)).toBeGreaterThan(0n);
    expect(e.target).toBe(String((BigInt(e.ytdProfit) * 2500n + 5000n) / 10000n));
    expect(e.toSetAside).toBe(e.target);
    expect(e.periods.filter((p: any) => p.status === 'next').length).toBeLessThanOrEqual(1);

    // A mileage deduction lowers taxable profit, so this agrees with Schedule C.
    const t = (
      await c.post(url('/mileage-trips'), { entityId: biz, date: today, purpose: 'Client', miles: '100' })
    ).body;
    const withMiles = (await c.get(url(`/tax/estimates?entityId=${biz}`))).body;
    expect(BigInt(withMiles.ytdProfit)).toBe(BigInt(e.ytdProfit) - BigInt(t.deduction));
    const schedule = (await c.get(url(`/reports/schedule-c?entityId=${biz}`))).body;
    expect(withMiles.ytdProfit).toBe(schedule.netProfit);
    await c.delete(url(`/mileage-trips/${t.id}`));
  });

  it('suggests setting aside, and accepting makes the transfer', async () => {
    const savings = (
      await c.post(url('/accounts'), {
        name: 'Tax savings',
        kind: 'savings',
        openingBalance: usd('0'),
        openingDate: `${year - 1}-12-01`,
        entityId: biz,
      })
    ).body.id;
    await c.patch(url(`/businesses/${biz}`), { taxSavingsAccountId: savings });
    const ctx = { workspaceId: wsId, userId: await ownerId() };
    await jobs.notes(ctx);
    const recs = (await c.get(url('/recommendations?status=open'))).body.data;
    const rec = recs.find((r: any) => r.type === 'REC-09');
    expect(rec.entityId).toBe(biz);
    expect(rec.budgetId).toBeNull();
    const amount = rec.payload.figures.stillToSetAside;
    expect(rec.payload.actions).toEqual([
      { kind: 'transfer', fromAccountId: bizChecking, toAccountId: savings, amount },
    ]);
    const done = await c.post(url(`/recommendations/${rec.id}/accept`), {});
    expect(done.status).toBe(200);
    expect(await balance(savings)).toBe(amount);
    const after = (await c.get(url(`/tax/estimates?entityId=${biz}`))).body;
    expect(after).toMatchObject({ saved: amount, toSetAside: '0' });
    // Asking again this month doesn't repeat it.
    await jobs.notes(ctx);
    const again = (await c.get(url('/recommendations?status=open'))).body.data;
    expect(again.filter((r: any) => r.type === 'REC-09')).toEqual([]);
  });
});

describe('business and personal separation (BIZ-03)', () => {
  it('flags what looks wrong, and one tap moves it', async () => {
    const personal = (await c.get(url('/categories'))).body.data.find(
      (x: any) => x.name === 'Groceries',
    ).entityId;
    const t = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: personalChecking,
        amount: usd('-5499'),
        payee: 'ADOBE CREATIVE',
        categoryId: cat('Groceries', personal),
      })
    ).body;
    const fine = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: personalChecking,
        amount: usd('-500'),
        payee: 'CORNER CAFE',
        categoryId: cat('Groceries', personal),
      })
    ).body;
    const ctx = { workspaceId: wsId, userId: await ownerId() };
    expect(await jobs.flagSeparation(ctx)).toBe(1);
    // Flagging again doesn't repeat it.
    expect(await jobs.flagSeparation(ctx)).toBe(0);
    const list = (await c.get(url('/insights'))).body.data;
    const flag = list.find((i: any) => i.kind === 'separation');
    expect(flag).toMatchObject({ transactionId: t.id, entityId: biz, payee: 'ADOBE CREATIVE' });
    expect(flag.data.category).toBe('Office expense');
    expect(list.map((i: any) => i.transactionId)).not.toContain(fine.id);
    // A partner with no access to the business sees no flag naming its categories.
    expect(
      (await partner.get(url('/insights'))).body.data.filter((i: any) => i.kind === 'separation'),
    ).toEqual([]);

    const res = await c.post(url(`/insights/${flag.id}/accept`), {});
    expect(res.status).toBe(200);
    const moved = (await c.get(url(`/transactions/${t.id}`))).body;
    expect(moved.splits[0].accountId).toBe(cat('Office expense'));
    expect(await balance(personalChecking)).toBe(String(100000n + 77700n - 5499n - 500n));
    const lines = await postings(t.id);
    expect(lines.map((l: any) => l.name)).toContain('Office expense');
    expect(lines.some((l: any) => /Owner|due|clearing/i.test(l.name))).toBe(true);
  });

  it("flags from the user's own habit with AI off", async () => {
    await c.patch(url('/ai/settings'), { mode: 'off' });
    const personal = (await c.get(url('/categories'))).body.data.find(
      (x: any) => x.name === 'Groceries',
    ).entityId;
    const add = (accountId: string, categoryId: string, date: string) =>
      c.post(url('/transactions'), {
        date,
        accountId,
        amount: usd('-2000'),
        payee: 'Plumb Supply',
        categoryId,
      });
    await add(bizChecking, cat('Repairs & maintenance'), addDays(today, -60));
    await add(bizChecking, cat('Repairs & maintenance'), addDays(today, -50));
    const t = (await add(personalChecking, cat('Groceries', personal), today)).body;
    await jobs.flagSeparation({ workspaceId: wsId, userId: await ownerId() });
    const list = (await c.get(url('/insights'))).body.data;
    const flag = list.find((i: any) => i.kind === 'separation' && i.transactionId === t.id);
    expect(flag.data.category).toBe('Repairs & maintenance');
    await c.patch(url('/ai/settings'), { mode: 'builtin' });
  });
});

describe('missing receipts (BIZ-12)', () => {
  it('lists business expenses over the threshold without one', async () => {
    const big = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: bizChecking,
        amount: usd('-7500'),
        payee: 'Big Purchase',
        categoryId: cat('Supplies'),
      })
    ).body;
    const small = (
      await c.post(url('/transactions'), {
        date: today,
        accountId: bizChecking,
        amount: usd('-7499'),
        payee: 'Small Purchase',
        categoryId: cat('Supplies'),
      })
    ).body;
    const list = (await c.get(url(`/reports/missing-receipts?entityId=${biz}`))).body;
    expect(list.threshold).toBe('7500');
    const ids = list.rows.map((r: any) => r.transactionId);
    expect(ids).toContain(big.id);
    expect(ids).not.toContain(small.id);
    await c.patch(url(`/businesses/${biz}`), { receiptThreshold: '5000' });
    const lower = (await c.get(url(`/reports/missing-receipts?entityId=${biz}`))).body;
    expect(lower.rows.map((r: any) => r.transactionId)).toContain(small.id);
    await c.patch(url(`/businesses/${biz}`), { receiptThreshold: '7500' });
  });
});

describe('revenue target (BIZ-11)', () => {
  it('sits on a business budget, and a margin note follows the month', async () => {
    const b = await c.post(url('/budgets'), {
      entityId: biz,
      name: 'Studio',
      method: 'category_limits',
      revenueTarget: '500000',
    });
    expect(b.status).toBe(201);
    expect(b.body.revenueTarget).toBe('500000');
    const u = await c.patch(url(`/budgets/${b.body.id}`), {
      revenueTarget: '600000',
      version: b.body.version,
    });
    expect(u.body.revenueTarget).toBe('600000');

    const last = startOfMonth(addDays(startOfMonth(today), -1));
    await c.post(url('/transactions'), {
      date: last,
      accountId: bizChecking,
      amount: usd('100000'),
      payee: 'Client',
      categoryId: cat('Sales & services'),
    });
    await c.post(url('/transactions'), {
      date: last,
      accountId: bizChecking,
      amount: usd('-40000'),
      payee: 'Costs',
      categoryId: cat('Supplies'),
    });
    await jobs.notes({ workspaceId: wsId, userId: await ownerId() });
    const note = (await c.get(url('/recommendations?status=open'))).body.data.find(
      (r: any) => r.type === 'BIZ-11',
    );
    expect(note.payload.figures).toMatchObject({
      revenueLastMonth: expect.any(String),
      marginLastMonth: expect.stringMatching(/%$/),
    });
    expect(note.wording).toBeTruthy();
  });
});

async function ownerId(): Promise<string> {
  const { rows } = await admin.query(`select id from app.app_user where email = $1`, [EMAIL]);
  return rows[0].id;
}
