/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OwnershipService } from '../src/data/ownership.service.js';
import { Db } from '../src/db/database.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// A legal hold keeps a closing account and its workspaces (NFR-06, BAK-09, ADR-0049 §4; migration 0080). The hourly
// retention job leaves them in place while the hold lasts, logs it once, and the staff console shows it. Once the hold
// is lifted, the next run purges as before.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let admin: pg.Client;
let h: Harness;
let staff: Client;
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

const retention = () => h.app.get(OwnershipService).retention();
const userId = async (email: string) =>
  (await admin.query(`select id from app.app_user where email = $1`, [email])).rows[0].id as string;
const workspaceRow = async (id: string) =>
  (await admin.query(`select purge_held_at from app.workspace where id = $1`, [id])).rows[0];
const userRow = async (id: string) =>
  (await admin.query(`select email, purge_after, purge_held_at from app.app_user where id = $1`, [id]))
    .rows[0];
const said = (spy: ReturnType<typeof vi.spyOn>, id: string) =>
  spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(id)).map((c: unknown[]) => String(c[0]));

/** Signs up, makes a workspace they alone own, and closes the account; its 30 days are then over. */
async function closing(email: string) {
  const c = h.as(email);
  const ws = (await c.post('/v1/workspaces', { name: 'Closing', baseCurrency: 'USD', template: 'household' }))
    .body.id as string;
  const id = await userId(email);
  return { c, ws, id };
}
async function overdue(id: string, ws: string) {
  await admin.query(`update app.app_user set purge_after = now() - interval '1 hour' where id = $1`, [id]);
  await admin.query(`update app.workspace set purge_after = now() - interval '1 hour' where id = $1`, [ws]);
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  h = await startHarness({});
  staff = h.as('hold-staff@example.test');
  await staff.get('/v1/me');
  await admin.query(`insert into app.staff_user (user_id, role) values ($1, 'admin')`, [
    await userId('hold-staff@example.test'),
  ]);
  // Whatever earlier test files left due is purged now, so the runs below see only this file's rows.
  await retention();
  const logger = (h.app.get(OwnershipService) as any).logger;
  warn = vi.spyOn(logger, 'warn');
  log = vi.spyOn(logger, 'log');
});
afterAll(async () => {
  warn.mockRestore();
  log.mockRestore();
  await h.close();
  await admin.end();
});

describe('a closing account under a legal hold', () => {
  const EMAIL = 'hold-leaving@example.test';
  let person: { c: Client; ws: string; id: string };

  beforeAll(async () => {
    person = await closing(EMAIL);
    expect((await person.c.post('/v1/me/deletion', { confirm: 'DELETE' })).status).toBe(200);
    const held = await staff.post(`/v1/admin/accounts/${person.id}/suspend`, {
      kind: 'legal_hold',
      reason: 'Court order 77',
    });
    expect(held.status).toBeLessThan(300);
    await overdue(person.id, person.ws);
  });

  it('isn’t purged while the hold lasts: the account and its workspace stay as they are', async () => {
    await retention();
    expect((await userRow(person.id)).email).toBe(EMAIL);
    expect((await admin.query(`select 1 from app.workspace where id = $1`, [person.ws])).rowCount).toBe(1);
    expect(
      (await admin.query(`select kind from app.account_suspension where user_id = $1`, [person.id])).rows,
    ).toEqual([{ kind: 'legal_hold' }]);

    // Nor can anything else purge them meanwhile.
    const db = h.app.get(Db);
    await expect(
      db.run({}, (trx) => sql`select app.purge_user(${person.id}::uuid)`.execute(trx)),
    ).rejects.toThrow(/legal hold/);
    await expect(
      db.run({}, (trx) => sql`select app.purge_workspace(${person.ws}::uuid)`.execute(trx)),
    ).rejects.toThrow(/legal hold/);
  });

  it('logs that it was held back, once', async () => {
    expect((await userRow(person.id)).purge_held_at).not.toBeNull();
    expect((await workspaceRow(person.ws)).purge_held_at).not.toBeNull();
    expect(said(warn, person.id)).toEqual([expect.stringContaining('Held back by a legal hold')]);
    expect(said(warn, person.ws)).toEqual([expect.stringContaining('Held back by a legal hold')]);

    await retention();
    expect(said(warn, person.id)).toHaveLength(1);
    expect((await userRow(person.id)).email).toBe(EMAIL);
  });

  it('shows in the staff console beside the hold', async () => {
    const found = (await staff.get(`/v1/admin/accounts?q=hold-leaving`)).body.data;
    expect(found).toEqual([
      expect.objectContaining({
        id: person.id,
        suspension: expect.objectContaining({ kind: 'legal_hold' }),
        purgeHeldSince: expect.any(String),
      }),
    ]);
    const workspaces = (await staff.get(`/v1/admin/accounts/${person.id}/workspaces`)).body.data;
    expect(workspaces).toEqual([
      expect.objectContaining({ id: person.ws, purgeHeldSince: expect.any(String) }),
    ]);
  });

  it('is purged on the next run once the hold is lifted', async () => {
    expect((await staff.post(`/v1/admin/accounts/${person.id}/restore`)).status).toBeLessThan(300);
    const done = await retention();
    expect(done).toMatchObject({ held: 0 });
    expect((await admin.query(`select 1 from app.workspace where id = $1`, [person.ws])).rowCount).toBe(0);
    const user = await userRow(person.id);
    expect(user).toEqual({
      email: `deleted+${person.id}@invalid.example`,
      purge_after: null,
      purge_held_at: null,
    });
    expect(said(log, person.id)).toEqual([expect.stringContaining('No longer held back')]);
  });
});

describe('a closing workspace with another member under a legal hold', () => {
  it('stays until that hold is lifted; the account that closed it goes as due', async () => {
    const owner = await closing('hold-owner@example.test');
    const memberEmail = 'hold-member@example.test';
    const invite = await owner.c.post(`/v1/workspaces/${owner.ws}/sharing/invites`, {
      email: memberEmail,
      role: 'partner',
    });
    expect(invite.status).toBe(201);
    await h.as(memberEmail).post(`/v1/invites/${invite.body.token}/accept`);
    const memberId = await userId(memberEmail);
    expect((await owner.c.post('/v1/me/deletion', { confirm: 'DELETE' })).status).toBe(200);
    await staff.post(`/v1/admin/accounts/${memberId}/suspend`, {
      kind: 'legal_hold',
      reason: 'Court order 78',
    });
    await overdue(owner.id, owner.ws);

    await retention();
    expect((await admin.query(`select 1 from app.workspace where id = $1`, [owner.ws])).rowCount).toBe(1);
    expect((await workspaceRow(owner.ws)).purge_held_at).not.toBeNull();
    expect((await userRow(owner.id)).email).toBe(`deleted+${owner.id}@invalid.example`);
    const shown = (await staff.get(`/v1/admin/accounts/${memberId}/workspaces`)).body.data;
    expect(shown).toEqual([expect.objectContaining({ id: owner.ws, purgeHeldSince: expect.any(String) })]);

    await staff.post(`/v1/admin/accounts/${memberId}/restore`);
    await retention();
    expect((await admin.query(`select 1 from app.workspace where id = $1`, [owner.ws])).rowCount).toBe(0);
  });
});
