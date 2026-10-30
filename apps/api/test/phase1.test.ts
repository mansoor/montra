/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { addDays, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';
import { MAIL_PORT, type MemoryMail } from '../src/mail/mail.service.js';

let h: Harness;
let admin: pg.Client;
const usd = (amount: string) => ({ amount, currency: 'USD' });

interface Ws {
  id: string;
  personalId: string;
  businessId: string;
  checking: string;
  card: string;
  cat: (entityId: string, name: string) => string;
  url: (path: string) => string;
}

async function setup(client: Client, opts: { template?: string } = {}): Promise<Ws> {
  const ws = await client.post('/v1/workspaces', {
    name: 'Phase 1',
    baseCurrency: 'USD',
    template: opts.template ?? 'freelancer',
    businessName: 'Studio',
  });
  const id = ws.body.id;
  const url = (path: string) => `/v1/workspaces/${id}${path}`;
  const cats = (await client.get(url('/categories'))).body.data;
  const checking = (
    await client.post(url('/accounts'), {
      name: 'Checking',
      kind: 'checking',
      openingBalance: usd('100000'),
      openingDate: '2026-08-01',
    })
  ).body.id;
  const card = (await client.post(url('/accounts'), { name: 'Card', kind: 'credit_card' })).body.id;
  return {
    id,
    personalId: ws.body.entities[0].id,
    businessId: ws.body.entities[1]?.id,
    checking,
    card,
    cat: (entityId, name) => cats.find((c: any) => c.entityId === entityId && c.name === name).id,
    url,
  };
}

const expense = (w: Ws, client: Client, date: string, amount: string, category: string, extra: object = {}) =>
  client.post(w.url('/transactions'), {
    date,
    accountId: w.card,
    amount: usd(amount),
    categoryId: category,
    ...extra,
  });

const accountsOf = (w: Ws, t: any) =>
  t.entries.flatMap((e: any) =>
    e.postings.map((p: any) => `${e.kind}:${p.accountName}:${p.debit ?? '-' + p.credit}`),
  );

beforeAll(async () => {
  h = await startHarness();
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('profile and settings (TZ-01, TZ-05, ACC-01, FAM)', () => {
  it('updates the profile', async () => {
    const me = h.as('profile@example.com');
    await me.get('/v1/workspaces');
    const res = await me.patch('/v1/me', {
      displayName: 'Pat',
      timeZone: 'Europe/Berlin',
      locale: 'de-DE',
      weekStart: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Pat', timeZone: 'Europe/Berlin', locale: 'de-DE' });
    expect((await me.patch('/v1/me', { timeZone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('adds a rental portfolio with its own currency and Schedule E chart', async () => {
    const c = h.as('entities@example.com');
    const w = await setup(c);
    const res = await c.post(w.url('/entities'), {
      type: 'rental',
      name: 'Oak St',
      functionalCurrency: 'CAD',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'rental', functionalCurrency: 'CAD' });
    const cats = (await c.get(w.url(`/categories?entityId=${res.body.id}`))).body.data;
    expect(cats.find((x: any) => x.name === 'Mortgage interest').taxLineCode).toBe('US_SCH_E_L12');
    const renamed = await c.patch(w.url(`/entities/${res.body.id}`), { name: '12 Oak St' });
    expect(renamed.body.name).toBe('12 Oak St');
  });

  it("tags a card's transactions with its default family member (FAM-04)", async () => {
    const c = h.as('family@example.com');
    const w = await setup(c, { template: 'household' });
    const son = (
      await c.post(w.url('/family-members'), { name: 'Sam', relationship: 'child', isDependent: true })
    ).body;
    expect(son).toMatchObject({ name: 'Sam', status: 'active' });
    await c.patch(w.url(`/accounts/${w.card}`), { defaultMemberId: son.id });
    const t = (await expense(w, c, '2026-10-01', '-4500', w.cat(w.personalId, 'Education'))).body;
    expect(t.entries[0].postings.every((p: any) => p.memberId === son.id)).toBe(true);
    const archived = await c.patch(w.url(`/family-members/${son.id}`), { status: 'inactive' });
    expect(archived.body.status).toBe('inactive');
  });
});

describe('editing transactions (DE-10, TXN-10)', () => {
  let c: Client;
  let w: Ws;
  beforeAll(async () => {
    c = h.as('editor@example.com');
    w = await setup(c);
  });

  it('rewrites an unprotected transaction in place and enforces If-Match', async () => {
    const t = (
      await expense(w, c, '2026-10-02', '-1850', w.cat(w.personalId, 'Groceries'), {
        memo: 'Lunch with client',
      })
    ).body;
    expect(t.memo).toBe('Lunch with client');
    const stale = await c.patch(
      w.url(`/transactions/${t.id}`),
      { categoryId: w.cat(w.personalId, 'Dining out') },
      { 'if-match': '"v999"' },
    );
    expect(stale.status).toBe(412);
    const res = await c.patch(
      w.url(`/transactions/${t.id}`),
      { categoryId: w.cat(w.personalId, 'Dining out'), amount: usd('-2000') },
      { 'if-match': `"v${t.version}"` },
    );
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(`"v${res.body.version}"`);
    expect(accountsOf(w, res.body)).toEqual(['standard:Card:-2000', 'standard:Dining out:2000']);
    expect(res.body.memo).toBe('Lunch with client');
  });

  it('stores memos encrypted at rest (NFR-01)', async () => {
    const { rows } = await admin.query(
      `select memo_enc from app.transaction where workspace_id = $1 and memo_enc is not null`,
      [w.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(Buffer.from(rows[0].memo_enc).toString('utf8')).not.toContain('Lunch');
  });

  it('moves a split to another entity with one tap (UP-08) and bulk-edits (TXN-10)', async () => {
    const a = (await expense(w, c, '2026-10-03', '-999', w.cat(w.personalId, 'Electronics'))).body;
    const b = (await expense(w, c, '2026-10-03', '-1299', w.cat(w.personalId, 'Electronics'))).body;
    const split = (
      await c.post(w.url('/transactions'), {
        date: '2026-10-03',
        accountId: w.card,
        amount: usd('-3000'),
        splits: [
          { accountId: w.cat(w.personalId, 'Groceries'), amount: usd('-1000') },
          { accountId: w.cat(w.personalId, 'Household'), amount: usd('-2000') },
        ],
      })
    ).body;
    const res = await c.post(w.url('/transactions/bulk'), {
      ids: [a.id, b.id, split.id],
      set: { entityId: w.businessId, addTags: ['equipment'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated.sort()).toEqual([a.id, b.id].sort());
    expect(res.body.skipped).toEqual([{ id: split.id, reason: expect.stringContaining('Split') }]);
    const moved = (await c.get(w.url(`/transactions/${a.id}`))).body;
    // No same-named "Electronics" category in the business chart → business uncategorized expense.
    expect(moved.entries.map((e: any) => e.entityId)).toEqual([w.personalId, w.businessId]);
    expect(moved.tags).toEqual(['equipment']);
  });

  it('voids to the trash and restores', async () => {
    const t = (await expense(w, c, '2026-10-04', '-700', w.cat(w.personalId, 'Groceries'))).body;
    expect((await c.delete(w.url(`/transactions/${t.id}`))).body).toEqual({ outcome: 'removed' });
    const voided = (await c.get(w.url(`/transactions/${t.id}`))).body;
    expect(voided.status).toBe('void');
    expect(voided.entries).toEqual([]);
    const restored = await c.post(w.url(`/transactions/${t.id}/restore`));
    expect(restored.body.status).toBe('posted');
    expect(restored.body.entries).toHaveLength(1);
  });

  it('reclassifies a reconciled transaction on its original date and refuses cash changes (DE-08)', async () => {
    const t = (await expense(w, c, '2026-10-05', '-5000', w.cat(w.personalId, 'Groceries'))).body;
    const entryId = t.entries[0].id;
    // Reconciliation UI arrives in Phase 2; mark it reconciled directly.
    await admin.query(
      `update app.posting set cleared = 'reconciled' where journal_entry_id = $1 and ledger_account_id = $2`,
      [entryId, w.card],
    );
    await admin.query(`update app.journal_entry set locked = true where id = $1`, [entryId]);

    const moved = await c.patch(w.url(`/transactions/${t.id}`), {
      categoryId: w.cat(w.personalId, 'Household'),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.entries.map((e: any) => [e.kind, e.date])).toEqual([
      ['standard', '2026-10-05'],
      ['adjustment', '2026-10-05'],
    ]);
    expect(accountsOf(w, moved.body)).toEqual([
      'standard:Card:-5000',
      'standard:Groceries:5000',
      'adjustment:Groceries:-5000',
      'adjustment:Household:5000',
    ]);
    const amount = await c.patch(w.url(`/transactions/${t.id}`), { amount: usd('-5100') });
    expect(amount.status).toBe(409);
    expect(amount.body.code).toBe('transaction.reconciled');
    expect((await c.delete(w.url(`/transactions/${t.id}`))).body.code).toBe('transaction.reconciled');
  });

  it('reverses into the first open period when the books are closed (DE-09, DE-10)', async () => {
    const t = (await expense(w, c, '2026-09-10', '-2500', w.cat(w.personalId, 'Groceries'))).body;
    const lock = await c.put(w.url(`/entities/${w.personalId}/period-lock`), {
      lockedThrough: '2026-09-30',
      note: 'September closed',
    });
    expect(lock.status).toBe(200);

    const created = await expense(w, c, '2026-09-15', '-100', w.cat(w.personalId, 'Groceries'));
    expect(created.status).toBe(409);
    expect(created.body.code).toBe('period.locked');

    const edited = await c.patch(w.url(`/transactions/${t.id}`), {
      categoryId: w.cat(w.personalId, 'Dining out'),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.entries.map((e: any) => [e.kind, e.date])).toEqual([
      ['standard', '2026-09-10'],
      ['reversal', '2026-10-01'],
      ['standard', '2026-10-01'],
    ]);
    const voided = await c.delete(w.url(`/transactions/${t.id}`));
    expect(voided.body).toEqual({ outcome: 'reversed' });

    const history = (await c.get(w.url(`/entities/${w.personalId}/period-lock/history`))).body.data;
    expect(history[0]).toMatchObject({ action: 'lock', lockedThrough: '2026-09-30' });
    const unlock = await c.delete(w.url(`/entities/${w.personalId}/period-lock`), {
      note: 'Reopen for audit',
    });
    expect(unlock.status).toBe(200);
  });
});

describe('journals, adjustments and audit (DE-07, ACC-05, NFR-03)', () => {
  let c: Client;
  let w: Ws;
  beforeAll(async () => {
    c = h.as('journals@example.com');
    w = await setup(c);
  });

  it('posts balanced manual journals and rejects unbalanced ones', async () => {
    const office = w.cat(w.businessId, 'Office expense');
    const ledger = (await c.get(w.url('/accounts'))).body.data;
    expect(ledger.length).toBe(2);
    const bizCash = (
      await c.post(w.url('/accounts'), { entityId: w.businessId, name: 'Biz checking', kind: 'checking' })
    ).body.id;
    const ok = await c.post(w.url('/journal-entries'), {
      entityId: w.businessId,
      date: '2026-10-10',
      description: 'Reclass supplies',
      lines: [
        { accountId: office, debit: '1500' },
        { accountId: bizCash, credit: '1500' },
      ],
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: 'manual', postings: [{ debit: '1500' }, { credit: '1500' }] });
    const bad = await c.post(w.url('/journal-entries'), {
      entityId: w.businessId,
      date: '2026-10-10',
      description: 'Oops',
      lines: [
        { accountId: office, debit: '1500' },
        { accountId: bizCash, credit: '1400' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('ledger.unbalanced');
  });

  it('adjusts a balance to match the statement with an audit trail (ACC-05)', async () => {
    const res = await c.post(w.url(`/accounts/${w.checking}/balance-adjustments`), {
      date: '2026-10-31',
      balance: usd('98765'),
      note: 'Match October statement',
    });
    expect(res.body.adjustment).toBe('-1235');
    const accounts = (await c.get(w.url('/accounts'))).body.data;
    expect(accounts.find((a: any) => a.id === w.checking).balance.amount).toBe('98765');
    const audit = (await c.get(w.url(`/audit-log?subjectId=${res.body.entryId}`))).body.data;
    expect(audit[0]).toMatchObject({ action: 'journal_entry.insert', subjectType: 'journal_entry' });
  });

  it('archives and hides accounts per user (ACC-06, UP-04)', async () => {
    const names = async (q = '') => (await c.get(w.url(`/accounts${q}`))).body.data.map((a: any) => a.name);
    await c.patch(w.url(`/accounts/${w.card}`), { hidden: true });
    expect(await names()).toEqual(['Checking', 'Biz checking']);
    expect(await names('?include=all')).toEqual(['Checking', 'Card', 'Biz checking']);
    await c.patch(w.url(`/accounts/${w.card}`), { hidden: false, archived: true });
    expect(await names()).toEqual(['Checking', 'Biz checking']);
  });
});

describe('sharing (UP-04, AUTH-10, BIZ-13)', () => {
  it('invites a partner with read access to the business', async () => {
    const owner = h.as('owner-share@example.com');
    const w = await setup(owner);
    await owner.post(w.url('/accounts'), { entityId: w.businessId, name: 'Biz checking', kind: 'checking' });
    const invite = await owner.post(w.url('/sharing/invites'), {
      email: 'Partner-Share@example.com',
      role: 'partner',
      entityGrants: [{ entityId: w.businessId, access: 'read' }],
    });
    expect(invite.status).toBe(201);
    expect(invite.body.email).toBe('partner-share@example.com');
    const mail = (h.app.get(MAIL_PORT) as MemoryMail).outbox.find(
      (m) => m.to === 'partner-share@example.com',
    );
    expect(mail).toMatchObject({ category: 'sharing', subject: expect.stringContaining('invited you') });
    expect(mail!.text).toContain(`/invite/${invite.body.token}`);

    const stranger = h.as('stranger@example.com');
    const wrong = await stranger.post(`/v1/invites/${invite.body.token}/accept`);
    expect(wrong.body.code).toBe('invite.email_mismatch');

    const partner = h.as('partner-share@example.com');
    expect((await partner.get(w.url('/accounts'))).status).toBe(403);
    const accepted = await partner.post(`/v1/invites/${invite.body.token}/accept`);
    expect(accepted.body).toEqual({ workspaceId: w.id });
    expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).body.code).toBe('invite.invalid');

    const visible = (await partner.get(w.url('/accounts'))).body.data.map((a: any) => a.name).sort();
    expect(visible).toEqual(['Biz checking', 'Card', 'Checking']);
    const write = await partner.post(w.url('/transactions'), {
      date: '2026-10-11',
      accountId: (await partner.get(w.url('/accounts'))).body.data.find((a: any) => a.name === 'Biz checking')
        .id,
      amount: usd('-100'),
      categoryId: w.cat(w.businessId, 'Office expense'),
    });
    expect(write.status).toBe(403);

    const members = (await owner.get(w.url('/sharing/members'))).body.data;
    expect(members.map((m: any) => [m.email, m.role])).toEqual([
      ['owner-share@example.com', 'owner'],
      ['partner-share@example.com', 'partner'],
    ]);
    expect(
      (await partner.post(w.url('/sharing/invites'), { email: 'x@example.com', role: 'viewer' })).status,
    ).toBe(403);

    // Revoking access takes effect immediately.
    await owner.patch(w.url(`/sharing/members/${members[1].userId}`), { status: 'revoked' });
    expect((await partner.get(w.url('/accounts'))).status).toBe(403);
  });
});

describe('recurring templates and sync (TXN-05, PLT-06)', () => {
  it('schedules occurrences, confirms them and auto-posts due ones', async () => {
    const c = h.as('recurring@example.com');
    const w = await setup(c, { template: 'household' });
    const today = todayIn('UTC');
    const rent = await c.post(w.url('/recurring'), {
      name: 'Rent',
      accountId: w.checking,
      amount: usd('-180000'),
      payee: 'Landlord',
      categoryId: w.cat(w.personalId, 'Rent'),
      cadence: 'monthly',
      startDate: addDays(today, 3),
    });
    expect(rent.status).toBe(201);
    expect(rent.body).toMatchObject({ name: 'Rent', cadence: 'monthly', status: 'active' });
    const scheduled = (await c.get(w.url('/transactions?status=scheduled'))).body.data;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      date: addDays(today, 3),
      entries: [],
      recurringItemId: rent.body.id,
    });

    // Materializing again is idempotent.
    expect((await c.post(w.url('/recurring/materialize'))).body).toEqual({ created: 0, posted: 0 });

    const confirmed = await c.post(w.url(`/transactions/${scheduled[0].id}/confirm`), {
      amount: usd('-181000'),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('posted');
    expect(confirmed.body.entries[0].postings.map((p: any) => p.debit ?? p.credit)).toEqual([
      '181000',
      '181000',
    ]);

    const salary = await c.post(w.url('/recurring'), {
      name: 'Salary',
      accountId: w.checking,
      amount: usd('320000'),
      categoryId: w.cat(w.personalId, 'Salary'),
      cadence: 'biweekly',
      startDate: addDays(today, -14),
      autoCreate: 'posted',
    });
    expect(salary.body.nextDate > today).toBe(true);
    const posted = (await c.get(w.url('/transactions?status=posted'))).body.data.filter(
      (t: any) => t.recurringItemId === salary.body.id,
    );
    expect(posted.map((t: any) => t.date)).toEqual([today, addDays(today, -14)]);

    // Pages end on transaction boundaries, so resuming from latestSeq never skips part of a transaction.
    const changes = await c.get(w.url('/sync/changes?since=0&limit=5'));
    expect(changes.body.changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.body.hasMore).toBe(true);
    const all = await c.get(w.url('/sync/changes?since=0&limit=1000'));
    const firstPageSeqs = new Set(changes.body.changes.map((x: any) => x.seq));
    expect(all.body.changes.filter((x: any) => firstPageSeqs.has(x.seq)).length).toBe(
      changes.body.changes.length,
    );
    const next = await c.get(w.url(`/sync/changes?since=${changes.body.latestSeq}&limit=1000`));
    expect(BigInt(next.body.changes[0].seq)).toBe(BigInt(changes.body.latestSeq) + 1n);
  });
});

describe('contract additions for the web client', () => {
  it('lists the trash, journals, the full chart, the sync head and entity lock dates', async () => {
    const c = h.as('contract@example.com');
    const w = await setup(c);
    const t = (await expense(w, c, '2026-10-06', '-300', w.cat(w.personalId, 'Groceries'))).body;
    expect(t.accountId).toBe(w.card);
    expect(t.splits).toEqual([
      { accountId: w.cat(w.personalId, 'Groceries'), amount: '-300', memberId: null, memo: null },
    ]);
    await c.delete(w.url(`/transactions/${t.id}`));
    expect((await c.get(w.url('/transactions'))).body.data.map((x: any) => x.id)).not.toContain(t.id);
    expect((await c.get(w.url('/transactions?trash=true'))).body.data.map((x: any) => x.id)).toEqual([t.id]);

    const journals = (await c.get(w.url(`/journal-entries?entityId=${w.personalId}&kind=opening_balance`)))
      .body.data;
    expect(journals).toEqual([
      expect.objectContaining({ kind: 'opening_balance', total: '100000', date: '2026-08-01' }),
    ]);

    const chart = (await c.get(w.url(`/ledger-accounts?entityId=${w.personalId}`))).body.data;
    expect(chart.find((a: any) => a.systemRole === 'opening_balance_equity')).toMatchObject({
      type: 'equity',
      isCategory: false,
    });

    const head = (await c.get(w.url('/sync/changes?head=true'))).body;
    expect(head.changes).toEqual([]);
    expect(Number(head.latestSeq)).toBeGreaterThan(3); // one sequence value per committed transaction

    await c.put(w.url(`/entities/${w.businessId}/period-lock`), { lockedThrough: '2026-06-30' });
    const ws = (await c.get(`/v1/workspaces/${w.id}`)).body;
    expect(ws.entities.map((e: any) => e.lockedThrough)).toEqual([null, '2026-06-30']);
    expect((await c.get(w.url('/entities'))).body.data[1].lockedThrough).toBe('2026-06-30');
  });
});
