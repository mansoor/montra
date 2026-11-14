/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonths, fromParts, parts, todayIn } from '@montra/domain';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { Worker } from '../src/jobs/queue.js';
import { PayslipJobs } from '../src/payslips/payslip-jobs.js';
import { ScanJobs } from '../src/scans/scan-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Billers on the budget and their next bills in upcoming, the calendar and the forecast (ADR-0048 §4).
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
/** The 20th of the month `n` months from this one. */
const the20th = (n: number) => {
  const m = parts(addMonths(today, n));
  return fromParts(m.year, m.month, 20);
};
/** The next 20th on or after today: when SDG&E's next bill is due. */
const nextDue = today <= the20th(0) ? the20th(0) : the20th(1);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;
let worker: Worker;
let wsId: string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(PayslipJobs).register();
  h.app.get(ScanJobs).register();
  worker = h.app.get(Worker);
  c = h.as('billers@example.com');
  const ws = (await c.post('/v1/workspaces', { name: 'Billers', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  wsId = ws.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('500000'),
      openingDate: addDays(the20th(-5), -1),
    })
  ).body.id;
  // Three months of the electricity bill, paid a day before it's due.
  for (const [n, amount] of [
    [-3, '-9000'],
    [-2, '-8000'],
    [-1, '-8500'],
  ] as const) {
    const res = await c.post(url('/transactions'), {
      date: addDays(the20th(n), -1),
      accountId: checking,
      amount: usd(amount),
      payee: 'SDG&E WEB PAYMENT',
      categoryId: cat('Utilities'),
    });
    expect(res.status).toBe(201);
  }
});
afterAll(() => h.close());

describe('billers (ADR-0048 §4)', () => {
  let sdge: any;

  it('names a provider on a budget category, and estimates its next bill from its payments', async () => {
    const res = await c.post(url('/billers'), { categoryId: cat('Utilities'), name: 'SDG&E', dueDay: 20 });
    expect(res.status).toBe(201);
    sdge = res.body;
    expect(sdge).toMatchObject({
      categoryId: cat('Utilities'),
      name: 'SDG&E',
      dueDay: 20,
      cadence: 'monthly',
      archived: false,
      next: { date: nextDue, amount: '8500', currency: 'USD', estimated: true, basedOn: 3 },
    });
    expect((await c.get(url('/billers'))).body.data.map((b: any) => b.name)).toEqual(['SDG&E']);
    // A new provider with no payments has nothing to go on yet.
    const water = (await c.post(url('/billers'), { categoryId: cat('Utilities'), name: 'City Water' })).body;
    expect(water.next).toBeNull();
    // A biller belongs to a spending category, and a name is used once per books.
    expect((await c.post(url('/billers'), { categoryId: checking, name: 'X' })).status).toBe(422);
    expect((await c.post(url('/billers'), { categoryId: cat('Utilities'), name: 'sdg&e' })).status).toBe(422);
  });

  it('shows the estimated bill in the calendar, upcoming and the forecast', async () => {
    const cal = (await c.get(url(`/calendar?from=${today}&to=${addDays(nextDue, 1)}`))).body;
    expect(cal.items).toContainEqual(
      expect.objectContaining({
        date: nextDue,
        kind: 'bill',
        name: 'SDG&E',
        amount: '-8500',
        variable: true,
        sourceId: sdge.id,
      }),
    );
    const f = (await c.get(url('/flow/forecast?days=60'))).body;
    // Paid from the books' main account.
    expect(f.accounts.find((a: any) => a.accountId === checking).items).toContainEqual(
      expect.objectContaining({ kind: 'bill', name: 'SDG&E', amount: '-8500', date: nextDue }),
    );
  });

  it('leaves the estimate out where a recurring item already shows the payee, and when archived', async () => {
    const rec = await c.post(url('/recurring'), {
      name: 'SDG&E',
      accountId: checking,
      amount: usd('-8500'),
      payee: 'SDG&E WEB PAYMENT',
      categoryId: cat('Utilities'),
      cadence: 'monthly',
      startDate: nextDue,
    });
    expect(rec.status).toBe(201);
    const calItems = async () =>
      (await c.get(url(`/calendar?from=${today}&to=${addDays(nextDue, 1)}`))).body.items.filter(
        (i: any) => i.sourceId === sdge.id,
      );
    expect(await calItems()).toEqual([]);
    const archived = await c.patch(url(`/billers/${sdge.id}`), { archived: true, version: sdge.version });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, next: null });
    expect(await calItems()).toEqual([]);
    // A stale version is refused.
    expect((await c.patch(url(`/billers/${sdge.id}`), { dueDay: 5, version: sdge.version })).status).toBe(
      409,
    );
  });
});

async function upload(bytes: Uint8Array, name = 'bill.png') {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/household-bills/files`,
    headers: {
      authorization: 'Bearer dev:billers@example.com',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return JSON.parse(res.body);
}

describe('scanned bills (ADR-0048 §4)', () => {
  let cable: any;
  const due = addDays(today, 10);

  it('reads a bill, finds its biller by account number, and files it with the exact amount and date', async () => {
    cable = (
      await c.post(url('/billers'), {
        categoryId: cat('Phone & internet'),
        name: 'Comcast',
        accountLast4: '4321',
      })
    ).body;
    await c.patch(url('/ai/settings'), { allowDocumentsToLlm: true });
    const page = await upload(
      encodeFakeReceiptImage(
        [
          'XFINITY',
          'ACCOUNT NUMBER 8774 1023 4321',
          'AMOUNT DUE $112.45',
          `DUE DATE ${due}`,
          'KIND internet_tv',
        ].join('\n'),
      ),
    );
    const scan = (await c.post(url('/scans'), { kind: 'bill', fileIds: [page.fileId] })).body;
    await worker.drain(['ai']);
    const read = (await c.get(url(`/scans/${scan.id}`))).body;
    expect(read).toMatchObject({
      status: 'ready',
      bill: {
        billerName: 'XFINITY',
        kind: 'internet_tv',
        accountLast4: '4321',
        billerId: cable.id,
        candidates: [{ billerId: cable.id, name: 'Comcast', reason: 'account' }],
        amount: '11245',
        currency: 'USD',
        dueDate: due,
      },
    });

    const filed = await c.post(url('/household-bills'), {
      billerId: cable.id,
      scanId: scan.id,
      amount: read.bill.amount,
      dueDate: read.bill.dueDate,
    });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ kind: 'household' });
    const bill = (await c.get(url(`/household-bills/${filed.body.id}`))).body;
    expect(bill).toMatchObject({
      billerName: 'Comcast',
      status: 'open',
      amount: '11245',
      dueDate: due,
      fileIds: [page.fileId],
    });
    // The exact bill shows in place of an estimate.
    const cal = (await c.get(url(`/calendar?from=${today}&to=${addDays(due, 1)}`))).body;
    expect(cal.items).toContainEqual(
      expect.objectContaining({
        date: due,
        kind: 'bill',
        name: 'Comcast',
        amount: '-11245',
        variable: false,
      }),
    );
    expect((await c.get(url(`/scans/${scan.id}`))).body).toMatchObject({
      status: 'used',
      usedId: filed.body.id,
    });
    await c.patch(url('/ai/settings'), { allowDocumentsToLlm: false });
  });

  it('is marked paid by the payment to the biller for the amount', async () => {
    await c.post(url('/transactions'), {
      date: today,
      accountId: checking,
      amount: usd('-11245'),
      payee: 'COMCAST CABLE COMM',
      categoryId: cat('Phone & internet'),
    });
    const list = (await c.get(url('/household-bills'))).body.data;
    expect(list).toContainEqual(expect.objectContaining({ billerName: 'Comcast', status: 'paid' }));
    expect((await c.get(url('/household-bills?status=open'))).body.data).toEqual([]);
  });

  it("files a business's bill as its vendor bill", async () => {
    const biz = (
      await c.post(url('/entities'), { type: 'business', name: 'Studio', businessType: 'sole_prop' })
    ).body.id;
    const cats = (await c.get(url(`/categories?entityId=${biz}`))).body.data;
    const utilities =
      cats.find((x: any) => /utilit/i.test(x.name) && x.type === 'expense') ??
      cats.find((x: any) => x.type === 'expense');
    const power = (await c.post(url('/billers'), { categoryId: utilities.id, name: 'SDG&E' })).body;
    expect(power.entityId).toBe(biz);
    const filed = await c.post(url('/household-bills'), {
      billerId: power.id,
      amount: '20000',
      dueDate: due,
    });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ kind: 'business', entityId: biz });
    const bills = (await c.get(url(`/bills?entityId=${biz}`))).body.data;
    expect(bills).toContainEqual(
      expect.objectContaining({
        id: filed.body.id,
        amount: '20000',
        dueDate: due,
        expenseAccountId: utilities.id,
      }),
    );
  });
});
