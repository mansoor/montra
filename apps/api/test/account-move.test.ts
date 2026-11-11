/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Moving an account to other books (ACC-03; ADR-0033).
const today = todayIn('UTC');
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'account-move@example.test';

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let url: (p: string) => string;
let ws: string;
let personal: string;
let biz: string;
let card: string;
let checking: string;
let cat: (name: string, entity: string) => string;
const tx: Record<string, string> = {};

/** Each transaction's lines as account → amount, settling accounts left out: what a move must keep. */
const lines = async (transactionId: string) => {
  const { rows } = await admin.query(
    `select p.ledger_account_id as account, sum(p.amount_minor)::text as amount
       from app.posting p
       join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
       join app.ledger_account a on a.id = p.ledger_account_id
      where je.transaction_id = $1
        and (a.system_role is null or a.system_role not in
             ('inter_entity_clearing', 'due_to_entity', 'due_from_entity', 'owner_contribution', 'owner_draw', 'uncategorized_expense', 'uncategorized_income'))
      group by 1 having sum(p.amount_minor) <> 0 order by 1`,
    [transactionId],
  );
  return rows;
};
const entitiesOf = async (transactionId: string) =>
  (
    await admin.query(
      `select distinct je.entity_id from app.journal_entry je where je.transaction_id = $1 order by 1`,
      [transactionId],
    )
  ).rows.map((r) => r.entity_id);
const accountOf = async (id: string) =>
  (await c.get(url('/accounts'))).body.data.find((a: any) => a.id === id);
const pnl = async (entityId: string) => (await c.get(url(`/reports/pnl?entityId=${entityId}`))).body;
const unbalanced = async () =>
  Number(
    (
      await admin.query(
        `select count(*) from (select journal_entry_id from app.posting where workspace_id = $1
          group by 1 having sum(functional_amount_minor) <> 0) x`,
        [ws],
      )
    ).rows[0].count,
  );

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  partner = h.as('account-move-partner@example.test');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const w = (await c.post('/v1/workspaces', { name: 'Books', baseCurrency: 'USD', template: 'household' }))
    .body;
  ws = w.id;
  url = (p) => `/v1/workspaces/${ws}${p}`;
  biz = (
    await c.post(url('/entities'), { type: 'business', name: 'Rivera Studio', businessType: 'sole_prop' })
  ).body.id;
  const me = (await c.get(url(''))).body;
  personal = me.entities.find((e: any) => e.type === 'personal').id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name, entity) => cats.find((x: any) => x.name === name && x.entityId === entity).id;
  const opening = addDays(today, -60);
  card = (
    await c.post(url('/accounts'), {
      name: 'Everyday card',
      kind: 'credit_card',
      openingBalance: usd('25000'),
      openingDate: opening,
    })
  ).body.id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Joint checking',
      kind: 'checking',
      openingBalance: usd('500000'),
      openingDate: opening,
    })
  ).body.id;
  const spend = async (amount: string, categoryId: string, payee: string, date = addDays(today, -20)) =>
    (await c.post(url('/transactions'), { date, accountId: card, amount: usd(amount), payee, categoryId }))
      .body.id;
  tx.office = await spend('-12000', cat('Office expense', biz), 'Staples');
  tx.groceries = await spend('-8000', cat('Groceries', personal), 'Market');
  tx.payment = (
    await c.post(url('/transactions/transfer'), {
      date: addDays(today, -10),
      fromAccountId: checking,
      toAccountId: card,
      amount: usd('20000'),
    })
  ).body.id;
  // The office purchase was on a statement that was reconciled.
  await admin.query(
    `update app.posting set cleared = 'reconciled' from app.journal_entry je
      where je.id = posting.journal_entry_id and je.transaction_id = $1 and posting.ledger_account_id = $2`,
    [tx.office, card],
  );
  await admin.query(
    `update app.journal_entry set locked = true where transaction_id = $1 and entity_id = $2`,
    [tx.office, personal],
  );
  const invite = await c.post(url('/sharing/invites'), {
    email: 'account-move-partner@example.test',
    role: 'partner',
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('moving an account to a business', () => {
  let before: Record<string, any>;
  let balance: string;
  let bizPnl: any;
  let personalPnl: any;

  beforeAll(async () => {
    before = {};
    for (const [k, id] of Object.entries(tx)) before[k] = await lines(id);
    balance = (await accountOf(card)).balance.amount;
    bizPnl = await pnl(biz);
    personalPnl = await pnl(personal);
  });

  it('previews what would move, changing nothing', async () => {
    const p = await c.get(url(`/accounts/${card}/move?entityId=${biz}`));
    expect(p.status).toBe(200);
    expect(p.body).toEqual({
      accountId: card,
      fromEntityId: personal,
      toEntityId: biz,
      transactions: 3,
      entries: 1,
      reconciledLines: 1,
      crossBooks: 1,
      clearedDefaults: [],
      blockers: [],
      moved: false,
    });
    expect((await accountOf(card)).entityId).toBe(personal);
  });

  it('is for owners only', async () => {
    expect((await partner.get(url(`/accounts/${card}/move?entityId=${biz}`))).status).toBe(403);
    expect((await partner.post(url(`/accounts/${card}/move`), { entityId: biz })).status).toBe(403);
  });

  it('moves the whole history, keeping every amount, date and reconciled line', async () => {
    const res = await c.post(url(`/accounts/${card}/move`), { entityId: biz });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: true, transactions: 3, entries: 1 });
    const a = await accountOf(card);
    expect(a.entityId).toBe(biz);
    expect(a.balance.amount).toBe(balance);
    for (const [k, id] of Object.entries(tx)) expect(await lines(id), k).toEqual(before[k]);
    expect(await unbalanced()).toBe(0);

    // The business purchase on the card is now the business's alone; the groceries are an owner draw.
    expect(await entitiesOf(tx.office!)).toEqual([biz]);
    expect((await entitiesOf(tx.groceries!)).sort()).toEqual([biz, personal].sort());
    const office = await admin.query(
      `select p.cleared, je.locked from app.posting p join app.journal_entry je on je.id = p.journal_entry_id
        where je.transaction_id = $1 and p.ledger_account_id = $2`,
      [tx.office, card],
    );
    expect(office.rows).toEqual([{ cleared: 'reconciled', locked: true }]);
    // The opening balance is the business's own.
    const opening = await admin.query(
      `select je.entity_id, a.system_role from app.posting p
         join app.journal_entry je on je.id = p.journal_entry_id
         join app.ledger_account a on a.id = p.ledger_account_id
        where je.kind = 'opening_balance' and je.transaction_id is null and je.workspace_id = $1
          and je.id in (select journal_entry_id from app.posting where ledger_account_id = $2)
        order by a.system_role nulls first`,
      [ws, card],
    );
    expect(opening.rows).toEqual([
      { entity_id: biz, system_role: null },
      { entity_id: biz, system_role: 'opening_balance_equity' },
    ]);
  });

  it('leaves the P&L of both books as it was: categories stay where they are', async () => {
    expect((await pnl(biz)).expenses).toBe(bizPnl.expenses);
    expect((await pnl(personal)).expenses).toBe(personalPnl.expenses);
  });

  it('keeps the read models and the register with the account', async () => {
    const rm = await admin.query(
      `select distinct entity_id from app.account_balance_daily where ledger_account_id = $1`,
      [card],
    );
    expect(rm.rows).toEqual([{ entity_id: biz }]);
    const reg = (await c.get(url(`/accounts/${card}/register`))).body;
    expect(reg.data ?? reg).toBeTruthy();
    const history = await admin.query(
      'select from_entity_id, to_entity_id, transactions from app.account_move where ledger_account_id = $1',
      [card],
    );
    expect(history.rows).toEqual([{ from_entity_id: personal, to_entity_id: biz, transactions: 3 }]);
  });

  it('can still be edited the ordinary way afterwards', async () => {
    // A new date makes the poster build it again from its spec, now with the card in the business's books.
    const res = await c.patch(url(`/transactions/${tx.groceries}`), { date: addDays(today, -21) });
    expect(res.status).toBe(200);
    expect((await entitiesOf(tx.groceries!)).sort()).toEqual([biz, personal].sort());
    expect(await lines(tx.groceries!)).toEqual(before.groceries);
    expect(await unbalanced()).toBe(0);
  });

  it('comes back to Personal exactly as it was', async () => {
    const res = await c.post(url(`/accounts/${card}/move`), { entityId: personal });
    expect(res.status).toBe(200);
    expect((await accountOf(card)).entityId).toBe(personal);
    for (const [k, id] of Object.entries(tx)) expect(await lines(id), k).toEqual(before[k]);
    expect(await entitiesOf(tx.groceries!)).toEqual([personal]);
    expect((await entitiesOf(tx.office!)).sort()).toEqual([biz, personal].sort());
    expect((await pnl(biz)).expenses).toBe(bizPnl.expenses);
    expect(await unbalanced()).toBe(0);
  });
});

describe('what stops a move', () => {
  it('refuses a closed period, changing nothing', async () => {
    await c.put(url(`/entities/${personal}/period-lock`), { lockedThrough: addDays(today, -15) });
    const p = (await c.get(url(`/accounts/${card}/move?entityId=${biz}`))).body;
    expect(p.blockers.map((b: any) => b.code)).toEqual(['closed_period']);
    expect(p.blockers[0].message).toMatch(/closed period/);
    const res = await c.post(url(`/accounts/${card}/move`), { entityId: biz });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account.move_blocked');
    expect((await accountOf(card)).entityId).toBe(personal);
    await admin.query('delete from app.period_lock where workspace_id = $1', [ws]);
  });

  it('refuses a hand-written journal tying the account to a category of the old books', async () => {
    const j = await c.post(url('/journal-entries'), {
      entityId: personal,
      date: today,
      description: 'Cashback',
      lines: [
        { accountId: card, debit: '500' },
        { accountId: cat('Groceries', personal), credit: '500' },
      ],
    });
    expect(j.status).toBe(201);
    const p = (await c.get(url(`/accounts/${card}/move?entityId=${biz}`))).body;
    expect(p.blockers.map((b: any) => b.code)).toEqual(['manual_journal']);
  });

  it('clears a business default that points at the account it loses', async () => {
    const bizChecking = (
      await c.post(url('/accounts'), { name: 'Studio checking', kind: 'checking', entityId: biz })
    ).body.id;
    await c.patch(url(`/businesses/${biz}`), { defaultDepositAccountId: bizChecking });
    const p = (await c.get(url(`/accounts/${bizChecking}/move?entityId=${personal}`))).body;
    expect(p.clearedDefaults).toEqual(['default_deposit_account']);
    expect((await c.post(url(`/accounts/${bizChecking}/move`), { entityId: personal })).status).toBe(200);
    expect((await c.get(url(`/businesses/${biz}`))).body.defaultDepositAccountId).toBeNull();
  });

  it('refuses the books it is already in', async () => {
    expect((await c.get(url(`/accounts/${checking}/move?entityId=${personal}`))).status).toBe(422);
  });
});
