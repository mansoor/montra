/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { RECORD_RENDER_JOB, RecordRenditions } from '../src/renditions/record-renditions.js';
import { ScanJobs } from '../src/scans/scan-jobs.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { RECORD_NOT_CONVERTED_WORDS } from '../src/storage/vault/vault.conversions.js';
import { VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { ADMIN_URL } from './env.js';
import { jpeg } from './fakes/jpeg.js';
import { startHarness, type Client, type Harness } from './harness.js';

// VLT-14, VLT-15 (ADR-0059): every receipt and every bill goes to the household's vault as one PDF of its pages, in
// order (a photo a page, a PDF's own pages copied), and never a page on its own; moving or removing pages afterwards
// sends the new PDF as a new document. Against the vault's own fake (`@fdv/client/testing`, in this process): no real
// vault is ever reached. The job runs as it does in production: no file goes alone (no `orphanWaitMs`).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-records@example.com';
const KINDS = ['utility_bill', 'bank_statement'];

const WALMART = [
  'WALMART SUPERCENTER #1234',
  '10/05/2026 14:32',
  'BANANAS                1.62 N',
  'SUBTOTAL               1.62',
  'TAX                    0.00',
  'TOTAL                  1.62',
].join('\n');

let h: Harness;
let c: Client;
let db: pg.Client;
let worker: Worker;
let jobs: VaultJobs;
let fake: FakeVaultHandle;
let wsId: string;
let appId: string;
let url: (p: string) => string;

const run = () => jobs.run({ sendGapMs: 0, settleMs: 0 });
const vstate = () => fake.vault.state as any;
const app = () => vstate().connectedApps.find((a: any) => a.id === appId);
const intake = (ref: string) => app().intake.get(ref) as any;
const intakeBytes = (ref: string): Uint8Array => intake(ref).bytes ?? intake(ref).file.bytes;
const sentCount = () => app().intake.size as number;
const item = async (fileId: string) =>
  (await db.query(`select * from app.vault_item where file_id = $1`, [fileId])).rows[0];
const fileRow = async (fileId: string) =>
  (await db.query(`select * from app.file where id = $1`, [fileId])).rows[0];
const badge = async (fileId: string) =>
  (await c.get(url(`/family-vault/files?ids=${fileId}`))).body.data[0]?.vault;
/** The current record PDFs made from any of `pages`, with their outbox rows. */
const pdfsOf = async (pages: string[]) =>
  (
    await db.query(
      `select f.id, f.source_file_ids, f.superseded_at, f.deleted_at, f.sha256, f.page_count, i.status, i.vault_ref
         from app.file f left join app.vault_item i on i.file_id = f.id
        where f.rendition = 'record_pdf' and f.source_file_ids && $1::uuid[]
        order by f.created_at`,
      [pages],
    )
  ).rows;

async function upload(bytes: Uint8Array, fileName: string, path = '/receipts/files') {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: url(path),
    headers: {
      authorization: `Bearer dev:${OWNER}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).fileId as string;
}

/** A PDF of pages of the given sizes, in points. */
async function pdfOf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save();
}

/** Uploads the pages, creates the receipt, lets it be read, and marks it reviewed (a page read as nothing waits). */
async function receipt(pages: { bytes: Uint8Array; name: string }[]) {
  const fileIds: string[] = [];
  for (const p of pages) fileIds.push(await upload(p.bytes, p.name));
  const created = await c.post(url('/receipts'), { fileIds });
  expect(created.status).toBe(201);
  await worker.drain(['ai', 'doc']);
  await db.query(
    `update app.receipt set status = 'inbox' where id = $1 and status in ('processing', 'needs_review')`,
    [created.body.id],
  );
  return { id: created.body.id as string, fileIds };
}

/** The vault's job makes the record's PDF ready, the worker draws it, and the job sends it. */
async function cycle() {
  await run();
  await worker.drain(['report']);
  await run();
}

/** Each page of a sent PDF: its size in points, rounded to whole points. */
async function pageSizes(bytes: Uint8Array): Promise<[number, number][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Number(width.toFixed(0)), Number(height.toFixed(0))];
  });
}

beforeAll(async () => {
  h = await startHarness({
    AI_PROVIDER: 'fake',
    FAMILY_VAULT_FAKE: 'on',
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
  });
  h.app.get(ReceiptJobs).register();
  h.app.get(ScanJobs).register();
  h.app.get(RecordRenditions).register();
  worker = h.app.get(Worker);
  jobs = h.app.get(VaultJobs);
  fake = h.app.get<VaultTransport & { fake: FakeVaultHandle }>(VAULT_TRANSPORT).fake;
  c = h.as(OWNER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  wsId = (
    await c.post('/v1/workspaces', { name: 'Vault records', baseCurrency: 'USD', template: 'household' })
  ).body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true, allowDocumentsToLlm: true });

  const registered = await fake.register({ kinds: KINDS });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault'), { connectionString: registered.codeWithSecret });
  expect(pasted.body.stage).toBe('connected');
  const version = (await c.get(url('/family-vault'))).body.connection.version;
  const set = await c.patch(url('/family-vault'), {
    version,
    groups: [
      { group: 'receipts', mode: 'sent_keep_copy', vaultKind: 'utility_bill' },
      { group: 'bills', mode: 'sent_keep_copy', vaultKind: 'utility_bill' },
    ],
  });
  expect(set.status).toBe(200);
});

afterAll(async () => {
  await db.query(`delete from app.storage_destination where workspace_id = $1`, [wsId]);
  // Nothing of ours may wake a worker in another test file.
  await db.query(`delete from app.job where type in ('storage.vault', 'storage.mirror', $1)`, [
    RECORD_RENDER_JOB,
  ]);
  await db.query(`delete from app.job where workspace_id = $1 and status = 'queued'`, [wsId]);
  await db.end();
  await h.close();
});

describe('a receipt goes as one PDF (ADR-0059 §1)', () => {
  let mixed: { id: string; fileIds: string[] };
  const photo = jpeg({ width: 100, height: 300, note: 'second slip' });

  it('puts a photo a page and a PDF’s own pages in one PDF, in order, and sends no page on its own', async () => {
    const before = sentCount();
    mixed = await receipt([
      { bytes: encodeFakeReceiptImage(WALMART), name: 'slip.png' },
      { bytes: photo, name: 'IMG_0002.jpg' },
      {
        bytes: await pdfOf([
          [200, 100],
          [100, 100],
        ]),
        name: 'invoice.pdf',
      },
    ]);
    await cycle();
    expect(sentCount()).toBe(before + 1);
    // One rendering asked for the record, not one per page.
    const asked = await db.query(
      `select count(*)::int as n from app.job where type = $1 and workspace_id = $2`,
      [RECORD_RENDER_JOB, wsId],
    );
    expect(asked.rows[0].n).toBe(1);
    for (const f of mixed.fileIds) {
      expect(await item(f)).toMatchObject({
        status: 'converted',
        render_state: 'rendered',
        render_options: { record: true },
      });
      // Montra keeps its pages.
      expect(await fileRow(f)).toMatchObject({ location: 'montra', deleted_at: null });
      expect([...app().intake.keys()]).not.toContain((await item(f)).vault_ref);
    }
    const [pdf, ...more] = await pdfsOf(mixed.fileIds);
    expect(more).toEqual([]);
    expect(pdf).toMatchObject({ source_file_ids: mixed.fileIds, status: 'received', page_count: 4 });
    const bytes = intakeBytes(pdf.vault_ref);
    // The PNG on a Letter-wide square page, the 100 × 300 photo three times as tall, the PDF's pages as they were.
    expect(await pageSizes(bytes)).toEqual([
      [612, 612],
      [612, 1836],
      [200, 100],
      [100, 100],
    ]);
    // The JPEG is inside exactly as it was taken: not decoded or compressed again.
    expect(Buffer.from(bytes).includes(Buffer.from(photo))).toBe(true);
    expect(intake(pdf.vault_ref).hints).toMatchObject({ kind: 'utility_bill', title: 'slip.png (PDF)' });
    // Each page's badge counts the record's PDF.
    expect(await badge(mixed.fileIds[1]!)).toMatchObject({
      status: 'converted',
      converted: { state: 'rendered', parts: 1, received: 1, combined: true, canSendAgain: false },
    });
  });

  it('sends a single photo as a one-page PDF', async () => {
    const one = await receipt([{ bytes: jpeg({ width: 400, height: 200, note: 'one' }), name: 'one.jpg' }]);
    await cycle();
    const [pdf] = await pdfsOf(one.fileIds);
    expect(pdf).toMatchObject({ status: 'received', page_count: 1 });
    expect(await pageSizes(intakeBytes(pdf.vault_ref))).toEqual([[612, 306]]);
    expect((await item(one.fileIds[0]!)).status).toBe('converted');
  });

  it('draws a photo upright as its camera said it was held', async () => {
    // Stored 300 wide and 100 tall, held turned a quarter: a person sees it 100 wide and 300 tall.
    const turned = await receipt([
      { bytes: jpeg({ width: 300, height: 100, orientation: 6, note: 'turned' }), name: 'turned.jpg' },
    ]);
    await cycle();
    const [pdf] = await pdfsOf(turned.fileIds);
    expect(await pageSizes(intakeBytes(pdf.vault_ref))).toEqual([[612, 1836]]);
  });

  it('puts a WebP photo in the PDF, decoded and upright', async () => {
    const before = sentCount();
    // Stored 200 wide and 100 tall, EXIF orientation 6: a person sees it 100 wide and 200 tall.
    const webp = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#3a6' } })
      .webp()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const r = await receipt([
      { bytes: webp, name: 'shot.webp' },
      { bytes: jpeg({ width: 100, height: 100, note: 'after webp' }), name: 'next.jpg' },
    ]);
    await cycle();
    expect(sentCount()).toBe(before + 1);
    const [pdf] = await pdfsOf(r.fileIds);
    expect(await pageSizes(intakeBytes(pdf.vault_ref))).toEqual([
      [612, 1224],
      [612, 612],
    ]);
  });

  it('sends a receipt that is one PDF as it is', async () => {
    const original = await pdfOf([[300, 400]]);
    const one = await receipt([{ bytes: original, name: 'order.pdf' }]);
    await cycle();
    const row = await item(one.fileIds[0]!);
    expect(row.status).toBe('received');
    expect(Buffer.from(intakeBytes(row.vault_ref)).equals(Buffer.from(original))).toBe(true);
    expect(await pdfsOf(one.fileIds)).toEqual([]);
  });

  it('waits for the capture: a page no receipt holds yet isn’t sent', async () => {
    const before = sentCount();
    const a = await upload(jpeg({ width: 10, height: 10, note: 'part one' }), 'part-1.jpg');
    await run();
    await run();
    expect(await item(a)).toMatchObject({ status: 'queued' });
    expect(sentCount()).toBe(before);
    // The phone comes back online with the next part, and the receipt is made.
    const b = await upload(jpeg({ width: 10, height: 20, note: 'part two' }), 'part-2.jpg');
    const created = await c.post(url('/receipts'), { fileIds: [a, b] });
    await worker.drain(['ai', 'doc']);
    await db.query(`update app.receipt set status = 'inbox' where id = $1`, [created.body.id]);
    await db.query(`update app.vault_item set next_attempt_at = now() where file_id = any ($1::uuid[])`, [
      [a, b],
    ]);
    await cycle();
    expect(sentCount()).toBe(before + 1);
    const [pdf] = await pdfsOf([a, b]);
    expect(pdf).toMatchObject({ source_file_ids: [a, b], page_count: 2 });
  });

  it('waits while the receipt is being read or waits on a person', async () => {
    const before = sentCount();
    const r = await receipt([{ bytes: jpeg({ width: 10, height: 10, note: 'review' }), name: 'r.jpg' }]);
    await db.query(`update app.receipt set status = 'needs_review' where id = $1`, [r.id]);
    await cycle();
    expect(await item(r.fileIds[0]!)).toMatchObject({ status: 'queued' });
    expect(sentCount()).toBe(before);
    await db.query(`update app.receipt set status = 'inbox' where id = $1`, [r.id]);
    await db.query(`update app.vault_item set next_attempt_at = now() where file_id = $1`, [r.fileIds[0]]);
    await cycle();
    expect(sentCount()).toBe(before + 1);
  });

  it('keeps the pages in Montra, and says why, when a page can’t go in a PDF', async () => {
    const before = sentCount();
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([30, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(18, 1),
    ]);
    const r = await receipt([
      { bytes: jpeg({ width: 10, height: 10, note: 'with webp' }), name: 'a.jpg' },
      { bytes: webp, name: 'b.webp' },
    ]);
    await cycle();
    expect(sentCount()).toBe(before);
    for (const f of r.fileIds) {
      expect(await item(f)).toMatchObject({
        status: 'converted',
        render_state: 'not_converted',
        not_kept_reason: RECORD_NOT_CONVERTED_WORDS.unreadable_page,
      });
    }
    expect(await badge(r.fileIds[0]!)).toMatchObject({
      converted: { state: 'not_converted', combined: true },
    });
    // Taking the damaged page out lets the rest go.
    const v = (await c.get(url(`/receipts/${r.id}`))).body.version;
    expect(
      (await c.put(url(`/receipts/${r.id}/pages`), { version: v, fileIds: [r.fileIds[0]] })).status,
    ).toBe(200);
    await cycle();
    expect(sentCount()).toBe(before + 1);
  });

  describe('fixing pages afterwards (ADR-0059 §4)', () => {
    it('moves a page: the new PDF goes as a new document, and the one the vault has stays there', async () => {
      const before = sentCount();
      const [first] = await pdfsOf(mixed.fileIds);
      const r = (await c.get(url(`/receipts/${mixed.id}`))).body;
      const order = [mixed.fileIds[2]!, mixed.fileIds[0]!, mixed.fileIds[1]!];
      const moved = await c.put(url(`/receipts/${mixed.id}/pages`), { version: r.version, fileIds: order });
      expect(moved.status).toBe(200);
      expect(moved.body.fileIds).toEqual(order);
      // Nothing is read again.
      expect(moved.body.total).toBe(r.total);
      await cycle();
      expect(sentCount()).toBe(before + 1);
      const all = await pdfsOf(mixed.fileIds);
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ id: first.id, status: 'received' });
      expect(all[0].superseded_at).not.toBeNull();
      expect(all[1]).toMatchObject({ source_file_ids: order, status: 'received', superseded_at: null });
      expect(await pageSizes(intakeBytes(all[1].vault_ref))).toEqual([
        [200, 100],
        [100, 100],
        [612, 612],
        [612, 1836],
      ]);
      expect(await badge(mixed.fileIds[0]!)).toMatchObject({ converted: { parts: 1, earlier: 1 } });
      // Run again: the same pages are never made twice.
      await cycle();
      expect(sentCount()).toBe(before + 1);
    });

    it('removes a page to the Trash, and refuses removing the last one or adding one', async () => {
      const before = sentCount();
      const r = (await c.get(url(`/receipts/${mixed.id}`))).body;
      const [pdfPage, png] = r.fileIds as string[];
      const stale = await c.put(url(`/receipts/${mixed.id}/pages`), { version: '1', fileIds: [png] });
      expect(stale.status).toBe(409);
      const none = await c.put(url(`/receipts/${mixed.id}/pages`), { version: r.version, fileIds: [] });
      expect(none.status).toBeGreaterThanOrEqual(400);
      const other = await upload(jpeg({ width: 5, height: 5, note: 'not this receipt' }), 'other.jpg');
      const added = await c.put(url(`/receipts/${mixed.id}/pages`), {
        version: r.version,
        fileIds: [...r.fileIds, other],
      });
      expect(added.status).toBe(422);
      expect(added.body.code).toBe('pages.unknown');

      const removed = await c.put(url(`/receipts/${mixed.id}/pages`), {
        version: r.version,
        fileIds: r.fileIds.filter((f: string) => f !== pdfPage),
      });
      expect(removed.status).toBe(200);
      expect((await fileRow(pdfPage!)).deleted_at).not.toBeNull();
      await cycle();
      expect(sentCount()).toBe(before + 1);
      const current = (await pdfsOf(r.fileIds)).filter((p: any) => !p.superseded_at && !p.deleted_at);
      expect(current).toHaveLength(1);
      expect(current[0].source_file_ids).toEqual(r.fileIds.filter((f: string) => f !== pdfPage));
      expect(await pageSizes(intakeBytes(current[0].vault_ref))).toEqual([
        [612, 612],
        [612, 1836],
      ]);
    });

    it('leaves a receipt the vault had before ADR-0059 as it is, until its pages change', async () => {
      const old = await receipt([
        { bytes: jpeg({ width: 10, height: 30, note: 'old 1' }), name: 'old-1.jpg' },
        { bytes: jpeg({ width: 30, height: 10, note: 'old 2' }), name: 'old-2.jpg' },
      ]);
      // Sent one photo at a time, as Montra did before.
      for (const [i, f] of old.fileIds.entries()) {
        await db.query(
          `update app.vault_item set status = 'filed', vault_ref = $2, filed_at = now(), received_at = now()
            where file_id = $1`,
          [f, `m1-old-${i}-${f.slice(0, 8)}`],
        );
      }
      const before = sentCount();
      await cycle();
      expect(sentCount()).toBe(before);
      expect(await pdfsOf(old.fileIds)).toEqual([]);

      const v = (await c.get(url(`/receipts/${old.id}`))).body.version;
      const swapped = [old.fileIds[1]!, old.fileIds[0]!];
      expect((await c.put(url(`/receipts/${old.id}/pages`), { version: v, fileIds: swapped })).status).toBe(
        200,
      );
      await cycle();
      expect(sentCount()).toBe(before + 1);
      const [pdf] = await pdfsOf(old.fileIds);
      expect(pdf).toMatchObject({ source_file_ids: swapped, status: 'received' });
      // What the vault had stays as it was.
      for (const f of old.fileIds) expect((await item(f)).status).toBe('filed');
      expect((await item(old.fileIds[0]!)).pages_changed_at).toBeNull();
    });
  });
});

describe('a bill goes as one PDF (ADR-0059 §1)', () => {
  it('sends a two-page scanned bill as one PDF, and its pages can be moved', async () => {
    const cats = (await c.get(url('/categories'))).body.data;
    const utilities = cats.find((x: any) => x.name === 'Utilities').id;
    const biller = (await c.post(url('/billers'), { categoryId: utilities, name: 'City Power' })).body;
    const text = ['CITY POWER', 'AMOUNT DUE $84.10', 'DUE DATE 2026-12-15', 'KIND electricity'].join('\n');
    const p1 = await upload(encodeFakeReceiptImage(text), 'bill-1.png', '/household-bills/files');
    const p2 = await upload(
      jpeg({ width: 50, height: 100, note: 'bill page 2' }),
      'bill-2.jpg',
      '/household-bills/files',
    );
    const scan = (await c.post(url('/scans'), { kind: 'bill', fileIds: [p1, p2] })).body;
    await worker.drain(['ai']);
    const read = (await c.get(url(`/scans/${scan.id}`))).body;
    expect(read.status).toBe('ready');
    const before = sentCount();
    // Read, and not filed yet: nothing goes.
    await cycle();
    expect(sentCount()).toBe(before);
    const filed = await c.post(url('/household-bills'), {
      billerId: biller.id,
      scanId: scan.id,
      amount: '8410',
      dueDate: '2026-12-15',
    });
    expect(filed.status).toBe(201);
    await db.query(`update app.vault_item set next_attempt_at = now() where file_id = any ($1::uuid[])`, [
      [p1, p2],
    ]);
    await cycle();
    expect(sentCount()).toBe(before + 1);
    const [pdf] = await pdfsOf([p1, p2]);
    expect(pdf).toMatchObject({ source_file_ids: [p1, p2], page_count: 2, status: 'received' });
    expect(await pageSizes(intakeBytes(pdf.vault_ref))).toEqual([
      [612, 612],
      [612, 1224],
    ]);

    const bill = (await c.get(url(`/household-bills/${filed.body.id}`))).body;
    const moved = await c.put(url(`/household-bills/${bill.id}/pages`), {
      version: bill.version,
      fileIds: [p2, p1],
    });
    expect(moved.status).toBe(200);
    expect(moved.body.fileIds).toEqual([p2, p1]);
    expect(moved.body.amount).toBe('8410');
    expect(
      (await c.put(url(`/household-bills/${bill.id}/pages`), { version: bill.version, fileIds: [p1] }))
        .status,
    ).toBe(409);
    await cycle();
    expect(sentCount()).toBe(before + 2);
    const current = (await pdfsOf([p1, p2])).filter((p: any) => !p.superseded_at);
    expect(current[0].source_file_ids).toEqual([p2, p1]);
  });
});
