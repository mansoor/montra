/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn, weekStartOf } from '@montra/domain';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { startHarness, type Client, type Harness } from './harness.js';

// The receipt habit (UP-09, RCP-11): this week's receipts kept and missing, and the purchases worth a receipt,
// including everyday spending above the reminder amount when one is set.
const EMAIL = 'habit@example.com';
const usd = (amount: string) => ({ amount, currency: 'USD' });
const today = todayIn('UTC');
const monday = weekStartOf(today, 1);

let h: Harness;
let c: Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;
let card: string;

const spend = async (payee: string, amount: string, category: string, accountId = checking) =>
  (
    await c.post(url('/transactions'), {
      date: monday,
      accountId,
      amount: usd(amount),
      payee,
      categoryId: cat(category),
    })
  ).body;

async function upload(bytes: Uint8Array, fileName: string) {
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
    url: url('/receipts/files'),
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  return JSON.parse(res.body) as { fileId: string };
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  const ws = (await c.post('/v1/workspaces', { name: 'Habit', baseCurrency: 'USD', template: 'household' }))
    .body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const personal = ws.entities[0].id;
  const open = { openingBalance: usd('500000'), openingDate: addDays(today, -60) };
  checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking', ...open })).body.id;
  card = (await c.post(url('/accounts'), { name: 'Visa', kind: 'credit_card', ...open })).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name && x.entityId === personal)?.id;
});

afterAll(async () => {
  await h?.close();
});

describe('receipt habit (UP-09)', () => {
  let walmart: any;
  let corner: any;

  it('counts this week’s purchases worth a receipt: multi-department stores by default', async () => {
    walmart = await spend('WALMART SUPERCENTER #1234', '-8000', 'Groceries');
    corner = await spend('CORNER STORE', '-1200', 'Groceries', card);
    await spend('OAK STREET APARTMENTS', '-150000', 'Rent');
    await spend('CAFE', '-500', 'Dining out', card);
    const r = await c.get(url('/receipts/habit'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      week: { start: monday, end: addDays(monday, 6) },
      captured: 0,
      missing: 1,
      streakWeeks: 0,
      waiting: 1,
    });
    expect(r.body.latest.map((x: any) => [x.transactionId, x.reason])).toEqual([
      [walmart.id, 'multi_department'],
    ]);
  });

  it('reminds about everyday spending above the amount set, card purchases too, never bills or small ones', async () => {
    expect((await c.patch(url('/planning/settings'), { receiptReminderMinor: '-5' })).status).toBe(400);
    const set = await c.patch(url('/planning/settings'), { receiptReminderMinor: '1000' });
    expect(set.status).toBe(200);
    expect(set.body.receiptReminderMinor).toBe('1000');
    const recommended = (await c.get(url('/receipts/recommended'))).body.data;
    expect(recommended.map((x: any) => [x.transactionId, x.reason]).sort()).toEqual(
      [
        [walmart.id, 'multi_department'],
        [corner.id, 'over_threshold'],
      ].sort(),
    );
    expect((await c.get(url('/receipts/habit'))).body).toMatchObject({ missing: 2, waiting: 2 });
  });

  it('counts a receipt kept, and forgets a purchase marked not needed', async () => {
    const f = await upload(encodeFakeReceiptImage('WALMART\nMILK 3.48\nTOTAL 3.48'), 'page-1.png');
    expect((await c.post(url('/receipts'), { fileIds: [f.fileId] })).status).toBe(201);
    expect((await c.post(url(`/receipts/recommended/${corner.id}/dismiss`))).status).toBe(204);
    expect((await c.get(url('/receipts/habit'))).body).toMatchObject({ captured: 1, missing: 1, waiting: 1 });
  });

  it('is off again when the amount is cleared', async () => {
    await c.patch(url('/planning/settings'), { receiptReminderMinor: null });
    expect((await c.get(url('/planning/settings'))).body.receiptReminderMinor).toBeNull();
  });
});
