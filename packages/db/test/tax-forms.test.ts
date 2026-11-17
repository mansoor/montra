import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { newId, withContext, type Database, type TaxFormKind, type Trx } from '../src/index.js';
import { APP_URL } from './env.js';
import { addMember, appDb, createWorkspace, type Fixture } from './fixtures.js';

// Who sees a tax form (ADR-0052 §8.4, TAX-08): the person it's for, owners and admins, and accountants while the
// owner's setting is on; always bounded by the books.

let db: Kysely<Database>;
let a: Fixture;
let adminId: string;
let partnerId: string;
let memberUserId: string;
let viewerId: string;
let accountantId: string;
/** Family members: Sam (the member login), Alex (the partner's login), Kim (the viewer's login). */
let sam: string;
let alex: string;
let kim: string;
let employerId: string;
let samW2: string;
let alexW2: string;
let bizForm: string;

const as = <T>(userId: string, fn: (trx: Trx) => Promise<T>) =>
  withContext(db, { workspaceId: a.workspaceId, userId }, fn);

const visibleForms = (userId: string) =>
  as(userId, async (trx) =>
    (await trx.selectFrom('app.tax_form').select('id').execute()).map((r) => r.id).sort(),
  );

function form(
  trx: Trx,
  opts: { kind?: TaxFormKind; person: string | null; entityId?: string; createdBy: string },
): Promise<string> {
  const id = newId();
  return trx
    .insertInto('app.tax_form')
    .values({
      workspace_id: a.workspaceId,
      id,
      entity_id: opts.entityId ?? a.personalId,
      tax_year: 2025,
      kind: opts.kind ?? 'w2',
      issuer_name: 'Acme Corp',
      issuer_ein: '123456789',
      person_tin_last4: '6789',
      person_member_id: opts.person,
      boxes: JSON.stringify({ box1: '8512034', box2: '1204500' }),
      source: 'typed',
      created_by: opts.createdBy,
    })
    .execute()
    .then(() => id);
}

const setting = (userId: string, on: boolean) =>
  as(userId, (trx) =>
    trx
      .updateTable('app.workspace')
      .set({ accountant_sees_tax_forms: on })
      .where('id', '=', a.workspaceId)
      .executeTakeFirst(),
  );

const settingNow = () =>
  as(a.ownerId, (trx) =>
    trx
      .selectFrom('app.workspace')
      .select('accountant_sees_tax_forms')
      .where('id', '=', a.workspaceId)
      .executeTakeFirstOrThrow()
      .then((r) => r.accountant_sees_tax_forms),
  );

beforeAll(async () => {
  db = appDb();
  a = await createWorkspace(db, 'tax-owner@example.com');
  adminId = await addMember(db, a, 'tax-admin@example.com', 'admin');
  partnerId = await addMember(db, a, 'tax-partner@example.com', 'partner');
  memberUserId = await addMember(db, a, 'tax-member@example.com', 'member');
  viewerId = await addMember(db, a, 'tax-viewer@example.com', 'viewer');
  accountantId = await addMember(db, a, 'tax-cpa@example.com', 'accountant');
  sam = newId();
  alex = newId();
  kim = newId();
  employerId = newId();
  await as(a.ownerId, async (trx) => {
    await trx
      .insertInto('app.family_member')
      .values([
        {
          workspace_id: a.workspaceId,
          id: sam,
          name: 'Sam',
          relationship: 'child',
          linked_user_id: memberUserId,
        },
        {
          workspace_id: a.workspaceId,
          id: alex,
          name: 'Alex',
          relationship: 'spouse_partner',
          linked_user_id: partnerId,
        },
        {
          workspace_id: a.workspaceId,
          id: kim,
          name: 'Kim',
          relationship: 'parent',
          linked_user_id: viewerId,
        },
      ])
      .execute();
    // The accountant can read the personal books, not the business.
    await trx
      .insertInto('app.entity_grant')
      .values({ workspace_id: a.workspaceId, user_id: accountantId, entity_id: a.personalId, access: 'read' })
      .execute();
    await trx
      .insertInto('app.employer')
      .values({
        workspace_id: a.workspaceId,
        id: employerId,
        entity_id: a.personalId,
        member_id: sam,
        name: 'Acme Corp',
        deposit_account_id: a.accounts.checking,
      })
      .execute();
    samW2 = await form(trx, { person: sam, createdBy: a.ownerId });
    alexW2 = await form(trx, { person: alex, createdBy: a.ownerId });
    bizForm = await form(trx, {
      kind: '1099_int',
      person: null,
      entityId: a.businessId,
      createdBy: a.ownerId,
    });
    await trx
      .insertInto('app.tax_form_target')
      .values({ workspace_id: a.workspaceId, tax_form_id: samW2, employer_id: employerId })
      .execute();
    // Two posted payslips in 2025 and one in 2024, for the totals.
    for (const [date, gross, k401] of [
      ['2025-01-31', 500_000n, 25_000n],
      ['2025-12-31', 520_000n, 26_000n],
      ['2024-12-31', 999_999n, 0n],
    ] as const) {
      const payslipId = newId();
      await trx
        .insertInto('app.payslip')
        .values({
          workspace_id: a.workspaceId,
          id: payslipId,
          entity_id: a.personalId,
          employer_id: employerId,
          member_id: sam,
          status: 'posted',
          pay_date: date,
          currency: 'USD',
          gross_minor: gross,
        })
        .execute();
      await trx
        .insertInto('app.payslip_line')
        .values(
          [
            { line_no: 1, section: 'earning' as const, code: 'salary', amount_minor: gross },
            { line_no: 2, section: 'pre_tax' as const, code: '401k', amount_minor: k401 },
            { line_no: 3, section: 'pre_tax' as const, code: 'hsa', amount_minor: 10_000n },
            { line_no: 4, section: 'employer' as const, code: 'hsa', amount_minor: 5_000n },
            { line_no: 5, section: 'tax' as const, code: 'fed_tax', amount_minor: 60_000n },
            { line_no: 6, section: 'tax' as const, code: 'social_security', amount_minor: 31_000n },
          ].map((l) => ({ ...l, workspace_id: a.workspaceId, payslip_id: payslipId, label: l.code })),
        )
        .execute();
    }
  });
});
afterAll(() => db.destroy());

describe('who sees a tax form (ADR-0052 §8.4)', () => {
  it('shows a member their own W-2 and not another member’s', async () => {
    expect(await visibleForms(memberUserId)).toEqual([samW2]);
    expect(await visibleForms(partnerId)).toEqual([alexW2]);
    // Owners and admins see every form, the business's included.
    expect(await visibleForms(a.ownerId)).toEqual([samW2, alexW2, bizForm].sort());
    expect(await visibleForms(adminId)).toEqual([samW2, alexW2, bizForm].sort());
  });

  it('keeps members’ forms from an accountant until the owner turns the setting on', async () => {
    expect(await settingNow()).toBe(false);
    expect(await visibleForms(accountantId)).toEqual([]);
    await setting(a.ownerId, true);
    try {
      expect(await settingNow()).toBe(true);
      // The personal books' forms, which the accountant can read; not the business's, which they can't.
      expect(await visibleForms(accountantId)).toEqual([samW2, alexW2].sort());
      expect(
        await as(accountantId, (trx) =>
          trx.selectFrom('app.tax_form').select('id').where('id', '=', bizForm).execute(),
        ),
      ).toEqual([]);
      // Targets follow their form.
      expect(
        (
          await as(accountantId, (trx) =>
            trx.selectFrom('app.tax_form_target').select('tax_form_id').execute(),
          )
        ).length,
      ).toBe(1);
    } finally {
      await setting(a.ownerId, false);
    }
    expect(await visibleForms(accountantId)).toEqual([]);
    expect(
      await as(accountantId, (trx) => trx.selectFrom('app.tax_form_target').select('tax_form_id').execute()),
    ).toEqual([]);
  });

  it('shows a form whose person isn’t known to its uploader, owners and admins only', async () => {
    const unmatched = await as(partnerId, (trx) => form(trx, { person: null, createdBy: partnerId }));
    expect(await visibleForms(partnerId)).toContain(unmatched);
    expect(await visibleForms(a.ownerId)).toContain(unmatched);
    expect(await visibleForms(memberUserId)).not.toContain(unmatched);
    // Matched to Sam, the partner who uploaded it no longer sees it; Sam does.
    await as(a.ownerId, (trx) =>
      trx.updateTable('app.tax_form').set({ person_member_id: sam }).where('id', '=', unmatched).execute(),
    );
    expect(await visibleForms(partnerId)).not.toContain(unmatched);
    expect(await visibleForms(memberUserId)).toContain(unmatched);
  });

  it('lets a member write their own forms but not another member’s', async () => {
    const own = await as(memberUserId, (trx) => form(trx, { person: sam, createdBy: memberUserId }));
    expect(await visibleForms(memberUserId)).toContain(own);
    await expect(
      as(memberUserId, (trx) => form(trx, { person: alex, createdBy: memberUserId })),
    ).rejects.toThrow(/row-level security/);
    const changed = await as(memberUserId, (trx) =>
      trx
        .updateTable('app.tax_form')
        .set({ issuer_name: 'Changed' })
        .where('id', '=', alexW2)
        .executeTakeFirst(),
    );
    expect(changed.numUpdatedRows).toBe(0n);
  });

  it('lets a viewer read their own form but write none', async () => {
    const kims = await as(a.ownerId, (trx) =>
      form(trx, { kind: '1099_div', person: kim, createdBy: a.ownerId }),
    );
    expect(await visibleForms(viewerId)).toEqual([kims]);
    await expect(as(viewerId, (trx) => form(trx, { person: kim, createdBy: viewerId }))).rejects.toThrow(
      /row-level security/,
    );
    const changed = await as(viewerId, (trx) =>
      trx
        .updateTable('app.tax_form')
        .set({ issuer_name: 'Changed' })
        .where('id', '=', kims)
        .executeTakeFirst(),
    );
    expect(changed.numUpdatedRows).toBe(0n);
    await expect(
      as(viewerId, (trx) =>
        trx
          .insertInto('app.tax_form_waiver')
          .values({
            workspace_id: a.workspaceId,
            entity_id: a.personalId,
            tax_year: 2025,
            kind: '1099_int',
            account_id: a.accounts.checking,
            person_member_id: kim,
            reason: 'not_issued',
            created_by: viewerId,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('reads waivers by the same rule', async () => {
    await as(a.ownerId, (trx) =>
      trx
        .insertInto('app.tax_form_waiver')
        .values({
          workspace_id: a.workspaceId,
          entity_id: a.personalId,
          tax_year: 2025,
          kind: 'w2',
          employer_id: employerId,
          person_member_id: sam,
          reason: 'combined',
          created_by: a.ownerId,
        })
        .execute(),
    );
    const waivers = (userId: string) =>
      as(userId, (trx) => trx.selectFrom('app.tax_form_waiver').select('kind').execute());
    expect(await waivers(memberUserId)).toHaveLength(1);
    expect(await waivers(partnerId)).toHaveLength(0);
    expect(await waivers(accountantId)).toHaveLength(0);
  });
});

describe('the owner’s setting (ADR-0052 §8.4)', () => {
  it('can’t be changed by an admin, even by a direct update', async () => {
    await expect(setting(adminId, true)).rejects.toThrow(/only the owner/);
    expect(await settingNow()).toBe(false);
    // An admin still updates the rest of the workspace row.
    const renamed = await as(adminId, (trx) =>
      trx
        .updateTable('app.workspace')
        .set({ name: 'Home' })
        .where('id', '=', a.workspaceId)
        .executeTakeFirst(),
    );
    expect(renamed.numUpdatedRows).toBe(1n);
  });

  it('can’t be changed by an accountant or a partner', async () => {
    for (const userId of [accountantId, partnerId, memberUserId]) {
      expect((await setting(userId, true)).numUpdatedRows).toBe(0n);
    }
    expect(await settingNow()).toBe(false);
  });
});

describe('payslip totals for a W-2 (ADR-0052 §8.4)', () => {
  const totals = (userId: string, formId = samW2) =>
    as(userId, async (trx) => {
      const { rows } = await sql<Record<string, bigint | number>>`
        select * from app.tax_form_payslip_totals(${formId}::uuid)`.execute(trx);
      return rows;
    });

  it('sums the year’s posted payslips for the form’s employer and person', async () => {
    const [t] = await totals(a.ownerId);
    expect(t).toMatchObject({
      payslips: 2,
      earnings: 1_020_000n,
      pre_tax: 71_000n,
      pre_tax_401k: 51_000n,
      hsa: 30_000n,
      fed_tax: 120_000n,
      social_security: 62_000n,
      medicare: 0n,
    });
  });

  it('gives an accountant the sums only while the setting is on, and nothing to others', async () => {
    expect(await totals(accountantId)).toEqual([]);
    // The accountant can't read the payslips themselves, setting or not.
    await setting(a.ownerId, true);
    try {
      expect((await totals(accountantId))[0]).toMatchObject({ payslips: 2, earnings: 1_020_000n });
      expect(await as(accountantId, (trx) => trx.selectFrom('app.payslip').select('id').execute())).toEqual(
        [],
      );
    } finally {
      await setting(a.ownerId, false);
    }
    expect(await totals(partnerId)).toEqual([]);
    // Only a W-2 has payslip totals.
    expect(await totals(a.ownerId, bizForm)).toEqual([]);
  });
});

describe('match memory for tax forms (ADR-0052 §4)', () => {
  it('lets a member learn tax issuers and people, but still not statements', async () => {
    const remember = (kind: 'tax_issuer' | 'statement') =>
      as(memberUserId, (trx) =>
        trx
          .insertInto('app.match_memory')
          .values({
            workspace_id: a.workspaceId,
            kind,
            signal: `w2:ein:123456789:${kind}`,
            target_id: employerId,
            confirmations: 1,
          })
          .execute(),
      );
    await expect(remember('tax_issuer')).resolves.toBeDefined();
    await expect(remember('statement')).rejects.toThrow(/row-level security/);
  });
});

describe('staff (ADR-0020)', () => {
  it('can’t reach the tax form tables', async () => {
    for (const role of ['montra_admin', 'montra_support']) {
      const url = new URL(APP_URL);
      url.username = role;
      url.password = role;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        for (const table of ['tax_form', 'tax_form_target', 'tax_form_waiver']) {
          await expect(c.query(`select 1 from app.${table} limit 1`)).rejects.toThrow(/permission denied/);
        }
        await expect(c.query(`select app.tax_form_payslip_totals(gen_random_uuid())`)).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await c.end();
      }
    }
  });
});
