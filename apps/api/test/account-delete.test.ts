/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Deleting an account added by mistake, when it is empty (ACC-14).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'account-delete@example.test';
const PARTNER = 'account-delete-partner@example.test';

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let ws: string;
let url: (p: string) => string;
let personal: string;
let groceries: string;

async function newWorkspace(name: string) {
  const w = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  return w.id as string;
}

const addAccount = async (name: string, extra: Record<string, unknown> = {}, wsId = ws) => {
  const res = await c.post(`/v1/workspaces/${wsId}/accounts`, { name, kind: 'checking', ...extra });
  expect(res.status).toBe(201);
  return res.body.id as string;
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
const rows = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  ws = await newWorkspace('Delete accounts');
  url = (p) => `/v1/workspaces/${ws}${p}`;
  personal = (await c.get(url(''))).body.entities.find((e: any) => e.type === 'personal').id;
  groceries = (await c.get(url('/categories'))).body.data.find(
    (x: any) => x.name === 'Groceries' && x.entityId === personal,
  ).id;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('an empty account', () => {
  let id: string;
  let since: string;

  beforeAll(async () => {
    id = await addAccount('Opened by mistake', {
      openingBalance: usd('125000'),
      openingDate: addDays(today, -3),
      institution: 'Wrong Bank',
    });
    since = (await c.get(url('/sync/pull?since=0'))).body.latestSeq;
  });

  it('can be deleted: nothing stops it', async () => {
    const res = await c.get(url(`/accounts/${id}/deletion`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountId: id,
      name: 'Opened by mistake',
      blockers: [],
      reason: null,
      deleted: false,
    });
  });

  it('is not the partner’s to delete', async () => {
    expect((await partner.get(url(`/accounts/${id}/deletion`))).status).toBe(403);
    expect((await partner.delete(url(`/accounts/${id}`))).status).toBe(403);
  });

  it('needs a recent sign-in', async () => {
    const res = await stale(() => c.delete(url(`/accounts/${id}`)));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth.required');
  });

  it('is deleted with its opening balance and entry, and the books stay balanced', async () => {
    const opening = await rows(
      `select distinct je.id from app.journal_entry je join app.posting p on p.journal_entry_id = je.id
        where p.ledger_account_id = $1`,
      [id],
    );
    expect(opening).toHaveLength(1);
    const res = await c.delete(url(`/accounts/${id}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId: id, deleted: true, blockers: [] });
    expect(await rows(`select 1 from app.ledger_account where id = $1`, [id])).toHaveLength(0);
    expect(await rows(`select 1 from app.bank_account where ledger_account_id = $1`, [id])).toHaveLength(0);
    expect(await rows(`select 1 from app.journal_entry where id = $1`, [opening[0].id])).toHaveLength(0);
    expect(await rows(`select 1 from app.posting where ledger_account_id = $1`, [id])).toHaveLength(0);
    expect(await unbalanced()).toBe(0);
    // Opening-balance equity no longer carries it.
    const equity = await rows(
      `select coalesce(sum(p.amount_minor), 0)::text as total from app.posting p
         join app.ledger_account a on a.id = p.ledger_account_id
        where p.workspace_id = $1 and a.system_role = 'opening_balance_equity'`,
      [ws],
    );
    expect(equity[0].total).toBe('0');
    expect((await c.get(url('/accounts?include=all'))).body.data.map((a: any) => a.id)).not.toContain(id);
    expect((await c.get(url(`/accounts/${id}/deletion`))).status).toBe(404);
  });

  it('is recorded in the audit log: who, which account, when', async () => {
    const [entry] = await rows(
      `select a.actor_user_id, a.subject_type, a.diff, a.at, u.email
         from app.audit_log a join app.app_user u on u.id = a.actor_user_id
        where a.workspace_id = $1 and a.action = 'account.deleted' and a.subject_id = $2`,
      [ws, id],
    );
    expect(entry).toMatchObject({
      email: EMAIL,
      subject_type: 'ledger_account',
      diff: {
        name: 'Opened by mistake',
        kind: 'checking',
        type: 'asset',
        currency: 'USD',
        entityId: personal,
        openingBalance: '125000',
      },
    });
    expect(entry.at).toBeInstanceOf(Date);
  });

  it('reaches the phone through the sync pull as a removed account', async () => {
    const res = await c.get(url(`/sync/pull?since=${since}`));
    expect(res.status).toBe(200);
    expect(res.body.removedAccounts).toEqual([id]);
    expect(res.body.accounts.map((a: any) => a.id)).not.toContain(id);
  });
});

describe('an account with history', () => {
  let withTxn: string;
  let withStatement: string;

  beforeAll(async () => {
    withTxn = await addAccount('Everyday checking');
    const txn = await c.post(url('/transactions'), {
      date: addDays(today, -1),
      accountId: withTxn,
      amount: usd('-4500'),
      payee: 'Market',
      categoryId: groceries,
    });
    expect(txn.status).toBe(201);
    withStatement = await addAccount('Savings with a statement');
    // A statement file imported into it: only the row is needed here, not the bytes.
    await admin.query(
      `with f as (
         insert into app.file (workspace_id, kind, file_name, mime, bytes, sha256, storage_key)
         values ($1, 'statement', 'march.csv', 'text/csv', 10, repeat('a', 64), 'test/march.csv') returning id)
       insert into app.import_batch (workspace_id, entity_id, ledger_account_id, file_id, file_name, file_type, currency)
       select $1, $2, $3, f.id, 'march.csv', 'csv', 'USD' from f`,
      [ws, personal, withStatement],
    );
  });

  it('is refused with 409 and the reason when it has a transaction', async () => {
    const res = await c.delete(url(`/accounts/${withTxn}`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account.not_empty');
    expect(res.body.detail ?? res.body.message).toBe(
      'This account has 1 transaction. Archive it instead, or remove them first.',
    );
    expect(await rows(`select 1 from app.ledger_account where id = $1`, [withTxn])).toHaveLength(1);
  });

  it('counts a receipt on its transactions', async () => {
    const [t] = await rows(
      `select distinct je.transaction_id as id from app.journal_entry je
         join app.posting p on p.journal_entry_id = je.id where p.ledger_account_id = $1`,
      [withTxn],
    );
    await admin.query(
      `insert into app.receipt (workspace_id, entity_id, status, transaction_id, total_minor, currency)
       values ($1, $2, 'matched', $3, 4500, 'USD')`,
      [ws, personal, t.id],
    );
    const check = (await c.get(url(`/accounts/${withTxn}/deletion`))).body;
    expect(check.blockers).toEqual([
      { code: 'transactions', count: 1 },
      { code: 'receipts', count: 1 },
    ]);
    expect(check.reason).toBe(
      'This account has 1 transaction and 1 receipt. Archive it instead, or remove them first.',
    );
    expect((await c.delete(url(`/accounts/${withTxn}`))).status).toBe(409);
  });

  it('is refused when a statement was imported into it', async () => {
    const res = await c.delete(url(`/accounts/${withStatement}`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account.not_empty');
    expect((await c.get(url(`/accounts/${withStatement}/deletion`))).body.blockers).toEqual([
      { code: 'statements', count: 1 },
    ]);
  });

  it('can still be archived', async () => {
    expect((await c.patch(url(`/accounts/${withStatement}`), { archived: true })).status).toBe(200);
  });
});

describe('an opening balance in closed books', () => {
  it('is refused with the reason until the books are reopened', async () => {
    const lockedWs = await newWorkspace('Closed books');
    const u = (p: string) => `/v1/workspaces/${lockedWs}${p}`;
    const entity = (await c.get(u(''))).body.entities.find((e: any) => e.type === 'personal').id;
    const id = await addAccount(
      'Old savings',
      { openingBalance: usd('9900'), openingDate: addDays(today, -90) },
      lockedWs,
    );
    const lockedThrough = addDays(today, -30);
    expect((await c.put(u(`/entities/${entity}/period-lock`), { lockedThrough })).status).toBe(200);

    const check = (await c.get(u(`/accounts/${id}/deletion`))).body;
    expect(check.blockers).toEqual([{ code: 'closed_period', count: 1 }]);
    const res = await c.delete(u(`/accounts/${id}`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account.opening_locked');
    expect(res.body.detail ?? res.body.message).toContain(`closed through ${lockedThrough}`);
    expect(await rows(`select 1 from app.ledger_account where id = $1`, [id])).toHaveLength(1);
    expect(await unbalanced(lockedWs)).toBe(0);
  });
});
