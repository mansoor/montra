/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { OwnershipService } from '../src/data/ownership.service.js';
import { Worker } from '../src/jobs/queue.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Receipts and files past their retention date (RCP-10, BAK-09; migration 0079). The hourly job lists them for the
// workspace's owners and tells them once; nothing goes until an owner approves exactly what was listed, with a recent
// sign-in, or keeps it for longer. Then the receipt goes with its lines and extracted text, and its image from storage;
// the transaction it was matched to stays as it was. A legal hold, another file naming the same object, and the
// household's vault each keep what is theirs.
const EMAIL = 'receipt-retention@example.com';
const ADMIN = 'retention-admin@example.com';
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
let adminUser: Client;
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
const review = async () => {
  const res = await c.get(url('/retention'));
  expect(res.status).toBe(200);
  return res.body as { items: any[]; extendYears: number };
};
const refs = (items: any[]) => items.map((i) => ({ kind: i.kind, id: i.id }));
/** Approves everything listed now, as the web's "Delete these" does. */
const approveListed = async () => {
  const { items } = await review();
  const res = await c.post(url('/retention/approve'), { items: refs(items.filter((i) => !i.approvedAt)) });
  expect(res.status).toBe(200);
  return res.body.count as number;
};

/** The sign-in is 30 minutes old by the time the API looks (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

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
  const key = sameAs ?? storageKey(wsId, 'invoice', randomUUID());
  if (!sameAs) await storage.put(key, PNG, 'image/png');
  const { rows } = await admin.query(
    `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, retain_until)
     values ($1, 'invoice', $2, 'bill.png', 'image/png', $3, repeat('c', 64), $4::date) returning id`,
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
  adminUser = h.as(ADMIN);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Retention', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
  card = (await c.post(url('/accounts'), { name: 'Visa', kind: 'credit_card', last4: '1234' })).body.id;
  const invite = await c.post(url('/sharing/invites'), { email: ADMIN, role: 'admin' });
  expect(invite.status).toBe(201);
  await adminUser.post(`/v1/invites/${invite.body.token}/accept`);
  ownerId = (await admin.query(`select id from app.app_user where email = $1`, [EMAIL])).rows[0].id;
  personal = (
    await admin.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
  ).rows[0].id;
  // Whatever earlier test files left behind is looked at now, so each run below counts only this file's rows.
  await retention();
});
afterAll(async () => {
  // "Delete these" queues a retention run now. Leave none queued, or a later file's drain of 'schedule' jobs picks it up.
  await admin.query(
    `delete from app.job where workspace_id is null and type = 'data.retention' and status = 'queued'`,
  );
  await admin.end();
  await h.close();
});

describe('a receipt past its retention date (RCP-10)', () => {
  let receipt: any;
  let txn: any;
  let keys: string[];
  let listed: any[];
  let later: { id: string; key: string };

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

    expect(await retention()).toMatchObject({ found: 0, receipts: 0, files: 0 });
    expect((await review()).items).toEqual([]);
  });

  it('is listed for the owners and they are told once; nothing is deleted without an approval', async () => {
    // A split posting may point at the line it came from (migration 0012); the purge will only clear that pointer.
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
    await admin.query(`update app.receipt set retain_until = current_date - 1 where id = $1`, [receipt.id]);

    // Its image goes with it, so only the receipt is listed.
    expect(await retention()).toMatchObject({ found: 1, receipts: 0, files: 0 });
    expect(await retention()).toMatchObject({ found: 0, receipts: 0, files: 0 });
    expect(await count(`select 1 from app.receipt where id = $1`, [receipt.id])).toBe(1);
    expect(await exists(keys[0]!)).toBe(true);

    listed = (await review()).items;
    expect(listed).toEqual([
      expect.objectContaining({
        kind: 'receipt',
        id: receipt.id,
        title: 'WALMART SUPERCENTER',
        date: '2026-10-05',
        amount: '2871',
        currency: 'USD',
        transaction: expect.objectContaining({ id: txn.id, date: '2026-10-06' }),
        approvedAt: null,
      }),
    ]);

    const told = await admin.query(
      `select user_id, title, body, link from app.notification where workspace_id = $1 and type = 'retention_due'`,
      [wsId],
    );
    expect(told.rows).toEqual([
      expect.objectContaining({ user_id: ownerId, link: `/w/${wsId}/settings?tab=data#retention` }),
    ]);
    expect(told.rows[0].body).toContain('on the web');
    expect(told.rows[0].body).not.toContain('WALMART');
  });

  it('is the owners’ alone to see and decide on', async () => {
    for (const res of [
      await adminUser.get(url('/retention')),
      await adminUser.post(url('/retention/approve'), { items: refs(listed) }),
      await adminUser.post(url('/retention/extend'), { items: refs(listed) }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('retention.owner_only');
    }
    expect((await review()).items[0].approvedAt).toBeNull();
  });

  it('needs a recent sign-in to approve deleting', async () => {
    const res = await stale(() => c.post(url('/retention/approve'), { items: refs(listed) }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth.required');
    expect((await review()).items[0].approvedAt).toBeNull();
  });

  it('approves only the items listed, never one found later', async () => {
    later = await storedFile('2020-01-01');
    expect(await retention()).toMatchObject({ found: 1, receipts: 0, files: 0 });
    // The page still shows what it showed before the file was found.
    const res = await c.post(url('/retention/approve'), { items: refs(listed) });
    expect(res.body).toEqual({ count: 1 });
    const now = (await review()).items;
    expect(now.find((i) => i.id === receipt.id).approvedAt).not.toBeNull();
    expect(now.find((i) => i.id === later.id).approvedAt).toBeNull();
  });

  it('then goes with its lines, text and image; its transaction stays as it was, in a locked period too', async () => {
    const before = (await c.get(url(`/transactions/${txn.id}`))).body;
    expect(await retention()).toMatchObject({ receipts: 1, files: 1 });

    expect(await count(`select 1 from app.receipt where id = $1`, [receipt.id])).toBe(0);
    expect(await count(`select 1 from app.receipt_line where receipt_id = $1`, [receipt.id])).toBe(0);
    expect(await count(`select 1 from app.file where id = any ($1)`, [receipt.fileIds])).toBe(0);
    expect(await exists(keys[0]!)).toBe(false);
    expect((await c.get(url(`/receipts/${receipt.id}`))).status).toBe(404);
    // The file found later wasn't approved, so it stays.
    expect(await exists(later.key)).toBe(true);
    expect((await review()).items.map((i) => i.id)).toEqual([later.id]);

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

  it('logs who approved, then each purge, and its earlier audit entries no longer hold what it said', async () => {
    const approved = await admin.query(
      `select actor_user_id, actor_type, diff from app.audit_log
        where workspace_id = $1 and action = 'retention.approved'`,
      [wsId],
    );
    expect(approved.rows).toEqual([
      {
        actor_user_id: ownerId,
        actor_type: 'user',
        diff: { count: 1, items: [{ kind: 'receipt', id: receipt.id }] },
      },
    ]);
    const { rows } = await admin.query(
      `select action, actor_type, diff from app.audit_log
        where workspace_id = $1 and subject_type = 'receipt' and subject_id = $2 order by id`,
      [wsId, receipt.id],
    );
    expect(rows.at(-1)).toMatchObject({
      action: 'receipt.purged',
      actor_type: 'system',
      diff: { reason: 'retention', transactionId: txn.id, files: 1, approvedBy: ownerId },
    });
    expect(rows.slice(0, -1).every((r) => r.diff.redacted === 'retention')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('WALMART');
    const files = await admin.query(
      `select diff from app.audit_log where workspace_id = $1 and action = 'file.purged' and subject_id = $2`,
      [wsId, receipt.fileIds[0]],
    );
    expect(files.rows).toEqual([
      { diff: expect.objectContaining({ reason: 'retention', kind: 'receipt', approvedBy: ownerId }) },
    ]);
  });

  it('keeps for longer what the owner picks: the date moves a year on, and it leaves the list', async () => {
    const res = await c.post(url('/retention/extend'), { items: [{ kind: 'file', id: later.id }] });
    expect(res.body).toEqual({ count: 1 });
    const { rows } = await admin.query(
      `select retain_until = (current_date + interval '1 year')::date as moved from app.file where id = $1`,
      [later.id],
    );
    expect(rows).toEqual([{ moved: true }]);
    expect((await review()).items).toEqual([]);
    expect(await retention()).toMatchObject({ found: 0, files: 0 });
    expect(await exists(later.key)).toBe(true);
    const logged = await admin.query(
      `select actor_user_id, diff from app.audit_log where workspace_id = $1 and action = 'retention.extended'`,
      [wsId],
    );
    expect(logged.rows).toEqual([
      {
        actor_user_id: ownerId,
        diff: expect.objectContaining({ count: 1, years: 1, items: [{ kind: 'file', id: later.id }] }),
      },
    ]);
  });
});

describe('what stays', () => {
  it('keeps everything under a legal hold, even once approved, and purges once it is lifted', async () => {
    const f = await storedFile('2020-01-01');
    const old = await receiptHolding([f.id], '2020-01-01');
    expect(await retention()).toMatchObject({ found: 1 });
    expect(await approveListed()).toBe(1);
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

  it('removes an approved file’s row but not an object another file still names', async () => {
    const live = await storedFile('2099-12-31');
    const expired = await storedFile('2020-01-01', live.key);
    expect(await retention()).toMatchObject({ found: 1 });
    expect(await approveListed()).toBe(1);
    expect(await retention()).toMatchObject({ files: 1 });
    expect(await count(`select 1 from app.file where id = $1`, [expired.id])).toBe(0);
    expect(await count(`select 1 from app.file where id = $1`, [live.id])).toBe(1);
    expect(await exists(live.key)).toBe(true);
  });

  it('lists and removes a batch a run, as RETENTION_BATCH says', async () => {
    const a = await storedFile('2020-01-01');
    const b = await storedFile('2020-01-02');
    const ownership = h.app.get(OwnershipService) as any;
    const saved = ownership.config;
    ownership.config = { ...saved, RETENTION_BATCH: 1 };
    try {
      expect(await retention()).toMatchObject({ found: 1 });
      expect(await retention()).toMatchObject({ found: 1 });
      expect(await approveListed()).toBe(2);
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
  it('loses only Montra’s row and leftover copy once approved; the vault keeps its document', async () => {
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

    expect(await retention()).toMatchObject({ found: 1, receipts: 0, files: 0 });
    expect(await count(`select 1 from app.file where id = $1`, [fileId])).toBe(1);
    expect(await approveListed()).toBe(1);
    expect(await retention()).toMatchObject({ receipts: 1, files: 1 });
    expect(await count(`select 1 from app.receipt where id = $1`, [receipt])).toBe(0);
    expect(await count(`select 1 from app.file where id = $1`, [fileId])).toBe(0);
    expect(await exists(leftover)).toBe(false);
    // The owner didn't ask for the vault's copy to go with Montra's: nothing is queued to delete there.
    expect(await count(`select 1 from app.vault_item where file_id = $1`, [fileId])).toBe(0);
    await admin.query(`delete from app.storage_destination where id = $1`, [vault]);
  });
});

describe('a receipt in the Trash', () => {
  // A receipt is a tax record, so deleting it doesn't shorten how long it is kept: it stays until its retention date,
  // and then goes only once an owner approves, as any other. The Trash says so, and it can be restored meanwhile.
  let f: { id: string; key: string };
  let receipt: string;
  const inTrash = async () => {
    const res = await c.get(url('/trash'));
    expect(res.status).toBe(200);
    return (res.body.data as any[]).find((i) => i.id === receipt);
  };

  it('shows its retention date, not 30 days, and outlasts the Trash’s 30 days', async () => {
    f = await storedFile('2099-12-31');
    receipt = await receiptHolding([f.id], '2032-06-30');
    expect((await c.delete(url(`/receipts/${receipt}`))).status).toBeLessThan(300);
    expect(await inTrash()).toMatchObject({ kind: 'receipt', removal: 'retention', until: '2032-06-30' });

    await admin.query(`update app.receipt set deleted_at = now() - interval '40 days' where id = $1`, [
      receipt,
    ]);
    expect(await retention()).toMatchObject({ found: 0, receipts: 0, files: 0 });
    expect(await count(`select 1 from app.receipt where id = $1`, [receipt])).toBe(1);
    expect(await exists(f.key)).toBe(true);
    expect(await inTrash()).toMatchObject({ removal: 'retention', until: '2032-06-30' });
  });

  it('can be restored meanwhile, and deleted again', async () => {
    expect((await c.post(url(`/trash/receipt/${receipt}/restore`))).status).toBe(204);
    expect((await c.get(url(`/receipts/${receipt}`))).status).toBe(200);
    expect(await inTrash()).toBeUndefined();
    expect((await c.delete(url(`/receipts/${receipt}`))).status).toBeLessThan(300);
    await admin.query(`update app.receipt set deleted_at = now() - interval '40 days' where id = $1`, [
      receipt,
    ]);
  });

  it('past its date, waits for an owner; nothing goes before an approval', async () => {
    await admin.query(`update app.receipt set retain_until = '2020-01-01' where id = $1`, [receipt]);
    expect(await inTrash()).toMatchObject({ removal: 'owner_approval', until: '2020-01-01' });
    expect(await retention()).toMatchObject({ found: 1, receipts: 0, files: 0 });
    expect(await retention()).toMatchObject({ receipts: 0, files: 0 });
    expect(await count(`select 1 from app.receipt where id = $1`, [receipt])).toBe(1);
    expect(await exists(f.key)).toBe(true);
    expect((await review()).items.map((i) => i.id)).toEqual([receipt]);

    expect(await approveListed()).toBe(1);
    expect(await retention()).toMatchObject({ receipts: 1, files: 1 });
    expect(await count(`select 1 from app.receipt where id = $1`, [receipt])).toBe(0);
    expect(await exists(f.key)).toBe(false);
    expect(await inTrash()).toBeUndefined();
    const purged = await admin.query(
      `select diff from app.audit_log where workspace_id = $1 and action = 'receipt.purged' and subject_id = $2`,
      [wsId, receipt],
    );
    expect(purged.rows).toEqual([
      { diff: expect.objectContaining({ wasInTrash: true, approvedBy: ownerId }) },
    ]);
  });
});
