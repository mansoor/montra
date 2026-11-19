/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { IntakeJobs } from '../src/intakes/intake-jobs.js';
import { ScanJobs } from '../src/scans/scan-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Discarding an import that was never committed (IMP-09): its preview goes, the batch stays as `discarded`, the file
// is kept, and a statement that led to it goes back to Review.

const CHASE = readFileSync(join(__dirname, '../../../packages/importers/test/corpus/chase-checking.csv'));

let h: Harness;
let worker: Worker;
let c: Client;
let db: pg.Client;
const EMAIL = 'discarder@example.com';

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    AI_PROVIDER: 'fake',
  });
  h.app.get(ImportJobs).register();
  h.app.get(IntakeJobs).register();
  h.app.get(ScanJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
});
afterAll(async () => {
  await db?.end();
  await h.close();
});

async function multipart(path: string, fileName: string, bytes: Uint8Array, email = EMAIL) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: path,
    headers: {
      authorization: `Bearer dev:${email}`,
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
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const count = async (q: string, args: unknown[]) => Number((await db.query(q, args)).rows[0].count);

describe('discarding an import that was never committed', () => {
  let url: (p: string) => string;
  let checking: string;

  beforeAll(async () => {
    const ws = (
      await c.post('/v1/workspaces', { name: 'Discard', baseCurrency: 'USD', template: 'household' })
    ).body;
    url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
    checking = (await c.post(url('/accounts'), { name: 'Checking', kind: 'checking', last4: '1234' })).body
      .id;
  });

  /** Uploads the Chase CSV and starts its import; `read` lets the worker parse it into a preview. */
  const start = async (read = true) => {
    const up = await multipart(url('/uploads'), 'chase.csv', CHASE);
    expect(up.status).toBe(201);
    const started = await c.post(url('/imports'), { fileId: up.body.fileId, accountId: checking });
    expect(started.status).toBe(202);
    if (read) await worker.drain();
    return { fileId: up.body.fileId as string, batchId: started.body.id as string };
  };

  it('drops the preview rows, keeps the batch as discarded with its file, audits it and leaves the history', async () => {
    const { fileId, batchId } = await start();
    expect((await c.get(url(`/imports/${batchId}`))).body).toMatchObject({
      status: 'preview',
      counts: { read: 6 },
    });
    expect(await count('select count(*) from app.import_row where import_batch_id = $1', [batchId])).toBe(6);

    const res = await c.post(url(`/imports/${batchId}/discard`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: batchId, status: 'discarded', fileId });

    expect(await count('select count(*) from app.import_row where import_batch_id = $1', [batchId])).toBe(0);
    expect(
      await count('select count(*) from app.transaction_source where import_batch_id = $1', [batchId]),
    ).toBe(0);
    // The uploaded file stays: a statement, the vault or a backup may still use it.
    expect(await count('select count(*) from app.file where id = $1 and deleted_at is null', [fileId])).toBe(
      1,
    );
    const audit = (
      await db.query(
        `select actor_type, diff from app.audit_log where subject_id = $1 and action = 'import_batch.discarded'`,
        [batchId],
      )
    ).rows;
    expect(audit).toEqual([
      expect.objectContaining({
        actor_type: 'user',
        diff: expect.objectContaining({ from: 'preview', rowsDeleted: 6, fileId, intakeId: null }),
      }),
    ]);
    // The trigger's row records the status change too.
    expect(
      await count(
        `select count(*) from app.audit_log where subject_id = $1 and action = 'import_batch.update'
            and diff -> 'status' = '["preview", "discarded"]'::jsonb`,
        [batchId],
      ),
    ).toBe(1);

    // It leaves the history, and is still readable on its own page.
    const listed = (await c.get(url('/imports'))).body.data.map((b: any) => b.id);
    expect(listed).not.toContain(batchId);
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('discarded');

    // Nothing more happens to it.
    const again = await c.post(url(`/imports/${batchId}/discard`));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('import.not_discardable');
    expect((await c.post(url(`/imports/${batchId}/commit`))).status).toBe(409);

    // The same file uploaded again isn't reported as imported before: nothing came of it.
    const reup = await multipart(url('/uploads'), 'chase.csv', CHASE);
    expect(reup.body.duplicateOf).toBeNull();
  });

  it('cancels the jobs still queued for it, and a read already under way leaves it alone', async () => {
    const { batchId } = await start(false);
    const before = await db.query(
      `select id from app.job where payload ->> 'batchId' = $1 and status = 'queued'`,
      [batchId],
    );
    expect(before.rows.length).toBe(1);
    const res = await c.post(url(`/imports/${batchId}/discard`));
    expect(res.status).toBe(200);
    expect(
      (await db.query(`select status from app.job where id = $1`, [before.rows[0].id])).rows[0].status,
    ).toBe('cancelled');
    await worker.drain();
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('discarded');

    // A parse job that was already running when it was discarded skips it.
    const late = await start(false);
    await db.query(`update app.job set status = 'running' where payload ->> 'batchId' = $1`, [late.batchId]);
    expect((await c.post(url(`/imports/${late.batchId}/discard`))).status).toBe(200);
    await db.query(`update app.job set status = 'queued' where payload ->> 'batchId' = $1`, [late.batchId]);
    await worker.drain();
    expect((await c.get(url(`/imports/${late.batchId}`))).body.status).toBe('discarded');
    expect(
      await count('select count(*) from app.import_row where import_batch_id = $1', [late.batchId]),
    ).toBe(0);
    const ran = await db.query(`select status, result from app.job where payload ->> 'batchId' = $1`, [
      late.batchId,
    ]);
    expect(ran.rows).toEqual([{ status: 'succeeded', result: { skipped: 'discarded' } }]);
  });

  it('refuses committed, undone and committing imports, and keeps their transactions', async () => {
    const { batchId } = await start();
    expect((await c.post(url(`/imports/${batchId}/commit`))).status).toBe(202);
    // Committing: refused while the worker has it.
    const committing = await c.post(url(`/imports/${batchId}/discard`));
    expect(committing.status).toBe(409);
    expect(committing.body.code).toBe('import.not_discardable');
    await worker.drain();
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('committed');
    expect((await c.post(url(`/imports/${batchId}/discard`))).status).toBe(409);
    const posted = await count('select count(*) from app.transaction_source where import_batch_id = $1', [
      batchId,
    ]);
    expect(posted).toBeGreaterThan(0);

    expect((await c.post(url(`/imports/${batchId}/undo`))).status).toBe(202);
    await worker.drain();
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('undone');
    expect((await c.post(url(`/imports/${batchId}/discard`))).status).toBe(409);
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('undone');
  });

  it('is for the roles that import files', async () => {
    const { batchId } = await start();
    const viewer = h.as('discard-viewer@example.com');
    const invite = await c.post(url('/sharing/invites'), {
      email: 'discard-viewer@example.com',
      role: 'viewer',
    });
    expect((await viewer.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
    expect((await viewer.post(url(`/imports/${batchId}/discard`))).status).toBe(403);

    // Someone else's workspace can't reach it.
    const other = h.as('discard-other@example.com');
    await other.post('/v1/workspaces', { name: 'Other', baseCurrency: 'USD', template: 'household' });
    expect((await other.post(url(`/imports/${batchId}/discard`))).status).toBeGreaterThanOrEqual(403);

    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('preview');
    expect((await c.post(url(`/imports/${batchId}/discard`))).status).toBe(200);
    expect((await c.post(url('/imports/00000000-0000-4000-8000-000000000000/discard'))).status).toBe(404);
  });

  it('sends a statement whose import is discarded back to Review, to pick the account again', async () => {
    const up = await multipart(url('/intakes/files'), 'Chase1234_Activity.csv', CHASE);
    expect(up.status).toBe(202);
    await worker.drain(['import']);
    const suggested = (await c.get(url(`/intakes/${up.body.id}`))).body;
    expect(suggested).toMatchObject({ status: 'suggested', targetId: checking });
    // Confirmed on the web: the import waits in preview.
    const done = (await c.post(url(`/intakes/${up.body.id}/resolve`), { targetId: checking })).body;
    expect(done.status).toBe('done');
    await worker.drain(['import']);
    const batchId = done.importBatchId as string;
    expect((await c.get(url(`/imports/${batchId}`))).body.status).toBe('preview');

    expect((await c.post(url(`/imports/${batchId}/discard`))).status).toBe(200);
    const back = (await c.get(url(`/intakes/${up.body.id}`))).body;
    expect(back).toMatchObject({ status: 'review', reason: 'discarded', importBatchId: null });
    const open = (await c.get(url('/intakes'))).body.data.map((i: any) => i.id);
    expect(open).toContain(up.body.id);
    const audit = (
      await db.query(
        `select diff from app.audit_log where subject_id = $1 and action = 'import_batch.discarded'`,
        [batchId],
      )
    ).rows[0];
    expect(audit.diff.intakeId).toBe(up.body.id);

    // Picking the account again starts a new import from the same file.
    const again = (await c.post(url(`/intakes/${up.body.id}/resolve`), { targetId: checking })).body;
    expect(again.status).toBe('done');
    expect(again.importBatchId).not.toBe(batchId);
    await worker.drain(['import']);
    expect((await c.get(url(`/imports/${again.importBatchId}`))).body.status).toBe('preview');
  });
});
