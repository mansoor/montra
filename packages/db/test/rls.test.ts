import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
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
        .values({
          workspace_id: a.workspaceId,
          user_id: accountantId,
          entity_id: a.businessId,
          access: 'read',
        })
        .execute(),
    );
    const acct = await visible(a.workspaceId, accountantId);
    expect(acct.entities).toEqual(['business']);
    expect(acct.postings).toHaveLength(2);
    await expect(
      withContext(db, { workspaceId: a.workspaceId, userId: accountantId }, (trx) =>
        trx
          .updateTable('app.posting')
          .set({ memo: 'x' })
          .where('entity_id', '=', a.businessId)
          .executeTakeFirstOrThrow(),
      ),
    ).resolves.toMatchObject({ numUpdatedRows: 0n });
  });
});

describe('cached access checks (performance migration 0009)', () => {
  it('sees a grant made earlier in the same transaction', async () => {
    const viewerId = await addMember(db, a, 'viewer-cache@example.com', 'viewer');
    // Owner grants inside one transaction while also reading as the owner: the cache is per user, so check
    // the viewer in a transaction that first reads (caching 'none') and then sees a grant applied.
    await withContext(db, { workspaceId: a.workspaceId, userId: viewerId }, async (trx) => {
      expect(
        await trx.selectFrom('app.entity').select('type').where('type', '=', 'business').execute(),
      ).toEqual([]);
      await trx.executeQuery(sql`select set_config('app.user_id', ${a.ownerId}, true)`.compile(trx));
      await trx
        .insertInto('app.entity_grant')
        .values({ workspace_id: a.workspaceId, user_id: viewerId, entity_id: a.businessId, access: 'read' })
        .execute();
      await trx.executeQuery(sql`select set_config('app.user_id', ${viewerId}, true)`.compile(trx));
      expect(
        await trx.selectFrom('app.entity').select('type').where('type', '=', 'business').execute(),
      ).toEqual([{ type: 'business' }]);
    });
  });
});

describe('restricted payslip entries (PAY-09)', () => {
  it('hides restricted entries from partners but not from owners or the linked member', async () => {
    const memberId = newId();
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, async (trx) => {
      await trx
        .insertInto('app.family_member')
        .values({
          workspace_id: a.workspaceId,
          id: memberId,
          name: 'Sam',
          relationship: 'spouse_partner',
          linked_user_id: null,
        })
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
      trx
        .updateTable('app.family_member')
        .set({ linked_user_id: partnerId })
        .where('id', '=', memberId)
        .execute(),
    );
    expect((await visible(a.workspaceId, partnerId)).postings.some((p) => p.amount_minor === 341250n)).toBe(
      true,
    );
  });

  it('shows a partner the net pay line of a restricted entry and nothing else (ADR-0016)', async () => {
    const memberId = newId();
    const employerId = newId();
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, async (trx) => {
      await trx
        .insertInto('app.family_member')
        .values({
          workspace_id: a.workspaceId,
          id: memberId,
          name: 'Robin',
          relationship: 'spouse_partner',
          linked_user_id: null,
        })
        .execute();
      await trx
        .insertInto('app.employer')
        .values({
          workspace_id: a.workspaceId,
          id: employerId,
          member_id: memberId,
          entity_id: a.personalId,
          name: 'Private Corp',
          deposit_account_id: a.accounts.checking,
        })
        .execute();
      await postEntry(
        trx,
        a,
        a.personalId,
        '2026-10-20',
        [
          { account: a.accounts.checking, amount: 70100n, memberId, publicLine: true },
          { account: a.accounts.groceries, amount: 29900n, memberId },
          { account: a.accounts.salary, amount: -100000n, memberId },
        ],
        { restricted: true, restrictedMemberId: memberId },
      );
    });
    const partner = await visible(a.workspaceId, partnerId);
    expect(partner.postings.some((p) => p.amount_minor === 70100n)).toBe(true);
    expect(partner.postings.some((p) => p.amount_minor === 29900n)).toBe(false);
    expect(partner.postings.some((p) => p.amount_minor === -100000n)).toBe(false);
    const owner = await visible(a.workspaceId, a.ownerId);
    expect(owner.postings.filter((p) => [70100n, 29900n, -100000n].includes(p.amount_minor))).toHaveLength(3);

    const employers = (userId: string) =>
      withContext(db, { workspaceId: a.workspaceId, userId }, (trx) =>
        trx.selectFrom('app.employer').select('id').where('id', '=', employerId).execute(),
      );
    expect(await employers(a.ownerId)).toHaveLength(1);
    expect(await employers(partnerId)).toHaveLength(0);
  });
});

describe('business records (ADR-0017)', () => {
  it('keep invoices, their lines and customers to those with a grant on the business', async () => {
    const partyId = newId();
    const invoiceId = newId();
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, async (trx) => {
      await trx
        .insertInto('app.business_party')
        .values({
          workspace_id: a.workspaceId,
          id: partyId,
          entity_id: a.businessId,
          kind: 'customer',
          name: 'Private customer',
          email: 'private@example.com',
        })
        .execute();
      await trx
        .insertInto('app.invoice')
        .values({
          workspace_id: a.workspaceId,
          id: invoiceId,
          entity_id: a.businessId,
          party_id: partyId,
          number: 'INV-0001',
          issue_date: '2026-10-01',
          due_date: '2026-10-31',
          currency: 'USD',
        })
        .execute();
      await trx
        .insertInto('app.invoice_line')
        .values({
          workspace_id: a.workspaceId,
          id: newId(),
          invoice_id: invoiceId,
          line_no: 1,
          description: 'Secret project',
          quantity_milli: 1000n,
          unit_price_minor: 100n,
          amount_minor: 100n,
          tax_minor: 0n,
          income_account_id: a.accounts.office,
        })
        .execute();
    });
    const seen = (userId: string) =>
      withContext(db, { workspaceId: a.workspaceId, userId }, async (trx) => ({
        parties: await trx.selectFrom('app.business_party').select('id').where('id', '=', partyId).execute(),
        invoices: await trx.selectFrom('app.invoice').select('id').where('id', '=', invoiceId).execute(),
        lines: await trx
          .selectFrom('app.invoice_line')
          .select('id')
          .where('invoice_id', '=', invoiceId)
          .execute(),
      }));
    const owner = await seen(a.ownerId);
    expect([owner.parties.length, owner.invoices.length, owner.lines.length]).toEqual([1, 1, 1]);
    const partner = await seen(partnerId);
    expect([partner.parties.length, partner.invoices.length, partner.lines.length]).toEqual([0, 0, 0]);
    // Nor can they write one in.
    await expect(
      withContext(db, { workspaceId: a.workspaceId, userId: partnerId }, (trx) =>
        trx
          .insertInto('app.business_party')
          .values({ workspace_id: a.workspaceId, entity_id: a.businessId, kind: 'vendor', name: 'Nope' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('rental records (ADR-0018)', () => {
  it('keep properties, leases and what hangs off them to those with a grant on the portfolio', async () => {
    const entityId = newId();
    const propertyId = newId();
    const unitId = newId();
    const tenantId = newId();
    const leaseId = newId();
    await withContext(db, { workspaceId: a.workspaceId, userId: a.ownerId }, async (trx) => {
      await trx
        .insertInto('app.entity')
        .values({
          workspace_id: a.workspaceId,
          id: entityId,
          type: 'rental',
          name: 'Private portfolio',
          functional_currency: 'USD',
        })
        .execute();
      await trx
        .insertInto('app.property')
        .values({
          workspace_id: a.workspaceId,
          id: propertyId,
          entity_id: entityId,
          name: 'Private house',
          type: 'sfh',
          created_by: a.ownerId,
        })
        .execute();
      await trx
        .insertInto('app.unit')
        .values({
          workspace_id: a.workspaceId,
          id: unitId,
          entity_id: entityId,
          property_id: propertyId,
          label: 'Main',
        })
        .execute();
      await trx
        .insertInto('app.tenant')
        .values({ workspace_id: a.workspaceId, id: tenantId, entity_id: entityId, name: 'Private tenant' })
        .execute();
      await trx
        .insertInto('app.lease')
        .values({
          workspace_id: a.workspaceId,
          id: leaseId,
          entity_id: entityId,
          property_id: propertyId,
          unit_id: unitId,
          start_date: '2026-01-01',
          rent_minor: 100000n,
          created_by: a.ownerId,
        })
        .execute();
      await trx
        .insertInto('app.lease_tenant')
        .values({ workspace_id: a.workspaceId, lease_id: leaseId, tenant_id: tenantId })
        .execute();
      await trx
        .insertInto('app.rent_charge')
        .values({
          workspace_id: a.workspaceId,
          id: newId(),
          entity_id: entityId,
          lease_id: leaseId,
          kind: 'rent',
          period_start: '2026-01-01',
          due_date: '2026-01-01',
          amount_minor: 100000n,
        })
        .execute();
    });
    const read = (ctx: { workspaceId: string; userId: string }) =>
      withContext(db, ctx, async (trx) => ({
        properties: await trx.selectFrom('app.property').select('id').where('id', '=', propertyId).execute(),
        units: await trx.selectFrom('app.unit').select('id').where('id', '=', unitId).execute(),
        tenants: await trx.selectFrom('app.tenant').select('id').where('id', '=', tenantId).execute(),
        leases: await trx.selectFrom('app.lease').select('id').where('id', '=', leaseId).execute(),
        charges: await trx
          .selectFrom('app.rent_charge')
          .select('id')
          .where('lease_id', '=', leaseId)
          .execute(),
      }));
    const counts = (r: Awaited<ReturnType<typeof read>>) => Object.values(r).map((x) => x.length);
    expect(counts(await read({ workspaceId: a.workspaceId, userId: a.ownerId }))).toEqual([1, 1, 1, 1, 1]);
    expect(counts(await read({ workspaceId: a.workspaceId, userId: partnerId }))).toEqual([0, 0, 0, 0, 0]);
    expect(counts(await read({ workspaceId: b.workspaceId, userId: b.ownerId }))).toEqual([0, 0, 0, 0, 0]);
    // A partner without the grant can't write there either.
    await expect(
      withContext(db, { workspaceId: a.workspaceId, userId: partnerId }, (trx) =>
        trx
          .insertInto('app.tenant')
          .values({ workspace_id: a.workspaceId, id: newId(), entity_id: entityId, name: 'Injected' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
