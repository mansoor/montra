/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Switching from another app (IMP-13, ADR-0029): one export, several accounts, mapped and imported for a fresh start.
const EMAIL = 'switcher@example.com';

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
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/uploads`,
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(text),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return JSON.parse(res.body).fileId as string;
}

// A YNAB register export: two accounts, their starting balances, categories with groups and a transfer between them.
const YNAB = `"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Checking","","10/01/2026","Starting Balance","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$1,000.00","Reconciled"
"Checking","","10/02/2026","ACME Payroll","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$3,000.00","Cleared"
"Checking","","10/03/2026","Whole Foods","Everyday: Groceries","Everyday","Groceries","","$120.00","$0.00","Cleared"
"Checking","","10/05/2026","Transfer : Visa","","","","","$500.00","$0.00","Cleared"
"Visa","","10/01/2026","Starting Balance","Inflow: Ready to Assign","Inflow","Ready to Assign","","$800.00","$0.00","Cleared"
"Visa","","10/13/2026","Bistro","Everyday: Dining Out","Everyday","Dining Out","date night","$45.00","$0.00","Cleared"
"Visa","","10/06/2026","Transfer : Checking","","","","","$0.00","$500.00","Cleared"
"Visa","","10/14/2026","Pet Palace","Pets: Vet","Pets","Vet","","$90.00","$0.00","Cleared"
`;

describe('switching from another app (IMP-13)', () => {
  let ws: any;
  let url: (p: string) => string;
  let cats: any[];
  let migrationId: string;
  let fileId: string;

  beforeAll(async () => {
    ws = (await c.post('/v1/workspaces', { name: 'Switched', baseCurrency: 'USD', template: 'household' }))
      .body;
    url = (p) => `/v1/workspaces/${ws.id}${p}`;
    cats = (await c.get(url('/categories'))).body.data;
  });
  const cat = (name: string) =>
    cats.find((x: any) => x.name === name && x.entityId === ws.entities[0].id)?.id;

  it('reads the export: its accounts with their opening balances, and its categories with groups', async () => {
    expect((await c.get(url('/migrations/eligibility'))).body).toEqual({ eligible: true, transactions: 0 });
    fileId = await upload(ws.id, 'YNAB Export - Home Register.csv', YNAB);
    const r = await c.post(url('/migrations/analyze'), { source: 'ynab', fileIds: [fileId] });
    expect(r.status).toBe(200);
    expect(r.body.files).toEqual([expect.objectContaining({ template: 'ynab', rows: 6, problem: null })]);
    expect(r.body.accounts).toEqual([
      expect.objectContaining({
        key: 'Checking',
        rows: 3,
        from: '2026-10-02',
        moneyIn: '300000',
        moneyOut: '62000',
        opening: '100000',
        suggestedKind: 'checking',
      }),
      expect.objectContaining({ key: 'Visa', rows: 3, opening: '-80000', suggestedKind: 'credit_card' }),
    ]);
    const byName = Object.fromEntries(r.body.categories.map((x: any) => [x.name, x]));
    expect(byName['Groceries']).toMatchObject({
      group: 'Everyday',
      rows: 1,
      moneyOut: '12000',
      matchId: cat('Groceries'),
    });
    expect(byName['Dining Out']).toMatchObject({ matchId: cat('Dining out') });
    expect(byName['Vet']).toMatchObject({ group: 'Pets', matchId: null, transfer: false });
    expect(byName['Ready to Assign']).toMatchObject({ moneyIn: '300000' });
  });

  it('creates the accounts and categories asked for and previews one import per account', async () => {
    const r = await c.post(url('/migrations'), {
      source: 'ynab',
      fileIds: [fileId],
      accounts: [
        { key: 'Checking', target: { type: 'new', name: 'Checking', kind: 'checking' } },
        { key: 'Visa', target: { type: 'new', name: 'Visa', kind: 'credit_card' } },
      ],
      categories: [
        { name: 'Groceries', target: { type: 'existing', categoryId: cat('Groceries') } },
        { name: 'Dining Out', target: { type: 'existing', categoryId: cat('Dining out') } },
        { name: 'Ready to Assign', target: { type: 'existing', categoryId: cat('Salary') } },
        { name: 'Vet', target: { type: 'new', name: 'Vet', group: 'Pets', kind: 'expense' } },
      ],
    });
    expect(r.status).toBe(201);
    migrationId = r.body.id;
    expect(r.body.batches.map((b: any) => b.accountName).sort()).toEqual(['Checking', 'Visa']);
    await worker.drain();
    const m = (await c.get(url(`/migrations/${migrationId}`))).body;
    expect(m).toMatchObject({ ready: true, done: false });
    expect(m.batches.map((b: any) => b.status)).toEqual(['preview', 'preview']);
  });

  it('imports everything: categories applied, opening balances right, and the transfer paired', async () => {
    await c.post(url(`/migrations/${migrationId}/commit`));
    await worker.drain();
    const m = (await c.get(url(`/migrations/${migrationId}`))).body;
    expect(m).toMatchObject({ done: true, transferPairs: 1 });

    const txns = (await c.get(url('/transactions?limit=50'))).body.data;
    // Payees can be tidied by the merchant directory ("Whole Foods" is "Whole Foods Market").
    const of = (payee: string) => txns.find((t: any) => t.payee?.startsWith(payee));
    expect(of('Whole Foods').splits[0].accountId).toBe(cat('Groceries'));
    expect(of('ACME Payroll').splits[0].accountId).toBe(cat('Salary'));
    const vet = (await c.get(url('/categories'))).body.data.find((x: any) => x.name === 'Vet');
    expect(vet).toBeTruthy();
    expect(of('Pet Palace').splits[0].accountId).toBe(vet.id);

    const made = (await c.post(url(`/migrations/${migrationId}/transfers`))).body;
    expect(made).toMatchObject({ made: 1, migration: { transferPairs: 0 } });

    // Opening balances from the export's Starting Balance rows: checking 1,000 held, the card 800 owed.
    const accounts = (await c.get(url('/accounts'))).body.data;
    const balance = (name: string) => accounts.find((a: any) => a.name === name).balance.amount;
    expect(balance('Checking')).toBe('338000'); // 1,000 + 3,000 − 120 − 500
    expect(balance('Visa')).toBe('43500'); // 800 + 45 + 90 − 500 owed
  });

  it('works out the opening balance from today’s balance when it’s given', async () => {
    const ws2 = (
      await c.post('/v1/workspaces', { name: 'Switched 2', baseCurrency: 'USD', template: 'household' })
    ).body;
    const u = (p: string) => `/v1/workspaces/${ws2.id}${p}`;
    const f = await upload(ws2.id, 'export.csv', YNAB);
    const r = await c.post(u('/migrations'), {
      source: 'ynab',
      fileIds: [f],
      accounts: [
        {
          key: 'Visa',
          target: {
            type: 'new',
            name: 'Card',
            kind: 'credit_card',
            balance: { amount: '50000', currency: 'USD' },
          },
        },
        { key: 'Checking', target: { type: 'skip' } },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.batches).toHaveLength(1);
    const card = () => c.get(u('/accounts')).then((x) => x.body.data.find((a: any) => a.name === 'Card'));
    // Owing 500 today after +45, +90 and −500 means it started at 865 owed …
    expect((await card()).balance.amount).toBe('86500');
    await worker.drain();
    await c.post(u(`/migrations/${r.body.id}/commit`));
    await worker.drain();
    // … and once its rows are in, it owes today's 500.
    expect((await card()).balance.amount).toBe('50000');
  });

  it('is for a fresh start: a workspace with its own transactions gets a 409', async () => {
    const accounts = (await c.get(url('/accounts'))).body.data;
    await c.post(url('/transactions'), {
      date: '2026-10-20',
      accountId: accounts.find((a: any) => a.name === 'Checking').id,
      amount: { amount: '-1000', currency: 'USD' },
      payee: 'Coffee',
    });
    expect((await c.get(url('/migrations/eligibility'))).body).toEqual({ eligible: false, transactions: 1 });
    const r = await c.post(url('/migrations'), {
      source: 'ynab',
      fileIds: [fileId],
      accounts: [{ key: 'Visa', target: { type: 'new', name: 'Visa 2', kind: 'credit_card' } }],
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('migration.not_fresh');
  });

  it('splits an export it doesn’t know by its Account column', async () => {
    const ws3 = (
      await c.post('/v1/workspaces', { name: 'Switched 3', baseCurrency: 'USD', template: 'household' })
    ).body;
    const f = await upload(
      ws3.id,
      'transactions.csv',
      `Date,Name,Account,Category,Amount
2026-10-02,Coffee Shop,Everyday Checking,Coffee,-4.50
2026-10-03,Grocer,Everyday Checking,Groceries,-80.00
2026-10-04,Airline,Travel Card,Travel,-300.00
`,
    );
    const r = (
      await c.post(`/v1/workspaces/${ws3.id}/migrations/analyze`, { source: 'copilot', fileIds: [f] })
    ).body;
    expect(r.files[0]).toMatchObject({ template: null, rows: 3, problem: null });
    expect(r.accounts.map((a: any) => [a.key, a.rows, a.suggestedKind])).toEqual([
      ['Everyday Checking', 2, 'checking'],
      ['Travel Card', 1, 'credit_card'],
    ]);
  });

  it('flips a file whose spending is positive, when asked, and imports it that way', async () => {
    const ws4 = (
      await c.post('/v1/workspaces', { name: 'Switched 4', baseCurrency: 'USD', template: 'household' })
    ).body;
    const u = (p: string) => `/v1/workspaces/${ws4.id}${p}`;
    const f = await upload(
      ws4.id,
      'positive-spending.csv',
      `Date,Name,Account,Category,Amount
2026-10-02,Coffee Shop,Card,Coffee,4.50
2026-10-03,Grocer,Card,Groceries,80.00
2026-10-09,Refund,Card,Groceries,-10.00
`,
    );
    const asIs = (await c.post(u('/migrations/analyze'), { source: 'rocket_money', fileIds: [f] })).body;
    expect(asIs.accounts[0]).toMatchObject({ moneyIn: '8450', moneyOut: '1000' });
    const flipped = (
      await c.post(u('/migrations/analyze'), { source: 'rocket_money', fileIds: [f], inverted: [f] })
    ).body;
    expect(flipped.accounts[0]).toMatchObject({ moneyIn: '1000', moneyOut: '8450' });

    const m = (
      await c.post(u('/migrations'), {
        source: 'rocket_money',
        fileIds: [f],
        inverted: [f],
        accounts: [{ key: 'Card', target: { type: 'new', name: 'Card', kind: 'credit_card' } }],
      })
    ).body;
    await worker.drain();
    await c.post(u(`/migrations/${m.id}/commit`));
    await worker.drain();
    const amounts = (await c.get(u('/transactions?limit=10'))).body.data
      .map((t: any) => t.amount.amount)
      .sort();
    expect(amounts).toEqual(['-450', '-8000', '1000']);
  });
});
