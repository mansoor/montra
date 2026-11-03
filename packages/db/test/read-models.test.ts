import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { newId, withContext, type Database, type Trx } from '../src/index.js';
import { addMember, appDb, createWorkspace, postEntry, type Fixture } from './fixtures.js';

// Read models (migration 0015, ADR-0015): trigger-maintained, so they must always equal the postings.

let db: Kysely<Database>;
let f: Fixture;
let partnerId: string;

beforeAll(async () => {
  db = appDb();
  f = await createWorkspace(db, 'reader@example.com');
  partnerId = await addMember(db, f, 'reader-partner@example.com', 'partner');
});
afterAll(() => db.destroy());

const asOwner = <T>(fn: (trx: Trx) => Promise<T>) =>
  withContext(db, { workspaceId: f.workspaceId, userId: f.ownerId }, fn);

/** The read models recomputed from postings, and as stored (non-zero rows only), keyed for comparison. */
async function snapshot(trx: Trx) {
  const fromPostings = await sql<{ k: string; v: string }>`
    select concat_ws('|', ledger_account_id, date_trunc('month', entry_date)::date, coalesce(member_id::text, '-'), restricted) as k,
           sum(functional_amount_minor)::text || '/' || count(*) as v
      from app.posting where workspace_id = ${f.workspaceId}
     group by 1 order by 1`.execute(trx);
  const stored = await sql<{ k: string; v: string }>`
    select concat_ws('|', ledger_account_id, month, case when member_key = '00000000-0000-0000-0000-000000000000' then '-' else member_key::text end, restricted) as k,
           sum(activity_minor)::text || '/' || sum(postings) as v
      from app.category_activity_monthly where workspace_id = ${f.workspaceId} and postings <> 0
     group by 1 order by 1`.execute(trx);
  const dailyFromPostings = await sql<{ k: string; v: string }>`
    select concat_ws('|', ledger_account_id, entry_date, restricted) as k, sum(amount_minor)::text || '/' || sum(functional_amount_minor) as v
      from app.posting where workspace_id = ${f.workspaceId}
     group by 1 having sum(amount_minor) <> 0 or sum(functional_amount_minor) <> 0 order by 1`.execute(trx);
  const dailyStored = await sql<{ k: string; v: string }>`
    select concat_ws('|', ledger_account_id, date, restricted) as k, sum(delta_minor)::text || '/' || sum(functional_delta_minor) as v
      from app.account_balance_daily where workspace_id = ${f.workspaceId}
     group by 1 having sum(delta_minor) <> 0 or sum(functional_delta_minor) <> 0 order by 1`.execute(trx);
  return {
    monthly: [fromPostings.rows, stored.rows] as const,
    daily: [dailyFromPostings.rows, dailyStored.rows] as const,
  };
}

async function expectReconciled() {
  const s = await asOwner(snapshot);
  expect(s.monthly[1]).toEqual(s.monthly[0]);
  expect(s.daily[1]).toEqual(s.daily[0]);
}

describe('category_activity_monthly and account_balance_daily', () => {
  it('track inserts, amount and date edits, cleared flags and deletes', async () => {
    const { transactionId, entryId } = await asOwner((trx) =>
      postEntry(trx, f, f.personalId, '2026-09-30', [
        { account: f.accounts.groceries, amount: 4200n },
        { account: f.accounts.checking, amount: -4200n },
      ]),
    );
    await asOwner((trx) =>
      postEntry(trx, f, f.personalId, '2026-10-02', [
        { account: f.accounts.groceries, amount: 1000n },
        { account: f.accounts.groceries, amount: 500n },
        { account: f.accounts.card, amount: -1500n },
      ]),
    );
    await expectReconciled();

    const groceries = () =>
      asOwner((trx) =>
        trx
          .selectFrom('app.category_activity_monthly')
          .select(['month', 'activity_minor', 'postings'])
          .where('ledger_account_id', '=', f.accounts.groceries)
          .orderBy('month')
          .execute(),
      );
    expect(await groceries()).toEqual([
      { month: '2026-09-01', activity_minor: 4200n, postings: 1 },
      { month: '2026-10-01', activity_minor: 1500n, postings: 2 },
    ]);

    // Moving the entry into October moves its activity (posting dates follow the entry).
    await asOwner((trx) =>
      trx
        .updateTable('app.journal_entry')
        .set({ entry_date: '2026-10-01' })
        .where('id', '=', entryId)
        .execute(),
    );
    expect(await groceries()).toEqual([
      { month: '2026-09-01', activity_minor: 0n, postings: 0 },
      { month: '2026-10-01', activity_minor: 5700n, postings: 3 },
    ]);

    // An amount edit (postings rewritten in place) and a status-only change.
    await asOwner(async (trx) => {
      await trx
        .updateTable('app.posting')
        .set((eb) => ({
          amount_minor: eb('amount_minor', '*', 2n),
          functional_amount_minor: eb('functional_amount_minor', '*', 2n),
        }))
        .where('journal_entry_id', '=', entryId)
        .execute();
      await trx
        .updateTable('app.posting')
        .set({ cleared: 'cleared' })
        .where('workspace_id', '=', f.workspaceId)
        .execute();
    });
    await expectReconciled();
    expect((await groceries()).at(-1)).toEqual({ month: '2026-10-01', activity_minor: 9900n, postings: 3 });

    // Deleting the transaction cascades to its entry and postings.
    await asOwner((trx) => trx.deleteFrom('app.transaction').where('id', '=', transactionId).execute());
    await expectReconciled();
    expect((await groceries()).at(-1)).toEqual({ month: '2026-10-01', activity_minor: 1500n, postings: 2 });
  });

  it('stay reconciled through a random series of writes', async () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const entries: string[] = [];
    for (let i = 0; i < 40; i++) {
      const op = entries.length ? rand(4) : 0;
      await asOwner(async (trx) => {
        if (op <= 1) {
          const amount = BigInt(1 + rand(50000));
          const day = String(1 + rand(28)).padStart(2, '0');
          const month = ['08', '09', '10', '11'][rand(4)]!;
          const { entryId } = await postEntry(trx, f, f.personalId, `2026-${month}-${day}`, [
            { account: rand(2) ? f.accounts.groceries : f.accounts.salary, amount },
            { account: rand(2) ? f.accounts.checking : f.accounts.card, amount: -amount },
          ]);
          entries.push(entryId);
        } else if (op === 2) {
          const id = entries[rand(entries.length)]!;
          const day = String(1 + rand(28)).padStart(2, '0');
          await trx
            .updateTable('app.journal_entry')
            .set({ entry_date: `2026-10-${day}` })
            .where('id', '=', id)
            .execute();
        } else {
          const id = entries.splice(rand(entries.length), 1)[0]!;
          await trx.deleteFrom('app.journal_entry').where('id', '=', id).execute();
        }
      });
    }
    await expectReconciled();
  });

  it('keep restricted amounts apart and apply the payslip read rule', async () => {
    const memberId = newId();
    await asOwner(async (trx) => {
      await trx
        .insertInto('app.family_member')
        .values({
          workspace_id: f.workspaceId,
          id: memberId,
          name: 'Sam',
          relationship: 'spouse_partner',
          linked_user_id: null,
        })
        .execute();
      await postEntry(
        trx,
        f,
        f.personalId,
        '2026-10-15',
        [
          { account: f.accounts.checking, amount: 341250n, memberId },
          { account: f.accounts.salary, amount: -341250n, memberId },
        ],
        { restricted: true, restrictedMemberId: memberId },
      );
    });
    await expectReconciled();
    const salary = (userId: string) =>
      withContext(db, { workspaceId: f.workspaceId, userId }, (trx) =>
        trx
          .selectFrom('app.category_activity_monthly')
          .select(['activity_minor', 'restricted', 'member_key', 'restricted_member_key'])
          .where('ledger_account_id', '=', f.accounts.salary)
          .where('restricted', '=', true)
          .execute(),
      );
    expect(await salary(f.ownerId)).toEqual([
      { activity_minor: -341250n, restricted: true, member_key: memberId, restricted_member_key: memberId },
    ]);
    expect(await salary(partnerId)).toEqual([]);
    const partnerDaily = await withContext(db, { workspaceId: f.workspaceId, userId: partnerId }, (trx) =>
      trx
        .selectFrom('app.account_balance_daily')
        .select('restricted')
        .where('restricted', '=', true)
        .execute(),
    );
    expect(partnerDaily).toEqual([]);
  });

  it('cannot be written by the app role', async () => {
    await expect(
      asOwner((trx) =>
        trx
          .insertInto('app.category_activity_monthly')
          .values({
            workspace_id: f.workspaceId,
            entity_id: f.personalId,
            ledger_account_id: f.accounts.groceries,
            month: '2026-01-01',
            member_key: '00000000-0000-0000-0000-000000000000',
            restricted: false,
            restricted_member_key: '00000000-0000-0000-0000-000000000000',
            activity_minor: 1n,
            postings: 1,
          })
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('budgets (BUD-01, UP-04)', () => {
  it('follow entity access: a partner sees personal budgets, not the business one', async () => {
    const ids = await asOwner(async (trx) => {
      const personal = await trx
        .insertInto('app.budget')
        .values({ workspace_id: f.workspaceId, entity_id: f.personalId, name: 'Household' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const business = await trx
        .insertInto('app.budget')
        .values({ workspace_id: f.workspaceId, entity_id: f.businessId, name: 'Studio' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const period = await trx
        .insertInto('app.budget_period')
        .values({
          workspace_id: f.workspaceId,
          budget_id: business.id,
          start_date: '2026-11-01',
          end_date: '2026-11-30',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.budget_line')
        .values({
          workspace_id: f.workspaceId,
          budget_period_id: period.id,
          category_id: f.accounts.office,
          assigned_minor: 5000n,
        })
        .execute();
      return { personal: personal.id, business: business.id };
    });
    const seen = await withContext(db, { workspaceId: f.workspaceId, userId: partnerId }, async (trx) => ({
      budgets: (await trx.selectFrom('app.budget').select('id').execute()).map((r) => r.id),
      periods: await trx.selectFrom('app.budget_period').select('id').execute(),
      lines: await trx.selectFrom('app.budget_line').select('category_id').execute(),
    }));
    expect(seen.budgets).toEqual([ids.personal]);
    expect(seen.periods).toEqual([]);
    expect(seen.lines).toEqual([]);
  });

  it('allow one active budget per entity and member', async () => {
    await expect(
      asOwner((trx) =>
        trx
          .insertInto('app.budget')
          .values({ workspace_id: f.workspaceId, entity_id: f.personalId, name: 'Second' })
          .execute(),
      ),
    ).rejects.toThrow(/budget_one_per_scope/);
  });
});

describe('nightly planning jobs (TZ-04)', () => {
  it('queues one job per workspace and local date, run as the owner', async () => {
    const enqueue = (hour: number) =>
      withContext(db, {}, async (trx) => {
        const { rows } = await sql<{
          n: number;
        }>`select app.enqueue_workspace_nightly('planning.nightly', ${hour}) as n`.execute(trx);
        return rows[0]!.n;
      });
    // Hour 24 never passes; hour 0 always has.
    await enqueue(24);
    const jobs = () =>
      asOwner((trx) =>
        trx
          .selectFrom('app.job')
          .select(['type', 'queue', 'created_by', 'payload'])
          .where('type', '=', 'planning.nightly')
          .execute(),
      );
    expect(await jobs()).toEqual([]);
    expect(await enqueue(0)).toBeGreaterThanOrEqual(1);
    await enqueue(0);
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ queue: 'schedule', created_by: f.ownerId });
    expect((queued[0]!.payload as { date: string }).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(
      withContext(db, {}, (trx) => sql`select app.enqueue_workspace_nightly('bad type', 0)`.execute(trx)),
    ).rejects.toThrow(/invalid job type/);
  });
});
