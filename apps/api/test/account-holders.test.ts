/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db/database.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// An account's holders (ACC-15) and its full number, sealed (ACC-16); ADR-0057 §5, §6. Made-up numbers only.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const EMAIL = 'acct-holders@example.test';
const PARTNER = 'acct-holders-partner@example.test';
const OTHER = 'acct-holders-other@example.test';
const FULL = '0012 3456 7890 4321';
const DIGITS = '0012345678904321';

let h: Harness;
let c: Client;
let partner: Client;
let other: Client;
let admin: pg.Client;
let wsId: string;
let otherWs: string;
let url: (p: string) => string;
let personal: string;
let business: string;
let joint: string;
let bizAccount: string;
let ada: string;
let ben: string;
let strangerMember: string;

const account = async (id: string, client = c) =>
  (await client.get(url('/accounts?include=all'))).body.data.find((a: any) => a.id === id);
const holderRows = async (id = joint) =>
  (
    await admin.query(
      `select id, position, name, member_id from app.account_holder where ledger_account_id = $1 order by position`,
      [id],
    )
  ).rows;
const stored = async (id = joint) =>
  (
    await admin.query(`select account_number_enc, last4 from app.bank_account where ledger_account_id = $1`, [
      id,
    ])
  ).rows[0];
const auditText = async () =>
  JSON.stringify(
    (await admin.query(`select action, diff from app.audit_log where workspace_id = $1`, [wsId])).rows,
  );
const reveal = (id = joint, client = c) => client.post(url(`/accounts/${id}/reveal-number`), {});

/** The sign-in is 30 minutes old by the time the API looks (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  c = h.as(EMAIL);
  partner = h.as(PARTNER);
  other = h.as(OTHER);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (await c.post('/v1/workspaces', { name: 'Holders', baseCurrency: 'USD', template: 'hybrid' }))
    .body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  const entities = (await c.get(url('/entities'))).body.data;
  personal = entities.find((e: any) => e.type === 'personal').id;
  business = entities.find((e: any) => e.type === 'business').id;
  const member = async (name: string, relationship: string, client = c, base = url) =>
    (await client.post(base('/family-members'), { name, relationship })).body.id as string;
  ada = await member('Ada Lovelace', 'self');
  ben = await member('Ben Lovelace', 'spouse_partner');
  joint = (await c.post(url('/accounts'), { name: 'Joint', kind: 'checking', entityId: personal })).body.id;
  bizAccount = (await c.post(url('/accounts'), { name: 'Studio', kind: 'checking', entityId: business })).body
    .id;
  // A partner who can write the personal books and can't see the business's.
  const invite = await c.post(url('/sharing/invites'), {
    email: PARTNER,
    role: 'partner',
    entityGrants: [
      { entityId: personal, access: 'write' },
      { entityId: business, access: 'none' },
    ],
  });
  await partner.post(`/v1/invites/${invite.body.token}/accept`);
  const o = (await other.post('/v1/workspaces', { name: 'Elsewhere', baseCurrency: 'USD' })).body;
  otherWs = o.id;
  strangerMember = await member('Someone Else', 'self', other, (p) => `/v1/workspaces/${otherWs}${p}`);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('holders (ACC-15)', () => {
  it('starts with none, beside the default member', async () => {
    const a = await account(joint);
    expect(a).toMatchObject({ holders: [], defaultMemberId: null, fullNumberKept: false });
  });

  it('lists holders in order, a member’s name filling in an empty one', async () => {
    const res = await c.patch(url(`/accounts/${joint}`), {
      defaultMemberId: ada,
      holders: [{ memberId: ada }, { name: 'BENJAMIN LOVELACE', memberId: ben }],
    });
    expect(res.status).toBe(200);
    expect(res.body.holders).toEqual([
      { name: 'Ada Lovelace', memberId: ada },
      { name: 'BENJAMIN LOVELACE', memberId: ben },
    ]);
    // The default member is its own thing and stays as set.
    expect(res.body.defaultMemberId).toBe(ada);
  });

  it('renames in place, adds and removes', async () => {
    const before = await holderRows();
    const renamed = await c.patch(url(`/accounts/${joint}`), {
      holders: [
        { name: 'Ada K. Lovelace', memberId: ada },
        { memberId: ben },
        { name: 'Trust for C. Lovelace' },
      ],
    });
    expect(renamed.body.holders).toEqual([
      { name: 'Ada K. Lovelace', memberId: ada },
      { name: 'Ben Lovelace', memberId: ben },
      { name: 'Trust for C. Lovelace', memberId: null },
    ]);
    const after = await holderRows();
    // A holder that stays in its place keeps its row: the audit log shows a change, not a new holder.
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).toBe(before[1].id);
    const removed = await c.patch(url(`/accounts/${joint}`), { holders: [{ memberId: ben }] });
    expect(removed.body.holders).toEqual([{ name: 'Ben Lovelace', memberId: ben }]);
    expect(await holderRows()).toHaveLength(1);
    // Leaving holders out of a change leaves them as they are.
    await c.patch(url(`/accounts/${joint}`), { institution: 'Credit Union' });
    expect((await account(joint)).holders).toHaveLength(1);
    const cleared = await c.patch(url(`/accounts/${joint}`), { holders: [] });
    expect(cleared.body.holders).toEqual([]);
  });

  it('takes holders when the account is added', async () => {
    const res = await c.post(url('/accounts'), {
      name: 'Savings',
      kind: 'savings',
      entityId: personal,
      holders: [{ memberId: ada }, { memberId: ben }],
    });
    expect(res.status).toBe(201);
    expect(res.body.holders.map((x: any) => x.name)).toEqual(['Ada Lovelace', 'Ben Lovelace']);
  });

  it('lists at most ACCOUNT_MAX_HOLDERS (4 by default)', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `Holder ${i + 1}` }));
    const res = await c.patch(url(`/accounts/${joint}`), { holders: five });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('account.holders_limit');
    expect(res.body.detail ?? res.body.title).toContain('4');
    expect(await holderRows()).toHaveLength(0);
    const four = await c.patch(url(`/accounts/${joint}`), { holders: five.slice(0, 4) });
    expect(four.status).toBe(200);
    expect(four.body.holders).toHaveLength(4);
  });

  it('follows the setting', async () => {
    const h2 = await startHarness({ AI_PROVIDER: 'fake', ACCOUNT_MAX_HOLDERS: '2' });
    try {
      const res = await h2.as(EMAIL).patch(url(`/accounts/${joint}`), {
        holders: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('account.holders_limit');
    } finally {
      await h2.close();
    }
  });

  it('needs a name or a member', async () => {
    const res = await c.patch(url(`/accounts/${joint}`), { holders: [{ name: '  ' }] });
    expect(res.status).toBe(400);
  });

  it('refuses a family member from another workspace', async () => {
    const res = await c.patch(url(`/accounts/${joint}`), { holders: [{ memberId: strangerMember }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('account.holder_member');
    expect(JSON.stringify(res.body)).not.toContain('Someone Else');
    // The database refuses it too, whatever the API does.
    await expect(
      admin.query(
        `insert into app.account_holder (workspace_id, ledger_account_id, position, name, member_id)
         values ($1, $2, 9, 'x', $3)`,
        [wsId, joint, strangerMember],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('goes with the account when it is deleted', async () => {
    const temp = (await c.post(url('/accounts'), { name: 'Mistake', kind: 'checking', entityId: personal }))
      .body.id;
    await c.patch(url(`/accounts/${temp}`), { holders: [{ memberId: ada }] });
    expect((await c.delete(url(`/accounts/${temp}`))).status).toBe(200);
    expect(await holderRows(temp)).toEqual([]);
  });
});

describe('who sees and changes holders (RLS)', () => {
  beforeAll(async () => {
    await c.patch(url(`/accounts/${bizAccount}`), { holders: [{ name: 'Studio LLC' }] });
    await c.patch(url(`/accounts/${joint}`), { holders: [{ memberId: ada }, { memberId: ben }] });
  });

  const asUser = async (email: string, workspaceId: string, fn: (trx: any) => Promise<unknown>) => {
    const { rows } = await admin.query(`select id from app.app_user where email = $1`, [email]);
    return h.app.get(Db).run({ workspaceId, userId: rows[0].id }, fn);
  };

  it('shows another workspace none of them', async () => {
    const seen = await asUser(OTHER, otherWs, (trx) =>
      trx.selectFrom('app.account_holder').select('name').execute(),
    );
    expect(seen).toEqual([]);
  });

  it('shows a partner only the books they can read, and lets them change those', async () => {
    const seen = (await asUser(PARTNER, wsId, (trx) =>
      trx.selectFrom('app.account_holder').select(['ledger_account_id', 'name']).execute(),
    )) as { ledger_account_id: string }[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((r) => r.ledger_account_id === bizAccount)).toBe(false);
    expect((await account(bizAccount, partner)) ?? null).toBeNull();
    const deleted = await asUser(PARTNER, wsId, (trx) =>
      trx.deleteFrom('app.account_holder').where('ledger_account_id', '=', bizAccount).executeTakeFirst(),
    );
    expect(Number((deleted as any).numDeletedRows)).toBe(0);
    expect(await holderRows(bizAccount)).toHaveLength(1);
    const res = await partner.patch(url(`/accounts/${joint}`), {
      holders: [{ memberId: ben }, { memberId: ada }],
    });
    expect(res.status).toBe(200);
    expect(res.body.holders.map((x: any) => x.memberId)).toEqual([ben, ada]);
  });

  it('tells phones the account changed', async () => {
    const { rows } = await admin.query(
      `select op from app.change_log where workspace_id = $1 and table_name = 'account_holder'`,
      [wsId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('the full number (ACC-16)', () => {
  it('is kept sealed, with its last four in the clear', async () => {
    const res = await c.patch(url(`/accounts/${joint}`), { accountNumber: FULL });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      last4: '4321',
      accountNumberMasked: '••••4321',
      fullNumberKept: true,
    });
    const row = await stored();
    expect(row.last4).toBe('4321');
    expect(Buffer.isBuffer(row.account_number_enc)).toBe(true);
    expect(row.account_number_enc.includes(Buffer.from(DIGITS))).toBe(false);
  });

  it('is typed in by owners and admins only', async () => {
    const res = await partner.patch(url(`/accounts/${joint}`), { accountNumber: '99998888' });
    expect(res.status).toBe(403);
    expect((await stored()).last4).toBe('4321');
    // A partner can still change everything else.
    expect((await partner.patch(url(`/accounts/${joint}`), { institution: 'Credit Union' })).status).toBe(
      200,
    );
  });

  it('keeps its last four with it', async () => {
    const mismatch = await c.patch(url(`/accounts/${joint}`), { last4: '1111' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('account.number_last4');
    expect((await c.patch(url(`/accounts/${joint}`), { last4: '4321' })).status).toBe(200);
    const both = await c.patch(url(`/accounts/${joint}`), { accountNumber: '55554444', last4: '1111' });
    expect(both.status).toBe(422);
  });

  it('refuses a number that isn’t one, without repeating it', async () => {
    const res = await c.patch(url(`/accounts/${joint}`), { accountNumber: 'ABC-SECRET-12' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });

  it('is shown in full after a recent sign-in, each time logged', async () => {
    const count = async () =>
      Number(
        (
          await admin.query(
            `select count(*) from app.audit_log where workspace_id = $1 and action = 'account.number_revealed'`,
            [wsId],
          )
        ).rows[0].count,
      );
    const before = await count();
    const refused = await stale(() => reveal());
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('reauth.required');
    expect(JSON.stringify(refused.body)).not.toContain(DIGITS);
    expect(await count()).toBe(before);

    const shown = await reveal();
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ value: DIGITS });
    await reveal();
    expect(await count()).toBe(before + 2);
    const { rows } = await admin.query(
      `select actor_user_id is not null as by_someone, subject_type, subject_id from app.audit_log
        where workspace_id = $1 and action = 'account.number_revealed'`,
      [wsId],
    );
    expect(
      rows.every((r) => r.by_someone && r.subject_type === 'bank_account' && r.subject_id === joint),
    ).toBe(true);
  });

  it('is shown to owners and admins only', async () => {
    const res = await reveal(joint, partner);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(DIGITS);
    const none = await reveal(bizAccount);
    expect(none.body).toEqual({ value: null });
  });

  it('never appears in a read, an error, a sync pull or the audit log', async () => {
    const reads = JSON.stringify([
      (await c.get(url('/accounts?include=all'))).body,
      (await c.get(url('/sync/pull?since=0'))).body,
    ]);
    const text = reads + (await auditText());
    expect(text).toContain('4321');
    expect(text).not.toContain(DIGITS);
    expect(text).not.toContain(FULL);
    // The audit entry for the change says it changed, as "[redacted]".
    const { rows } = await admin.query(
      `select diff from app.audit_log where workspace_id = $1 and action = 'bank_account.update'
          and diff ? 'account_number_enc'`,
      [wsId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.diff.account_number_enc === '[redacted]')).toBe(true);
  });

  it('can be removed, leaving the last four', async () => {
    const res = await c.patch(url(`/accounts/${joint}`), { accountNumber: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ last4: '4321', accountNumberMasked: '••••4321', fullNumberKept: false });
    expect((await stored()).account_number_enc).toBeNull();
    expect((await reveal()).body).toEqual({ value: null });
    // Without a full number, the last four are the person's to change again.
    expect((await c.patch(url(`/accounts/${joint}`), { last4: '1111' })).status).toBe(200);
  });
});
