/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Local mode on the hosted service (06 §2, backlog item 2): the server can't reach the user's model, so AI work is
// parked; a browser on the user's network runs it and posts the answer, which is then applied to what it was for.
const EMAIL = 'local-results@example.test';

let h: Harness;
let worker: Worker;
let c: Client;
let admin: pg.Client;
let wsId: string;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;

async function upload(bytes: Uint8Array, fileName: string, path: string, type: string) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`,
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
  return JSON.parse(res.body);
}

/** Lists (claims) the parked tasks of a kind. */
const claim = async (task: string) =>
  ((await c.get(url('/ai/tasks'))).body.data as any[]).filter((t) => t.task === task);

/** The category list's short id for a name, read from the parked request as the local model would. */
function shortId(task: any, name: string): string {
  const system = task.input.messages[0].content as string;
  const context = JSON.parse(system.slice(system.indexOf('{"categories"')));
  return context.categories.find((x: any) => x.name === name).id;
}

/** Runs the follow-up now rather than after its wait for more answers. */
async function runFollowUps() {
  await admin.query(
    `update app.job set run_after = now() where workspace_id = $1 and type like 'ai.local_result.%' and status = 'queued'`,
    [wsId],
  );
  await worker.drain(['ai', 'import']);
}

const categorizeAnswer = (task: any, byPayee: Record<string, string>) => {
  const items = JSON.parse(task.input.messages[1].content).items as any[];
  return {
    results: items.map((i) => ({
      id: i.id,
      category: byPayee[i.payee ?? i.description] ? shortId(task, byPayee[i.payee ?? i.description]!) : null,
      member: null,
      tags: [],
      confidence: 0.97,
      reason: 'a widget shop',
      merchant: null,
    })),
  };
};

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    AI_PROVIDER: 'fake',
    AI_LOCAL_DIRECT: 'false',
  });
  h.app.get(ImportJobs).register();
  h.app.get(ReceiptJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Local AI', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking' })).body.id;
  expect(
    (await c.patch(url('/ai/settings'), { mode: 'local', endpoint: 'http://localhost:11434/v1' })).status,
  ).toBe(200);
});
afterAll(async () => {
  await admin?.end();
  await h?.close();
});

describe('a local answer to an import (backlog item 2)', () => {
  it('parks the rows once as a chat request, then suggests from the answer in the preview', async () => {
    const csv = [
      'Date,Description,Amount',
      '2026-11-02,ZQX WIDGET CO,-12.00',
      '2026-11-03,PLOVR MARKET,-30.00',
    ].join('\n');
    const file = await upload(Buffer.from(csv), 'local.csv', '/uploads', 'text/csv');
    const batch = (await c.post(url('/imports'), { fileId: file.fileId, accountId: checking })).body;
    await worker.drain(['import', 'ai']);
    const rows = async () => (await c.get(url(`/imports/${batch.id}/rows`))).body.data as any[];
    expect((await rows()).map((r) => r.suggestion?.categoryId ?? null)).toEqual([null, null]);

    const [task, ...more] = await claim('categorize');
    expect(more).toEqual([]);
    // A body the browser sends to the user's endpoint as it is.
    expect(task.input).toMatchObject({ stream: false, response_format: { type: 'json_schema' } });
    expect(task.input.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    const { rows: stored } = await admin.query(
      `select subject_type, subject_id, created_by is not null as by, cardinality(item_keys) as n from app.ai_task where id = $1`,
      [task.id],
    );
    expect(stored[0]).toMatchObject({ subject_type: 'import_batch', subject_id: batch.id, by: true, n: 2 });

    const answer = categorizeAnswer(task, { 'ZQX WIDGET CO': 'Household' });
    expect((await c.post(url(`/ai/tasks/${task.id}/result`), { output: answer })).status).toBe(204);
    // The follow-up waits a moment for more answers, then applies them; the other row stays for the person.
    expect((await rows()).map((r) => r.suggestion?.categoryId ?? null)).toEqual([null, null]);
    await runFollowUps();
    expect((await rows()).map((r) => r.suggestion?.categoryId ?? null)).toEqual([cat('Household'), null]);
    // Nothing new was parked for the answered row.
    const { rows: tasks } = await admin.query(
      `select count(*)::int as n from app.ai_task where workspace_id = $1`,
      [wsId],
    );
    expect(tasks[0].n).toBe(1);
  });

  it("suggests in Review for a committed import's transactions", async () => {
    const csv = [
      'Date,Description,Amount',
      '2026-11-05,KWOBBLE TOOLS,-18.00',
      '2026-11-06,FRUMP GARDEN,-22.00',
    ].join('\n');
    const file = await upload(Buffer.from(csv), 'committed.csv', '/uploads', 'text/csv');
    const batch = (await c.post(url('/imports'), { fileId: file.fileId, accountId: checking })).body;
    await worker.drain(['import', 'ai']);
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain(['import', 'ai']);
    expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('committed');
    const review = async () =>
      ((await c.get(url('/review'))).body.items as any[]).filter((i) =>
        ['KWOBBLE TOOLS', 'FRUMP GARDEN'].some((p) => (i.payee ?? i.description).toUpperCase().includes(p)),
      );
    expect((await review()).map((i) => i.categorization?.suggested ?? null)).toEqual([null, null]);

    const [task] = await claim('categorize');
    await c.post(url(`/ai/tasks/${task.id}/result`), {
      output: categorizeAnswer(task, { 'KWOBBLE TOOLS': 'Household', 'FRUMP GARDEN': 'Household' }),
    });
    await runFollowUps();
    const after = await review();
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.categorization.suggested.categoryId)).toEqual([
      cat('Household'),
      cat('Household'),
    ]);
  });
});

describe('a local answer to a receipt (backlog item 2)', () => {
  it('reads the receipt again from its text once the answer is in', async () => {
    const f = await upload(encodeFakeReceiptImage('IGNORED'), 'local.png', '/receipts/files', 'image/png');
    const created = (await c.post(url('/receipts'), { fileIds: [f.fileId] })).body;
    // Play the doc-worker: the OCR job's text queues the reading.
    const { rows } = await admin.query(
      `select id from app.job where type = 'receipt.ocr' and payload->>'receiptId' = $1`,
      [created.id],
    );
    const text = ['CORNER SHOP', '11/05/2026 09:15', 'APPLES   4.00', 'TOTAL 4.00'].join('\n');
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
    const waiting = (await c.get(url(`/receipts/${created.id}`))).body;
    expect(waiting.status).toBe('needs_review');
    expect(waiting.lines).toEqual([]);

    const [task] = await claim('extract_receipt');
    expect(JSON.stringify(task.input)).toContain('CORNER SHOP');
    const none = '';
    await c.post(url(`/ai/tasks/${task.id}/result`), {
      output: {
        merchant: 'Corner Shop',
        storeAddress: none,
        storePhone: none,
        storeWebsite: none,
        date: '2026-11-05',
        localTime: '09:15',
        currency: 'USD',
        lines: [
          {
            rawText: 'APPLES',
            expandedName: 'Apples',
            qty: null,
            unitPrice: null,
            lineTotal: '4.00',
            discount: null,
            taxable: 'unmarked',
          },
        ],
        subtotal: '4.00',
        tax: null,
        taxIncluded: 'no',
        discount: null,
        fees: null,
        tip: null,
        total: '4.00',
        cardLast4: null,
        confidence: 0.9,
      },
    });
    await runFollowUps();
    await worker.drain(['ai']);
    const read = (await c.get(url(`/receipts/${created.id}`))).body;
    expect(read).toMatchObject({ merchant: 'Corner Shop', total: '400', extraction: { mode: 'local' } });
    expect(read.lines.map((l: any) => [l.rawText, l.qty, l.unitPrice, l.lineTotal])).toEqual([
      ['APPLES', '1', '400', '400'],
    ]);
  });
});
