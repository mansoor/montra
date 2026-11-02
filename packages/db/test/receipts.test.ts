import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { newId, withContext, type Database, type Trx } from '../src/index.js';
import { addMember, appDb, createWorkspace, type Fixture } from './fixtures.js';

// Migration 0012 (Phase 5, ADR-0014): receipts, receipt lines, trips and FX reference rates.
let db: Kysely<Database>;
let a: Fixture;
let b: Fixture;
let partnerId: string;
let personalReceipt: string;
let businessReceipt: string;

const asUser = <T>(f: Fixture, userId: string, fn: (trx: Trx) => Promise<T>) =>
  withContext(db, { workspaceId: f.workspaceId, userId }, fn);

beforeAll(async () => {
  db = appDb();
  a = await createWorkspace(db, 'rita@example.com');
  b = await createWorkspace(db, 'sam@example.com');
  partnerId = await addMember(db, a, 'pia@example.com', 'partner');
  personalReceipt = newId();
  businessReceipt = newId();
  await asUser(a, a.ownerId, async (trx) => {
    await trx
      .insertInto('app.receipt')
      .values([
        {
          workspace_id: a.workspaceId,
          id: personalReceipt,
          entity_id: a.personalId,
          merchant: 'Walmart',
          ocr_text: 'GV 2% MLK GAL 3.48 BANANAS 1.62 ONN USB-C CHRGR 12.88',
          status: 'inbox',
          currency: 'USD',
          total_minor: 2871n,
        },
        {
          workspace_id: a.workspaceId,
          id: businessReceipt,
          entity_id: a.businessId,
          merchant: 'Staples',
          ocr_text: 'COPY PAPER 10 REAM',
          status: 'inbox',
          currency: 'USD',
          total_minor: 5499n,
        },
      ])
      .execute();
    await trx
      .insertInto('app.receipt_line')
      .values([
        {
          workspace_id: a.workspaceId,
          receipt_id: personalReceipt,
          line_no: 1,
          raw_text: 'GV 2% MLK GAL',
          line_total_minor: 348n,
          taxable: false,
        },
        {
          workspace_id: a.workspaceId,
          receipt_id: personalReceipt,
          line_no: 2,
          raw_text: 'PRINTER PAPER',
          line_total_minor: 899n,
          entity_id: a.businessId,
          category_id: a.accounts.office,
        },
      ])
      .execute();
  });
});
afterAll(() => db.destroy());

describe('receipts (RCP-01, RCP-07, RCP-10)', () => {
  it('keeps receipts inside their workspace', async () => {
    const own = await asUser(a, a.ownerId, (trx) => trx.selectFrom('app.receipt').select('id').execute());
    expect(own).toHaveLength(2);
    const intruder = await asUser(a, b.ownerId, (trx) =>
      trx.selectFrom('app.receipt').select('id').execute(),
    );
    expect(intruder).toEqual([]);
    const intruderLines = await asUser(a, b.ownerId, (trx) =>
      trx.selectFrom('app.receipt_line').select('id').execute(),
    );
    expect(intruderLines).toEqual([]);
  });

  it('follows entity access: a partner sees personal receipts but not business lines on them', async () => {
    const receipts = await asUser(a, partnerId, (trx) =>
      trx.selectFrom('app.receipt').select('id').execute(),
    );
    expect(receipts.map((r) => r.id)).toEqual([personalReceipt]);
    const lines = await asUser(a, partnerId, (trx) =>
      trx.selectFrom('app.receipt_line').select('raw_text').orderBy('line_no').execute(),
    );
    expect(lines.map((l) => l.raw_text)).toEqual(['GV 2% MLK GAL']);
  });

  it('does not let a partner write a line to an entity they cannot write', async () => {
    await expect(
      asUser(a, partnerId, (trx) =>
        trx
          .insertInto('app.receipt_line')
          .values({
            workspace_id: a.workspaceId,
            receipt_id: personalReceipt,
            line_no: 3,
            raw_text: 'TONER',
            line_total_minor: 2999n,
            entity_id: a.businessId,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('marks returns by sign and rejects a mismatch (RCP-08)', async () => {
    await asUser(a, a.ownerId, (trx) =>
      trx
        .insertInto('app.receipt_line')
        .values({
          workspace_id: a.workspaceId,
          receipt_id: personalReceipt,
          line_no: 4,
          raw_text: 'RETURN CABLE',
          line_total_minor: -1000n,
          is_return: true,
        })
        .execute(),
    );
    await expect(
      asUser(a, a.ownerId, (trx) =>
        trx
          .insertInto('app.receipt_line')
          .values({
            workspace_id: a.workspaceId,
            receipt_id: personalReceipt,
            line_no: 5,
            raw_text: 'CABLE',
            line_total_minor: -1000n,
          })
          .execute(),
      ),
    ).rejects.toThrow(/receipt_line_check/);
  });

  it('searches merchant and OCR text and defaults retention to 7 years', async () => {
    const found = await asUser(a, a.ownerId, (trx) =>
      trx
        .selectFrom('app.receipt')
        .select([
          'id',
          'retain_until',
          sql<string>`(created_at::date + interval '7 years')::date::text`.as('expected'),
        ])
        .where(sql<boolean>`search @@ plainto_tsquery('simple', 'chrgr')`)
        .execute(),
    );
    expect(found.map((r) => r.id)).toEqual([personalReceipt]);
    expect(found[0]!.retain_until).toBe(found[0]!.expected);
  });

  it('requires a transaction for a matched receipt', async () => {
    await expect(
      asUser(a, a.ownerId, (trx) =>
        trx.updateTable('app.receipt').set({ status: 'matched' }).where('id', '=', personalReceipt).execute(),
      ),
    ).rejects.toThrow(/receipt_check/);
  });
});

describe('trips (CUR-09)', () => {
  it('stores a trip window and rejects one that ends before it starts', async () => {
    await asUser(a, a.ownerId, (trx) =>
      trx
        .insertInto('app.trip')
        .values({
          workspace_id: a.workspaceId,
          name: 'Paris',
          start_date: '2026-11-10',
          end_date: '2026-11-17',
          currency: 'EUR',
          time_zone: 'Europe/Paris',
        })
        .execute(),
    );
    await expect(
      asUser(a, a.ownerId, (trx) =>
        trx
          .insertInto('app.trip')
          .values({
            workspace_id: a.workspaceId,
            name: 'Backwards',
            start_date: '2026-11-10',
            end_date: '2026-11-09',
            currency: 'EUR',
          })
          .execute(),
      ),
    ).rejects.toThrow(/trip_check/);
    const other = await asUser(a, b.ownerId, (trx) => trx.selectFrom('app.trip').select('id').execute());
    expect(other).toEqual([]);
  });
});

describe('FX reference rates (CUR-05)', () => {
  it('are read-only for the app and loaded through app.upsert_fx_rates', async () => {
    const rows = JSON.stringify([
      { date: '2026-10-30', base: 'EUR', quote: 'USD', rate: '1.0912' },
      { date: '2026-10-30', base: 'EUR', quote: 'JPY', rate: '163.42' },
    ]);
    const n = await asUser(
      a,
      a.ownerId,
      async (trx) =>
        (await sql<{ n: number }>`select app.upsert_fx_rates('ecb', ${rows}::jsonb) as n`.execute(trx))
          .rows[0]!.n,
    );
    expect(n).toBe(2);
    // Same rates again: nothing changes.
    const again = await asUser(
      a,
      a.ownerId,
      async (trx) =>
        (await sql<{ n: number }>`select app.upsert_fx_rates('ecb', ${rows}::jsonb) as n`.execute(trx))
          .rows[0]!.n,
    );
    expect(again).toBe(0);
    const usd = await asUser(a, a.ownerId, (trx) =>
      trx.selectFrom('ref.fx_rate').select('rate').where('quote', '=', 'USD').executeTakeFirstOrThrow(),
    );
    expect(usd.rate).toBe('1.0912000000');
    await expect(
      asUser(a, a.ownerId, (trx) =>
        trx
          .insertInto('ref.fx_rate')
          .values({ rate_date: '2026-10-30', base: 'EUR', quote: 'GBP', rate: '0.84', source: 'ecb' })
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
