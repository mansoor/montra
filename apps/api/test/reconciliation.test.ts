/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Statement reconciliation: the statement chain, adjustments, undo and history (DE-08, DE-11..15; ADR-0039).
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'reconcile-owner@example.test';
const PARTNER = 'reconcile-partner@example.test';

let h: Harness;
let c: Client;
let admin: pg.Client;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

async function workspace(name: string) {
  const ws = (await c.post('/v1/workspaces', { name, baseCurrency: 'USD', template: 'household' })).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const me = (await c.get(url(''))).body;
  const personal = me.entities.find((e: any) => e.type === 'personal').id;
  const cats = (await c.get(url('/categories'))).body.data;
  const cat = (name: string) => cats.find((x: any) => x.name === name && x.entityId === personal).id;
  const income = cats.find((x: any) => x.type === 'income' && x.entityId === personal).id;
  const account = async (name: string, kind: string, opening?: string) =>
    (
      await c.post(url('/accounts'), {
        name,
        kind,
        ...(opening ? { openingBalance: usd(opening), openingDate: '2026-06-01' } : {}),
      })
    ).body.id as string;
  const spend = async (accountId: string, date: string, amount: string, categoryId = cat('Groceries')) =>
    (await c.post(url('/transactions'), { date, accountId, amount: usd(amount), payee: 'Shop', categoryId }))
      .body.id as string;
  /** Starts a statement, ticks every line on it and returns the reconciliation. */
  const reconcile = async (accountId: string, statementDate: string, balance: string) => {
    const rec = (
      await c.post(url(`/accounts/${accountId}/reconciliations`), {
        statementDate,
        statementBalance: usd(balance),
      })
    ).body;
    const open = rec.lines.filter((l: any) => l.cleared === 'uncleared').map((l: any) => l.postingId);
    return (await c.post(url(`/reconciliations/${rec.id}/cleared`), { clear: open })).body;
  };
  return { id: ws.id as string, url, personal, cat, income, account, spend, reconcile };
}

type W = Awaited<ReturnType<typeof workspace>>;

describe('the statement chain (DE-11)', () => {
  let w: W;
  let checking: string;
  let first: any;

  beforeAll(async () => {
    w = await workspace('Chain');
    checking = await w.account('Checking', 'checking', '100000');
    await w.spend(checking, '2026-06-10', '-2500');
    await w.spend(checking, '2026-06-20', '50000', w.income);
    await w.spend(checking, '2026-07-05', '-1000');
  });

  it('opens the first statement at 0, with its deposits and payments', async () => {
    first = await w.reconcile(checking, '2026-06-30', '147500');
    expect(first).toMatchObject({
      openingBalance: usd('0'),
      previousStatementDate: null,
      clearedDeposits: usd('150000'),
      clearedPayments: usd('2500'),
      clearedBalance: usd('147500'),
      statementBalance: usd('147500'),
      difference: usd('0'),
      chainBreak: null,
      adjustmentCategoryId: null,
    });
    const done = (await c.post(w.url(`/reconciliations/${first.id}/complete`))).body;
    expect(done).toMatchObject({
      status: 'completed',
      clearedDeposits: usd('150000'),
      clearedPayments: usd('2500'),
      difference: usd('0'),
    });
  });

  it('suggests the next statement a month on and shows the account reconciled through the last', async () => {
    const history = (await c.get(w.url(`/accounts/${checking}/reconciliations/history`))).body;
    expect(history).toMatchObject({
      reconciledThrough: '2026-06-30',
      next: { statementDate: '2026-07-31', openingBalance: usd('147500') },
      inProgressId: null,
    });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      statementDate: '2026-06-30',
      status: 'completed',
      completedBy: { name: expect.any(String) },
      adjustment: null,
      canUndo: true,
    });
    const account = (await c.get(w.url('/accounts'))).body.data.find((a: any) => a.id === checking);
    expect(account.reconciledThrough).toBe('2026-06-30');
  });

  it('refuses a statement dated on or before the last one', async () => {
    const res = await c.post(w.url(`/accounts/${checking}/reconciliations`), {
      statementDate: '2026-06-30',
      statementBalance: usd('0'),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('reconciliation.statement_date_order');
  });

  it("opens the next statement at the last one's ending balance and warns when the chain breaks", async () => {
    const second = await w.reconcile(checking, '2026-07-31', '146500');
    expect(second).toMatchObject({
      openingBalance: usd('147500'),
      previousStatementDate: '2026-06-30',
      clearedDeposits: usd('0'),
      clearedPayments: usd('1000'),
      difference: usd('0'),
      chainBreak: null,
    });

    // Something reconciled in June stops being reconciled (only the undo path can do this; here the test plays it).
    const groceries = first.lines.find((l: any) => l.amount === '-2500').postingId;
    await admin.query('begin');
    await admin.query(`select set_config('app.allow_unreconcile', 'on', true)`);
    await admin.query(`update app.posting set cleared = 'cleared', reconciliation_id = null where id = $1`, [
      groceries,
    ]);
    await admin.query('commit');
    const broken = (await c.get(w.url(`/reconciliations/${second.id}`))).body;
    expect(broken.chainBreak).toEqual({ reconciledBalance: usd('150000') });

    // Put it back: reconciling again is a status change the guard allows.
    await admin.query(`update app.posting set cleared = 'reconciled', reconciliation_id = $2 where id = $1`, [
      groceries,
      first.id,
    ]);
    expect((await c.get(w.url(`/reconciliations/${second.id}`))).body.chainBreak).toBeNull();
    const done = (await c.post(w.url(`/reconciliations/${second.id}/complete`))).body;
    expect(done.status).toBe('completed');
    const history = (await c.get(w.url(`/accounts/${checking}/reconciliations/history`))).body;
    expect(history.items.map((i: any) => [i.statementDate, i.canUndo])).toEqual([
      ['2026-07-31', true],
      ['2026-06-30', false],
    ]);
    expect(history.next.statementDate).toBe('2026-08-31');
  });
});

describe('finishing with an adjustment (DE-12)', () => {
  it('books the difference on the statement date, reconciled, to Uncategorized by default', async () => {
    const w = await workspace('Adjust');
    const checking = await w.account('Checking', 'checking', '100000');
    await w.spend(checking, '2026-06-10', '-3000');
    const rec = await w.reconcile(checking, '2026-06-30', '96800');
    expect(rec.difference).toEqual(usd('-200'));
    const uncategorized = (await c.get(w.url('/categories'))).body.data.find(
      (x: any) => x.name === 'Uncategorized expense' && x.entityId === w.personal,
    ).id;
    expect(rec.adjustmentCategoryId).toBe(uncategorized);

    const refused = await c.post(w.url(`/reconciliations/${rec.id}/complete`));
    expect(refused.body.code).toBe('reconciliation.difference');

    const done = (await c.post(w.url(`/reconciliations/${rec.id}/complete`), { adjustment: {} })).body;
    expect(done).toMatchObject({
      status: 'completed',
      difference: usd('0'),
      clearedPayments: usd('3200'),
      adjustment: { amount: usd('-200') },
    });
    const txn = (await c.get(w.url(`/transactions/${done.adjustment.transactionId}`))).body;
    expect(txn).toMatchObject({
      date: '2026-06-30',
      payee: 'Reconciliation adjustment',
      amount: usd('-200'),
      reconciled: true,
    });
    expect(txn.entries[0].postings.find((p: any) => p.isCategory).accountId).toBe(uncategorized);
    expect(done.lines.find((l: any) => l.transactionId === txn.id).cleared).toBe('reconciled');

    const history = (await c.get(w.url(`/accounts/${checking}/reconciliations/history`))).body;
    expect(history.items[0].adjustment).toEqual({ transactionId: txn.id, amount: usd('-200') });
  });

  it("uses the category picked, and a card's sign (more owed is a charge)", async () => {
    const w = await workspace('Adjust card');
    const card = await w.account('Card', 'credit_card');
    await w.spend(card, '2026-06-15', '-4000');
    const rec = await w.reconcile(card, '2026-06-30', '4100');
    expect(rec.difference).toEqual(usd('100'));
    const fees = w.cat('Bank fees');
    const done = (
      await c.post(w.url(`/reconciliations/${rec.id}/complete`), { adjustment: { categoryId: fees } })
    ).body;
    expect(done.adjustment.amount).toEqual(usd('100'));
    const txn = (await c.get(w.url(`/transactions/${done.adjustment.transactionId}`))).body;
    expect(txn.amount).toEqual(usd('-100'));
    expect(txn.entries[0].postings.find((p: any) => p.isCategory).accountId).toBe(fees);
    const account = (await c.get(w.url('/accounts'))).body.data.find((a: any) => a.id === card);
    expect(account.balance).toEqual(usd('4100'));
  });
});

describe('undo (DE-13)', () => {
  let w: W;
  let checking: string;
  let june: any;
  let july: any;
  let julyTxn: string;

  beforeAll(async () => {
    w = await workspace('Undo');
    checking = await w.account('Checking', 'checking', '100000');
    await w.spend(checking, '2026-06-10', '-2500');
    julyTxn = await w.spend(checking, '2026-07-10', '-1500');
    june = await w.reconcile(checking, '2026-06-30', '97500');
    await c.post(w.url(`/reconciliations/${june.id}/complete`));
    july = await w.reconcile(checking, '2026-07-31', '96000');
    july = (await c.post(w.url(`/reconciliations/${july.id}/complete`))).body;
    expect(july.status).toBe('completed');

    const invite = await c.post(w.url('/sharing/invites'), { email: PARTNER, role: 'partner' });
    await h.as(PARTNER).post(`/v1/invites/${invite.body.token}/accept`);
  });

  it('is for owners and accountants', async () => {
    const res = await h
      .as(PARTNER)
      .post(w.url(`/reconciliations/${july.id}/undo`), { reason: 'Wrong statement' });
    expect(res.status).toBe(403);
    const history = (await h.as(PARTNER).get(w.url(`/accounts/${checking}/reconciliations/history`))).body;
    expect(history.items.every((i: any) => i.canUndo === false)).toBe(true);
  });

  it('needs a reason, and only the latest one', async () => {
    expect((await c.post(w.url(`/reconciliations/${july.id}/undo`), { reason: '' })).status).toBe(400);
    expect((await c.post(w.url(`/reconciliations/${july.id}/undo`), {})).status).toBe(400);
    const older = await c.post(w.url(`/reconciliations/${june.id}/undo`), { reason: 'Typo in balance' });
    expect(older.status).toBe(409);
    expect(older.body.code).toBe('reconciliation.not_latest');
  });

  it('refuses while its lines are in a closed period', async () => {
    await c.put(w.url(`/entities/${w.personal}/period-lock`), { lockedThrough: '2026-07-31' });
    const res = await c.post(w.url(`/reconciliations/${july.id}/undo`), { reason: 'Wrong statement' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('reconciliation.period_closed');
    await c.delete(w.url(`/entities/${w.personal}/period-lock`), { note: 'Reopen to undo July' });
  });

  it('puts the lines back to cleared, unlocks their entries and keeps the reason in the audit log', async () => {
    const before = (await c.get(w.url('/sync/pull?since=0'))).body.latestSeq;
    expect((await c.get(w.url(`/transactions/${julyTxn}`))).body.reconciled).toBe(true);
    const res = await c.post(w.url(`/reconciliations/${july.id}/undo`), {
      reason: 'Imported the wrong statement',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'undone', lines: [] });

    const { rows } = await admin.query(
      `select p.cleared, p.reconciliation_id, je.locked from app.posting p
         join app.journal_entry je on je.id = p.journal_entry_id
        where je.transaction_id = $1 and p.ledger_account_id = $2`,
      [julyTxn, checking],
    );
    expect(rows).toEqual([{ cleared: 'cleared', reconciliation_id: null, locked: false }]);
    expect((await c.get(w.url(`/transactions/${julyTxn}`))).body.reconciled).toBe(false);
    // The phone hears about it through sync.
    const pulled = (await c.get(w.url(`/sync/pull?since=${before}`))).body;
    expect(pulled.transactions.find((t: any) => t.id === julyTxn)?.reconciled).toBe(false);
    // Unlocked: the amount can change again.
    expect((await c.patch(w.url(`/transactions/${julyTxn}`), { amount: usd('-1600') })).status).toBe(200);

    const audit = (await c.get(w.url(`/audit-log?subjectId=${july.id}`))).body.data;
    const undo = audit.find((a: any) => a.action === 'reconciliation.undo');
    expect(undo).toMatchObject({ subjectType: 'reconciliation' });
    expect(undo.diff).toMatchObject({
      reason: 'Imported the wrong statement',
      statementDate: '2026-07-31',
      lines: 1,
    });

    const history = (await c.get(w.url(`/accounts/${checking}/reconciliations/history`))).body;
    expect(history.reconciledThrough).toBe('2026-06-30');
    expect(history.items[0]).toMatchObject({
      id: july.id,
      status: 'undone',
      undoneBy: { name: expect.any(String) },
      undoReason: 'Imported the wrong statement',
      canUndo: false,
    });
    expect(history.items[1]).toMatchObject({ id: june.id, canUndo: true });
    const account = (await c.get(w.url('/accounts'))).body.data.find((a: any) => a.id === checking);
    expect(account.reconciledThrough).toBe('2026-06-30');
    // June's lines are still reconciled, and the next statement opens at June's ending balance again.
    const again = (
      await c.post(w.url(`/accounts/${checking}/reconciliations`), {
        statementDate: '2026-07-31',
        statementBalance: usd('95900'),
      })
    ).body;
    expect(again).toMatchObject({ openingBalance: usd('97500'), previousStatementDate: '2026-06-30' });
  });

  it("keeps an entry locked while another account's statement still reconciles it", async () => {
    const x = await workspace('Undo transfer');
    const a = await x.account('Checking', 'checking', '100000');
    const b = await x.account('Savings', 'savings', '0');
    const transfer = (
      await c.post(x.url('/transactions/transfer'), {
        date: '2026-06-10',
        fromAccountId: a,
        toAccountId: b,
        amount: usd('20000'),
      })
    ).body.id;
    const recA = await x.reconcile(a, '2026-06-30', '80000');
    await c.post(x.url(`/reconciliations/${recA.id}/complete`));
    const recB = await x.reconcile(b, '2026-06-30', '20000');
    await c.post(x.url(`/reconciliations/${recB.id}/complete`));

    const locked = async () =>
      (
        await admin.query(
          `select bool_or(locked) as locked from app.journal_entry where transaction_id = $1`,
          [transfer],
        )
      ).rows[0].locked;
    await c.post(x.url(`/reconciliations/${recA.id}/undo`), { reason: 'Redo checking' });
    expect(await locked()).toBe(true);
    await c.post(x.url(`/reconciliations/${recB.id}/undo`), { reason: 'Redo savings' });
    expect(await locked()).toBe(false);
  });
});

describe('only the undo un-reconciles (DE-13)', () => {
  let w: W;
  let entryId: string;
  let postingId: string;
  let txnId: string;

  beforeAll(async () => {
    w = await workspace('Guard');
    const checking = await w.account('Checking', 'checking', '100000');
    txnId = await w.spend(checking, '2026-06-10', '-2500');
    const rec = await w.reconcile(checking, '2026-06-30', '97500');
    await c.post(w.url(`/reconciliations/${rec.id}/complete`));
    const { rows } = await admin.query(
      `select p.id, p.journal_entry_id from app.posting p
         join app.journal_entry je on je.id = p.journal_entry_id
        where je.transaction_id = $1 and p.ledger_account_id = $2`,
      [txnId, checking],
    );
    postingId = rows[0].id;
    entryId = rows[0].journal_entry_id;
  });

  it('refuses a direct un-reconcile, even on the locked-edit path', async () => {
    await expect(
      admin.query(`update app.posting set cleared = 'cleared' where id = $1`, [postingId]),
    ).rejects.toThrow(/only be un-reconciled by undoing/);
    await admin.query('begin');
    await admin.query(`select set_config('app.allow_locked_edit', 'on', true)`);
    await expect(
      admin.query(`update app.posting set cleared = 'uncleared', reconciliation_id = null where id = $1`, [
        postingId,
      ]),
    ).rejects.toThrow(/only be un-reconciled by undoing/);
    await admin.query('rollback');
    // Unlocking the entry without the undo is refused too.
    await expect(
      admin.query(`update app.journal_entry set locked = false where id = $1`, [entryId]),
    ).rejects.toThrow(/locked/);
  });

  it("points the entry unlock and transaction edits at the reconciliation's undo", async () => {
    const unlock = await c.post(w.url(`/journal-entries/${entryId}/unlock`), { note: 'Fix the amount' });
    expect(unlock.status).toBe(409);
    expect(unlock.body.code).toBe('journal_entry.reconciled');
    const edit = await c.patch(w.url(`/transactions/${txnId}`), { amount: usd('-2600') });
    expect(edit.body.code).toBe('transaction.reconciled');
    expect(edit.body.detail ?? edit.body.message).toMatch(/reconciliation history/);
  });
});
