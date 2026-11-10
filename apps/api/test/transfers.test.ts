/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Making detected transfers real (TXN-04, AI-01 step 3): a card payment recorded on both statements becomes one
// transfer, keeps both statement lines, stops counting as spending and income, and re-imports stay clean.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'transfers@example.com';

let h: Harness;
let worker: Worker;
let c: Client;

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    AI_PROVIDER: 'fake',
  });
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
});
afterAll(() => h.close());

async function upload(wsId: string, fileName: string, text: string) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.from(text),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/uploads`,
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  return JSON.parse(res.body).fileId as string;
}

async function setup(name: string) {
  const ws = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
  const card = (await c.post(url('/accounts'), { name: 'Visa', kind: 'credit_card', last4: '4321' })).body.id;
  /** Previews a CSV on an account; returns the batch and its rows. */
  const preview = async (accountId: string, file: string, csv: string) => {
    const fileId = await upload(ws.id, file, csv);
    const batch = (await c.post(url('/imports'), { fileId, accountId })).body;
    await worker.drain();
    const rows = (await c.get(url(`/imports/${batch.id}/rows`))).body.data;
    return { batchId: batch.id as string, rows: rows as any[] };
  };
  const commit = async (batchId: string) => {
    await c.post(url(`/imports/${batchId}/commit`));
    await worker.drain();
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('committed');
  };
  const review = async () => (await c.get(url('/review'))).body.items as any[];
  const month = async (start: string) => (await c.get(url(`/dashboard?period=${start}`))).body;
  const register = async (accountId: string) =>
    (await c.get(url(`/accounts/${accountId}/register`))).body.data as any[];
  return { ws, url, checking, card, preview, commit, review, month, register };
}

const CHECKING_OCT = `Date,Description,Amount
2026-10-01,ACME PAYROLL,3000.00
2026-10-05,ONLINE PAYMENT TO CARD XXXX4321,-500.00
2026-10-07,GROCERY STORE,-80.00
`;
const CARD_OCT = `Date,Description,Amount
2026-10-03,BLUE BOTTLE COFFEE,-6.50
2026-10-06,PAYMENT THANK YOU,500.00
`;

describe('making detected transfers real (TXN-04)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let checkingBatch: string;
  let cardBatch: string;

  beforeAll(async () => {
    w = await setup('Transfers');
  });

  it('suggests the card payment from the checking statement alone, by the card’s last 4 digits', async () => {
    const p = await w.preview(w.checking, 'checking-oct.csv', CHECKING_OCT);
    checkingBatch = p.batchId;
    await w.commit(checkingBatch);
    const pay = (await w.review()).find((i) => i.description.includes('PAYMENT TO CARD'));
    expect(pay.categorization).toMatchObject({
      step: 'transfer',
      confidence: 0.8,
      transfer: { accountId: w.card, transactionId: null },
    });
    // Until it's made a transfer, the payment counts as spending.
    expect((await w.month('2026-10-01')).spent.amount).toBe('58000');
  });

  it('pairs the card side with the checking side when the card statement arrives', async () => {
    const p = await w.preview(w.card, 'card-oct.csv', CARD_OCT);
    cardBatch = p.batchId;
    await w.commit(cardBatch);
    const items = await w.review();
    const checkingSide = items.find((i) => i.description.includes('PAYMENT TO CARD'));
    const cardSide = items.find((i) => i.description.includes('THANK YOU'));
    expect(cardSide.categorization).toMatchObject({
      step: 'transfer',
      confidence: 0.95,
      transfer: { accountId: w.checking, transactionId: checkingSide.transactionId },
    });
    // Both sides count: $500 spent from checking, $500 "received" on the card.
    const oct = await w.month('2026-10-01');
    expect(oct.spent.amount).toBe('58650');
    expect(oct.income.amount).toBe('350000');
  });

  it('accepting makes one transfer that keeps both statement lines, and the money stops counting', async () => {
    // Accepting the card side absorbs the checking side (accepting either works; this one keeps the test exact).
    const cardSide = (await w.review()).find((i) => i.description.includes('THANK YOU'));
    const res = (await c.post(w.url('/review/accept'), { transactionIds: [cardSide.transactionId] })).body;
    expect(res).toMatchObject({ accepted: 1, transfers: 1 });

    const left = (await w.review()).map((i) => i.description);
    expect(left.some((d: string) => d.includes('PAYMENT'))).toBe(false);
    const oct = await w.month('2026-10-01');
    expect(oct.spent.amount).toBe('8650');
    expect(oct.income.amount).toBe('300000');

    // One transfer, on both registers, both lines still cleared.
    const big = (l: any) => (l.debit ?? l.credit) === '50000';
    const onChecking = (await w.register(w.checking)).filter(big);
    const onCard = (await w.register(w.card)).filter(big);
    expect(onChecking).toHaveLength(1);
    expect(onCard).toHaveLength(1);
    expect(onChecking[0].transactionId).toBe(cardSide.transactionId);
    expect(onCard[0].transactionId).toBe(cardSide.transactionId);
    expect([onChecking[0].cleared, onCard[0].cleared]).toEqual(['cleared', 'cleared']);
    const t = (await c.get(w.url(`/transactions/${cardSide.transactionId}`))).body;
    expect(t.entries.map((e: any) => e.kind)).toEqual(['transfer']);
    // The other side is in the trash.
    const trash = (await c.get(w.url('/trash'))).body;
    expect(JSON.stringify(trash)).toContain('"amount":"-50000"');
  });

  it('re-importing either statement finds nothing new', async () => {
    for (const [account, file, csv] of [
      [w.checking, 'checking-oct-again.csv', CHECKING_OCT],
      [w.card, 'card-oct-again.csv', CARD_OCT],
    ] as const) {
      const p = await w.preview(account, file, csv);
      expect(p.rows.map((r) => r.status)).toEqual(p.rows.map(() => 'duplicate'));
    }
  });

  it('undoing the import that created the transfer keeps it, saying why', async () => {
    expect((await c.post(w.url(`/imports/${cardBatch}/undo`))).status).toBe(202);
    await worker.drain();
    const job = (await c.get(w.url(`/imports/${cardBatch}`))).body;
    expect(JSON.stringify(job)).toContain('"reason":"transfer"');
    expect((await w.month('2026-10-01')).spent.amount).toBe('8000');
  });
});

describe('a transfer made before the other statement arrives', () => {
  it('is matched by that statement instead of duplicated', async () => {
    const w = await setup('One side first');
    const p = await w.preview(
      w.checking,
      'checking-sep.csv',
      `Date,Description,Amount
2026-09-10,ONLINE PAYMENT TO CARD XXXX4321,-200.00
2026-09-12,GROCERY STORE,-40.00
`,
    );
    await w.commit(p.batchId);
    const pay = (await w.review()).find((i) => i.description.includes('PAYMENT TO CARD'));
    const made = await c.post(w.url(`/transactions/${pay.transactionId}/make-transfer`), {
      accountId: w.card,
    });
    expect(made.status).toBe(200);
    expect(made.body.absorbedId).toBeNull();
    expect(made.body.transaction.entries.map((e: any) => e.kind)).toEqual(['transfer']);
    expect((await w.month('2026-09-01')).spent.amount).toBe('4000');

    const card = await w.preview(
      w.card,
      'card-sep.csv',
      `Date,Description,Amount
2026-09-11,PAYMENT THANK YOU,200.00
`,
    );
    expect(card.rows[0]).toMatchObject({ status: 'match', matchTransactionId: pay.transactionId });
    await w.commit(card.batchId);
    const onCard = await w.register(w.card);
    expect(onCard).toHaveLength(1);
    expect(onCard[0]).toMatchObject({ transactionId: pay.transactionId, cleared: 'cleared' });
    expect((await w.review()).some((i) => i.description.includes('THANK YOU'))).toBe(false);
  });

  it('refuses the same account, a non-matching other side, and a transfer twice', async () => {
    const w = await setup('Refusals');
    const t = (
      await c.post(w.url('/transactions'), {
        date: '2026-09-02',
        accountId: w.checking,
        amount: usd('-1500'),
        payee: 'Lunch',
      })
    ).body;
    const other = (
      await c.post(w.url('/transactions'), {
        date: '2026-09-02',
        accountId: w.card,
        amount: usd('-1500'),
        payee: 'Lunch',
      })
    ).body;
    const make = (body: object) => c.post(w.url(`/transactions/${t.id}/make-transfer`), body);
    expect((await make({ accountId: w.checking })).body.code).toBe('transfer.same_account');
    expect((await make({ accountId: w.card, counterpartId: other.id })).body.code).toBe(
      'transfer.counterpart',
    );
    expect((await make({ accountId: w.card, counterpartId: null })).status).toBe(200);
    expect((await make({ accountId: w.card })).body.code).toBe('transfer.not_standard');
  });
});
