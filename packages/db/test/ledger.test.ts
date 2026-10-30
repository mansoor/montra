import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withContext, type Database } from '../src/index.js';
import { appDb, createWorkspace, postEntry, type Fixture } from './fixtures.js';

let db: Kysely<Database>;
let f: Fixture;
const ctx = () => ({ workspaceId: f.workspaceId, userId: f.ownerId });

beforeAll(async () => {
  db = appDb();
  f = await createWorkspace(db, 'ledger-owner@example.com');
});
afterAll(() => db.destroy());

const errorHint = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { hint?: string; message: string }).hint ?? (e as Error).message;
  }
  throw new Error('expected the database to reject the write');
};

describe('balance invariant (DE-01)', () => {
  it('commits a balanced entry and maintains denormalized columns', async () => {
    const { entryId } = await withContext(db, ctx(), (trx) =>
      postEntry(trx, f, f.personalId, '2026-10-01', [
        { account: f.accounts.groceries, amount: 5000n },
        { account: f.accounts.checking, amount: -5000n },
      ]),
    );
    const rows = await withContext(db, ctx(), (trx) =>
      trx.selectFrom('app.posting').selectAll().where('journal_entry_id', '=', entryId).orderBy('line_no').execute(),
    );
    expect(rows.map((r) => r.amount_minor)).toEqual([5000n, -5000n]);
    expect(rows[0]!.entry_date).toBe('2026-10-01');
    expect(rows[0]!.entity_id).toBe(f.personalId);
  });

  it('rejects an unbalanced entry at commit', async () => {
    const hint = await errorHint(
      withContext(db, ctx(), (trx) =>
        postEntry(trx, f, f.personalId, '2026-10-02', [
          { account: f.accounts.groceries, amount: 5000n },
          { account: f.accounts.checking, amount: -4999n },
        ]),
      ),
    );
    expect(hint).toBe('ledger.unbalanced');
  });

  it('rejects an entry with fewer than two postings', async () => {
    expect(await errorHint(withContext(db, ctx(), (trx) => postEntry(trx, f, f.personalId, '2026-10-02', [])))).toBe(
      'ledger.too_few_postings',
    );
  });

  it('rejects unbalancing an existing entry later', async () => {
    const { entryId } = await withContext(db, ctx(), (trx) =>
      postEntry(trx, f, f.personalId, '2026-10-03', [
        { account: f.accounts.groceries, amount: 100n },
        { account: f.accounts.checking, amount: -100n },
      ]),
    );
    const hint = await errorHint(
      withContext(db, ctx(), (trx) =>
        trx
          .updateTable('app.posting')
          .set({ amount_minor: 101n, functional_amount_minor: 101n })
          .where('journal_entry_id', '=', entryId)
          .where('line_no', '=', 1)
          .execute(),
      ),
    );
    expect(hint).toBe('ledger.unbalanced');
  });

  it("rejects a posting to another entity's account (composite FK)", async () => {
    const msg = await errorHint(
      withContext(db, ctx(), (trx) =>
        postEntry(trx, f, f.personalId, '2026-10-04', [
          { account: f.accounts.office, amount: 100n },
          { account: f.accounts.checking, amount: -100n },
        ]),
      ),
    );
    expect(msg).toMatch(/foreign key/);
  });
});

describe('locks (DE-08..10)', () => {
  it('blocks new and changed entries inside a locked period, and allows status-only changes', async () => {
    const { entryId } = await withContext(db, ctx(), (trx) =>
      postEntry(trx, f, f.businessId, '2026-09-15', [
        { account: f.accounts.office, amount: 2500n },
        { account: f.accounts.bizChecking, amount: -2500n },
      ]),
    );
    await withContext(db, ctx(), (trx) =>
      trx
        .insertInto('app.period_lock')
        .values({ workspace_id: f.workspaceId, entity_id: f.businessId, locked_through: '2026-09-30' })
        .execute(),
    );

    // New entry dated in the locked period.
    expect(
      await errorHint(
        withContext(db, ctx(), (trx) =>
          postEntry(trx, f, f.businessId, '2026-09-20', [
            { account: f.accounts.office, amount: 1n },
            { account: f.accounts.bizChecking, amount: -1n },
          ]),
        ),
      ),
    ).toBe('period.locked');

    // Changing an amount in the locked period.
    expect(
      await errorHint(
        withContext(db, ctx(), (trx) =>
          trx.updateTable('app.posting').set({ memo: 'edited' }).where('journal_entry_id', '=', entryId).execute(),
        ),
      ),
    ).toBe('period.locked');

    // Deleting the entry.
    expect(
      await errorHint(
        withContext(db, ctx(), (trx) => trx.deleteFrom('app.journal_entry').where('id', '=', entryId).execute()),
      ),
    ).toBe('period.locked');

    // Clearing status is allowed.
    await withContext(db, ctx(), (trx) =>
      trx.updateTable('app.posting').set({ cleared: 'cleared' }).where('journal_entry_id', '=', entryId).execute(),
    );

    // The audited unlock path can edit.
    await withContext(db, { ...ctx(), allowLockedEdit: true }, (trx) =>
      trx.updateTable('app.posting').set({ memo: 'corrected' }).where('journal_entry_id', '=', entryId).execute(),
    );

    // Entries after the lock date are unaffected.
    await withContext(db, ctx(), (trx) =>
      postEntry(trx, f, f.businessId, '2026-10-01', [
        { account: f.accounts.office, amount: 1n },
        { account: f.accounts.bizChecking, amount: -1n },
      ]),
    );
  });

  it('protects reconciled entries in open periods and forbids un-locking', async () => {
    const { entryId } = await withContext(db, ctx(), (trx) =>
      postEntry(trx, f, f.personalId, '2026-10-10', [
        { account: f.accounts.groceries, amount: 700n },
        { account: f.accounts.card, amount: -700n },
      ]),
    );
    await withContext(db, ctx(), async (trx) => {
      await trx.updateTable('app.posting').set({ cleared: 'reconciled' }).where('journal_entry_id', '=', entryId).execute();
      await trx.updateTable('app.journal_entry').set({ locked: true }).where('id', '=', entryId).execute();
    });
    expect(
      await errorHint(
        withContext(db, ctx(), (trx) =>
          trx.updateTable('app.journal_entry').set({ locked: false }).where('id', '=', entryId).execute(),
        ),
      ),
    ).toBe('period.locked');
    expect(
      await errorHint(
        withContext(db, ctx(), (trx) =>
          trx.updateTable('app.posting').set({ cleared: 'cleared' }).where('journal_entry_id', '=', entryId).execute(),
        ),
      ),
    ).toBe('period.locked');
  });
});

describe('change feed and audit (ADR-0008, NFR-03)', () => {
  it('assigns a gapless per-workspace sequence and records audited diffs', async () => {
    const { transactionId } = await withContext(db, ctx(), (trx) =>
      postEntry(trx, f, f.personalId, '2026-10-12', [
        { account: f.accounts.checking, amount: 300000n },
        { account: f.accounts.salary, amount: -300000n },
      ]),
    );
    await withContext(db, ctx(), (trx) =>
      trx.updateTable('app.transaction').set({ description: 'October salary' }).where('id', '=', transactionId).execute(),
    );
    const { seqs, audit } = await withContext(db, ctx(), async (trx) => ({
      seqs: (await trx.selectFrom('app.change_log').select('seq').orderBy('seq').execute()).map((r) => r.seq),
      audit: await trx
        .selectFrom('app.audit_log')
        .selectAll()
        .where('subject_id', '=', transactionId)
        .where('action', '=', 'transaction.update')
        .execute(),
    }));
    seqs.forEach((s, i) => expect(s).toBe(BigInt(i + 1)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.diff).toEqual({ description: ['', 'October salary'] });
    expect(audit[0]!.actor_user_id).toBe(f.ownerId);
  });

  it('keeps the audit log append-only for the app role', async () => {
    const msg = await errorHint(
      withContext(db, ctx(), (trx) => sql`delete from app.audit_log`.execute(trx)),
    );
    expect(msg).toMatch(/permission denied/);
  });
});
