/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { OwnershipService } from '../src/data/ownership.service.js';
import { Worker } from '../src/jobs/queue.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Receipts and files past their retention date (RCP-10, BAK-09; migration 0079). The hourly job removes the receipt
// with its lines and extracted text, and its image from storage; the transaction it was matched to stays as it was. A
// receipt still within its date, a legal hold, another file naming the same object, and the household's vault each
// keep what is theirs.
const EMAIL = 'receipt-retention@example.com';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const WALMART = [
  'WALMART SUPERCENTER #1234',
  '10/05/2026 14:32',
  'GV 2% MLK GAL          3.48 N',
  'BANANAS                1.62 N',
  'ONN USB-C CHRGR       12.88 T',
  'TS MENS TEE            8.98 T',
  'SUBTOTAL              26.96',
  'TAX                    1.75',
  'TOTAL                 28.71',
  'CARD **** 1234',
].join('\n');

let h: Harness;
let c: Client;
let worker: Worker;
let admin: pg.Client;
let storage: StoragePort;
let url: (p: string) => string;
let wsId: string;
let ownerId: string;
let personal: string;
let card: string;

const retention = () => h.app.get(OwnershipService).retention();
const exists = (key: string) =>
  storage.get(key).then(
    () => true,
    () => false,
  );
const count = async (q: string, params: unknown[]) => (await admin.query(q, params)).rowCount;
const keysOf = async (fileIds: string[]) =>
  (await admin.query(`select storage_key from app.file where id = any ($1)`, [fileIds])).rows.map(
    (r) => r.storage_key as string,
  );

async function upload(bytes: Uint8Array, fileName: string) {
  const boundary = '----retention' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: url('/receipts/files'),
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
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

/** Uploads the receipt text as a fake photo, creates the receipt and reads it. */
async function capture(text: string) {
  const fileId = await upload(encodeFakeReceiptImage(text), 'receipt.png');
  const created = await c.post(url('/receipts'), { fileIds: [fileId] });
  expect(created.status).toBe(201);
  await worker.drain(['ai']);
  return (await c.get(url(`/receipts/${created.body.id}`))).body;
}

/** A file stored the way an upload stores it: bytes in storage, then the row. Given a key, a second row for its bytes. */
async function storedFile(retainUntil: string, sameAs?: string) {
  const key = sameAs ?? storageKey(wsId, 'receipt', randomUUID());
  if (!sameAs) await storage.put(key, PNG, 'image/png');
  const { rows } = await admin.query(
    `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, retain_until)
     values ($1, 'receipt', $2, 'r.png', 'image/png', $3, repeat('c', 64), $4::date) returning id`,
    [wsId, key, PNG.length, retainUntil],
  );
  return { id: rows[0].id as string, key };
}

async function receiptHolding(fileIds: string[], retainUntil: string) {
  const { rows } = await admin.query(
    `insert into app.receipt (workspace_id, entity_id, status, merchant, ocr_text, attachment_ids, retain_until)
     values ($1, $2, 'inbox', 'Old Grocer', 'MILK 3.48', $3::uuid[], $4::date) returning id`,
    [wsId, personal, fileIds, retainUntil],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', AI_LOCAL_DIRECT: 'true' });
  h.app.get(ReceiptJobs).register();
  worker = h.app.get(Worker);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Retention', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
  card = (await c.post(url('/accounts'), { name: 'Visa', kind: 'credit_card', last4: '1234' })).body.id;
  ownerId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  personal = (
    await admin.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
  ).rows[0].id;
  // Whatever earlier test files left past its date goes now, so each run below counts only this file's rows.
  await retention();
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('a receipt past its retention date (RCP-10)', () => {
  let receipt: any;
  let txn: any;
  let keys: string[];

  it('is kept, with its image, until its date has passed', async () => {
    txn = (
      await c.post(url('/transactions'), {
        date: '2026-10-06',
        accountId: card,
        amount: { amount: '-2871', currency: 'USD' },
        payee: 'WALMART SUPERCENTER #1234 BENTONVILLE AR',
      })
    ).body;
    receipt = await capture(WALMART);
    expect(receipt).toMatchObject({ status: 'matched', transactionId: txn.id });
    expect(receipt.retainUntil.slice(0, 4)).toBe(String(new Date().getUTCFullYear() + 7));
    keys = await keysOf(receipt.fileIds);
    expect(await exists(keys[0]!)).toBe(true);

    const done = await retention();
    expect(done).toMatchObject({ receipts: 0, files: 0 });
    expect((await c.get(url(`/receipts/${receipt.id}`))).status).toBe(200);
  });

  it('goes with its lines, text and image; its transaction stays as it was, in a locked period too', async () => {
    const before = (await c.get(url(`/transactions/${txn.id}`))).body;
    expect(before.splits.length).toBe(3);
    // A split posting may point at the line it came from (migration 0012); the purge only clears that pointer.
    const linked = await admin.query(
      `update app.posting p set receipt_line_id = (select l.id from app.receipt_line l where l.receipt_id = $2 limit 1)
         from app.journal_entry e
        where e.workspace_id = p.workspace_id and e.id = p.journal_entry_id and e.transaction_id = $1
          and p.id = (select p2.id from app.posting p2
                       where p2.workspace_id = e.workspace_id and p2.journal_entry_id = e.id order by p2.id limit 1)`,
      [txn.id, receipt.id],
    );
    expect(linked.rowCount).toBe(1);
    // Reconciled and locked long ago: the purge must not need to change the books.
    await admin.query(`update app.journal_entry set locked = true where transaction_id = $1`, [txn.id]);
    // Only the receipt's date has passed; its files follow it in the same run.
    await admin.query(`update app.receipt set retain_until = current_date - 1 where id = $1`, [receipt.id]);

    const done = await retention();
    expect(done).toMatchObject({ receipts: 1, files: 1 });

    expect(await count(`select 1 from app.receipt where id = $1`, [receipt.id])).toBe(0);
    expect(await count(`select 1 from app.receipt_line where receipt_id = $1`, [receipt.id])).toBe(0);
    expect(await count(`select 1 from app.file where id = any ($1)`, [receipt.fileIds])).toBe(0);
    expect(await exists(keys[0]!)).toBe(false);
    expect((await c.get(url(`/receipts/${receipt.id}`))).status).toBe(404);

    const after = (await c.get(url(`/transactions/${txn.id}`))).body;
    expect(after).toMatchObject({ id: txn.id, status: before.status, date: before.date, receipt: null });
    expect(after.splits.map((s: any) => [s.accountId, s.amount])).toEqual(
      before.splits.map((s: any) => [s.accountId, s.amount]),
    );
    expect(
      await count(
        `select 1 from app.posting p join app.journal_entry e on e.workspace_id = p.workspace_id and e.id = p.journal_entry_id
          where e.transaction_id = $1 and p.receipt_line_id is not null`,
        [txn.id],
      ),
    ).toBe(0);
  });

  it('is logged as purged, and its earlier audit entries no longer hold what it said', async () => {
    const { rows } = await admin.query(
      `select action, actor_type, diff from app.audit_log
        where workspace_id = $1 and subject_type = 'receipt' and subject_id = $2 order by id`,
      [wsId, receipt.id],
    );
    expect(rows.at(-1)).toMatchObject({
      action: 'receipt.purged',
      actor_type: 'system',
      diff: { reason: 'retention', transactionId: txn.id, files: 1 },
    });
    expect(rows.slice(0, -1).every((r) => r.diff.redacted === 'retention')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('WALMART');
    const files = await admin.query(
      `select diff from app.audit_log where workspace_id = $1 and action = 'file.purged' and subject_id = $2`,
      [wsId, receipt.fileIds[0]],
    );
    expect(files.rows).toEqual([{ diff: expect.objectContaining({ reason: 'retention', kind: 'receipt' }) }]);
  });
});

describe('what stays', () => {
  it('keeps a receipt within its date, and its file even when the file’s own date has passed', async () => {
    const f = await storedFile('2020-01-01');
    const kept = await receiptHolding([f.id], '2099-12-31');
    await retention();
    expect(await count(`select 1 from app.receipt where id = $1`, [kept])).toBe(1);
    expect(await count(`select 1 from app.file where id = $1`, [f.id])).toBe(1);
    expect(await exists(f.key)).toBe(true);
  });

  it('keeps everything while a member is under a legal hold, and purges once it is lifted', async () => {
    const f = await storedFile('2020-01-01');
    const old = await receiptHolding([f.id], '2020-01-01');
    await admin.query(
      `insert into app.account_suspension (user_id, kind, reason, suspended_by) values ($1, 'legal_hold', 'case 1', $1)`,
      [ownerId],
    );
    try {
      expect(await retention()).toMatchObject({ receipts: 0, files: 0 });
      expect(await count(`select 1 from app.receipt where id = $1`, [old])).toBe(1);
      expect(await exists(f.key)).toBe(true);
    } finally {
      await admin.query(`delete from app.account_suspension where user_id = $1`, [ownerId]);
    }
    expect(await retention()).toMatchObject({ receipts: 1, files: 1 });
    expect(await count(`select 1 from app.receipt where id = $1`, [old])).toBe(0);
    expect(await exists(f.key)).toBe(false);
  });

  it('removes an expired file’s row but not an object another file still names', async () => {
    const live = await storedFile('2099-12-31');
    const expired = await storedFile('2020-01-01', live.key);
    expect(await retention()).toMatchObject({ files: 1 });
    expect(await count(`select 1 from app.file where id = $1`, [expired.id])).toBe(0);
    expect(await count(`select 1 from app.file where id = $1`, [live.id])).toBe(1);
    expect(await exists(live.key)).toBe(true);
  });

  it('takes a batch a run, as RETENTION_BATCH says', async () => {
    const a = await storedFile('2020-01-01');
    const b = await storedFile('2020-01-02');
    const ownership = h.app.get(OwnershipService) as any;
    const saved = ownership.config;
    ownership.config = { ...saved, RETENTION_BATCH: 1 };
    try {
      expect(await retention()).toMatchObject({ files: 1 });
      expect(await exists(a.key)).toBe(false);
      expect(await exists(b.key)).toBe(true);
      expect(await retention()).toMatchObject({ files: 1 });
      expect(await exists(b.key)).toBe(false);
    } finally {
      ownership.config = saved;
    }
  });
});

describe('a file held in the household’s vault (ADR-0054 §10)', () => {
  it('loses only Montra’s row and leftover copy; the vault keeps its document', async () => {
    const vault = (
      await admin.query(
        `insert into app.storage_destination
           (workspace_id, kind, label, secret_enc, folder, file_kinds, status, delete_with_montra, can_delete)
         values ($1, 'fdv', 'Family Document Vault', decode('00', 'hex'), 'Montra', array['receipt'], 'active', false, true)
         returning id`,
        [wsId],
      )
    ).rows[0].id;
    // Montra's copy went when the vault became the record; its old object was still to be removed (§5).
    const leftover = storageKey(wsId, 'receipt', randomUUID());
    await storage.put(leftover, PNG, 'image/png');
    const fileId = (
      await admin.query(
        `insert into app.file (workspace_id, kind, storage_key, location, file_name, mime, bytes, sha256, retain_until)
         values ($1, 'receipt', null, 'vault', 'v.png', 'image/png', 11, repeat('d', 64), '2020-01-01') returning id`,
        [wsId],
      )
    ).rows[0].id;
    await admin.query(
      `update app.vault_item set status = 'filed', vault_ref = 'r-' || file_id, vault_document_id = 'doc-1',
              filed_at = now(), source_key = $2
        where file_id = $1`,
      [fileId, leftover],
    );
    const receipt = await receiptHolding([fileId], '2020-01-01');

    expect(await retention()).toMatchObject({ receipts: 1, files: 1 });
    expect(await count(`select 1 from app.receipt where id = $1`, [receipt])).toBe(0);
    expect(await count(`select 1 from app.file where id = $1`, [fileId])).toBe(0);
    expect(await exists(leftover)).toBe(false);
    // The owner didn't ask for the vault's copy to go with Montra's: nothing is queued to delete there.
    expect(await count(`select 1 from app.vault_item where file_id = $1`, [fileId])).toBe(0);
    await admin.query(`delete from app.storage_destination where id = $1`, [vault]);
  });
});
