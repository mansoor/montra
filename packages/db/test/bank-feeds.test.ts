import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { withContext, type Database, type Trx } from '../src/index.js';
import { ADMIN_URL, APP_URL } from './env.js';
import { addMember, appDb, createWorkspace, type Fixture } from './fixtures.js';

// Bank feeds, PR 1 (migration 0071, ADR-0055 §2): the feed with its sealed secret, its accounts and runs, feed batches
// with no file, the sync job's functions, the plan key, and who may see what.

let db: Kysely<Database>;
let admin: pg.Client;
let a: Fixture;
let b: Fixture;
let adminId: string;
let partnerId: string;
let accountantId: string;
let memberId: string;
let viewerId: string;

const as = <T>(f: Fixture, userId: string, fn: (trx: Trx) => Promise<T>) =>
  withContext(db, { workspaceId: f.workspaceId, userId }, fn);

async function feed(
  f: Fixture,
  opts: { status?: string; nextSyncAt?: string | null; connectedBy?: string } = {},
): Promise<string> {
  const disconnected = opts.status === 'disconnected';
  const { rows } = await admin.query<{ id: string }>(
    `insert into app.bank_feed (workspace_id, provider, status, secret_enc, host, sync_minute, connected_by,
                                next_sync_at, disconnected_at)
     values ($1, 'simplefin', $2, $3, 'bridge.simplefin.org', 300, $4, $5, $6) returning id`,
    [
      f.workspaceId,
      opts.status ?? 'active',
      disconnected ? null : Buffer.from([1, 2, 3]),
      opts.connectedBy ?? f.ownerId,
      opts.nextSyncAt === undefined ? null : opts.nextSyncAt,
      disconnected ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

async function feedAccount(
  f: Fixture,
  feedId: string,
  providerId: string,
  link?: { ledgerAccountId: string; startDate: string },
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into app.bank_feed_account (workspace_id, bank_feed_id, provider_account_id, name, currency,
                                        ledger_account_id, state, start_date)
     values ($1, $2, $3, 'Checking …1234', 'USD', $4, $5, $6) returning id`,
    [
      f.workspaceId,
      feedId,
      providerId,
      link?.ledgerAccountId ?? null,
      link ? 'linked' : 'new',
      link?.startDate ?? null,
    ],
  );
  return rows[0]!.id;
}

const dropFeeds = (f: Fixture) =>
  admin.query(`delete from app.bank_feed where workspace_id = $1`, [f.workspaceId]);

async function asRole<T>(role: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = role;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = appDb();
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  a = await createWorkspace(db, 'feeds-owner@example.com');
  b = await createWorkspace(db, 'feeds-other@example.com');
  adminId = await addMember(db, a, 'feeds-admin@example.com', 'admin');
  partnerId = await addMember(db, a, 'feeds-partner@example.com', 'partner');
  accountantId = await addMember(db, a, 'feeds-accountant@example.com', 'accountant');
  memberId = await addMember(db, a, 'feeds-member@example.com', 'member');
  viewerId = await addMember(db, a, 'feeds-viewer@example.com', 'viewer');
});

afterAll(async () => {
  await admin.end();
  await db.destroy();
});

describe('the feed: one live per workspace, its secret held until disconnected (ADR-0055 §2)', () => {
  afterAll(() => dropFeeds(a));

  it('keeps one live feed, and lets a disconnected one stay beside a new one', async () => {
    const first = await feed(a);
    await expect(feed(a)).rejects.toThrow(/bank_feed_one_live/);
    await expect(
      admin.query(`update app.bank_feed set secret_enc = null where id = $1`, [first]),
    ).rejects.toThrow(/bank_feed_secret_held/);
    await expect(
      admin.query(`update app.bank_feed set status = 'disconnected' where id = $1`, [first]),
    ).rejects.toThrow(/bank_feed_disconnected/);
    await admin.query(
      `update app.bank_feed set status = 'disconnected', disconnected_at = now(), secret_enc = null where id = $1`,
      [first],
    );
    expect(await feed(a)).toBeTruthy();
    await expect(
      admin.query(
        `insert into app.bank_feed (workspace_id, provider, secret_enc, sync_minute) values ($1, 'plaid', '\\x01', 1)`,
        [b.workspaceId],
      ),
    ).rejects.toThrow(/bank_feed_provider_check/);
    await expect(
      admin.query(
        `insert into app.bank_feed (workspace_id, provider, secret_enc, sync_minute) values ($1, 'simplefin', '\\x01', 1440)`,
        [b.workspaceId],
      ),
    ).rejects.toThrow(/bank_feed_sync_minute_check/);
  });
});

describe('its accounts (ADR-0055 §4)', () => {
  let id: string;
  beforeAll(async () => {
    id = await feed(a);
  });
  afterAll(() => dropFeeds(a));

  it('links one feed account to a Montra account at most, and a link needs a start date', async () => {
    await feedAccount(a, id, 'ACT-1', { ledgerAccountId: a.accounts.checking, startDate: '2026-11-01' });
    await expect(
      feedAccount(a, id, 'ACT-2', { ledgerAccountId: a.accounts.checking, startDate: '2026-11-01' }),
    ).rejects.toThrow(/bank_feed_account_ledger/);
    await expect(feedAccount(a, id, 'ACT-1')).rejects.toThrow(/bank_feed_account_provider/);
    const other = await feedAccount(a, id, 'ACT-3');
    await expect(
      admin.query(`update app.bank_feed_account set state = 'linked', ledger_account_id = $2 where id = $1`, [
        other,
        a.accounts.card,
      ]),
    ).rejects.toThrow(/bank_feed_account_start/);
    await expect(
      admin.query(`update app.bank_feed_account set currency = 'usd' where id = $1`, [other]),
    ).rejects.toThrow(/bank_feed_account_currency/);
    // Ignored accounts may point anywhere; they never import.
    await admin.query(`update app.bank_feed_account set state = 'ignored' where id = $1`, [other]);
  });
});

describe('feed batches have no file (ADR-0055 §2)', () => {
  afterAll(() => admin.query(`delete from app.import_batch where workspace_id = $1`, [a.workspaceId]));

  const batch = (source: string, fileType: string, fileId: string | null) =>
    admin.query(
      `insert into app.import_batch (workspace_id, entity_id, ledger_account_id, file_id, file_name, file_type,
                                     currency, source, bank_feed_account_id)
       values ($1, $2, $3, $4, 'SimpleFIN, Nov 20', $5, 'USD', $6, $7)`,
      [
        a.workspaceId,
        a.personalId,
        a.accounts.checking,
        fileId,
        fileType,
        source,
        source === 'feed' ? '00000000-0000-4000-8000-000000000001' : null,
      ],
    );

  it('takes a feed batch with no file, and nothing in between', async () => {
    await batch('feed', 'feed', null);
    await expect(batch('file', 'csv', null)).rejects.toThrow(/import_batch_source_file/);
    await expect(batch('feed', 'csv', null)).rejects.toThrow(/import_batch_source_file/);
    await expect(batch('nope', 'feed', null)).rejects.toThrow(/import_batch_source_check/);
    const { rows } = await admin.query(`select source from app.import_batch where workspace_id = $1`, [
      a.workspaceId,
    ]);
    expect(rows).toEqual([{ source: 'feed' }]);
  });
});

describe('who may see and change it (ADR-0055 §2, D5)', () => {
  let id: string;
  beforeAll(async () => {
    id = await feed(a);
    await feedAccount(a, id, 'ACT-1');
    await admin.query(
      `insert into app.bank_feed_run (workspace_id, bank_feed_id, trigger) values ($1, $2, 'first')`,
      [a.workspaceId, id],
    );
  });
  afterAll(() => dropFeeds(a));

  const counts = (f: Fixture, userId: string) =>
    as(f, userId, async (trx) => ({
      feeds: (await trx.selectFrom('app.bank_feed').select('id').execute()).length,
      accounts: (await trx.selectFrom('app.bank_feed_account').select('id').execute()).length,
      runs: (await trx.selectFrom('app.bank_feed_run').select('id').execute()).length,
    }));

  it('shows the feed and its runs to owners, admins and partners, and its accounts to whoever imports', async () => {
    for (const userId of [a.ownerId, adminId, partnerId])
      expect(await counts(a, userId), userId).toEqual({ feeds: 1, accounts: 1, runs: 1 });
    expect(await counts(a, accountantId)).toEqual({ feeds: 0, accounts: 1, runs: 0 });
    for (const userId of [memberId, viewerId])
      expect(await counts(a, userId), userId).toEqual({ feeds: 0, accounts: 0, runs: 0 });
    expect(await counts(b, b.ownerId)).toEqual({ feeds: 0, accounts: 0, runs: 0 });
  });

  it('lets only an owner change any of it', async () => {
    const rename = (userId: string) =>
      as(a, userId, (trx) =>
        trx
          .updateTable('app.bank_feed')
          .set({ label: 'Mine' })
          .where('id', '=', id)
          .returning('id')
          .execute(),
      );
    for (const userId of [adminId, partnerId, accountantId]) expect(await rename(userId), userId).toEqual([]);
    expect(await rename(a.ownerId)).toEqual([{ id }]);
    const ignore = (userId: string) =>
      as(a, userId, (trx) =>
        trx
          .updateTable('app.bank_feed_account')
          .set({ state: 'ignored' })
          .where('bank_feed_id', '=', id)
          .returning('id')
          .execute(),
      );
    for (const userId of [adminId, partnerId, accountantId]) expect(await ignore(userId), userId).toEqual([]);
    expect(await ignore(a.ownerId)).toHaveLength(1);
    const run = (userId: string) =>
      as(a, userId, (trx) =>
        trx
          .insertInto('app.bank_feed_run')
          .values({ workspace_id: a.workspaceId, bank_feed_id: id, trigger: 'manual' })
          .execute(),
      );
    await expect(run(partnerId)).rejects.toThrow(/row-level security/);
    await expect(run(a.ownerId)).resolves.toBeDefined();
  });

  it('gives staff nothing: no table, no function (ADR-0020)', async () => {
    for (const role of ['montra_admin', 'montra_support']) {
      await asRole(role, async (c) => {
        for (const table of ['bank_feed', 'bank_feed_account', 'bank_feed_run']) {
          await expect(c.query(`select 1 from app.${table} limit 1`)).rejects.toThrow(/permission denied/);
        }
        await expect(c.query(`select * from app.bank_feed_due()`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`select app.bank_feed_next()`)).rejects.toThrow(/permission denied/);
      });
    }
  });
});

describe('the sync job’s functions (ADR-0055 §5)', () => {
  afterAll(() => dropFeeds(a));

  const due = () =>
    asRole('montra_app', async (c) => {
      const { rows } = await c.query<{ bank_feed_id: string; user_id: string }>(
        `select bank_feed_id, user_id from app.bank_feed_due() where workspace_id = $1`,
        [a.workspaceId],
      );
      return rows;
    });

  it('is due when its time has come, acting as the owner who connected it, and never while it needs a person', async () => {
    const id = await feed(a, { nextSyncAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(await due()).toEqual([]);
    const next = await asRole(
      'montra_app',
      async (c) => (await c.query(`select app.bank_feed_next() as t`)).rows[0].t,
    );
    expect(next).toBeInstanceOf(Date);

    await admin.query(`update app.bank_feed set next_sync_at = now() - interval '1 minute' where id = $1`, [
      id,
    ]);
    expect(await due()).toEqual([{ bank_feed_id: id, user_id: a.ownerId }]);
    for (const status of ['needs_attention', 'revoked', 'payment_required', 'paused']) {
      await admin.query(`update app.bank_feed set status = $2 where id = $1`, [id, status]);
      expect(await due(), status).toEqual([]);
    }
    await admin.query(`update app.bank_feed set status = 'failing' where id = $1`, [id]);
    expect(await due()).toHaveLength(1);
  });
});

describe('the plan key (ADR-0055 §11, D6)', () => {
  it('is on in every plan version that has own storage', async () => {
    const { rows } = await admin.query<{ features: string[] }>(
      `select entitlements -> 'features' as features from app.plan_version
        where (entitlements -> 'features') @> '["ownStorage"]'::jsonb`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.features).toContain('bankFeeds');
  });
});
