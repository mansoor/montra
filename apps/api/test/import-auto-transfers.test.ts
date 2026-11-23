/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { Db } from '../src/db/database.js';
import { FxRatesService } from '../src/fx/fx.service.js';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { fixtureHttp } from './fx-fixtures.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Import makes sure transfer pairs transfers on its own (TXN-04, AI-03; ADR-0028 amendment of 2026-11-23): a card
// payment on both statements becomes one transfer when the second statement is committed, at or above the workspace's
// setting. Weaker pairs wait in Review, and so does a pair whose other side is reconciled, claimed twice or in another
// currency. Undoing the import, or the transfer itself, brings both sides back.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'auto-transfers@example.com';

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

async function setup(name: string, opts: { transferThreshold?: number | null; cardCurrency?: string } = {}) {
  const ws = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  if (opts.transferThreshold !== undefined) {
    const res = await c.patch(url('/ai/settings'), { transferThreshold: opts.transferThreshold });
    expect(res.status).toBe(200);
    expect(res.body.transferThreshold).toBe(opts.transferThreshold);
  }
  const checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id as string;
  const card = (
    await c.post(url('/accounts'), {
      name: 'Visa',
      kind: 'credit_card',
      last4: '4321',
      ...(opts.cardCurrency ? { currency: opts.cardCurrency } : {}),
    })
  ).body.id as string;
  /** Imports a CSV on an account and commits it; returns the committed batch. */
  const importCsv = async (accountId: string, file: string, csv: string) => {
    const fileId = await upload(ws.id, file, csv);
    const batch = (await c.post(url('/imports'), { fileId, accountId })).body;
    await worker.drain();
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain();
    const done = (await c.get(url(`/imports/${batch.id}`))).body;
    expect(done.status).toBe('committed');
    return done;
  };
  const preview = async (accountId: string, file: string, csv: string) => {
    const fileId = await upload(ws.id, file, csv);
    const batch = (await c.post(url('/imports'), { fileId, accountId })).body;
    await worker.drain();
    return (await c.get(url(`/imports/${batch.id}/rows`))).body.data as any[];
  };
  const undoImport = async (batchId: string) => {
    expect((await c.post(url(`/imports/${batchId}/undo`))).status).toBe(202);
    await worker.drain();
    return (await c.get(url(`/imports/${batchId}`))).body;
  };
  const review = async () => (await c.get(url('/review'))).body.items as any[];
  const month = async (start: string) => (await c.get(url(`/dashboard?period=${start}`))).body;
  const register = async (accountId: string) =>
    (await c.get(url(`/accounts/${accountId}/register`))).body.data as any[];
  const balance = async (id: string) =>
    (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;
  const get = async (id: string) => (await c.get(url(`/transactions/${id}`))).body;
  return { ws, url, checking, card, importCsv, preview, undoImport, review, month, register, balance, get };
}

const CHECKING_OCT = `Date,Description,Amount
2026-10-01,ACME PAYROLL,3000.00
2026-10-05,ONLINE PAYMENT TO CARD XXXX4321,-500.00
2026-10-07,GROCERY STORE,-80.00
`;
// The payment pairs with the checking side at 0.95. The store credit matches the groceries on amount alone (0.60).
const CARD_OCT = `Date,Description,Amount
2026-10-03,BLUE BOTTLE COFFEE,-6.50
2026-10-06,PAYMENT THANK YOU,500.00
2026-10-08,STORE CREDIT,80.00
`;

const big = (l: any) => (l.debit ?? l.credit) === '50000';
const find = (items: any[], text: string) => items.find((i) => i.description.includes(text));

describe('a sure pair becomes a transfer at import (default 0.95)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let checkingSide: string;
  let cardBatch: any;
  let cardSide: string;
  let cardBalance: string;

  beforeAll(async () => {
    w = await setup('Auto transfers');
    expect((await c.get(w.url('/ai/settings'))).body.transferThreshold).toBe(0.95);
    const b = await w.importCsv(w.checking, 'checking-oct.csv', CHECKING_OCT);
    expect(b.counts.transfers).toBe(0);
    // Only one side is in: the account named by its last 4 (0.80) waits, as before.
    const pay = find(await w.review(), 'PAYMENT TO CARD');
    expect(pay.categorization).toMatchObject({ confidence: 0.8, transfer: { transactionId: null } });
    checkingSide = pay.transactionId;
    expect(await w.balance(w.checking)).toBe('242000');
  });

  it('makes the pair one transfer when the card statement is committed, and says so', async () => {
    cardBatch = await w.importCsv(w.card, 'card-oct.csv', CARD_OCT);
    expect(cardBatch.counts).toMatchObject({ added: 3, transfers: 1 });

    const items = await w.review();
    expect(items.some((i) => i.description.includes('PAYMENT'))).toBe(false);
    const rows = (await c.get(w.url(`/imports/${cardBatch.id}/rows`))).body.data as any[];
    cardSide = rows.find((r) => r.description.includes('THANK YOU')).transactionId;
    const t = await w.get(cardSide);
    expect(t.entries.map((e: any) => e.kind)).toEqual(['transfer']);
    expect(t.reviewState).toBe('auto_applied');
    expect(t.categorization).toMatchObject({
      step: 'transfer',
      confidence: 0.95,
      transfer: { accountId: w.checking, transactionId: checkingSide, made: 'import' },
    });
    // The checking side is absorbed: in the trash.
    expect((await w.get(checkingSide)).status).toBe('void');
  });

  it('leaves the weaker pair waiting in Review', async () => {
    const credit = find(await w.review(), 'STORE CREDIT');
    expect(credit.categorization).toMatchObject({ step: 'transfer', confidence: 0.6 });
    expect((await w.get(credit.transactionId)).entries.map((e: any) => e.kind)).not.toContain('transfer');
  });

  it('keeps the balances and both statement lines; the payment stops counting as spending and income', async () => {
    expect(await w.balance(w.checking)).toBe('242000');
    cardBalance = await w.balance(w.card);
    const oct = await w.month('2026-10-01');
    expect(oct.spent.amount).toBe('8650');
    expect(oct.income.amount).toBe('308000');
    const onChecking = (await w.register(w.checking)).filter(big);
    const onCard = (await w.register(w.card)).filter(big);
    expect(onChecking.map((l) => l.transactionId)).toEqual([cardSide]);
    expect(onCard.map((l) => l.transactionId)).toEqual([cardSide]);
    expect([onChecking[0].cleared, onCard[0].cleared]).toEqual(['cleared', 'cleared']);
  });

  it('undoing the card import takes the transfer apart and brings the checking side back', async () => {
    const undone = await w.undoImport(cardBatch.id);
    expect(undone.status).toBe('undone');
    expect(undone.job.result).toMatchObject({ voided: 3, transfers: 1, kept: [] });

    const back = await w.get(checkingSide);
    expect(back.status).toBe('posted');
    expect(back.reviewState).toBe('needs_review');
    expect(back.categorization).toMatchObject({ confidence: 0.8, transfer: { transactionId: null } });
    expect((await w.get(cardSide)).status).toBe('void');
    const onChecking = (await w.register(w.checking)).filter(big);
    expect(onChecking.map((l) => [l.transactionId, l.cleared])).toEqual([[checkingSide, 'cleared']]);
    expect((await w.register(w.card)).filter(big)).toEqual([]);

    expect(await w.balance(w.checking)).toBe('242000');
    expect(await w.balance(w.card)).toBe('0');
    const oct = await w.month('2026-10-01');
    expect(oct.spent.amount).toBe('58000');
    expect(oct.income.amount).toBe('300000');
  });

  it('importing the card statement again pairs it again, and re-importing either statement adds nothing', async () => {
    cardBatch = await w.importCsv(w.card, 'card-oct-2.csv', CARD_OCT);
    expect(cardBatch.counts).toMatchObject({ added: 3, transfers: 1 });
    const rows = (await c.get(w.url(`/imports/${cardBatch.id}/rows`))).body.data as any[];
    cardSide = rows.find((r) => r.description.includes('THANK YOU')).transactionId;
    expect(await w.balance(w.card)).toBe(cardBalance);
    for (const [account, file, csv] of [
      [w.checking, 'checking-oct-again.csv', CHECKING_OCT],
      [w.card, 'card-oct-again.csv', CARD_OCT],
    ] as const) {
      const again = await w.preview(account, file, csv);
      expect(again.map((r) => r.status)).toEqual(again.map(() => 'duplicate'));
    }
  });

  it('can be undone from the transaction, as one made by hand can', async () => {
    const res = await c.post(w.url(`/transactions/${cardSide}/undo-transfer`));
    expect(res.status).toBe(200);
    expect(res.body.restoredId).toBe(checkingSide);
    expect(res.body.transaction.entries.map((e: any) => e.kind)).not.toContain('transfer');
    expect(res.body.transaction.categorization).toMatchObject({ step: 'transfer', confidence: 0.95 });
    expect(res.body.transaction.categorization.transfer.made ?? null).toBeNull();

    const items = await w.review();
    expect(find(items, 'THANK YOU').transactionId).toBe(cardSide);
    expect(find(items, 'PAYMENT TO CARD').transactionId).toBe(checkingSide);
    expect(await w.balance(w.checking)).toBe('242000');
    expect(await w.balance(w.card)).toBe(cardBalance);
    expect((await w.month('2026-10-01')).spent.amount).toBe('58650');
    const lines = [...(await w.register(w.checking)), ...(await w.register(w.card))].filter(big);
    expect(lines.map((l) => l.cleared)).toEqual(['cleared', 'cleared']);
    // Nothing left to undo.
    const again = await c.post(w.url(`/transactions/${cardSide}/undo-transfer`));
    expect(again.status).toBe(422);
  });

  it('a transfer made by hand can be undone the same way', async () => {
    const made = await c.post(w.url(`/transactions/${cardSide}/make-transfer`), { accountId: w.checking });
    expect(made.status).toBe(200);
    expect(made.body.absorbedId).toBe(checkingSide);
    expect(made.body.transaction.categorization.transfer.made).toBe('you');
    const res = await c.post(w.url(`/transactions/${cardSide}/undo-transfer`));
    expect(res.status).toBe(200);
    expect(res.body.restoredId).toBe(checkingSide);
    expect((await w.month('2026-10-01')).spent.amount).toBe('58650');
    expect(await w.balance(w.card)).toBe(cardBalance);
  });
});

describe('the setting', () => {
  it('turned off, every pair waits in Review', async () => {
    const w = await setup('Auto transfers off', { transferThreshold: null });
    await w.importCsv(w.checking, 'checking-oct.csv', CHECKING_OCT);
    const card = await w.importCsv(w.card, 'card-oct.csv', CARD_OCT);
    expect(card.counts.transfers).toBe(0);
    const pay = find(await w.review(), 'THANK YOU');
    expect(pay.categorization).toMatchObject({ step: 'transfer', confidence: 0.95 });
    expect((await w.month('2026-10-01')).spent.amount).toBe('58650');
  });

  it('above a pair’s confidence, the pair waits in Review', async () => {
    const w = await setup('Auto transfers strict', { transferThreshold: 0.99 });
    await w.importCsv(w.checking, 'checking-oct.csv', CHECKING_OCT);
    const card = await w.importCsv(w.card, 'card-oct.csv', CARD_OCT);
    expect(card.counts.transfers).toBe(0);
    expect(find(await w.review(), 'THANK YOU').categorization.confidence).toBe(0.95);
  });

  it('refuses a threshold that would pair on amount alone', async () => {
    const w = await setup('Auto transfers bounds');
    expect((await c.patch(w.url('/ai/settings'), { transferThreshold: 0.6 })).status).toBe(400);
  });
});

describe('pairs left in Review', () => {
  it('a reconciled other side is skipped, not forced (DE-10)', async () => {
    const w = await setup('Auto transfers reconciled');
    await w.importCsv(w.checking, 'checking-oct.csv', CHECKING_OCT);
    const rec = (
      await c.post(w.url(`/accounts/${w.checking}/reconciliations`), {
        statementDate: '2026-10-31',
        statementBalance: usd('242000'),
      })
    ).body;
    const open = rec.lines.filter((l: any) => l.cleared === 'uncleared').map((l: any) => l.postingId);
    if (open.length) await c.post(w.url(`/reconciliations/${rec.id}/cleared`), { clear: open });
    expect((await c.post(w.url(`/reconciliations/${rec.id}/complete`))).status).toBe(200);

    const card = await w.importCsv(w.card, 'card-oct.csv', CARD_OCT);
    expect(card.counts.transfers).toBe(0);
    expect(find(await w.review(), 'THANK YOU').categorization.confidence).toBe(0.95);
    expect(find(await w.review(), 'PAYMENT TO CARD')).toBeTruthy();
  });

  it('an other side in closed books is skipped', async () => {
    const w = await setup('Auto transfers closed');
    await w.importCsv(w.checking, 'checking-oct.csv', CHECKING_OCT);
    const me = (await c.get(w.url(''))).body;
    const personal = me.entities.find((e: any) => e.type === 'personal').id;
    await c.put(w.url(`/entities/${personal}/period-lock`), { lockedThrough: '2026-10-05' });
    const card = await w.importCsv(
      w.card,
      'card-oct.csv',
      `Date,Description,Amount
2026-10-06,PAYMENT THANK YOU,500.00
`,
    );
    expect(card.counts.transfers).toBe(0);
    expect(find(await w.review(), 'THANK YOU').categorization.confidence).toBe(0.95);
  });

  it('one other side claimed by two lines of the same import is left for the person', async () => {
    const w = await setup('Auto transfers claimed twice');
    await w.importCsv(w.checking, 'checking-oct.csv', CHECKING_OCT);
    const card = await w.importCsv(
      w.card,
      'card-twice.csv',
      `Date,Description,Amount
2026-10-04,PAYMENT THANK YOU,500.00
2026-10-06,PAYMENT THANK YOU,500.00
`,
    );
    expect(card.counts.transfers).toBe(0);
    const waiting = (await w.review()).filter((i) => i.description.includes('THANK YOU'));
    expect(waiting.map((i) => i.categorization.confidence)).toEqual([0.95, 0.95]);
  });

  it('two accounts in different currencies are left for the person (the amount received is needed)', async () => {
    await new FxRatesService(
      h.app.get(Db),
      { ...h.app.get(CONFIG), OXR_APP_ID: undefined },
      fixtureHttp().get,
    ).refresh('daily');
    const w = await setup('Auto transfers currencies', { cardCurrency: 'EUR' });
    await w.importCsv(
      w.checking,
      'checking-late-oct.csv',
      `Date,Description,Amount
2026-10-29,ONLINE PAYMENT TO CARD XXXX4321,-500.00
`,
    );
    const card = await w.importCsv(
      w.card,
      'card-late-oct.csv',
      `Date,Description,Amount
2026-10-30,PAYMENT THANK YOU,500.00
`,
    );
    expect(card.counts.transfers).toBe(0);
    expect(find(await w.review(), 'THANK YOU').categorization.step).toBe('transfer');
  });
});
