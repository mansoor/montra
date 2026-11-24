/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { addDays, todayIn } from '@montra/domain';
import { OwnershipService } from '../src/data/ownership.service.js';
import { Worker } from '../src/jobs/queue.js';
import { ReceiptJobs } from '../src/receipts/receipt-jobs.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Removing things from the Trash for good (migration 0088):
// - ACC-14: an empty account goes with its transactions in the Trash, when they touch nothing else.
// - BAK-06: "Delete forever" and "Empty Trash", for owners and admins with a recent sign-in.
// - RCP-10 (owner, 2026-11-23): personal receipts have no minimum retention; business and rental ones keep theirs.
// - A matched receipt can be deleted by an owner or admin: it is unlinked, and its transaction stays as it is.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'trash-forever@example.test';
const PARTNER = 'trash-forever-partner@example.test';
const HELD = 'trash-forever-held@example.test';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const started = new Date();

let h: Harness;
let c: Client;
let partner: Client;
let worker: Worker;
let storage: StoragePort;
let admin: pg.Client;
let ws: string;
let url: (p: string) => string;
let personal: string;
let business: string;
let groceries: string;
let checking: string;
let heldUserId: string;

const rows = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows;
const exists = (key: string) =>
  storage.get(key).then(
    () => true,
    () => false,
  );
const unbalanced = async (wsId = ws) =>
  Number(
    (
      await admin.query(
        `select count(*) from (select journal_entry_id from app.posting where workspace_id = $1
          group by 1 having sum(functional_amount_minor) <> 0) x`,
        [wsId],
      )
    ).rows[0].count,
  );

/** The sign-in is 30 minutes old by the time the API looks (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** A legal hold on another active member holds the whole workspace (migration 0079). */
async function underLegalHold<T>(fn: () => Promise<T>): Promise<T> {
  await admin.query(
    `insert into app.account_suspension (user_id, kind, reason, suspended_by) values ($1, 'legal_hold', 'case 7', $1)`,
    [heldUserId],
  );
  try {
    return await fn();
  } finally {
    await admin.query(`delete from app.account_suspension where user_id = $1`, [heldUserId]);
  }
}

const addAccount = async (name: string, extra: Record<string, unknown> = {}, wsId = ws) => {
  const res = await c.post(`/v1/workspaces/${wsId}/accounts`, { name, kind: 'checking', ...extra });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

/** A purchase on the account, then deleted: it sits in the Trash with no entries. */
async function trashed(accountId: string, date = addDays(today, -2), wsId = ws, categoryId = groceries) {
  const res = await c.post(`/v1/workspaces/${wsId}/transactions`, {
    date,
    accountId,
    amount: usd('-4500'),
    payee: 'Mistake',
    categoryId,
  });
  expect(res.status).toBe(201);
  expect((await c.delete(`/v1/workspaces/${wsId}/transactions/${res.body.id}`)).status).toBe(200);
  return res.body.id as string;
}

async function upload(bytes: Uint8Array, fileName: string) {
  const boundary = '----trash' + Math.random().toString(16).slice(2);
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

/** A receipt photo read by the fake AI; `entityId` names its books. */
async function capture(text: string, entityId?: string) {
  const fileId = await upload(encodeFakeReceiptImage(text), 'receipt.png');
  const created = await c.post(url('/receipts'), { fileIds: [fileId], ...(entityId ? { entityId } : {}) });
  expect(created.status).toBe(201);
  await worker.drain(['ai']);
  return (await c.get(url(`/receipts/${created.body.id}`))).body;
}

const receiptText = (merchant: string, date: string, total: string) => {
  const [y, m, d] = date.split('-');
  return [
    `${merchant} #12`,
    `${m}/${d}/${y} 14:32`,
    `MILK GAL          ${total} N`,
    `TOTAL           ${total}`,
  ].join('\n');
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', AI_LOCAL_DIRECT: 'true' });
  h.app.get(ReceiptJobs).register();
  worker = h.app.get(Worker);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  ws = (await c.post('/v1/workspaces', { name: 'Trash forever', baseCurrency: 'USD', template: 'household' }))
    .body.id;
  url = (p) => `/v1/workspaces/${ws}${p}`;
  await c.patch(url('/ai/settings'), { allowReceiptImagesToLlm: true });
  personal = (await c.get(url(''))).body.entities.find((e: any) => e.type === 'personal').id;
  business = (
    await c.post(url('/entities'), { type: 'business', name: 'Side Studio', businessType: 'sole_prop' })
  ).body.id;
  groceries = (await c.get(url('/categories'))).body.data.find(
    (x: any) => x.name === 'Groceries' && x.entityId === personal,
  ).id;
  checking = await addAccount('Everyday checking');
  for (const [email, role] of [
    [PARTNER, 'partner'],
    [HELD, 'viewer'],
  ] as const) {
    const invite = await c.post(url('/sharing/invites'), { email, role });
    expect(invite.status).toBe(201);
    expect((await h.as(email).post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  }
  heldUserId = (await rows(`select id from app.app_user where email = $1`, [HELD]))[0].id;
});
afterAll(async () => {
  await admin.query(`delete from app.account_suspension where user_id = $1`, [heldUserId]);
  await admin.query(
    `delete from app.job where workspace_id is null and status = 'queued' and created_at >= $1
        and type in ('data.retention', 'storage.mirror')`,
    [started],
  );
  await admin.end();
  await h.close();
});

describe('deleting an account with transactions in the Trash (ACC-14)', () => {
  it('the owner’s case: the account goes with its one trashed transaction, and the books stay balanced', async () => {
    const loan = await addAccount('Auto Loan', { kind: 'loan' });
    const txn = await trashed(loan);

    const check = (await c.get(url(`/accounts/${loan}/deletion`))).body;
    expect(check).toEqual({
      accountId: loan,
      name: 'Auto Loan',
      blockers: [],
      reason: null,
      trashedTransactions: 1,
      deleted: false,
    });
    const res = await c.delete(url(`/accounts/${loan}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, trashedTransactions: 1 });
    expect(await rows(`select 1 from app.ledger_account where id = $1`, [loan])).toHaveLength(0);
    expect(await rows(`select 1 from app.transaction where id = $1`, [txn])).toHaveLength(0);
    expect(await rows(`select 1 from app.journal_entry where transaction_id = $1`, [txn])).toHaveLength(0);
    expect(await unbalanced()).toBe(0);
    expect((await c.get(url('/trash'))).body.data.map((i: any) => i.id)).not.toContain(txn);

    const [audit] = await rows(
      `select a.diff, a.at, u.email from app.audit_log a join app.app_user u on u.id = a.actor_user_id
        where a.workspace_id = $1 and a.action = 'account.deleted' and a.subject_id = $2`,
      [ws, loan],
    );
    expect(audit).toMatchObject({ email: EMAIL, diff: { name: 'Auto Loan', trashedTransactions: 1 } });
  });

  it('is still refused for a trashed transfer that touches another account', async () => {
    const savings = await addAccount('Savings by mistake');
    const transfer = await c.post(url('/transactions/transfer'), {
      date: addDays(today, -1),
      fromAccountId: checking,
      toAccountId: savings,
      amount: usd('10000'),
    });
    expect(transfer.status).toBe(201);
    expect((await c.delete(url(`/transactions/${transfer.body.id}`))).status).toBe(200);

    const check = (await c.get(url(`/accounts/${savings}/deletion`))).body;
    expect(check.blockers).toEqual([{ code: 'trashed_transfers', count: 1 }]);
    expect(check.reason).toBe(
      'This account has 1 transfer in the trash that also touches another account. Archive it instead, or remove them first.',
    );
    const res = await c.delete(url(`/accounts/${savings}`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account.not_empty');
    expect(await rows(`select 1 from app.transaction where id = $1`, [transfer.body.id])).toHaveLength(1);
  });

  it('is still refused for a trashed transaction with a receipt kept as a tax record', async () => {
    const acct = await addAccount('Card by mistake');
    const txn = await trashed(acct);
    await admin.query(
      `insert into app.receipt (workspace_id, entity_id, status, transaction_id, total_minor, currency, retain_until,
                                deleted_at)
       values ($1, $2, 'inbox', $3, 4500, 'USD', current_date + 365 * 7, now())`,
      [ws, business, txn],
    );
    const check = (await c.get(url(`/accounts/${acct}/deletion`))).body;
    expect(check.blockers).toEqual([{ code: 'trashed_receipts', count: 1 }]);
    expect(check.trashedTransactions).toBe(0);
    expect((await c.delete(url(`/accounts/${acct}`))).status).toBe(409);
    expect(await rows(`select 1 from app.transaction where id = $1`, [txn])).toHaveLength(1);
  });

  it('is refused under a legal hold, and goes once it is lifted', async () => {
    const acct = await addAccount('Held by mistake');
    const txn = await trashed(acct);
    await underLegalHold(async () => {
      const check = (await c.get(url(`/accounts/${acct}/deletion`))).body;
      expect(check.blockers).toEqual([{ code: 'legal_hold', count: 1 }]);
      expect(check.reason).toContain('legal hold');
      const res = await c.delete(url(`/accounts/${acct}`));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('account.legal_hold');
    });
    expect(await rows(`select 1 from app.transaction where id = $1`, [txn])).toHaveLength(1);
    expect((await c.delete(url(`/accounts/${acct}`))).status).toBe(200);
  });
});

describe('closed books (DE-10)', () => {
  let lockedWs: string;
  let txn: string;
  let acct: string;

  beforeAll(async () => {
    lockedWs = (
      await c.post('/v1/workspaces', { name: 'Closed', baseCurrency: 'USD', template: 'household' })
    ).body.id;
    const u = (p: string) => `/v1/workspaces/${lockedWs}${p}`;
    const entity = (await c.get(u(''))).body.entities.find((e: any) => e.type === 'personal').id;
    const cat = (await c.get(u('/categories'))).body.data.find(
      (x: any) => x.name === 'Groceries' && x.entityId === entity,
    ).id;
    acct = await addAccount('Old card', {}, lockedWs);
    txn = await trashed(acct, addDays(today, -60), lockedWs, cat);
    expect(
      (await c.put(u(`/entities/${entity}/period-lock`), { lockedThrough: addDays(today, -30) })).status,
    ).toBe(200);
  });

  it('keeps a trashed transaction dated there with its account', async () => {
    const check = (await c.get(`/v1/workspaces/${lockedWs}/accounts/${acct}/deletion`)).body;
    expect(check.blockers).toEqual([{ code: 'trashed_closed', count: 1 }]);
    expect((await c.delete(`/v1/workspaces/${lockedWs}/accounts/${acct}`)).status).toBe(409);
  });

  it('refuses Delete forever for it', async () => {
    const res = await c.delete(`/v1/workspaces/${lockedWs}/trash/transaction/${txn}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('trash.closed_period');
    expect(await rows(`select 1 from app.transaction where id = $1`, [txn])).toHaveLength(1);
  });
});

describe('Delete forever (BAK-06)', () => {
  it('removes a trashed transaction now, and records who did it', async () => {
    const txn = await trashed(checking);
    expect((await c.get(url('/trash'))).body.data.find((i: any) => i.id === txn)).toMatchObject({
      kind: 'transaction',
      removal: 'trash',
      date: addDays(today, -2),
    });
    expect((await c.delete(url(`/trash/transaction/${txn}`))).status).toBe(204);
    expect(await rows(`select 1 from app.transaction where id = $1`, [txn])).toHaveLength(0);
    const [audit] = await rows(
      `select a.actor_type, a.diff, a.at, u.email from app.audit_log a join app.app_user u on u.id = a.actor_user_id
        where a.workspace_id = $1 and a.action = 'transaction.purged' and a.subject_id = $2`,
      [ws, txn],
    );
    expect(audit).toMatchObject({ email: EMAIL, actor_type: 'user', diff: { reason: 'deleted_forever' } });
    expect(audit.at).toBeInstanceOf(Date);
    expect((await c.delete(url(`/trash/transaction/${txn}`))).status).toBe(404);
  });

  it('removes a trashed tax form with its file and stored bytes', async () => {
    const key = storageKey(ws, 'tax_form', randomUUID());
    await storage.put(key, PNG, 'image/png');
    const [file] = await rows(
      `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256)
       values ($1, 'tax_form', $2, 'w2.png', 'image/png', $3, repeat('d', 64)) returning id`,
      [ws, key, PNG.length],
    );
    const [form] = await rows(
      `insert into app.tax_form (workspace_id, entity_id, tax_year, kind, issuer_name, file_ids, source, status,
                                 created_by, deleted_at)
       values ($1, $2, 2025, 'w2', 'Acme Payroll', array[$3::uuid], 'upload', 'confirmed',
               (select id from app.app_user where email = $4), now()) returning id`,
      [ws, personal, file.id, EMAIL],
    );
    expect((await c.get(url('/trash'))).body.data.find((i: any) => i.id === form.id)).toMatchObject({
      kind: 'tax_form',
      removal: 'trash',
      date: null,
    });
    expect((await c.delete(url(`/trash/tax_form/${form.id}`))).status).toBe(204);
    expect(await rows(`select 1 from app.tax_form where id = $1`, [form.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.file where id = $1`, [file.id])).toHaveLength(0);
    expect(await exists(key)).toBe(false);
    const actions = (
      await rows(
        `select action from app.audit_log where workspace_id = $1 and subject_id = any ($2) and actor_user_id is not null`,
        [ws, [form.id, file.id]],
      )
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['tax_form.purged', 'file.purged']));
  });

  it('is refused to a partner, without a recent sign-in, and under a legal hold', async () => {
    const txn = await trashed(checking);
    expect((await partner.delete(url(`/trash/transaction/${txn}`))).status).toBe(403);
    const late = await stale(() => c.delete(url(`/trash/transaction/${txn}`)));
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('reauth.required');
    await underLegalHold(async () => {
      const res = await c.delete(url(`/trash/transaction/${txn}`));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('trash.legal_hold');
      expect((await c.post(url('/trash/empty'))).status).toBe(409);
    });
    expect(await rows(`select 1 from app.transaction where id = $1`, [txn])).toHaveLength(1);
    expect((await c.delete(url(`/trash/transaction/${txn}`))).status).toBe(204);
  });

  it('is not offered for a business receipt: the API refuses it', async () => {
    const receipt = await capture(receiptText('OFFICE DEPOT', addDays(today, -3), '19.99'), business);
    expect(receipt.retainUntil?.slice(0, 4)).toBe(String(new Date().getUTCFullYear() + 7));
    expect((await c.delete(url(`/receipts/${receipt.id}`))).status).toBe(204);
    expect((await c.get(url('/trash'))).body.data.find((i: any) => i.id === receipt.id)).toMatchObject({
      removal: 'retention',
    });
    const res = await c.delete(url(`/trash/receipt/${receipt.id}`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('trash.retention');
    expect(await rows(`select 1 from app.receipt where id = $1`, [receipt.id])).toHaveLength(1);
    // Empty Trash leaves it too.
    const emptied = await c.post(url('/trash/empty'));
    expect(emptied.status).toBe(200);
    expect(await rows(`select 1 from app.receipt where id = $1`, [receipt.id])).toHaveLength(1);
  });

  it('Empty Trash deletes every item that would go after 30 days', async () => {
    const a = await trashed(checking);
    const b = await trashed(checking);
    const res = await c.post(url('/trash/empty'));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBeGreaterThanOrEqual(2);
    expect(await rows(`select 1 from app.transaction where id = any ($1)`, [[a, b]])).toHaveLength(0);
    // The one with a receipt (above) stays: its receipt is a tax record.
    expect(res.body.kept).toBeGreaterThanOrEqual(1);
  });
});

describe('personal receipts have no minimum retention (RCP-10, owner 2026-11-23)', () => {
  it('a personal receipt gets no retention date; a business one keeps 7 years', async () => {
    const mine = await capture(receiptText('CORNER GROCER', addDays(today, -4), '7.25'));
    expect(mine.entityId).toBe(personal);
    expect(mine.retainUntil).toBeNull();
    const [row] = await rows(`select retain_until from app.receipt where id = $1`, [mine.id]);
    expect(row.retain_until).toBeNull();
  });

  it('a deleted personal receipt goes 30 days later, with its lines and its file', async () => {
    const r = await capture(receiptText('BAKERY', addDays(today, -5), '4.10'));
    const keys = (await rows(`select storage_key from app.file where id = any ($1)`, [r.fileIds])).map(
      (x) => x.storage_key as string,
    );
    expect((await c.delete(url(`/receipts/${r.id}`))).status).toBe(204);
    const item = (await c.get(url('/trash'))).body.data.find((i: any) => i.id === r.id);
    expect(item).toMatchObject({ kind: 'receipt', removal: 'trash', until: addDays(today, 30) });
    await admin.query(`update app.receipt set deleted_at = now() - interval '31 days' where id = $1`, [r.id]);
    await h.app.get(OwnershipService).retention();
    expect(await rows(`select 1 from app.receipt where id = $1`, [r.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.receipt_line where receipt_id = $1`, [r.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.file where id = any ($1)`, [r.fileIds])).toHaveLength(0);
    expect(await exists(keys[0]!)).toBe(false);
  });

  it('Delete forever removes a personal receipt now, with its file and bytes', async () => {
    const r = await capture(receiptText('FLOWER SHOP', addDays(today, -6), '12.00'));
    const [file] = await rows(`select storage_key from app.file where id = $1`, [r.fileIds[0]]);
    expect((await c.delete(url(`/receipts/${r.id}`))).status).toBe(204);
    expect((await c.delete(url(`/trash/receipt/${r.id}`))).status).toBe(204);
    expect(await rows(`select 1 from app.receipt where id = $1`, [r.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.file where id = $1`, [r.fileIds[0]])).toHaveLength(0);
    expect(await exists(file.storage_key)).toBe(false);
    const [audit] = await rows(
      `select actor_user_id, diff from app.audit_log where workspace_id = $1 and action = 'receipt.purged'
          and subject_id = $2`,
      [ws, r.id],
    );
    expect(audit.actor_user_id).not.toBeNull();
    expect(audit.diff).toMatchObject({ reason: 'deleted_forever' });
  });

  it('the migration clears only personal receipts’ dates', async () => {
    const insert = async (entity: string) =>
      (
        await rows(
          `insert into app.receipt (workspace_id, entity_id, status, retain_until)
           values ($1, $2, 'inbox', '2033-12-31') returning id`,
          [ws, entity],
        )
      )[0].id as string;
    const mine = await insert(personal);
    const theirs = await insert(business);
    // The clearing statements of migration 0088, run again on these rows.
    const migration = readFileSync(
      join(__dirname, '../../../packages/db/migrations/0088_trash_delete_forever.sql'),
      'utf8',
    );
    const clear = migration.match(/update app\.receipt r set retain_until = null[\s\S]*?;/)![0];
    const forget = migration.match(/delete from app\.retention_item i[\s\S]*?;/)![0];
    await admin.query(clear);
    await admin.query(forget);
    const dates = await rows(`select id, retain_until::text as d from app.receipt where id = any ($1)`, [
      [mine, theirs],
    ]);
    expect(Object.fromEntries(dates.map((x) => [x.id, x.d]))).toEqual({
      [mine]: null,
      [theirs]: '2033-12-31',
    });
  });
});

describe('deleting a matched receipt (owner, 2026-11-23)', () => {
  let card: string;
  let txn: any;
  let receipt: any;
  let before: any;
  let postings: any[];
  const txnDate = addDays(today, -10);

  const postingsOf = async (id: string) =>
    rows(
      `select p.ledger_account_id, p.amount_minor::text, p.memo from app.posting p
         join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
        where je.transaction_id = $1 order by p.ledger_account_id, p.amount_minor`,
      [id],
    );

  beforeAll(async () => {
    card = (await c.post(url('/accounts'), { name: 'Visa', kind: 'credit_card', last4: '1234' })).body.id;
    txn = (
      await c.post(url('/transactions'), {
        date: txnDate,
        accountId: card,
        amount: usd('-2871'),
        payee: 'WALMART SUPERCENTER #1234 BENTONVILLE AR',
      })
    ).body;
    receipt = await capture(
      [
        'WALMART SUPERCENTER #1234',
        `${txnDate.slice(5, 7)}/${txnDate.slice(8, 10)}/${txnDate.slice(0, 4)} 14:32`,
        'GV 2% MLK GAL          3.48 N',
        'BANANAS                1.62 N',
        'ONN USB-C CHRGR       12.88 T',
        'TS MENS TEE            8.98 T',
        'SUBTOTAL              26.96',
        'TAX                    1.75',
        'TOTAL                 28.71',
        'CARD **** 1234',
      ].join('\n'),
    );
    expect(receipt).toMatchObject({ status: 'matched', transactionId: txn.id });
    before = (await c.get(url(`/transactions/${txn.id}`))).body;
    postings = await postingsOf(txn.id);
  });

  it('is still refused to a writer, who must unlink it first', async () => {
    const res = await partner.delete(url(`/receipts/${receipt.id}`));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('receipt.matched');
    expect((await partner.delete(url(`/receipts/${receipt.id}?unlink=true`))).status).toBe(403);
    expect((await c.delete(url(`/receipts/${receipt.id}`))).body.code).toBe('receipt.matched');
    const late = await stale(() => c.delete(url(`/receipts/${receipt.id}?unlink=true`)));
    expect(late.body.code).toBe('reauth.required');
  });

  it('is refused in closed books and under a legal hold', async () => {
    expect(
      (await c.put(url(`/entities/${personal}/period-lock`), { lockedThrough: addDays(today, -5) })).status,
    ).toBe(200);
    try {
      const res = await c.delete(url(`/receipts/${receipt.id}?unlink=true`));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('receipt.closed_period');
    } finally {
      expect(
        (await c.delete(url(`/entities/${personal}/period-lock`), { note: 'test reopens' })).status,
      ).toBeLessThan(300);
    }
    await underLegalHold(async () => {
      const res = await c.delete(url(`/receipts/${receipt.id}?unlink=true`));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('receipt.legal_hold');
    });
    expect((await c.get(url(`/receipts/${receipt.id}`))).body).toMatchObject({ status: 'matched' });
  });

  it('an owner with a recent sign-in deletes it: unlinked, and its transaction unchanged', async () => {
    expect((await c.delete(url(`/receipts/${receipt.id}?unlink=true`))).status).toBe(204);
    const [row] = await rows(`select status, transaction_id, deleted_at from app.receipt where id = $1`, [
      receipt.id,
    ]);
    expect(row).toMatchObject({ status: 'needs_review', transaction_id: null });
    expect(row.deleted_at).toBeInstanceOf(Date);
    const after = (await c.get(url(`/transactions/${txn.id}`))).body;
    expect(after.splits).toEqual(before.splits);
    expect(after.amount).toEqual(before.amount);
    expect(after.date).toBe(before.date);
    expect(after.receipt).toBeNull();
    expect(await postingsOf(txn.id)).toEqual(postings);
    expect(await unbalanced()).toBe(0);
  });

  it('records who deleted it and which transaction it was linked to', async () => {
    const [audit] = await rows(
      `select a.diff, a.at, u.email from app.audit_log a join app.app_user u on u.id = a.actor_user_id
        where a.workspace_id = $1 and a.action = 'receipt.deleted_matched' and a.subject_id = $2`,
      [ws, receipt.id],
    );
    expect(audit).toMatchObject({ email: EMAIL, diff: { transactionId: txn.id, unlinked: true } });
  });

  it('comes back from the Trash unmatched, and is not linked again on its own', async () => {
    expect((await c.post(url(`/trash/receipt/${receipt.id}/restore`))).status).toBe(204);
    await c.post(url('/receipts/' + receipt.id + '/match'));
    await worker.drain(['ai']);
    const back = (await c.get(url(`/receipts/${receipt.id}`))).body;
    expect(back.status).toBe('needs_review');
    expect(back.transactionId).toBeNull();
  });
});

describe('afterwards', () => {
  it('leaves no system job queued', async () => {
    const queued = await rows(
      `select type from app.job where workspace_id is null and status = 'queued' and created_at >= $1
          and type in ('data.retention', 'storage.mirror')`,
      [started],
    );
    expect(queued).toEqual([]);
  });
});
