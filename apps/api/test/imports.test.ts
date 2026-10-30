/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { Db } from '../src/db/database.js';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

const corpus = (name: string) =>
  readFileSync(join(__dirname, '../../../packages/importers/test/corpus', name));
const usd = (amount: string) => ({ amount, currency: 'USD' });

let h: Harness;
let worker: Worker;
let c: Client;
const EMAIL = 'importer@example.com';

beforeAll(async () => {
  h = await startHarness({ STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')) });
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
});
afterAll(() => h.close());

async function upload(wsId: string, fileName: string, bytes: Buffer, email = EMAIL) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${wsId}/uploads`,
    headers: {
      authorization: `Bearer dev:${email}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function setup() {
  const ws = (await c.post('/v1/workspaces', { name: 'Imports', baseCurrency: 'USD', template: 'household' }))
    .body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (name: string) => cats.find((x: any) => x.name === name).id;
  return { ws, url, cat };
}

describe('statement import pipeline (IMP-01..09, UP-01)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let checking: string;
  let manualCoffee: string;
  let firstBatch: string;

  beforeAll(async () => {
    w = await setup();
    checking = (await c.post(w.url('/accounts'), { name: 'Chase Checking', kind: 'checking' })).body.id;
    manualCoffee = (
      await c.post(w.url('/transactions'), {
        date: '2026-10-27',
        accountId: checking,
        amount: usd('-650'),
        payee: 'Blue Bottle',
        categoryId: w.cat('Dining out'),
      })
    ).body.id;
  });

  it('uploads, parses and previews with dedupe, matching and suggestions', async () => {
    const up = await upload(w.ws.id, 'chase-checking.csv', corpus('chase-checking.csv'));
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ fileType: 'csv', duplicateOf: null });

    const started = await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: checking });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe('parsing');
    firstBatch = started.body.id;
    await worker.drain();

    const batch = (await c.get(w.url(`/imports/${firstBatch}`))).body;
    expect(batch).toMatchObject({
      status: 'preview',
      mappingSource: 'heuristic',
      balanceCheck: 'ok',
      minDate: '2026-10-15',
      maxDate: '2026-10-28',
      statement: { opening: usd('28025'), closing: usd('248175') },
    });
    expect(batch.counts).toMatchObject({ read: 6, new: 5, match: 1, duplicate: 0, error: 0 });

    const rows = (await c.get(w.url(`/imports/${firstBatch}/rows`))).body.data;
    const coffee = rows.find((r: any) => r.description.includes('BLUE BOTTLE'));
    expect(coffee).toMatchObject({ status: 'match', matchTransactionId: manualCoffee, effective: 'match' });
    const tj = rows.filter((r: any) => r.description.includes("TRADER JOE'S"));
    expect(tj).toHaveLength(2); // two identical rows on one day are both kept
    expect(tj[0].suggestion).toMatchObject({
      categoryId: w.cat('Groceries'),
      explanation: "Known merchant: Trader Joe's",
    });
  });

  it('lets the user skip a row and commits atomically (IMP-06, IMP-08)', async () => {
    const rows = (await c.get(w.url(`/imports/${firstBatch}/rows`))).body.data;
    console.log('DESCS', JSON.stringify(rows.map((r: any) => r.description)));
    const check = rows.find((r: any) => r.description === 'CHECK 1043');
    const skipped = await c.patch(w.url(`/imports/${firstBatch}/rows/${check.id}`), { decision: 'skip' });
    expect(skipped.body.effective).toBe('skip');

    expect((await c.post(w.url(`/imports/${firstBatch}/commit`))).body.status).toBe('committing');
    await worker.drain();
    const done = (await c.get(w.url(`/imports/${firstBatch}`))).body;
    expect(done).toMatchObject({
      status: 'committed',
      counts: { added: 4, matched: 1, skipped: 1, failed: 0 },
    });
    expect(done.undoUntil).not.toBeNull();

    const txns = (await c.get(w.url(`/transactions?accountId=${checking}&limit=50`))).body.data;
    expect(txns).toHaveLength(5);
    const tj = txns.find((t: any) => t.payee === "Trader Joe's");
    expect(tj).toMatchObject({ source: 'import', reviewState: 'auto_applied' });
    expect(tj.entries[0].postings.map((p: any) => p.accountName)).toContain('Groceries');
    const payroll = txns.find((t: any) => t.description.includes('ACME CORP PAYROLL'));
    expect(payroll.reviewState).toBe('needs_review'); // no suggestion → uncategorized → review queue
    // The manual coffee was confirmed, not duplicated.
    expect(txns.filter((t: any) => t.amount?.amount === '-650')).toHaveLength(1);

    const reg = (await c.get(w.url(`/accounts/${checking}/register`))).body.data;
    expect(reg.every((l: any) => l.cleared === 'cleared')).toBe(true);
  });

  it('re-importing the same statement adds nothing (UP-01, IMP-07)', async () => {
    const up = await upload(w.ws.id, 'chase-checking (1).csv', corpus('chase-checking.csv'));
    expect(up.body.duplicateOf).toMatchObject({ importBatchId: firstBatch });
    const again = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: checking })).body;
    await worker.drain();
    const preview = (await c.get(w.url(`/imports/${again.id}`))).body;
    // The mapping profile saved by the first commit is reused (IMP-04).
    expect(preview).toMatchObject({ status: 'preview', mappingSource: 'profile', mappingConfidence: 1 });
    // Five rows were imported or matched before; the skipped check is offered again.
    expect(preview.counts).toMatchObject({ duplicate: 5, new: 1 });
  });

  it('undoes an import within 30 days (IMP-09)', async () => {
    expect((await c.post(w.url(`/imports/${firstBatch}/undo`))).status).toBe(202);
    await worker.drain();
    const undone = (await c.get(w.url(`/imports/${firstBatch}`))).body;
    expect(undone.status).toBe('undone');
    const txns = (await c.get(w.url(`/transactions?accountId=${checking}&limit=50`))).body.data;
    expect(txns.map((t: any) => t.id)).toEqual([manualCoffee]); // imported rows voided, the manual entry kept
    const reg = (await c.get(w.url(`/accounts/${checking}/register`))).body.data;
    expect(reg.map((l: any) => l.cleared)).toEqual(['uncleared']); // match before-image restored
    expect((await c.post(w.url(`/imports/${firstBatch}/undo`))).body.code).toBe('import.not_committed');
  });
});

describe('reconciliation (DE-08)', () => {
  it('reconciles imported lines against the statement and locks them', async () => {
    const w = await setup();
    const card = (await c.post(w.url('/accounts'), { name: 'Amex', kind: 'credit_card' })).body.id;
    const up = await upload(w.ws.id, 'amex.csv', corpus('amex.csv'));
    const batch = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: card })).body;
    await worker.drain();
    const preview = (await c.get(w.url(`/imports/${batch.id}`))).body;
    expect(preview.mapping.sign).toBe('inverted'); // purchases listed as positive
    await c.post(w.url(`/imports/${batch.id}/commit`));
    await worker.drain();

    // Owed after the statement: 23.45 + 112.30 − 704.00 + 389.20 = −179.05 (a credit balance).
    const rec = await c.post(w.url(`/accounts/${card}/reconciliations`), {
      statementDate: '2026-10-31',
      statementBalance: usd('-17905'),
    });
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ clearedBalance: usd('-17905'), difference: usd('0') });
    expect(
      (
        await c.post(w.url(`/accounts/${card}/reconciliations`), {
          statementDate: '2026-10-31',
          statementBalance: usd('0'),
        })
      ).body.code,
    ).toBe('reconciliation.in_progress');

    const one = rec.body.lines[0];
    const off = await c.post(w.url(`/reconciliations/${rec.body.id}/cleared`), { unclear: [one.postingId] });
    expect(off.body.difference.amount).not.toBe('0');
    expect((await c.post(w.url(`/reconciliations/${rec.body.id}/complete`))).body.code).toBe(
      'reconciliation.difference',
    );
    await c.post(w.url(`/reconciliations/${rec.body.id}/cleared`), { clear: [one.postingId] });

    const done = await c.post(w.url(`/reconciliations/${rec.body.id}/complete`));
    expect(done.body.status).toBe('completed');
    expect(done.body.lines.every((l: any) => l.cleared === 'reconciled')).toBe(true);

    // Reconciled lines are protected: the amount can't change any more (DE-10).
    const txn = (await c.get(w.url(`/transactions?accountId=${card}`))).body.data[0];
    const edit = await c.patch(w.url(`/transactions/${txn.id}`), { amount: usd('-1') });
    expect(edit.body.code).toBe('transaction.reconciled');
    // …and undo keeps them, reporting a partial undo.
    await c.post(w.url(`/imports/${batch.id}/undo`));
    await worker.drain();
    const job = (await c.get(w.url(`/jobs/${(await c.get(w.url(`/imports/${batch.id}`))).body.jobId}`))).body;
    expect(job.result.kept).toHaveLength(4);
    expect((await c.get(w.url(`/imports/${batch.id}`))).body.warnings).toEqual(['partial_undo']);
  });
});

describe('other file types and mapping', () => {
  it('imports XLSX workbooks (IMP-01)', async () => {
    const w = await setup();
    const acct = (await c.post(w.url('/accounts'), { name: 'Savings', kind: 'savings' })).body.id;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Date', 'Description', 'Amount']);
    ws.addRow([new Date(Date.UTC(2026, 9, 2)), 'Interest', 1.23]);
    ws.addRow([new Date(Date.UTC(2026, 9, 9)), 'Transfer in', 500]);
    const up = await upload(w.ws.id, 'statement.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(up.body.fileType).toBe('xlsx');
    const batch = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: acct })).body;
    await worker.drain();
    const rows = (await c.get(w.url(`/imports/${batch.id}/rows`))).body.data;
    expect(rows.map((r: any) => [r.date, r.amount.amount])).toEqual([
      ['2026-10-02', '123'],
      ['2026-10-09', '50000'],
    ]);
  });

  it('asks for a mapping when inference is unsure, then re-parses with it (IMP-03)', async () => {
    const w = await setup();
    const acct = (await c.post(w.url('/accounts'), { name: 'Cash', kind: 'cash' })).body.id;
    const csv = Buffer.from(
      '2026-10-01,COFFEE,4.50,12\n2026-10-02,LUNCH,12.00,13\n2026-10-03,REFUND,3.00,14\n',
    );
    const up = await upload(w.ws.id, 'mystery.csv', csv);
    const batch = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: acct })).body;
    await worker.drain();
    const first = (await c.get(w.url(`/imports/${batch.id}`))).body;
    expect(first.status).toBe('needs_mapping');
    expect(first.warnings).toContain('no_negative_amounts');
    expect(first.analysis.sample[0]).toEqual(['2026-10-01', 'COFFEE', '4.50', '12']);
    expect((await c.post(w.url(`/imports/${batch.id}/commit`))).body.code).toBe('import.not_ready');

    const mapped = await c.put(w.url(`/imports/${batch.id}/mapping`), {
      mapping: {
        headerRow: null,
        dataStart: 0,
        date: 0,
        dateFormat: 'YYYY-MM-DD',
        description: [1],
        amount: 2,
        sign: 'inverted',
        decimal: '.',
      },
    });
    expect(mapped.status).toBe(202);
    await worker.drain();
    const second = (await c.get(w.url(`/imports/${batch.id}`))).body;
    expect(second).toMatchObject({ status: 'preview', mappingSource: 'user' });
    const rows = (await c.get(w.url(`/imports/${batch.id}/rows`))).body.data;
    expect(rows.map((r: any) => r.amount.amount)).toEqual(['-450', '-1200', '-300']);
  });

  it('routes PDF statements through the doc worker and surfaces extraction failures (IMP-05)', async () => {
    const w = await setup();
    const acct = (await c.post(w.url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
    const pdf = Buffer.from('%PDF-1.4\n% fake statement for the queue test\n');
    const up = await upload(w.ws.id, 'statement.pdf', pdf);
    expect(up.body.fileType).toBe('pdf');
    const batch = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: acct })).body;

    // Play the Python doc worker: claim the doc job and complete it with an extracted grid.
    const db = h.app.get(Db).kysely;
    const { rows: jobs } = await sql<any>`select * from app.dequeue_job('doc', 'test-doc-worker')`.execute(
      db,
    );
    expect(jobs[0]).toMatchObject({
      type: 'doc.extract',
      payload: expect.objectContaining({ fileType: 'pdf' }),
    });
    const grid = {
      kind: 'grid',
      textLayer: true,
      pages: 1,
      sheets: [
        {
          name: 'Page 1',
          rows: [
            ['Date', 'Description', 'Amount', 'Balance'],
            ['10/03/2026', 'GROCERY', '-20.00', '980.00'],
            ['10/05/2026', 'PAYROLL', '100.00', '1,080.00'],
          ],
        },
      ],
      statement: {
        openingBalance: '1,000.00',
        closingBalance: '1,080.00',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        accountLast4: '1234',
        currency: 'USD',
      },
    };
    await sql`select app.complete_job(${jobs[0].id}, ${JSON.stringify(grid)}::jsonb)`.execute(db);
    await worker.drain();
    const preview = (await c.get(w.url(`/imports/${batch.id}`))).body;
    expect(preview).toMatchObject({
      status: 'preview',
      balanceCheck: 'ok',
      statement: { opening: usd('100000'), closing: usd('108000') },
    });
    expect(preview.counts.new).toBe(2);

    // A permanent extraction failure (scanned PDF) shows on the batch instead of leaving it "parsing".
    const up2 = await upload(w.ws.id, 'scan.pdf', pdf);
    const batch2 = (await c.post(w.url('/imports'), { fileId: up2.body.fileId, accountId: acct })).body;
    const { rows: jobs2 } = await sql<any>`select * from app.dequeue_job('doc', 'test-doc-worker')`.execute(
      db,
    );
    await sql`select app.fail_job(${jobs2[0].id}, ${'pdf.no_text_layer: scanned PDF'}, true)`.execute(db);
    expect((await c.get(w.url(`/imports/${batch2.id}`))).body).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('pdf.no_text_layer'),
    });
  });

  it('rejects unsupported uploads and other workspaces', async () => {
    const w = await setup();
    const bad = await upload(w.ws.id, 'virus.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));
    expect(bad.body.code).toBe('upload.unsupported_type');
    const other = await upload(w.ws.id, 'x.csv', Buffer.from('a,b\n'), 'stranger@example.com');
    expect(other.status).toBe(403);
  });
});

describe('contract additions for the import UI', () => {
  it('bulk-skips rows, exposes the latest job, accountColumn, and lists reconciliations', async () => {
    const w = await setup();
    const acct = (await c.post(w.url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
    const up = await upload(w.ws.id, 'ynab.csv', corpus('ynab.csv'));
    const batch = (await c.post(w.url('/imports'), { fileId: up.body.fileId, accountId: acct })).body;
    await worker.drain();
    const preview = (await c.get(w.url(`/imports/${batch.id}`))).body;
    expect(preview.analysis).toMatchObject({
      templateId: 'ynab',
      accounts: ['Checking', 'Savings'],
      accountColumn: 0,
    });
    expect(preview.job).toMatchObject({ type: 'import.parse', status: 'succeeded' });

    const bulk = await c.patch(w.url(`/imports/${batch.id}/rows`), { status: 'new', decision: 'skip' });
    expect(bulk.body.updated).toBeGreaterThan(0);
    const rows = (await c.get(w.url(`/imports/${batch.id}/rows`))).body.data;
    expect(rows.every((r: any) => r.effective === 'skip')).toBe(true);
    expect((await c.patch(w.url(`/imports/${batch.id}/rows`), { decision: 'skip' })).status).toBe(400);

    await c.post(w.url(`/accounts/${acct}/reconciliations`), {
      statementDate: '2026-10-31',
      statementBalance: usd('0'),
    });
    const open = (await c.get(w.url(`/accounts/${acct}/reconciliations?status=in_progress`))).body.data;
    expect(open).toHaveLength(1);
  });
});
