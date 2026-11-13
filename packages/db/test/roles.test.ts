import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { newId, withContext, type Database } from '../src/index.js';
import { addMember, appDb, createUser, createWorkspace, postEntry, type Fixture } from './fixtures.js';

// Admin and member roles, and linking a login to a family member (AUTH-14..17; ADR-0041).
let db: Kysely<Database>;
let a: Fixture;
let adminId: string;
let partnerId: string;
let memberId: string;

const as = <T>(userId: string, fn: Parameters<typeof withContext<T>>[2]) =>
  withContext(db, { workspaceId: a.workspaceId, userId }, fn);
const entityTypes = (userId: string) =>
  as(userId, async (trx) =>
    (await trx.selectFrom('app.entity').select('type').execute()).map((r) => r.type).sort(),
  );
const roleOf = (userId: string) =>
  as(
    a.ownerId,
    async (trx) =>
      (
        await trx
          .selectFrom('app.workspace_member')
          .select('role')
          .where('workspace_id', '=', a.workspaceId)
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow()
      ).role,
  );
const person = (userId: string, name: string, linked: string | null = null) =>
  as(userId, async (trx) => {
    const id = newId();
    await trx
      .insertInto('app.family_member')
      .values({ workspace_id: a.workspaceId, id, name, relationship: 'child', linked_user_id: linked })
      .execute();
    return id;
  });

beforeAll(async () => {
  db = appDb();
  a = await createWorkspace(db, 'roles-owner@example.com');
  adminId = await addMember(db, a, 'roles-admin@example.com', 'admin');
  partnerId = await addMember(db, a, 'roles-partner@example.com', 'partner');
  memberId = await addMember(db, a, 'roles-member@example.com', 'member');
});
afterAll(() => db.destroy());

describe('admins (AUTH-14)', () => {
  it('read and write every book, as the owner does', async () => {
    expect(await entityTypes(adminId)).toEqual(['business', 'personal']);
    await as(adminId, (trx) =>
      postEntry(trx, a, a.businessId, '2026-10-02', [
        { account: a.accounts.office, amount: 500n },
        { account: a.accounts.bizChecking, amount: -500n },
      ]),
    );
  });

  it('change the workspace and other members, but never the owner', async () => {
    await as(adminId, (trx) =>
      trx.updateTable('app.workspace').set({ name: 'Renamed by admin' }).executeTakeFirstOrThrow(),
    );
    await as(adminId, (trx) =>
      trx
        .updateTable('app.workspace_member')
        .set({ role: 'viewer' })
        .where('user_id', '=', partnerId)
        .execute(),
    );
    expect(await roleOf(partnerId)).toBe('viewer');
    const demote = await as(adminId, (trx) =>
      trx
        .updateTable('app.workspace_member')
        .set({ role: 'viewer' })
        .where('user_id', '=', a.ownerId)
        .executeTakeFirst(),
    );
    expect(demote.numUpdatedRows).toBe(0n);
    const remove = await as(adminId, (trx) =>
      trx.deleteFrom('app.workspace_member').where('user_id', '=', a.ownerId).executeTakeFirst(),
    );
    expect(remove.numDeletedRows).toBe(0n);
    await expect(
      as(adminId, (trx) =>
        trx
          .updateTable('app.workspace_member')
          .set({ role: 'owner' })
          .where('user_id', '=', adminId)
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await roleOf(a.ownerId)).toBe('owner');
  });

  it('can be made owner by the owner', async () => {
    const second = await addMember(db, a, 'roles-admin-2@example.com', 'admin');
    await as(a.ownerId, (trx) =>
      trx
        .updateTable('app.workspace_member')
        .set({ role: 'owner' })
        .where('user_id', '=', second)
        .executeTakeFirstOrThrow(),
    );
    expect(await roleOf(second)).toBe('owner');
    // Put it back, so the rest of the file has one owner.
    await as(a.ownerId, (trx) =>
      trx.updateTable('app.workspace_member').set({ role: 'admin' }).where('user_id', '=', second).execute(),
    );
  });

  it('see restricted lines, as the owner does (PAY-09)', async () => {
    const restricted = await as(adminId, async (trx) => {
      const { rows } = await sql<{
        ok: boolean;
      }>`select app.can_read_restricted(${newId()}::uuid) as ok`.execute(trx);
      return rows[0]!.ok;
    });
    expect(restricted).toBe(true);
  });
});

describe('members (AUTH-17)', () => {
  it('write the personal books by default, and nothing else', async () => {
    expect(await entityTypes(memberId)).toEqual(['personal']);
    await as(memberId, async (trx) => {
      await postEntry(trx, a, a.personalId, '2026-10-03', [
        { account: a.accounts.groceries, amount: 300n },
        { account: a.accounts.checking, amount: -300n },
      ]);
      await trx
        .insertInto('app.tag')
        .values({ workspace_id: a.workspaceId, id: newId(), name: 'school' })
        .execute();
    });
    await expect(
      as(memberId, (trx) =>
        postEntry(trx, a, a.businessId, '2026-10-03', [
          { account: a.accounts.office, amount: 1n },
          { account: a.accounts.bizChecking, amount: -1n },
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot change setup: family members, rules or the workspace', async () => {
    await expect(person(memberId, 'Sneaky')).rejects.toThrow(/row-level security/);
    await expect(
      as(memberId, (trx) =>
        trx
          .insertInto('app.rule')
          .values({
            workspace_id: a.workspaceId,
            id: newId(),
            name: 'x',
            conditions: JSON.stringify({ all: [] }),
            actions: JSON.stringify({}),
          } as never)
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    const renamed = await as(memberId, (trx) =>
      trx.updateTable('app.workspace').set({ name: 'Nope' }).executeTakeFirst(),
    );
    expect(renamed.numUpdatedRows).toBe(0n);
  });
});

describe('linking a login to a family member (AUTH-16)', () => {
  it('is for owners and admins only', async () => {
    const kid = await person(a.ownerId, 'Kid');
    // The first partner was made a viewer above, so this one is fresh.
    const partner2 = await addMember(db, a, 'roles-partner-2@example.com', 'partner');
    await expect(
      as(partner2, (trx) =>
        trx
          .updateTable('app.family_member')
          .set({ linked_user_id: partner2 })
          .where('id', '=', kid)
          .execute(),
      ),
    ).rejects.toThrow(/only an owner or admin/);
    await expect(person(partner2, 'Linked', partner2)).rejects.toThrow(/only an owner or admin/);
    // Renaming without touching the link is fine.
    await as(partner2, (trx) =>
      trx.updateTable('app.family_member').set({ name: 'Kiddo' }).where('id', '=', kid).execute(),
    );
    await as(adminId, (trx) =>
      trx.updateTable('app.family_member').set({ linked_user_id: memberId }).where('id', '=', kid).execute(),
    );
  });

  it('lets a linked login read their own restricted lines and nobody else’s', async () => {
    const [mine, theirs] = await as(a.ownerId, async (trx) => {
      const rows = await trx
        .selectFrom('app.family_member')
        .select(['id', 'linked_user_id'])
        .where('name', '=', 'Kiddo')
        .execute();
      return [rows[0]!.id, newId()];
    });
    const check = (id: string) =>
      as(memberId, async (trx) => {
        const { rows } = await sql<{
          ok: boolean;
        }>`select app.can_read_restricted(${id}::uuid) as ok`.execute(trx);
        return rows[0]!.ok;
      });
    expect(await check(mine!)).toBe(true);
    expect(await check(theirs!)).toBe(false);
  });

  it('allows one person per login in a workspace', async () => {
    await expect(person(a.ownerId, 'Twin', memberId)).rejects.toThrow(/family_member_one_login/);
  });

  it('happens when the invite for that person is accepted', async () => {
    const spouse = await person(a.ownerId, 'Spouse');
    const invitee = await createUser(db, 'roles-spouse@example.com');
    const hash = `hash-${newId()}`;
    await as(adminId, (trx) =>
      trx
        .insertInto('app.workspace_invite')
        .values({
          workspace_id: a.workspaceId,
          id: newId(),
          email: 'roles-spouse@example.com',
          role: 'partner',
          entity_grants: JSON.stringify([]),
          token_hash: hash,
          invited_by: adminId,
          family_member_id: spouse,
        })
        .execute(),
    );
    await withContext(db, { userId: invitee }, (trx) => sql`select app.accept_invite(${hash})`.execute(trx));
    expect(await roleOf(invitee)).toBe('partner');
    const linked = await as(invitee, (trx) =>
      trx
        .selectFrom('app.family_member')
        .select('linked_user_id')
        .where('id', '=', spouse)
        .executeTakeFirstOrThrow(),
    );
    expect(linked.linked_user_id).toBe(invitee);
  });

  it('never demotes the owner, whatever an invite says', async () => {
    const hash = `hash-${newId()}`;
    await as(adminId, (trx) =>
      trx
        .insertInto('app.workspace_invite')
        .values({
          workspace_id: a.workspaceId,
          id: newId(),
          email: 'roles-owner@example.com',
          role: 'viewer',
          entity_grants: JSON.stringify([]),
          token_hash: hash,
          invited_by: adminId,
        })
        .execute(),
    );
    await withContext(db, { userId: a.ownerId }, (trx) =>
      sql`select app.accept_invite(${hash})`.execute(trx),
    );
    expect(await roleOf(a.ownerId)).toBe('owner');
  });
});
