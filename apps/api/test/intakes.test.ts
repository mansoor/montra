/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { Db } from '../src/db/database.js';
import { Worker } from '../src/jobs/queue.js';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { IntakeJobs } from '../src/intakes/intake-jobs.js';
import { PayslipJobs } from '../src/payslips/payslip-jobs.js';
import { ScanJobs } from '../src/scans/scan-jobs.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Statements and bills find their account or biller, learn it, and wait in Review otherwise (ADR-0051).

const CHASE = readFileSync(join(__dirname, '../../../packages/importers/test/corpus/chase-checking.csv'));

let h: Harness;
let worker: Worker;
let c: Client;
const EMAIL = 'intakes@example.com';

beforeAll(async () => {
  h = await startHarness({
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    AI_PROVIDER: 'fake',
  });
  h.app.get(ImportJobs).register();
  h.app.get(IntakeJobs).register();
  h.app.get(ScanJobs).register();
  h.app.get(PayslipJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
});
afterAll(() => h.close());

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

async function setup(name: string, client = c) {
  const ws = (await client.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  return { ws, url };
}

describe('statements without an account (ADR-0051 §1–§4, §6)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let checking: string;
  let savings: string;
  const intakeIds: string[] = [];

  /** Uploads the Chase CSV as if downloaded again, and lets the worker read it (and import it, when learned). */
  const drop = async (name = 'Chase1234_Activity.csv') => {
    const up = await multipart(w.url('/intakes/files'), name, CHASE);
    expect(up.status).toBe(202);
    expect(up.body).toMatchObject({ kind: 'statement', status: 'reading', fileType: 'csv' });
    await worker.drain(['import']);
    intakeIds.push(up.body.id);
    return (await c.get(w.url(`/intakes/${up.body.id}`))).body;
  };

  beforeAll(async () => {
    w = await setup('Statements');
    checking = (await c.post(w.url('/accounts'), { name: 'Checking', kind: 'checking', last4: '1234' })).body
      .id;
    savings = (await c.post(w.url('/accounts'), { name: 'Savings', kind: 'savings', last4: '9876' })).body.id;
  });

  it('suggests the account from the digits in the file name, and learns from three confirmations', async () => {
    for (let n = 1; n <= 3; n++) {
      const intake = await drop();
      expect(intake).toMatchObject({
        status: 'suggested',
        reason: null,
        targetId: checking,
        targetName: 'Checking',
        automatic: false,
        detected: { last4: '1234', fileNamePattern: 'chase#_activity' },
        learning: { confirmations: n - 1, needed: 3 },
      });
      expect(intake.candidates[0]).toMatchObject({ id: checking, last4: '1234' });
      // It waits in Review until it's confirmed.
      const open = (await c.get(w.url('/intakes'))).body.data;
      expect(open.map((i: any) => i.id)).toContain(intake.id);

      // Confirmed on the web: the import continues in the existing preview.
      const done = (await c.post(w.url(`/intakes/${intake.id}/resolve`), { targetId: checking })).body;
      expect(done).toMatchObject({ status: 'done', learning: { confirmations: n } });
      await worker.drain(['import']);
      expect((await c.get(w.url(`/imports/${done.importBatchId}`))).body).toMatchObject({
        status: 'preview',
        accountId: checking,
      });
    }
    expect((await c.get(w.url('/intakes'))).body.data).toEqual([]);
  });

  it('imports the fourth automatically when the import is clean', async () => {
    const intake = await drop();
    expect(intake).toMatchObject({ status: 'done', automatic: true, targetId: checking, reason: null });
    const batch = (await c.get(w.url(`/imports/${intake.importBatchId}`))).body;
    expect(batch).toMatchObject({ status: 'committed', accountId: checking, counts: { added: 6 } });
    expect(batch.undoUntil).not.toBeNull();
  });

  it('sends an import that is not clean to Review, with its import waiting in preview', async () => {
    // The same rows again: nothing new, which is a decision.
    const intake = await drop();
    expect(intake).toMatchObject({
      status: 'review',
      reason: 'nothing_new',
      automatic: true,
      targetId: checking,
    });
    expect((await c.get(w.url(`/imports/${intake.importBatchId}`))).body).toMatchObject({
      status: 'preview',
      counts: { duplicate: 6 },
    });
    const open = (await c.get(w.url('/intakes'))).body.data;
    expect(open).toEqual([expect.objectContaining({ id: intake.id, reason: 'nothing_new' })]);
    expect((await c.post(w.url(`/intakes/${intake.id}/dismiss`))).body.status).toBe('dismissed');
  });

  it('forgets the account when an automatic import is undone, and a correction starts again', async () => {
    const auto = (await c.get(w.url(`/intakes/${intakeIds[3]}`))).body;
    expect((await c.post(w.url(`/imports/${auto.importBatchId}/undo`))).status).toBe(202);
    await worker.drain(['import']);
    const back = (await c.get(w.url(`/intakes/${auto.id}`))).body;
    expect(back).toMatchObject({ status: 'review', reason: 'undone', learning: { confirmations: 0 } });

    // It was really savings: a correction, so the memory points there with one confirmation.
    const fixed = (await c.post(w.url(`/intakes/${auto.id}/resolve`), { targetId: savings })).body;
    expect(fixed).toMatchObject({ status: 'done', targetId: savings, learning: { confirmations: 1 } });
    expect(fixed.importBatchId).not.toBe(auto.importBatchId);

    // The next file is neither automatic nor suggested: the memory and the digits disagree.
    const next = await drop();
    expect(next).toMatchObject({ status: 'review', reason: 'several', targetId: null });
    expect(next.candidates.map((x: any) => [x.id, x.reason])).toEqual([
      [savings, 'learned'],
      [checking, 'last4'],
    ]);
  });

  it('commits a confirmed import only when clean when asked (the phone), and replaces an import waiting for another account', async () => {
    const next = (await c.get(w.url(`/intakes/${intakeIds.at(-1)}`))).body;
    const res = (
      await c.post(w.url(`/intakes/${next.id}/resolve`), { targetId: savings, commitIfClean: true })
    ).body;
    expect(res).toMatchObject({ status: 'importing', targetId: savings });
    await worker.drain(['import']);
    const after = (await c.get(w.url(`/intakes/${next.id}`))).body;
    // Savings already holds these rows from the correction above (still in preview, so not duplicates): it's clean.
    expect(after).toMatchObject({ status: 'done', automatic: false });
    expect((await c.get(w.url(`/imports/${after.importBatchId}`))).body.status).toBe('committed');
  });

  it('offers the accounts a saved mapping profile belongs to for a file of the same shape', async () => {
    // No digits in the name: the header fingerprint finds the profiles saved when Checking and Savings committed.
    const intake = await drop('export.csv');
    expect(intake).toMatchObject({ status: 'review', reason: 'several', targetId: null });
    expect(intake.candidates.map((x: any) => [x.id, x.reason]).sort()).toEqual(
      [
        [checking, 'profile'],
        [savings, 'profile'],
      ].sort(),
    );
    // Digits in the name are more specific than the layout: only their account is offered.
    const named = await drop('Chase9876_Activity.csv');
    expect(named).toMatchObject({ status: 'suggested', targetId: savings });
    expect(named.candidates).toEqual([expect.objectContaining({ id: savings, reason: 'last4' })]);
    await c.post(w.url(`/intakes/${named.id}/dismiss`));
  });

  it('offers recent accounts when nothing identifies the file, and never picks them itself', async () => {
    const up = await multipart(
      w.url('/intakes/files'),
      'download.csv',
      Buffer.from(
        ['Posted On,Details,Value', '2026-11-02,CORNER CAFE,-4.50', '2026-11-03,BOOKSHOP,-12.00', ''].join(
          '\n',
        ),
      ),
    );
    await worker.drain(['import']);
    const intake = (await c.get(w.url(`/intakes/${up.body.id}`))).body;
    expect(intake).toMatchObject({ status: 'review', reason: 'no_match', targetId: null });
    expect(intake.candidates.every((x: any) => x.reason === 'recent')).toBe(true);
    expect(intake.candidates.map((x: any) => x.id)).toEqual(expect.arrayContaining([checking, savings]));
  });

  it('refuses statements to people who do not import files, and keeps workspaces apart', async () => {
    const viewer = h.as('intake-viewer@example.com');
    const invite = await c.post(w.url('/sharing/invites'), {
      email: 'intake-viewer@example.com',
      role: 'viewer',
    });
    expect((await viewer.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
    expect(
      (await multipart(w.url('/intakes/files'), 'x.csv', CHASE, 'intake-viewer@example.com')).status,
    ).toBe(403);
    const listed = await viewer.get(w.url('/intakes'));
    const open = listed.body.data;
    expect(open?.length, JSON.stringify(listed.body)).toBeGreaterThan(0);
    expect((await viewer.post(w.url(`/intakes/${open[0].id}/resolve`), { targetId: checking })).status).toBe(
      403,
    );

    // Someone else's workspace sees none of it, through the API or under row-level security.
    const other = h.as('intake-other@example.com');
    const o = await setup('Other', other);
    expect((await other.get(o.url('/intakes'))).body.data).toEqual([]);
    expect((await other.get(w.url('/intakes'))).status).toBeGreaterThanOrEqual(403);
    const db = h.app.get(Db);
    const otherId = (await other.get('/v1/me')).body.id;
    const seen = await db.run({ workspaceId: o.ws.id, userId: otherId }, async (trx) => ({
      memory: await trx.selectFrom('app.match_memory').select('id').execute(),
      intakes: await trx.selectFrom('app.document_intake').select('id').execute(),
    }));
    expect(seen).toEqual({ memory: [], intakes: [] });
    // Even naming the workspace: not a member, so nothing.
    const named = await db.run({ workspaceId: w.ws.id, userId: otherId }, (trx) =>
      trx.selectFrom('app.match_memory').select('id').where('workspace_id', '=', w.ws.id).execute(),
    );
    expect(named).toEqual([]);
    // The owner's memory is there.
    const ownerId = (await c.get('/v1/me')).body.id;
    const own = await db.run({ workspaceId: w.ws.id, userId: ownerId }, (trx) =>
      trx.selectFrom('app.match_memory').select('id').execute(),
    );
    expect(own.length).toBeGreaterThan(0);
  });
});

describe('bills filed automatically (ADR-0051 §4)', () => {
  let w: Awaited<ReturnType<typeof setup>>;
  let comcast: string;
  const due = addDays(todayIn('UTC'), 10);
  const page = (amount = '$112.45') =>
    encodeFakeReceiptImage(
      [
        'XFINITY',
        'ACCOUNT NUMBER 8774 1023 4321',
        `AMOUNT DUE ${amount}`,
        `DUE DATE ${due}`,
        'KIND internet_tv',
      ].join('\n'),
    );
  const scan = async (autoFile: boolean, bytes = page()) => {
    const f = await multipart(w.url('/household-bills/files'), 'bill.png', bytes);
    const s = (await c.post(w.url('/scans'), { kind: 'bill', fileIds: [f.body.fileId], autoFile })).body;
    await worker.drain(['ai', 'import']);
    return (await c.get(w.url(`/scans/${s.id}`))).body;
  };

  beforeAll(async () => {
    w = await setup('Bills');
    const cats = (await c.get(w.url('/categories'))).body.data;
    const phone = cats.find((x: any) => x.name === 'Phone & internet').id;
    comcast = (await c.post(w.url('/billers'), { categoryId: phone, name: 'Comcast', accountLast4: '4321' }))
      .body.id;
    await c.patch(w.url('/ai/settings'), { allowDocumentsToLlm: true });
  });

  it('waits for a confirmation without autoFile, as before', async () => {
    const s = await scan(false);
    expect(s).toMatchObject({ status: 'ready', bill: { billerId: comcast } });
    expect(s.bill.intakeId ?? null).toBeNull();
    expect((await c.get(w.url('/intakes?kind=bill'))).body.data).toEqual([]);
    // Confirming it (the existing path) is the first confirmation.
    const filed = await c.post(w.url('/household-bills'), {
      billerId: comcast,
      scanId: s.id,
      amount: s.bill.amount,
      dueDate: s.bill.dueDate,
    });
    expect(filed.status).toBe(201);
  });

  it('suggests the biller in Review until it is learned, then files the next one itself', async () => {
    for (let n = 2; n <= 3; n++) {
      const s = await scan(true);
      expect(s.status).toBe('ready');
      const intake = (await c.get(w.url(`/intakes/${s.bill.intakeId}`))).body;
      expect(intake).toMatchObject({
        kind: 'bill',
        status: 'suggested',
        targetId: comcast,
        learning: { confirmations: n - 1, needed: 3 },
        bill: { amount: '11245', dueDate: due },
      });
      await c.post(w.url('/household-bills'), {
        billerId: comcast,
        scanId: s.id,
        amount: s.bill.amount,
        dueDate: s.bill.dueDate,
      });
      expect((await c.get(w.url(`/intakes/${intake.id}`))).body).toMatchObject({
        status: 'done',
        filed: { kind: 'household' },
      });
    }
    const auto = await scan(true);
    expect(auto).toMatchObject({ status: 'used', bill: { filed: { kind: 'household' } } });
    const bill = (await c.get(w.url(`/household-bills/${auto.bill.filed.id}`))).body;
    expect(bill).toMatchObject({ billerName: 'Comcast', amount: '11245', dueDate: due, status: 'open' });
    expect((await c.get(w.url('/intakes?kind=bill'))).body.data).toEqual([]);
  });

  it('files from Review when nothing matches, and learns the new provider', async () => {
    const f = await multipart(
      w.url('/household-bills/files'),
      'bill.png',
      encodeFakeReceiptImage(
        ['CITY WATER DEPT', 'AMOUNT DUE $40.00', `DUE DATE ${due}`, 'KIND water'].join('\n'),
      ),
    );
    const s = (await c.post(w.url('/scans'), { kind: 'bill', fileIds: [f.body.fileId], autoFile: true }))
      .body;
    await worker.drain(['ai', 'import']);
    const read = (await c.get(w.url(`/scans/${s.id}`))).body;
    const intake = (await c.get(w.url(`/intakes/${read.bill.intakeId}`))).body;
    expect(intake).toMatchObject({
      status: 'review',
      reason: 'no_match',
      detected: { billerName: 'CITY WATER DEPT' },
    });

    const cats = (await c.get(w.url('/categories'))).body.data;
    const utilities = cats.find((x: any) => x.name === 'Utilities').id;
    const water = (await c.post(w.url('/billers'), { categoryId: utilities, name: 'City Water' })).body.id;
    const done = (await c.post(w.url(`/intakes/${intake.id}/resolve`), { targetId: water })).body;
    expect(done).toMatchObject({ status: 'done', targetId: water, filed: { kind: 'household' } });
    // The scan can't be filed twice.
    expect((await c.get(w.url(`/scans/${s.id}`))).body.status).toBe('used');
    const memory = await h.app
      .get(Db)
      .run({ workspaceId: w.ws.id, userId: (await c.get('/v1/me')).body.id }, (trx) =>
        trx.selectFrom('app.match_memory').selectAll().where('kind', '=', 'bill').execute(),
      );
    expect(memory.find((m) => m.target_id === water)).toMatchObject({ confirmations: 1 });
    expect(memory.find((m) => m.target_id === comcast)).toMatchObject({
      signal: 'last4:4321',
      confirmations: 3,
    });
  });

  it('asks for the amount when it was not read', async () => {
    const f = await multipart(
      w.url('/household-bills/files'),
      'bill.png',
      encodeFakeReceiptImage(['XFINITY', 'ACCOUNT NUMBER 8774 1023 4321', 'KIND internet_tv'].join('\n')),
    );
    const s = (await c.post(w.url('/scans'), { kind: 'bill', fileIds: [f.body.fileId], autoFile: true }))
      .body;
    await worker.drain(['ai', 'import']);
    const read = (await c.get(w.url(`/scans/${s.id}`))).body;
    expect(read.status).toBe('ready');
    const intake = (await c.get(w.url(`/intakes/${read.bill.intakeId}`))).body;
    expect(intake).toMatchObject({ status: 'suggested', reason: 'bill_incomplete', targetId: comcast });
    const refused = await c.post(w.url(`/intakes/${intake.id}/resolve`), { targetId: comcast });
    expect(refused).toMatchObject({ status: 422, body: { code: 'intake.bill_incomplete' } });
    const done = await c.post(w.url(`/intakes/${intake.id}/resolve`), {
      targetId: comcast,
      amount: '9900',
      dueDate: due,
    });
    expect(done.body).toMatchObject({ status: 'done', filed: { kind: 'household' } });
  });
});

describe('possible duplicates only while the earlier copy is still live', () => {
  it('flags the same statement while the first is waiting, and not once every copy was put aside', async () => {
    const w = await setup('Duplicates');
    await c.post(w.url('/accounts'), { name: 'Checking', kind: 'checking', last4: '1234' });
    const up = async () => {
      const r = await multipart(w.url('/intakes/files'), 'Chase1234_Activity.csv', CHASE);
      expect(r.status).toBe(202);
      await worker.drain(['import']);
      return r.body;
    };
    const first = await up();
    expect(first.duplicateOf).toBeNull();
    // The first is still waiting for its account: the second is a possible duplicate of it.
    const second = await up();
    expect(second.duplicateOf).toMatchObject({ fileId: first.fileIds[0] });
    // Both put aside, nothing came of either: uploading it again starts over, with no warning.
    for (const i of [first, second]) await c.post(w.url(`/intakes/${i.id}/dismiss`));
    expect((await up()).duplicateOf).toBeNull();
  });
});
