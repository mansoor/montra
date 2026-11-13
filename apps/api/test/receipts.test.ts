/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { CONFIG } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { FxRatesService } from '../src/fx/fx.service.js';
import { Worker } from '../src/jobs/queue.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { ADMIN_URL } from './env.js';
import { fixtureHttp } from './fx-fixtures.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Receipts end to end (RCP-01..12, IMP-11, CUR-04, CUR-09, TZ-03; 04 §7) with the fake provider: receipt
// "photos" are PNGs carrying their text, read deterministically.
const usd = (amount: string) => ({ amount, currency: 'USD' });

const WALMART = [
  'WALMART SUPERCENTER #1234',
  '10/05/2026 14:32',
  'GV 2% MLK GAL          3.48 N',
  'BANANAS                1.62 N',
  'ONN USB-C CHRGR       12.88 T',
  'TS MENS TEE            8.98 T',
  'SUBTOTAL              26.96',
  'TAX                    1.75',
  'TOTAL                 28.71',
  'CARD **** 1234',
].join('\n');

let h: Harness;
let c: Client;
let worker: Worker;
let admin: pg.Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let card: string;
let checking: string;
const EMAIL = 'receipts@example.com';

async function upload(bytes: Uint8Array, fileName: string, path = '/receipts/files') {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: url(path),
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** Uploads the receipt text as a fake photo (or several pages), creates the receipt and runs the jobs. */
async function capture(pages: string | string[], extra: Record<string, unknown> = {}) {
  const fileIds: string[] = [];
  for (const [i, text] of [pages].flat().entries()) {
    const f = await upload(encodeFakeReceiptImage(text), `page-${i}.png`);
    expect(f.status).toBe(201);
    fileIds.push(f.body.fileId);
  }
  const created = await c.post(url('/receipts'), { fileIds, ...extra });
  expect(created.status).toBe(201);
  await worker.drain(['ai']);
  return (await c.get(url(`/receipts/${created.body.id}`))).body;
}

const spend = async (date: string, amount: string, payee: string, accountId = card, categoryId?: string) =>
  (
    await c.post(url('/transactions'), {
      date,
      accountId,
      amount: usd(amount),
      payee,
      ...(categoryId ? { categoryId } : {}),
    })
  ).body;

/** Category name → split amount (minor units, positive = spent) of a transaction. */
const splitsOf = async (transactionId: string) => {
  const t = (await c.get(url(`/transactions/${transactionId}`))).body;
  const names = new Map((await c.get(url('/categories'))).body.data.map((x: any) => [x.id, x.name]));
  return Object.fromEntries(
    t.splits.map((s: any) => [names.get(s.accountId) ?? s.accountId, String(-BigInt(s.amount))]),
  );
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', AI_LOCAL_DIRECT: 'true' });
  h.app.get(ReceiptJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await new FxRatesService(
    h.app.get(Db),
    { ...h.app.get(CONFIG), OXR_APP_ID: undefined },
    fixtureHttp().get,
  ).refresh('daily');
  const ws = (
    await c.post('/v1/workspaces', { name: 'Receipts', baseCurrency: 'USD', template: 'household' })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  // The fake provider reads the text carried in the photo, so these tests let photos go to the AI.
  await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
  card = (await c.post(url('/accounts'), { name: 'Visa', kind: 'credit_card', last4: '1234' })).body.id;
  checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('the Walmart receipt (Phase 5 exit criterion 1, requirements §3.5)', () => {
  let receipt: any;
  let txn: any;

  it('reads, categorizes items, matches the card line and splits it exactly', async () => {
    txn = await spend('2026-10-06', '-2871', 'WALMART SUPERCENTER #1234 BENTONVILLE AR');
    receipt = await capture(WALMART);
    expect(receipt).toMatchObject({
      status: 'matched',
      merchant: 'WALMART SUPERCENTER',
      receiptDate: '2026-10-05',
      localTime: '14:32',
      currency: 'USD',
      total: '2871',
      tax: '175',
      taxIncluded: false,
      cardLast4: '1234',
      validationGap: '0',
      transactionId: txn.id,
    });
    expect(receipt.matchScore).toBeGreaterThanOrEqual(0.8);
    expect(receipt.lines.map((l: any) => [l.rawText, l.expandedName])).toEqual([
      ['GV 2% MLK GAL', 'Great Value 2% milk 1 gal'],
      ['BANANAS', null],
      ['ONN USB-C CHRGR', 'onn. USB-C charger'],
      ['TS MENS TEE', "Men's T-shirt"],
    ]);
    expect(receipt.lines.map((l: any) => l.categoryId)).toEqual([
      cat('Groceries'),
      cat('Groceries'),
      cat('Electronics'),
      cat('Clothing'),
    ]);
    expect(receipt.groups.map((g: any) => [g.total, g.tax])).toEqual([
      ['510', '0'],
      ['1391', '103'],
      ['970', '72'],
    ]);
    expect(await splitsOf(txn.id)).toEqual({ Groceries: '510', Electronics: '1391', Clothing: '970' });
    const t = (await c.get(url(`/transactions/${txn.id}`))).body;
    expect(t.categorization).toMatchObject({ step: 'receipt' });
    expect(t.localTime).toBe('14:32:00'); // TZ-03
  });

  it('shows the receipt on its transaction, and one added from a transaction while it needs a look', async () => {
    expect((await c.get(url(`/transactions/${txn.id}`))).body.receipt).toEqual({
      id: receipt.id,
      status: 'matched',
    });
    const other = await spend('2026-10-26', '-1500', 'CORNER HARDWARE', checking);
    expect((await c.get(url(`/transactions/${other.id}`))).body.receipt).toBeNull();
    // Added from that transaction, but it doesn't add up to the charge: it waits for a look, and still shows there.
    const added = await capture(['CORNER HARDWARE', '10/26/2026', 'NAILS   12.00 T', 'TOTAL   12.00'], {
      transactionId: other.id,
    });
    expect(added).toMatchObject({ status: 'needs_review', transactionId: null });
    expect((await c.get(url(`/transactions/${other.id}`))).body.receipt).toEqual({
      id: added.id,
      status: 'needs_review',
    });
    const listed = (await c.get(url('/transactions?limit=200'))).body.data;
    expect(listed.find((x: any) => x.id === other.id).receipt).toEqual({
      id: added.id,
      status: 'needs_review',
    });
    // Deleted, it's gone from the transaction, so the screen offers "Add a receipt" again.
    expect((await c.delete(url(`/receipts/${added.id}`))).status).toBe(204);
    expect((await c.get(url(`/transactions/${other.id}`))).body.receipt).toBeNull();
  });

  it('keeps the image 7 years and serves it to the review screen (RCP-06, RCP-10)', async () => {
    expect(receipt.retainUntil.slice(0, 4)).toBe(String(new Date().getUTCFullYear() + 7));
    const res = await h.app.inject({
      method: 'GET',
      url: url(`/receipts/${receipt.id}/files/${receipt.fileIds[0]}`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect([...res.rawPayload.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('finds receipts by what is on them (RCP-10)', async () => {
    const found = (await c.get(url('/receipts?q=chrgr'))).body.data.map((r: any) => r.id);
    expect(found).toContain(receipt.id);
    expect(
      (await c.get(url('/receipts?q=walmart&status=matched'))).body.data.map((r: any) => r.id),
    ).toContain(receipt.id);
    expect((await c.get(url('/receipts?q=zucchini'))).body.data).toEqual([]);
  });

  it('re-splits the transaction when a reviewed line changes, and learns an item rule (RCP-06)', async () => {
    const lines = receipt.lines.map((l: any) => ({
      id: l.id,
      rawText: l.rawText,
      lineTotal: l.lineTotal,
      discount: l.discount,
      taxable: l.taxable,
      ...(l.rawText === 'TS MENS TEE' ? { categoryId: cat('Gifts') } : {}),
    }));
    const updated = await c.patch(url(`/receipts/${receipt.id}`), { version: receipt.version, lines });
    expect(updated.status).toBe(200);
    expect(await splitsOf(txn.id)).toEqual({
      Groceries: '510',
      Electronics: '1391',
      Gifts: '970',
    });
    const rules = (await c.get(url('/rules'))).body.data;
    expect(rules).toContainEqual(
      expect.objectContaining({ scope: 'receipt_line', name: "Men's T-shirt → Gifts" }),
    );
    // The same item on the next receipt follows the rule.
    const next = await capture([
      'TARGET',
      '11/02/2026 10:05',
      'TS MENS TEE   8.98 T',
      'TAX 0.72',
      'TOTAL 9.70',
    ]);
    expect(next.lines[0]).toMatchObject({
      categoryId: cat('Gifts'),
      categorization: { step: 'rule' },
    });
  });
});

describe('a receipt in another currency (Phase 5 exit criterion 2, CUR-04)', () => {
  it('matches €40.00 to a $43.60 card line within ±3% and stores the actual rate', async () => {
    const txn = await spend('2026-10-31', '-4360', 'GALERIES LAFAYETTE PARIS FR');
    const receipt = await capture([
      'GALERIES LAFAYETTE',
      '2026-10-30',
      'CURRENCY EUR',
      'FOULARD SOIE   40,00',
      'TOTAL   40,00',
    ]);
    expect(receipt).toMatchObject({
      status: 'matched',
      currency: 'EUR',
      total: '4000',
      transactionId: txn.id,
      fxRate: '1.09',
    });
    expect(receipt.candidates[0].reasons[0]).toBe('converted at 1.0912 (-0.11%)');
    const t = (await c.get(url(`/transactions/${txn.id}`))).body;
    expect(t.foreign).toMatchObject({
      original: { amount: '-4000', currency: 'EUR' },
      rate: '1.09',
      rateSource: 'implied',
    });
    expect(t.splits.reduce((s: bigint, x: any) => s + BigInt(x.amount), 0n)).toBe(-4360n);
  });

  it('accepts VAT-inclusive receipts and a tip (taxIncluded)', async () => {
    const receipt = await capture([
      'LE PETIT BISTRO',
      '2026-10-30 20:45',
      'CURRENCY EUR',
      'CAFE CREME 2 @ 4,50     9,00',
      'CROQUE MONSIEUR        14,50',
      'TVA 10%                 2,14',
      'TIP                     3,00',
      'TOTAL                  26,50',
    ]);
    expect(receipt).toMatchObject({
      taxIncluded: true,
      tax: '214',
      tip: '300',
      total: '2650',
      validationGap: '0',
    });
    expect(receipt.status).toBe('inbox'); // no card line yet
  });
});

describe('the inbox (IMP-11)', () => {
  it('waits for its transaction, then links when matched again', async () => {
    const receipt = await capture(['SHELL', '10/20/2026', 'UNLEADED   45.00', 'TOTAL   45.00']);
    expect(receipt).toMatchObject({ status: 'inbox', candidates: [] });
    await spend('2026-10-21', '-4500', 'SHELL OIL 57444');
    const matched = await c.post(url(`/receipts/${receipt.id}/match`));
    expect(matched.body).toMatchObject({ status: 'matched' });
  });

  it('flags receipts that do not add up, with the gap (RCP-05)', async () => {
    const receipt = await capture(['KROGER', '10/22/2026', 'EGGS   3.99 N', 'MILK   2.49 N', 'TOTAL   7.48']);
    expect(receipt).toMatchObject({ status: 'needs_review', validationGap: '100' });
  });

  it('records a cash purchase from the receipt itself', async () => {
    const cash = (await c.post(url('/accounts'), { name: 'Cash', kind: 'cash' })).body.id;
    const receipt = await capture([
      'FARMERS MARKET',
      '10/24/2026',
      'EGGS   6.00 N',
      'BREAD   5.00 N',
      'TOTAL   11.00',
    ]);
    const applied = await c.post(url(`/receipts/${receipt.id}/apply`), {
      createTransaction: { accountId: cash },
      version: receipt.version,
    });
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('matched');
    expect(await splitsOf(applied.body.transactionId)).toEqual({ Groceries: '1100' });
  });

  it('flags a receipt scanned twice as a likely duplicate, until one copy is discarded (RCP-13)', async () => {
    const lines = ['11/02/2026', 'MUFFIN   4.50 N', 'COFFEE   3.00 N', 'TOTAL   7.50'];
    const first = await capture(['CORNER BAKERY', ...lines]);
    const again = await capture(['CORNER BAKERY #12', ...lines]);
    const otherStore = await capture(['HILLTOP CAFE', ...lines]);
    expect(again.likelyDuplicates).toEqual([
      expect.objectContaining({ id: first.id, merchant: 'CORNER BAKERY', total: '750' }),
    ]);
    const firstNow = (await c.get(url(`/receipts/${first.id}`))).body;
    expect(firstNow.likelyDuplicates.map((d: { id: string }) => d.id)).toEqual([again.id]);
    expect(otherStore.likelyDuplicates).toEqual([]);

    expect((await c.delete(url(`/receipts/${again.id}`))).status).toBe(204);
    expect((await c.get(url(`/receipts/${first.id}`))).body.likelyDuplicates).toEqual([]);
  });

  it('refuses to apply when the receipt differs from the charge', async () => {
    const receipt = await capture(['CVS', '10/25/2026', 'VITAMINS   12.00 T', 'TOTAL   12.00']);
    const other = await spend('2026-10-25', '-1500', 'CVS PHARMACY', checking);
    const res = await c.post(url(`/receipts/${receipt.id}/apply`), {
      transactionId: other.id,
      version: receipt.version,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('receipt.gap');
  });
});

describe('AI modes', () => {
  it('OCRs receipts first by default: photos go to the AI only when allowed (UP-06, ADR-0014 §7)', async () => {
    await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: false });
    try {
      expect((await c.get(url('/ai/settings'))).body.allowReceiptImagesToLlm).toBe(false);
      const f = await upload(encodeFakeReceiptImage(WALMART), 'private.png');
      const created = (await c.post(url('/receipts'), { fileIds: [f.body.fileId] })).body;
      const { rows } = await admin.query(
        `select then_job from app.job where type = 'receipt.ocr' and payload->>'receiptId' = $1`,
        [created.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].then_job).toMatchObject({ queue: 'ai', type: 'receipt.extract' });
      // No doc-worker here: cancel the job so later tests that play the doc-worker don't pick it up.
      await admin.query(
        `update app.job set status = 'cancelled' where type = 'receipt.ocr' and payload->>'receiptId' = $1`,
        [created.id],
      );
    } finally {
      await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
    }
  });

  it('sends receipts to review for manual entry when AI is off', async () => {
    await c.patch(url('/ai/settings'), { mode: 'off' });
    try {
      const receipt = await capture(WALMART);
      expect(receipt).toMatchObject({ status: 'needs_review', lines: [] });
      expect(receipt.extraction.warnings[0]).toMatch(/AI is off/);
      const typed = await c.patch(url(`/receipts/${receipt.id}`), {
        version: receipt.version,
        currency: 'USD',
        total: '500',
        lines: [{ rawText: 'Notebook', lineTotal: '500', categoryId: cat('Education') }],
      });
      expect(typed.body).toMatchObject({ status: 'inbox', validationGap: '0' });
    } finally {
      await c.patch(url('/ai/settings'), { mode: 'builtin' });
    }
  });

  it('OCRs in the doc-worker first in local mode, and never sends the image', async () => {
    await c.patch(url('/ai/settings'), { mode: 'local', endpoint: 'http://localhost:11434/v1' });
    try {
      const f = await upload(encodeFakeReceiptImage('IGNORED'), 'local.png');
      const created = (await c.post(url('/receipts'), { fileIds: [f.body.fileId] })).body;
      const { rows } = await admin.query(
        `select id, payload, then_job from app.job where type = 'receipt.ocr' and payload->>'receiptId' = $1`,
        [created.id],
      );
      expect(rows[0].then_job).toMatchObject({ queue: 'ai', type: 'receipt.extract' });
      // Play the doc-worker: complete the OCR job with the text, which queues receipt.extract.
      const text = ['TRADER JOES', '10/26/2026', 'BANANAS   1.20 N', 'TOTAL   1.20'].join('\n');
      await admin.query(`update app.job set status = 'running' where id = $1`, [rows[0].id]);
      await admin.query(`select app.complete_job($1, $2::jsonb)`, [
        rows[0].id,
        JSON.stringify({
          kind: 'receipt_text',
          pages: [text],
          pageCount: 1,
          textLayer: false,
          ocrEngine: 'tesseract',
        }),
      ]);
      await worker.drain(['ai']);
      const read = (await c.get(url(`/receipts/${created.id}`))).body;
      expect(read).toMatchObject({ merchant: 'TRADER JOES', total: '120', extraction: { mode: 'local' } });
    } finally {
      await c.patch(url('/ai/settings'), { mode: 'builtin' });
    }
  });
});

describe('a receipt nothing is reading', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const jobOf = async (receiptId: string, type: string) =>
    (
      await admin.query(`select id from app.job where type = $1 and payload->>'receiptId' = $2`, [
        type,
        receiptId,
      ])
    ).rows[0].id as string;

  it('says when the doc-worker hasn’t picked up its OCR, and when the OCR failed', async () => {
    await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: false });
    try {
      const f = await upload(encodeFakeReceiptImage(WALMART), 'waiting.png');
      const created = (await c.post(url('/receipts'), { fileIds: [f.body.fileId] })).body;
      // Just queued: still reading, nothing to say yet.
      expect(created).toMatchObject({ status: 'processing', stalled: null });
      const job = await jobOf(created.id, 'receipt.ocr');
      await admin.query(`update app.job set run_after = $2 where id = $1`, [job, ago(10)]);
      const waiting = (await c.get(url(`/receipts/${created.id}`))).body;
      expect(waiting.stalled).toEqual({ worker: 'documents', reason: 'waiting', since: expect.any(String) });
      // The list says the same, so the web's "being read" panel can show it.
      const listed = (await c.get(url('/receipts?status=processing'))).body.data;
      expect(listed.find((r: any) => r.id === created.id).stalled).toMatchObject({ reason: 'waiting' });
      await admin.query(`update app.job set status = 'failed' where id = $1`, [job]);
      expect((await c.get(url(`/receipts/${created.id}`))).body.stalled).toMatchObject({
        worker: 'documents',
        reason: 'failed',
      });
      await admin.query(`update app.job set status = 'cancelled' where id = $1`, [job]);
    } finally {
      await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
    }
  });

  it('says when the job worker hasn’t picked up the AI read', async () => {
    const f = await upload(encodeFakeReceiptImage(WALMART), 'no-worker.png');
    const created = (await c.post(url('/receipts'), { fileIds: [f.body.fileId] })).body;
    const job = await jobOf(created.id, 'receipt.extract');
    await admin.query(`update app.job set run_after = $2 where id = $1`, [job, ago(10)]);
    expect((await c.get(url(`/receipts/${created.id}`))).body.stalled).toMatchObject({
      worker: 'jobs',
      reason: 'waiting',
    });
    // Once a worker runs it, the receipt is read and the warning goes.
    await worker.drain(['ai']);
    const read = (await c.get(url(`/receipts/${created.id}`))).body;
    expect(read.status).not.toBe('processing');
    expect(read.stalled).toBeNull();
  });

  it('says why AI can’t read it when “your own key” has no key', async () => {
    await c.patch(url('/ai/settings'), { mode: 'byok', apiKey: 'sk-test-abcdefgh1234' });
    await c.patch(url('/ai/settings'), { clearKey: true });
    try {
      const receipt = await capture(WALMART);
      expect(receipt).toMatchObject({ status: 'needs_review', lines: [] });
      expect(receipt.extraction.warnings[0]).toMatch(
        /no key is saved\. Add one in Settings → AI\. Until then, enter the lines yourself/,
      );
    } finally {
      await c.patch(url('/ai/settings'), { mode: 'builtin' });
    }
  });
});

describe('receipt recommended (RCP-11)', () => {
  it('lists multi-department purchases over $50 without a receipt, until dismissed', async () => {
    const big = await spend(
      '2026-10-27',
      '-7500',
      'TARGET T-1234 MINNEAPOLIS MN',
      checking,
      cat('Household'),
    );
    await spend('2026-10-27', '-2000', 'TARGET T-1234 MINNEAPOLIS MN', checking, cat('Household'));
    await spend('2026-10-27', '-9900', 'APPLE STORE', checking, cat('Electronics'));
    const ids = (await c.get(url('/receipts/recommended'))).body.data.map((r: any) => r.transactionId);
    expect(ids).toEqual([big.id]);
    expect((await c.post(url(`/receipts/recommended/${big.id}/dismiss`))).status).toBe(204);
    expect((await c.get(url('/receipts/recommended'))).body.data).toEqual([]);
  });
});

describe('online order history (RCP-12)', () => {
  const csv = [
    'Website,Order ID,Order Date,Currency,Unit Price,Unit Price Tax,Shipping Charge,Total Owed,Quantity,Product Name',
    'Amazon.com,111-0000001-0000001,2026-10-28T10:00:00Z,USD,9.99,0.80,0,21.58,2,USB-C Cable 2-pack',
    'Amazon.com,111-0000002-0000002,2026-10-29T10:00:00Z,USD,24.99,2.00,0,26.99,1,Cotton T-shirt',
    'Amazon.com,111-0000002-0000002,2026-10-29T10:00:00Z,USD,3.49,0,0,3.49,1,Bananas organic',
  ].join('\n');

  it('creates one receipt per order, categorizes its lines and matches the charge', async () => {
    const txn = await spend('2026-10-30', '-3048', 'AMAZON.COM*AB12C', card);
    const first = await upload(Buffer.from(csv), 'Retail.OrderHistory.1.csv', '/receipts/order-history');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ orders: 2, created: 2, duplicates: 0, matched: 1 });
    const second = await upload(Buffer.from(csv), 'Retail.OrderHistory.1.csv', '/receipts/order-history');
    expect(second.body).toMatchObject({ orders: 2, created: 0, duplicates: 2 });
    expect(await splitsOf(txn.id)).toEqual({ Clothing: '2699', Groceries: '349' });
  });

  it('rejects files that are not order history', async () => {
    const res = await upload(Buffer.from('Date,Amount\n2026-10-01,5'), 'x.csv', '/receipts/order-history');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('receipt.order_history_invalid');
  });
});

describe('trips (CUR-09)', () => {
  it('tags transactions in the window, new ones too, and untags on delete', async () => {
    const before = await spend('2026-11-03', '-1000', 'CAFE DE FLORE', checking, cat('Dining out'));
    const trip = await c.post(url('/trips'), {
      name: 'Paris',
      startDate: '2026-11-02',
      endDate: '2026-11-09',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    });
    expect(trip.status).toBe(201);
    expect(trip.body.transactionCount).toBe(1);
    const during = await spend('2026-11-05', '-2000', 'LOUVRE', checking, cat('Entertainment'));
    expect(during.tripId).toBe(trip.body.id);
    expect((await c.get(url(`/transactions/${before.id}`))).body.tripId).toBe(trip.body.id);
    const moved = await c.patch(url(`/trips/${trip.body.id}`), {
      name: 'Paris',
      startDate: '2026-11-04',
      endDate: '2026-11-09',
      currency: 'EUR',
      version: trip.body.version,
    });
    expect(moved.body.transactionCount).toBe(1);
    expect((await c.get(url(`/transactions/${before.id}`))).body.tripId).toBeNull();
    expect((await c.delete(url(`/trips/${trip.body.id}`))).status).toBe(204);
    expect((await c.get(url(`/transactions/${during.id}`))).body.tripId).toBeNull();
  });
});

describe('uploads', () => {
  it('accepts photos and PDFs by content only, and reports duplicates', async () => {
    const bad = await upload(Buffer.from('GIF89a...'), 'receipt.jpg');
    expect(bad.status).toBe(415);
    const png = encodeFakeReceiptImage('DUP TEST');
    const a = await upload(png, 'a.png');
    const b = await upload(png, 'b.png');
    expect(b.body.duplicateOf).toEqual({ fileId: a.body.fileId, receiptId: null });
  });

  it('keeps receipts private to their workspace', async () => {
    const other = h.as('outsider@example.com');
    expect((await other.get(url('/receipts'))).status).toBe(403);
  });
});
