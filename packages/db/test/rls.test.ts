import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { newId, withContext, type Database } from '../src/index.js';
import { addMember, appDb, createWorkspace, postEntry, type Fixture } from './fixtures.js';

let db: Kysely<Database>;
let a: Fixture;
let b: Fixture;
let partnerId: string;
let accountantId: string;

beforeAll(async () => {
  db = appDb();
  a = await createWorkspace(db, 'alice@example.com');
  b = await createWorkspace(db, 'bob@example.com');
  partnerId = await addMember(db, a, 'pat@example.com', 'partner');
  accountantId = await addMember(db, a, 'acct@example.com', 'accountant');
  await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, async (trx) => {
    await postEntry(trx, a, a.personalId, '2026-10-01', [
      { account: a.accounts.groceries, amount: 4200n },
      { account: a.accounts.checking, amount: -4200n },
    ]);
    await postEntry(trx, a, a.businessId, '2026-10-01', [
      { account: a.accounts.office, amount: 9900n },
      { account: a.accounts.bizChecking, amount: -9900n },
    ]);
  });
});
afterAll(() => db.destroy());

const visible = (workspaceId: string, userId: string) =>
  withContext(db, { workspaceId, userId }, async (trx) => ({
    workspaces: await trx.selectFrom('app.workspace').select('id').execute(),
    entities: (await trx.selectFrom('app.entity').select('type').execute()).map((r) => r.type).sort(),
    postings: await trx.selectFrom('app.posting').select(['amount_minor', 'entity_id']).execute(),
    transactions: await trx.selectFrom('app.transaction').select('id').execute(),
    payees: await trx.selectFrom('app.payee').select('id').execute(),
  }));

describe('tenant isolation (NFR-03, design 03 §11)', () => {
  it('shows a member only their workspace', async () => {
    const own = await visible(a.workspaceId, a.ownerId);
    expect(own.workspaces).toHaveLength(1);
    expect(own.postings).toHaveLength(4);
  });

  it('shows nothing when a non-member sets the context to another workspace', async () => {
    const intruder = await visible(a.workspaceId, b.ownerId);
    // Bob still lists his own workspace (for the workspace switcher), never Alice's.
    expect(intruder.workspaces.map((w) => w.id)).toEqual([b.workspaceId]);
    expect(intruder.entities).toEqual([]);
    expect(intruder.postings).toEqual([]);
    expect(intruder.transactions).toEqual([]);
  });

  it('shows nothing without a context', async () => {
    const none = await withContext(db, {}, (trx) => trx.selectFrom('app.posting').select('id').execute());
    expect(none).toEqual([]);
  });

  it('prevents writing rows into another workspace', async () => {
    await expect(
      withContext(db, { workspaceId: b.workspaceId, userId: b.ownerId }, (trx) =>
        trx
          .insertInto('app.tag')
          .values({ workspace_id: a.workspaceId, id: newId(), name: 'sneaky' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('entity access (UP-04, BIZ-13)', () => {
  it('gives a partner personal books only by default', async () => {
    const p = await visible(a.workspaceId, partnerId);
    expect(p.entities).toEqual(['personal']);
    expect(p.postings.every((r) => r.entity_id === a.personalId)).toBe(true);
    expect(p.postings).toHaveLength(2);
  });

  it('blocks a partner from writing business entries', async () => {
    await expect(
      withContext(db, { workspaceId: a.workspaceId, userId: partnerId }, (trx) =>
        postEntry(trx, a, a.businessId, '2026-10-05', [
          { account: a.accounts.office, amount: 1n },
          { account: a.accounts.bizChecking, amount: -1n },
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('lets the owner grant an accountant read access to the business only', async () => {
    expect((await visible(a.workspaceId, accountantId)).entities).toEqual([]);
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, (trx) =>
      trx
        .insertInto('app.entity_grant')
        .values({ workspace_id: a.workspaceId, user_id: accountantId, entity_id: a.businessId, access: 'read' })
        .execute(),
    );
    const acct = await visible(a.workspaceId, accountantId);
    expect(acct.entities).toEqual(['business']);
    expect(acct.postings).toHaveLength(2);
    await expect(
      withContext(db, { workspaceId: a.workspaceId, userId: accountantId }, (trx) =>
        trx.updateTable('app.posting').set({ memo: 'x' }).where('entity_id', '=', a.businessId).executeTakeFirstOrThrow(),
      ),
    ).resolves.toMatchObject({ numUpdatedRows: 0n });
  });
});

describe('restricted payslip entries (PAY-09)', () => {
  it('hides restricted entries from partners but not from owners or the linked member', async () => {
    const memberId = newId();
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, async (trx) => {
      await trx
        .insertInto('app.family_member')
        .values({ workspace_id: a.workspaceId, id: memberId, name: 'Sam', relationship: 'spouse_partner', linked_user_id: null })
        .execute();
      await postEntry(
        trx,
        a,
        a.personalId,
        '2026-10-15',
        [
          { account: a.accounts.checking, amount: 341250n, memberId },
          { account: a.accounts.salary, amount: -341250n, memberId },
        ],
        { restricted: true, restrictedMemberId: memberId },
      );
    });
    const ownerView = await visible(a.workspaceId, a.ownerId);
    const partnerView = await visible(a.workspaceId, partnerId);
    expect(ownerView.postings.some((p) => p.amount_minor === 341250n)).toBe(true);
    expect(partnerView.postings.some((p) => p.amount_minor === 341250n)).toBe(false);

    // Linking the member to the partner's login makes their own payslip visible to them.
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, (trx) =>
      trx.updateTable('app.family_member').set({ linked_user_id: partnerId }).where('id', '=', memberId).execute(),
    );
    expect((await visible(a.workspaceId, partnerId)).postings.some((p) => p.amount_minor === 341250n)).toBe(true);
  });
});
