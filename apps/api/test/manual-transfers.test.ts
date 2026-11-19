/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

// "Make transfer…" by hand (TXN-04, AI-05; ADR-0028): a card or loan payment whose statement line carries the payee's
// ID rather than the card's last 4 isn't detected, so the person picks the account. The payee is remembered, so the
// next line is suggested the same way; a tracked loan (ADR-0024) takes the line as its scheduled payment.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'manual-transfers@example.com';
const today = todayIn('UTC');

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
  const checking = (
    await c.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('5000000'),
      openingDate: addDays(today, -400),
    })
  ).body.id as string;
  const card = (
    await c.post(url('/accounts'), { name: 'Chase Sapphire', kind: 'credit_card', last4: '9876' })
  ).body.id as string;
  const importCsv = async (accountId: string, file: string, csv: string) => {
    const fileId = await upload(ws.id, file, csv);
    const batch = (await c.post(url('/imports'), { fileId, accountId })).body;
    await worker.drain();
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain();
    expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('committed');
    return batch.id as string;
  };
  const review = async () => (await c.get(url('/review'))).body.items as any[];
  const month = async (start: string) => (await c.get(url(`/dashboard?period=${start}`))).body;
  const register = async (accountId: string) =>
    (await c.get(url(`/accounts/${accountId}/register`))).body.data as any[];
  const balance = async (id: string) =>
    (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;
  const add = async (accountId: string, date: string, amount: string, payee: string, extra: object = {}) =>
    (await c.post(url('/transactions'), { date, accountId, amount: usd(amount), payee, ...extra })).body;
  const make = (id: string, body: object) => c.post(url(`/transactions/${id}/make-transfer`), body);
  return { ws, url, checking, card, importCsv, review, month, register, balance, add, make };
}

const balanced = (t: any) =>
  t.entries.every((e: any) => {
    const sum = (k: 'debit' | 'credit') =>
      e.postings.reduce((s: bigint, p: any) => s + BigInt(p[k] ?? '0'), 0n);
    return sum('debit') === sum('credit');
  });

describe('making an unsuggested card payment a transfer', () => {
  let w: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    w = await setup('Manual card payment');
  });

  it('moves the money to the card, keeps the statement line cleared, and stops counting it as spending', async () => {
    await w.importCsv(
      w.checking,
      'checking-oct.csv',
      `Date,Description,Amount
2026-10-05,CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224,-500.00
2026-10-07,GROCERY STORE,-80.00
`,
    );
    const pay = (await w.review()).find((i) => i.description.includes('CHASE CREDIT'));
    expect(pay.categorization?.step).not.toBe('transfer');
    expect((await w.month('2026-10-01')).spent.amount).toBe('58000');
    const cardBefore = await w.balance(w.card);

    const made = await w.make(pay.transactionId, { accountId: w.card });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ absorbedId: null, loan: null });
    expect(made.body.transaction.entries.map((e: any) => e.kind)).toEqual(['transfer']);
    expect(balanced(made.body.transaction)).toBe(true);

    expect((await w.month('2026-10-01')).spent.amount).toBe('8000');
    expect(BigInt(await w.balance(w.card))).toBe(BigInt(cardBefore) - 50000n);
    const onChecking = (await w.register(w.checking)).find((l) => l.transactionId === pay.transactionId);
    expect(onChecking.cleared).toBe('cleared');
    expect((await w.register(w.card)).map((l) => l.transactionId)).toEqual([pay.transactionId]);
    expect((await w.review()).some((i) => i.transactionId === pay.transactionId)).toBe(false);
  });

  it('suggests the next line from the same payee as a transfer to the card, without applying it', async () => {
    await w.importCsv(
      w.checking,
      'checking-nov.csv',
      `Date,Description,Amount
2026-11-05,CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224,-612.34
`,
    );
    const next = (await w.review()).find((i) => i.description.includes('CHASE CREDIT'));
    expect(next.categorization).toMatchObject({
      step: 'transfer',
      confidence: 0.9,
      transfer: { accountId: w.card, transactionId: null },
    });
    // Still a suggestion: it counts as spending until accepted.
    expect((await w.month('2026-11-01')).spent.amount).toBe('61234');
    const res = (await c.post(w.url('/review/accept'), { transactionIds: [next.transactionId] })).body;
    expect(res).toMatchObject({ accepted: 1, transfers: 1 });
    expect((await w.month('2026-11-01')).spent.amount).toBe('0');
  });
});

describe('absorbing the line already on the chosen account', () => {
  it('makes one transfer out of the two lines', async () => {
    const w = await setup('Manual absorb');
    const out = await w.add(w.checking, '2026-09-10', '-30000', 'SALAL CU LOAN');
    const onCard = await w.add(w.card, '2026-09-11', '30000', 'ONLINE PMT RCVD');
    const made = await w.make(out.id, { accountId: w.card });
    expect(made.status).toBe(200);
    expect(made.body.absorbedId).toBe(onCard.id);
    expect(balanced(made.body.transaction)).toBe(true);
    expect((await w.register(w.card)).map((l) => l.transactionId)).toEqual([out.id]);
    expect((await c.get(w.url(`/transactions/${onCard.id}`))).body.status).toBe('void');
  });
});

describe('refusals', () => {
  it('says why in words, and changes nothing', async () => {
    const w = await setup('Manual refusals');
    const t = await w.add(w.checking, '2026-09-02', '-1500', 'Lunch');
    const code = async (body: object, id = t.id) => {
      const res = await w.make(id, body);
      expect(res.status).toBe(422);
      expect(res.body.detail).toMatch(/\w+ \w+/);
      return res.body.code as string;
    };
    expect(await code({ accountId: w.checking })).toBe('transfer.same_account');

    const old = (await c.post(w.url('/accounts'), { name: 'Old card', kind: 'credit_card' })).body.id;
    await c.patch(w.url(`/accounts/${old}`), { archived: true });
    expect(await code({ accountId: old })).toBe('transfer.archived');

    const cats = (await c.get(w.url('/categories'))).body.data;
    expect(await code({ accountId: cats[0].id })).toBe('transfer.not_an_account');

    const euro = (await c.post(w.url('/accounts'), { name: 'Euro', kind: 'checking', currency: 'EUR' })).body
      .id;
    expect(await code({ accountId: euro })).toBe('fx.amount_in_required');

    const split = await w.add(w.checking, '2026-09-03', '-3000', 'Costco', {
      splits: [
        { accountId: cats.find((x: any) => x.name === 'Groceries').id, amount: usd('-2000') },
        { accountId: cats.find((x: any) => x.name === 'Household').id, amount: usd('-1000') },
      ],
    });
    expect(split.id).toBeTruthy();
    expect(await code({ accountId: w.card }, split.id)).toBe('transfer.split');

    expect((await w.make(t.id, { accountId: w.card, counterpartId: null })).status).toBe(200);
    expect(await code({ accountId: w.card })).toBe('transfer.not_standard');
    // Nothing was remembered from the refusals: Lunch is remembered only with the card.
    const again = await w.add(w.checking, '2026-09-20', '-1500', 'Lunch');
    expect(again.categorization).toMatchObject({ step: 'transfer', transfer: { accountId: w.card } });
  });
});

describe('a tracked loan takes the line as its scheduled payment', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let loan: any;
  let interestCat: string;

  beforeAll(async () => {
    w = await setup('Manual loan payment');
    const res = await c.post(w.url('/loans'), {
      name: 'Home mortgage',
      newAccount: { kind: 'mortgage' },
      principal: '20000000',
      rateBps: 600,
      termMonths: 360,
      firstPaymentDate: addDays(today, -2),
      balanceAsOf: addDays(today, -30),
      payingAccountId: w.checking,
    });
    expect(res.status).toBe(201);
    loan = res.body;
    interestCat = (await c.get(w.url('/categories'))).body.data.find(
      (x: any) => x.name === 'Mortgage interest',
    )?.id;
  });

  it('splits it into interest and principal through the loan', async () => {
    const line = await w.add(w.checking, addDays(today, -1), `-${loan.totalPayment}`, 'USBANK LOAN');
    const owedBefore = BigInt(await w.balance(loan.loanAccountId));
    const made = await w.make(line.id, { accountId: loan.loanAccountId });
    expect(made.status).toBe(200);
    expect(made.body.loan).toEqual({ loanId: loan.id, name: 'Home mortgage', number: 1 });
    expect(made.body.transaction.managedBy).toBe('loan');
    expect(balanced(made.body.transaction)).toBe(true);
    const parts = made.body.transaction.splits.map((s: any) => [s.accountId, s.amount]);
    expect(parts).toEqual([
      [interestCat, '-100000'],
      [loan.loanAccountId, '-19910'],
    ]);
    expect(BigInt(await w.balance(loan.loanAccountId))).toBe(owedBefore - 19910n);
    const after = (await c.get(w.url('/loans'))).body.data.find((l: any) => l.id === loan.id);
    expect(after.paymentsMade).toBe(1);
  });

  it('suggests the payee’s next line for the loan, and accepting records the next payment', async () => {
    const next = (await c.get(w.url('/loans'))).body.data.find((l: any) => l.id === loan.id).next;
    const line = await w.add(w.checking, next.date, `-${next.total}`, 'USBANK LOAN');
    expect(line.categorization).toMatchObject({
      step: 'transfer',
      transfer: { accountId: loan.loanAccountId },
    });
    expect(line.reviewState).toBe('needs_review');
    const res = (await c.post(w.url('/review/accept'), { transactionIds: [line.id] })).body;
    expect(res).toMatchObject({ accepted: 1, transfers: 1 });
    const t = (await c.get(w.url(`/transactions/${line.id}`))).body;
    expect(t.managedBy).toBe('loan');
    expect((await c.get(w.url('/loans'))).body.data.find((l: any) => l.id === loan.id).paymentsMade).toBe(2);
  });

  it('falls back to a plain transfer to the loan account when no payment matches, and says so', async () => {
    const line = await w.add(w.checking, addDays(today, -1), '-25000', 'EXTRA TO MORTGAGE');
    const made = await w.make(line.id, { accountId: loan.loanAccountId });
    expect(made.status).toBe(200);
    expect(made.body.loan).toEqual({ loanId: loan.id, name: 'Home mortgage', number: null });
    expect(made.body.transaction.entries.map((e: any) => e.kind)).toEqual(['transfer']);
    expect((await c.get(w.url('/loans'))).body.data.find((l: any) => l.id === loan.id).paymentsMade).toBe(2);
  });
});
