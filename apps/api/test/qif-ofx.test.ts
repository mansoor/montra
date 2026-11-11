/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

// QIF and OFX/QFX statements (IMP-01, IMP-13, ADR-0030), end to end: upload, parse, preview, commit, re-import.
const EMAIL = 'quicken@example.com';
const corpus = (name: string) =>
  readFileSync(join(__dirname, '../../../packages/importers/test/corpus', name));

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

async function upload(wsId: string, fileName: string, bytes: Buffer) {
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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function workspace(name: string) {
  const ws = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (n: string) => cats.find((x: any) => x.name === n && x.entityId === ws.entities[0].id)?.id;
  return { ws, url, cat };
}

describe('statement import of QIF and OFX files', () => {
  let w: Awaited<ReturnType<typeof workspace>>;

  beforeAll(async () => {
    w = await workspace('Quicken files');
  });

  it('imports a Quicken QIF register: categories by their subcategory, the opening balance row left out', async () => {
    const checking = (await c.post(w.url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
    const up = await upload(w.ws.id, 'Checking.QIF', corpus('quicken-bank.qif'));
    expect(up.status).toBe(201);
    expect(up.body.fileType).toBe('qif');
    const started = await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: checking });
    expect(started.status).toBe(202);
    await worker.drain();

    const batch = (await c.get(w.url(`/imports/${started.body.id}`))).body;
    expect(batch).toMatchObject({
      fileType: 'qif',
      status: 'preview',
      mappingSource: 'reference',
      minDate: '2026-10-01',
      maxDate: '2026-10-12',
      warnings: [],
    });
    expect(batch.counts).toMatchObject({ read: 6, new: 5, skipped: 1, error: 0 });
    const rows = (await c.get(w.url(`/imports/${started.body.id}/rows`))).body.data;
    // "Food:Groceries" lands in Groceries; the transfer to savings stays uncategorized.
    const groceries = rows.find((r: any) => r.payee === 'Whole Foods');
    expect(groceries.suggestion).toMatchObject({ categoryId: w.cat('Groceries') });
    expect(rows.find((r: any) => r.description === 'Transfer : Savings')).toBeTruthy();

    await c.post(w.url(`/imports/${started.body.id}/commit`));
    await worker.drain();
    expect((await c.get(w.url(`/imports/${started.body.id}`))).body).toMatchObject({
      status: 'committed',
      counts: { added: 5 },
    });
    const accounts = (await c.get(w.url('/accounts'))).body.data;
    expect(accounts.find((a: any) => a.id === checking).balance.amount).toBe('91723');
  });

  it('imports an OFX download with its closing balance, and a re-download adds nothing even if names changed', async () => {
    const checking = (await c.post(w.url('/accounts'), { name: 'First Bank', kind: 'checking' })).body.id;
    const up = await upload(w.ws.id, 'download.ofx', corpus('bank-ofx1.ofx'));
    expect(up.body.fileType).toBe('ofx');
    const first = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: checking })).body;
    await worker.drain();
    const preview = (await c.get(w.url(`/imports/${first.id}`))).body;
    expect(preview).toMatchObject({
      fileType: 'ofx',
      status: 'preview',
      statement: { opening: null, closing: { amount: '373113', currency: 'USD' } },
      balanceCheck: 'n_a',
    });
    // Two same-day purchases with their own FITIDs are both new.
    expect(preview.counts).toMatchObject({ read: 5, new: 5, duplicate: 0 });
    await c.post(w.url(`/imports/${first.id}/commit`));
    await worker.drain();

    // The bank renames a payee between downloads: the FITIDs still say these are the same transactions.
    const renamed = corpus('bank-ofx1.ofx')
      .toString('latin1')
      .replace('WHOLE FOODS #123', 'WHOLE FOODS MARKET');
    const up2 = await upload(w.ws.id, 'download (1).ofx', Buffer.from(renamed, 'latin1'));
    const again = (await c.post(w.url('/imports'), { fileId: up2.body.fileId, accountId: checking })).body;
    await worker.drain();
    expect((await c.get(w.url(`/imports/${again.id}`))).body.counts).toMatchObject({ duplicate: 5, new: 0 });
  });

  it('imports one account of a multi-account QFX/QIF by the account asked for', async () => {
    const visa = (await c.post(w.url('/accounts'), { name: 'Visa', kind: 'credit_card' })).body.id;
    const up = await upload(w.ws.id, 'all-accounts.qif', corpus('quicken-multi.qif'));
    const b = (
      await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: visa, accountFilter: 'Visa' })
    ).body;
    await worker.drain();
    const batch = (await c.get(w.url(`/imports/${b.id}`))).body;
    expect(batch).toMatchObject({ status: 'preview', warnings: ['investment_transactions_skipped:2'] });
    expect(batch.counts).toMatchObject({ new: 2 });
  });

  it('refuses a broken OFX file with a readable error', async () => {
    const acct = (await c.post(w.url('/accounts'), { name: 'Broken', kind: 'checking' })).body.id;
    const up = await upload(
      w.ws.id,
      'broken.ofx',
      Buffer.from('OFXHEADER:100\nDATA:OFXSGML\n\nnot a statement'),
    );
    expect(up.body.fileType).toBe('ofx');
    const b = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: acct })).body;
    await worker.drain();
    const batch = (await c.get(w.url(`/imports/${b.id}`))).body;
    expect(batch.status).toBe('failed');
    expect(batch.error).toMatch(/^doc\.corrupt/);
  });
});

describe('switching from Quicken for Windows and from bank downloads (IMP-13)', () => {
  it('reads a QIF export: accounts with their kinds, Quicken categories, and the transfer paired', async () => {
    const w = await workspace('From Quicken');
    const f = (await upload(w.ws.id, 'QUICKEN.QIF', corpus('quicken-multi.qif'))).body.fileId;
    const a = (await c.post(w.url('/migrations/analyze'), { source: 'quicken_windows', fileIds: [f] })).body;
    expect(a.files).toEqual([expect.objectContaining({ template: 'qif', rows: 5, problem: null })]);
    expect(a.accounts.map((x: any) => [x.key, x.rows, x.suggestedKind])).toEqual([
      ['Checking', 3, 'checking'],
      ['Visa', 2, 'credit_card'],
    ]);
    const byName = Object.fromEntries(a.categories.map((x: any) => [x.name, x]));
    // Quicken's "Food:Groceries" is the Groceries category, in the Food group.
    expect(byName['Food:Groceries']).toMatchObject({ group: 'Food', matchId: w.cat('Groceries') });
    expect(byName['Auto:Fuel']).toMatchObject({ group: 'Auto' });

    const m = (
      await c.post(w.url('/migrations'), {
        source: 'quicken_windows',
        fileIds: [f],
        accounts: [
          { key: 'Checking', target: { type: 'new', name: 'Checking', kind: 'checking' } },
          { key: 'Visa', target: { type: 'new', name: 'Visa', kind: 'credit_card' } },
        ],
        categories: [
          { name: 'Food:Groceries', target: { type: 'existing', categoryId: w.cat('Groceries') } },
          { name: 'Auto:Fuel', target: { type: 'new', name: 'Fuel', group: 'Auto', kind: 'expense' } },
        ],
      })
    ).body;
    await worker.drain();
    expect((await c.get(w.url(`/migrations/${m.id}`))).body).toMatchObject({ ready: true });
    await c.post(w.url(`/migrations/${m.id}/commit`));
    await worker.drain();
    const done = (await c.get(w.url(`/migrations/${m.id}`))).body;
    // The card payment ([Visa] on one side, [Checking] on the other) pairs as a transfer.
    expect(done).toMatchObject({ done: true, transferPairs: 1 });
    const txns = (await c.get(w.url('/transactions?limit=50'))).body.data;
    expect(txns.find((t: any) => t.payee?.startsWith('Costco')).splits[0].accountId).toBe(w.cat('Groceries'));
  });

  it('opens each bank download’s account at the balance that ends at its closing balance', async () => {
    const w = await workspace('From the bank');
    const f1 = (await upload(w.ws.id, 'checking.ofx', corpus('bank-ofx1.ofx'))).body.fileId;
    const f2 = (await upload(w.ws.id, 'card.qfx', corpus('card.qfx'))).body.fileId;
    const a = (await c.post(w.url('/migrations/analyze'), { source: 'bank', fileIds: [f1, f2] })).body;
    expect(a.accounts.map((x: any) => [x.key, x.rows, x.suggestedKind, x.opening])).toEqual([
      ['First Bank Checking ••5678', 5, 'checking', '250450'], // 3,731.13 − 1,226.63
      ['B1 Credit card ••4321', 3, 'credit_card', '-50000'], // −347.59 − 152.41
    ]);
    const m = (
      await c.post(w.url('/migrations'), {
        source: 'bank',
        fileIds: [f1, f2],
        accounts: a.accounts.map((x: any) => ({
          key: x.key,
          target: { type: 'new', name: x.key, kind: x.suggestedKind },
        })),
      })
    ).body;
    await worker.drain();
    await c.post(w.url(`/migrations/${m.id}/commit`));
    await worker.drain();
    const accounts = (await c.get(w.url('/accounts'))).body.data;
    const balance = (name: string) => accounts.find((x: any) => x.name === name).balance.amount;
    expect(balance('First Bank Checking ••5678')).toBe('373113');
    expect(balance('B1 Credit card ••4321')).toBe('34759'); // owed
  });
});
