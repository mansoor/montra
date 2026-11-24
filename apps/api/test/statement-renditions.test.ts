/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/database.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import {
  RENDER_JOB,
  StatementRenditions,
  type RenderOptions,
} from '../src/renditions/statement-renditions.js';
import type { DrawnText } from '../src/renditions/statement-pdf.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { attachments, coverText, drawnRows, drawnTotals } from './fakes/statement-pdf-view.js';
import { startHarness, type Client, type Harness } from './harness.js';

// VLT-13 (ADR-0057 §2–§4): statements rendered from their imported rows and stored as files of their own.

const EMAIL = 'renditions@example.com';
const OTHER = 'renditions-other@example.com';
const MAX_ROWS = 10;
const corpus = (name: string) =>
  readFileSync(join(__dirname, '../../../packages/importers/test/corpus', name));
const DETAIL: RenderOptions = { detail: true, accountNumber: 'last4', attachOriginal: true };

let h: Harness;
let worker: Worker;
let renditions: StatementRenditions;
let storage: StoragePort;
let admin: pg.Client;
let c: Client;
let userId: string;
let wsId: string;
let url: (p: string) => string;
let checking: string;
let drawn: DrawnText[] = [];

async function upload(fileName: string, bytes: Buffer, email = EMAIL, ws = wsId) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${ws}/uploads`,
    headers: {
      authorization: `Bearer dev:${email}`,
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
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { fileId: string; fileType: string };
}

/** Imports a file into an account and commits it. A spreadsheet's extraction is played as the doc-worker would. */
async function importFile(fileName: string, bytes: Buffer, grid?: string[][]) {
  const up = await upload(fileName, bytes);
  const batch = (await c.post(url('/imports'), { fileId: up.fileId, accountId: checking })).body;
  if (grid) {
    const db = h.app.get(Db).kysely;
    const { rows } = await sql<any>`select * from app.dequeue_job('doc', 'test-doc-worker')`.execute(db);
    expect(rows[0]).toMatchObject({ type: 'doc.extract' });
    const result = { kind: 'grid', textLayer: true, pages: 1, sheets: [{ name: 'Sheet1', rows: grid }] };
    await sql`select app.complete_job(${rows[0].id}, ${JSON.stringify(result)}::jsonb)`.execute(db);
  }
  await worker.drain();
  expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('preview');
  await c.post(url(`/imports/${batch.id}/commit`));
  await worker.drain();
  expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('committed');
  return { fileId: up.fileId, batchId: batch.id as string, bytes };
}

const render = (fileId: string, options: RenderOptions = DETAIL) => {
  drawn = [];
  return renditions.render({ workspaceId: wsId, userId }, fileId, options);
};

/** "1,234.56" from minor units, worked out apart from the renderer. */
function fmt(minor: bigint): string {
  const s = (minor < 0n ? -minor : minor).toString().padStart(3, '0');
  const whole = s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0n ? '-' : ''}${whole}.${s.slice(-2)}`;
}

/** The batch's rows as the import stored them, and its balances. */
async function batchRows(batchId: string) {
  const { rows } = await admin.query(
    `select txn_date::text as date, coalesce(description, payee_raw, '') as description, amount_minor::text as amount
       from app.import_row where import_batch_id = $1 and status <> 'error' order by txn_date, row_no`,
    [batchId],
  );
  const { rows: b } = await admin.query(
    `select statement_opening_minor::text as opening, statement_closing_minor::text as closing
       from app.import_batch where id = $1`,
    [batchId],
  );
  return {
    rows: rows.map((r): { date: string; description: string; amount: bigint } => ({
      date: r.date,
      description: r.description,
      amount: BigInt(r.amount),
    })),
    opening: b[0].opening === null ? null : BigInt(b[0].opening),
    closing: b[0].closing === null ? null : BigInt(b[0].closing),
  };
}

/** The PDF drawn for a batch shows every row and the batch's totals. */
async function expectMatches(batchId: string) {
  const { rows, opening, closing } = await batchRows(batchId);
  const shown = drawnRows(drawn);
  expect(shown.map((r) => [r.date, r.description])).toEqual(rows.map((r) => [r.date, r.description]));
  expect(shown.map((r) => r.out ?? `+${r.in}`)).toEqual(
    rows.map((r) => (r.amount < 0n ? fmt(-r.amount) : `+${fmt(r.amount)}`)),
  );
  const moneyIn = rows.filter((r) => r.amount > 0n).reduce((t, r) => t + r.amount, 0n);
  const moneyOut = rows.filter((r) => r.amount < 0n).reduce((t, r) => t - r.amount, 0n);
  const totals = drawnTotals(drawn, 'Totals');
  expect(totals).toMatchObject({ out: fmt(moneyOut), in: fmt(moneyIn) });
  // The closing balance, the statement's own or worked out from its opening one.
  const end = closing ?? (opening === null ? null : opening + moneyIn - moneyOut);
  if (end !== null) expect([totals!.balance, shown.at(-1)!.balance]).toEqual([fmt(end), fmt(end)]);
  return { rows, moneyIn, moneyOut };
}

async function fileRow(id: string) {
  const { rows } = await admin.query(
    `select id, kind, mime, file_name, bytes, sha256, storage_key, derived_from_file_id, rendition, deleted_at,
            page_count, uploaded_by
       from app.file where id = $1`,
    [id],
  );
  return rows[0];
}

const renditionIds = async (fileId: string) =>
  (
    await admin.query(`select id from app.file where derived_from_file_id = $1 order by file_name`, [fileId])
  ).rows.map((r) => r.id as string);

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    AI_PROVIDER: 'fake',
    STATEMENT_PDF_MAX_ROWS: String(MAX_ROWS),
  });
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  renditions = h.app.get(StatementRenditions);
  renditions.register();
  renditions.trace = (t) => drawn.push(t);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Renditions', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  userId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  const member = (await c.post(url('/family-members'), { name: 'Sam Rivera', relationship: 'self' })).body.id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Everyday Checking',
      kind: 'checking',
      institution: 'First Bank',
      last4: '4321',
      defaultMemberId: member,
    })
  ).body.id;
});

afterAll(async () => {
  // Nothing of ours may wake a worker in another test file.
  await admin.query(`delete from app.storage_destination where workspace_id = $1`, [wsId]);
  await admin.query(`delete from app.job where type in ('storage.vault', 'storage.mirror', $1)`, [
    RENDER_JOB,
  ]);
  await admin.end();
  await h.close();
});

beforeEach(() => {
  drawn = [];
});

describe('rendering an imported statement (ADR-0057 §2)', () => {
  it('a CSV: every row and the totals, the cover from the account, the original attached byte for byte', async () => {
    const csv = Buffer.from(
      [
        'Date,Description,Amount,Balance',
        '2026-10-01,Payroll ACME,2500.00,3500.00',
        '2026-10-02,Rent October,-2000.00,1500.00',
        '2026-10-04,GROCERY OUTLET,-45.75,1454.25',
        '2026-10-09,Café Lumière,-12.40,1441.85',
      ].join('\n'),
    );
    const { fileId, batchId } = await importFile('october.csv', csv);
    const r = await render(fileId);
    expect(r).toMatchObject({ status: 'rendered', coverOnly: false, replaced: [] });
    if (r.status !== 'rendered') throw new Error('not rendered');
    expect(r.files).toHaveLength(1);
    await expectMatches(batchId);

    const cover = coverText(drawn);
    for (const s of [
      'Everyday Checking',
      'First Bank',
      'Checking',
      'Sam Rivera',
      '••••4321',
      'USD',
      'october.csv',
      'CSV',
    ])
      expect(cover).toContain(s);
    expect(cover).toContain((await fileRow(fileId)).sha256);
    expect(cover).not.toContain('4321 ');

    // Stored as a file of its own: the original's kind, linked to it, counted like any file.
    const f = await fileRow(r.files[0]!.fileId);
    expect(f).toMatchObject({
      kind: 'statement',
      mime: 'application/pdf',
      file_name: 'october.csv (PDF).pdf',
      derived_from_file_id: fileId,
      rendition: 'statement_pdf',
      deleted_at: null,
      page_count: 2,
      uploaded_by: null,
    });
    const bytes = await storage.get(f.storage_key);
    expect(f.sha256).toBe(r.files[0]!.sha256);
    expect(Number(f.bytes)).toBe(bytes.length);
    const files = await attachments(bytes);
    expect(Buffer.from(files.get('october.csv')!.bytes).equals(csv)).toBe(true);
    const usage = (await c.get(url('/storage'))).body;
    expect(BigInt(usage.byKind.statement)).toBeGreaterThanOrEqual(BigInt(bytes.length + csv.length));
  });

  it('an XLS statement, read by the doc-worker', async () => {
    const grid = [
      ['Posted', 'Details', 'Debit', 'Credit', 'Balance'],
      ['03/10/2026', 'Card payment COFFEE', '3.50', '', '996.50'],
      ['05/10/2026', 'Transfer in', '', '200.00', '1196.50'],
      ['06/10/2026', 'Electricity', '80.25', '', '1116.25'],
    ];
    const xls = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('xls'),
    ]);
    const { fileId, batchId } = await importFile('statement.xls', xls, grid);
    expect(await render(fileId)).toMatchObject({ status: 'rendered' });
    const { rows } = await expectMatches(batchId);
    expect(rows).toHaveLength(3);
    expect(coverText(drawn)).toContain('XLS');
  });

  it('an OFX download: the running balance works back from its closing balance', async () => {
    const { fileId, batchId } = await importFile('download.ofx', corpus('bank-ofx1.ofx'));
    expect(await render(fileId)).toMatchObject({ status: 'rendered' });
    const { rows } = await expectMatches(batchId);
    expect(rows).toHaveLength(5);
    expect(drawnTotals(drawn, 'Totals')!.balance).toBe('3,731.13');
    expect(coverText(drawn)).toContain('OFX');
  });

  it('splits a statement longer than STATEMENT_PDF_MAX_ROWS into parts, each its own file', async () => {
    const lines = Array.from(
      { length: 23 },
      (_, i) => `2026-09-${String(i + 1).padStart(2, '0')},Item ${i + 1},-1.00`,
    );
    const { fileId } = await importFile(
      'september.csv',
      Buffer.from(['Date,Description,Amount', ...lines].join('\n')),
    );
    const r = await render(fileId, { ...DETAIL, attachOriginal: false });
    if (r.status !== 'rendered') throw new Error(r.status);
    expect(r.files.map((f) => [f.part, f.parts])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    const names: string[] = [];
    for (const f of r.files) names.push((await fileRow(f.fileId)).file_name);
    expect(names).toEqual([
      'september.csv (PDF, part 1 of 3).pdf',
      'september.csv (PDF, part 2 of 3).pdf',
      'september.csv (PDF, part 3 of 3).pdf',
    ]);
    expect([1, 2, 3].map((p) => drawnRows(drawn, p).length)).toEqual([MAX_ROWS, MAX_ROWS, 3]);
    const third = await PDFDocument.load(await storage.get((await fileRow(r.files[2]!.fileId)).storage_key), {
      updateMetadata: false,
    });
    expect(third.getTitle()).toBe('Everyday Checking statement, 2026-09-01 to 2026-09-23, part 3 of 3');
    expect(drawnTotals(drawn, 'Statement totals', 3)).toMatchObject({ out: '23.00', in: '0.00' });
  });
});

describe('the cover follows the detail switch and the number setting (ADR-0057 §3)', () => {
  let fileId: string;
  beforeAll(async () => {
    fileId = (await importFile('cover.csv', Buffer.from('Date,Description,Amount\n2026-08-03,Lunch,-9.99\n')))
      .fileId;
  });

  it('off: no amounts, no number, nothing about the file', async () => {
    await render(fileId, { detail: false, accountNumber: 'last4', attachOriginal: false });
    const cover = coverText(drawn);
    expect(cover).toContain('Everyday Checking');
    expect(cover).toContain('Sam Rivera');
    expect(cover).not.toMatch(/\$|4321|cover\.csv|SHA-256/);
    // The rows are the statement itself, and are drawn whatever the switch.
    expect(drawnRows(drawn)).toHaveLength(1);
  });

  it('on: the last four by default, none when None, and no full number unless Full is passed in', async () => {
    await render(fileId, { detail: true, accountNumber: 'none', attachOriginal: false });
    expect(coverText(drawn)).not.toContain('4321');
    expect(coverText(drawn)).toContain('$9.99');
    await render(fileId, { detail: true, accountNumber: 'last4', attachOriginal: false });
    expect(coverText(drawn)).toContain('••••4321');
    // No full number is kept yet (ADR-0057 §6 arrives with PR 1): Full still shows only the last four.
    await render(fileId, { detail: true, accountNumber: 'full', attachOriginal: false });
    expect(coverText(drawn)).toContain('••••4321');
  });
});

describe('a file the import couldn’t read (ADR-0057 §2)', () => {
  it('with the original attached: the cover alone, saying so; without: not converted, and no file', async () => {
    const junk = Buffer.from('this is not a statement at all\n\u0001');
    const up = await upload('mystery.txt', junk);
    expect(await render(up.fileId, { ...DETAIL, attachOriginal: false })).toEqual({
      status: 'not_converted',
      reason: 'unreadable',
    });
    expect(await renditionIds(up.fileId)).toEqual([]);

    const r = await render(up.fileId);
    if (r.status !== 'rendered') throw new Error(r.status);
    expect(r.coverOnly).toBe(true);
    expect(coverText(drawn)).toContain("Montra couldn't render this statement");
    expect(drawnRows(drawn)).toEqual([]);
    const f = await fileRow(r.files[0]!.fileId);
    expect(f.page_count).toBe(1);
    const files = await attachments(await storage.get(f.storage_key));
    expect(Buffer.from(files.get('mystery.txt')!.bytes).equals(junk)).toBe(true);
  });

  it('waits while the import is still open, and renders nothing that isn’t an uploaded statement', async () => {
    const up = await upload('open.csv', Buffer.from('Date,Description,Amount\n2026-07-01,X,-1.00\n'));
    await c.post(url('/imports'), { fileId: up.fileId, accountId: checking });
    await worker.drain();
    expect(await render(up.fileId)).toEqual({ status: 'not_ready' });
    expect(await render(randomUUID())).toEqual({ status: 'not_renderable', reason: 'not_found' });
  });
});

describe('a rendering is a file of its own (ADR-0057 §4)', () => {
  let fileId: string;
  let batchId: string;
  beforeAll(async () => {
    ({ fileId, batchId } = await importFile(
      'june.csv',
      Buffer.from('Date,Description,Amount\n2026-06-01,Gym,-30.00\n'),
    ));
  });

  it('replaces one not yet sent, removing its stored copy', async () => {
    const first = await render(fileId);
    if (first.status !== 'rendered') throw new Error(first.status);
    const oldKey = (await fileRow(first.files[0]!.fileId)).storage_key;
    const second = await render(fileId, { ...DETAIL, detail: false });
    if (second.status !== 'rendered') throw new Error(second.status);
    expect(second.replaced).toEqual([first.files[0]!.fileId]);
    expect(await renditionIds(fileId)).toEqual([second.files[0]!.fileId]);
    await expect(storage.get(oldKey)).rejects.toThrow();
    // Rendering again from the same inputs gives the same bytes.
    const third = await render(fileId, { ...DETAIL, detail: false });
    if (third.status !== 'rendered') throw new Error(third.status);
    expect(third.files[0]!.sha256).toBe(second.files[0]!.sha256);
  });

  it('is never rendered again, and keeps its original’s kind', async () => {
    const [rendition] = await renditionIds(fileId);
    expect(await render(rendition!)).toEqual({ status: 'not_renderable', reason: 'rendition' });
    const other = await upload('other.csv', Buffer.from('Date,Amount\n2026-01-01,1.00\n'));
    // Made from a rendering: refused.
    await expect(
      admin.query(
        `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, derived_from_file_id, rendition)
         values ($1, gen_random_uuid(), 'statement', 'k', 'x.pdf', 'application/pdf', 1, $2, $3, 'statement_pdf')`,
        [wsId, 'a'.repeat(64), rendition],
      ),
    ).rejects.toThrow(/not rendered again/);
    // Another kind than its original's: refused.
    await expect(
      admin.query(
        `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, derived_from_file_id, rendition)
         values ($1, gen_random_uuid(), 'receipt', 'k', 'x.pdf', 'application/pdf', 1, $2, $3, 'statement_pdf')`,
        [wsId, 'a'.repeat(64), other.fileId],
      ),
    ).rejects.toThrow(/keeps its original/);
    // Derived without saying what rendering it is: refused.
    await expect(
      admin.query(
        `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, derived_from_file_id)
         values ($1, gen_random_uuid(), 'statement', 'k', 'x.pdf', 'application/pdf', 1, $2, $3)`,
        [wsId, 'a'.repeat(64), other.fileId],
      ),
    ).rejects.toThrow(/file_rendition_of/);
  });

  it('belongs to its workspace: another workspace can’t see it or point at it', async () => {
    const [rendition] = await renditionIds(fileId);
    const o = h.as(OTHER);
    const other = (
      await o.post('/v1/workspaces', { name: 'Elsewhere', baseCurrency: 'USD', template: 'household' })
    ).body.id;
    const otherUser = (await admin.query(`select id from app.app_user where email = $1`, [OTHER])).rows[0].id;
    const seen = await h.app
      .get(Db)
      .run({ workspaceId: other, userId: otherUser }, (trx) =>
        trx.selectFrom('app.file').select('id').where('id', 'in', [rendition!, fileId]).execute(),
      );
    expect(seen).toEqual([]);
    expect(await renditions.render({ workspaceId: other, userId: otherUser }, fileId, DETAIL)).toEqual({
      status: 'not_renderable',
      reason: 'not_found',
    });
    // The link is to a file in the same workspace only.
    const theirs = await upload('theirs.csv', Buffer.from('Date,Amount\n2026-01-01,1.00\n'), OTHER, other);
    await expect(
      admin.query(
        `update app.file set derived_from_file_id = $1, rendition = 'statement_pdf' where id = $2`,
        [fileId, theirs.fileId],
      ),
    ).rejects.toThrow(/file_derived_from/);
  });

  it('goes in the Trash and comes back with its original, and outlives its link when the original is gone', async () => {
    const [rendition] = await renditionIds(fileId);
    await admin.query(`update app.file set deleted_at = now() where id = $1`, [fileId]);
    expect((await fileRow(rendition!)).deleted_at).not.toBeNull();
    await admin.query(`update app.file set deleted_at = null where id = $1`, [fileId]);
    expect((await fileRow(rendition!)).deleted_at).toBeNull();
    // Deleted for good: the rendering stays a file, unlinked, and is purged by its own row.
    const orphan = await upload('gone.csv', Buffer.from('Date,Amount\n2026-01-01,1.00\n'));
    const id = randomUUID();
    await admin.query(
      `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, derived_from_file_id, rendition)
       values ($1, $2, 'statement', $3, 'gone.csv (PDF).pdf', 'application/pdf', 1, $4, $5, 'statement_pdf')`,
      [wsId, id, `${wsId}/statement/2026/${id}`, 'b'.repeat(64), orphan.fileId],
    );
    await admin.query(`delete from app.file where id = $1`, [orphan.fileId]);
    expect(await fileRow(id)).toMatchObject({ derived_from_file_id: null, rendition: 'statement_pdf' });
    await admin.query(`delete from app.file where id = $1`, [id]);
  });

  it('isn’t queued for the vault when stored; one the vault has is kept, and an undone import drops only unsent ones', async () => {
    const dest = (
      await admin.query(
        `insert into app.storage_destination (workspace_id, kind, label, folder, file_kinds, status, secret_enc)
         values ($1, 'fdv', 'Vault', 'montra', '{statement}', 'active', $2) returning id`,
        [wsId, Buffer.from([0])],
      )
    ).rows[0].id;
    const queued = async (id: string) =>
      (await admin.query(`select status from app.vault_item where file_id = $1`, [id])).rows.map(
        (r) => r.status,
      );
    const r = await render(fileId);
    if (r.status !== 'rendered') throw new Error(r.status);
    const pdfId = r.files[0]!.fileId;
    expect(await queued(pdfId)).toEqual([]);
    // An upload is still queued as before.
    const plain = await upload('plain.csv', Buffer.from('Date,Amount\n2026-01-01,1.00\n'));
    expect(await queued(plain.fileId)).toEqual(['queued']);

    // Say the vault filed this rendering (as sending, ADR-0057 §1, will): it is kept, not redone.
    await admin.query(
      `insert into app.vault_item (workspace_id, destination_id, file_id, vault_ref, status, filed_at)
       values ($1, $2, $3, $4, 'filed', now())`,
      [wsId, dest, pdfId, `m-${pdfId}`],
    );
    expect(await render(fileId, { ...DETAIL, detail: false })).toMatchObject({
      status: 'kept',
      files: [{ fileId: pdfId }],
    });

    // Undo the import: the sent rendering stays; an unsent one goes, with its stored copy.
    const unsentId = randomUUID();
    const key = `${wsId}/statement/2026/${unsentId}`;
    await storage.put(key, new Uint8Array([1]), 'application/pdf');
    await admin.query(
      `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, derived_from_file_id, rendition)
       values ($1, $2, 'statement', $3, 'june.csv (PDF, part 2 of 2).pdf', 'application/pdf', 1, $4, $5, 'statement_pdf')`,
      [wsId, unsentId, key, 'c'.repeat(64), fileId],
    );
    expect((await c.post(url(`/imports/${batchId}/undo`))).status).toBeLessThan(300);
    await worker.drain();
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('undone');
    expect(await renditionIds(fileId)).toEqual([pdfId]);
    await expect(storage.get(key)).rejects.toThrow();
    expect(await render(fileId)).toMatchObject({ status: 'kept' });
    await admin.query(`delete from app.vault_item where workspace_id = $1`, [wsId]);
    expect(await render(fileId)).toEqual({ status: 'import_undone', dropped: [pdfId] });
    expect(await renditionIds(fileId)).toEqual([]);
  });
});

describe('the worker’s job', () => {
  it('runs a rendering for a file, as the user who queued it', async () => {
    const { fileId } = await importFile(
      'job.csv',
      Buffer.from('Date,Description,Amount\n2026-05-01,Books,-15.00\n'),
    );
    await h.app
      .get(Db)
      .run({ workspaceId: wsId, userId }, (trx) =>
        renditions.enqueue(trx, { workspaceId: wsId, userId }, fileId, DETAIL),
      );
    await worker.drain(['report']);
    const { rows } = await admin.query(
      `select status, result from app.job where type = $1 and workspace_id = $2`,
      [RENDER_JOB, wsId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', result: { status: 'rendered' } });
    expect(rows[0].result.files).toEqual(await renditionIds(fileId));
  });
});
