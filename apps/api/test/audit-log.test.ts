/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Reading the workspace audit log (NFR-03): owners and admins, a page at a time, with filters.
const usd = (amount: string) => ({ amount, currency: 'USD' });
const OWNER = 'audit-owner@example.test';
const ADMIN = 'audit-admin@example.test';
const PARTNER = 'audit-partner@example.test';

let h: Harness;
let owner: Client;
let admin: Client;
let partner: Client;
let db: pg.Client;
let wsId: string;
let url: (p: string) => string;
let checking: string;
let txn: any;

const log = async (q = '', c: Client = owner) => {
  const res = await c.get(url(`/audit-log${q}`));
  expect(res.status).toBe(200);
  return res.body as { data: any[]; nextCursor: string | null };
};

beforeAll(async () => {
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  h = await startHarness({ AI_PROVIDER: 'fake' });
  owner = h.as(OWNER);
  admin = h.as(ADMIN);
  partner = h.as(PARTNER);
  const ws = (
    await owner.post('/v1/workspaces', {
      name: 'Audit',
      baseCurrency: 'USD',
      timeZone: 'America/Los_Angeles',
      template: 'household',
    })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  for (const [who, email, role] of [
    [admin, ADMIN, 'admin'],
    [partner, PARTNER, 'partner'],
  ] as const) {
    const invite = await owner.post(url('/sharing/invites'), { email, role });
    expect(invite.status).toBe(201);
    expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
  }
  const entities = (await owner.get(url('/entities'))).body.data;
  const personal = entities.find((e: any) => e.type === 'personal').id;
  checking = (await owner.post(url('/accounts'), { name: 'Checking', kind: 'checking', entityId: personal }))
    .body.id;
  txn = (
    await admin.post(url('/transactions'), {
      date: '2026-10-03',
      accountId: checking,
      amount: usd('-1250'),
      description: 'Corner shop',
    })
  ).body;
  expect(txn.id).toBeTruthy();
});
afterAll(async () => {
  await h.close();
  await db.end();
});

describe('the workspace audit log (NFR-03)', () => {
  it('is for owners and admins only', async () => {
    expect((await partner.get(url('/audit-log'))).status).toBe(403);
    expect((await log('', admin)).data.length).toBeGreaterThan(0);
  });

  it('says who did it, by name, newest first', async () => {
    const { data } = await log(`?subjectId=${txn.id}`);
    expect(data[0]).toMatchObject({
      action: 'transaction.insert',
      subjectType: 'transaction',
      subjectId: txn.id,
      actorType: 'user',
      actorName: expect.any(String),
    });
    expect(data[0].actorUserId).toBeTruthy();
    expect(typeof data[0].at).toBe('string');
    const ids = (await log()).data.map((r) => BigInt(r.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
  });

  it('hides the ledger’s own bookkeeping when asked, and only then', async () => {
    const all = (await log('?limit=500')).data;
    expect(all.some((r) => r.action === 'ledger_account.insert')).toBe(true);
    expect(all.some((r) => r.action === 'posting.insert')).toBe(true);
    const plain = (await log('?limit=500&bookkeeping=hide')).data;
    expect(plain.map((r) => r.subjectType)).not.toContain('posting');
    expect(plain.map((r) => r.subjectType)).not.toContain('ledger_account');
    expect(plain.map((r) => r.action)).toEqual(
      expect.arrayContaining(['transaction.insert', 'workspace.insert', 'bank_account.insert']),
    );
  });

  it('keeps an explicit action on a bookkeeping record', async () => {
    await db.query(
      `insert into app.audit_log (workspace_id, actor_user_id, action, subject_type, subject_id, diff)
       values ($1, null, 'journal_entry.unlock', 'journal_entry', 'entry-1', '{"note":"fix"}')`,
      [wsId],
    );
    const { data } = await log('?bookkeeping=hide&limit=5');
    expect(data[0]).toMatchObject({ action: 'journal_entry.unlock', actorName: null, diff: { note: 'fix' } });
  });

  it('filters by person, record type, action and day', async () => {
    const adminId = (await owner.get(url('/sharing/members'))).body.data.find(
      (m: any) => m.email === ADMIN,
    ).userId;
    const byAdmin = (await log(`?actorUserId=${adminId}&bookkeeping=hide`)).data;
    expect(byAdmin.length).toBeGreaterThan(0);
    expect(byAdmin.every((r) => r.actorUserId === adminId)).toBe(true);
    expect(byAdmin.map((r) => r.action)).toContain('transaction.insert');

    const accounts = (await log('?subjectType=bank_account')).data;
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((r) => r.subjectType === 'bank_account')).toBe(true);
    expect((await log('?action=transaction.insert')).data).toHaveLength(1);

    // Days are the workspace's (Los Angeles): today there, whatever the hour in UTC.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    expect((await log(`?from=${today}&to=${today}`)).data.length).toBeGreaterThan(0);
    expect((await log('?to=2020-01-01')).data).toEqual([]);
    expect((await log('?from=2099-01-01')).data).toEqual([]);
  });

  it('pages without repeating or skipping a row', async () => {
    const all = (await log('?limit=500')).data.map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: any[]; nextCursor: string | null } = await log(
        `?limit=7${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.data.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it('refuses a malformed filter', async () => {
    for (const q of [
      '?cursor=abc',
      '?from=2026-13-01',
      '?actorUserId=nope',
      '?bookkeeping=maybe',
      '?limit=0',
    ])
      expect((await owner.get(url(`/audit-log${q}`))).status).toBe(400);
  });
});
