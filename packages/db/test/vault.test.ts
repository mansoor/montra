import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { newId, withContext, type Database, type Trx } from '../src/index.js';
import { ADMIN_URL, APP_URL } from './env.js';
import { addMember, appDb, createWorkspace, type Fixture } from './fixtures.js';

// The household's Family Document Vault as a storage provider, PR 1 (migration 0063, ADR-0054 §11): the connection
// beside the mirror, its state and outbox, a file's place, the triggers and the job's functions, and who may see them.

let db: Kysely<Database>;
let admin: pg.Client;
let a: Fixture;
let b: Fixture;
let adminId: string;
let memberId: string;
let viewerId: string;
let partnerId: string;

const as = <T>(f: Fixture, userId: string, fn: (trx: Trx) => Promise<T>) =>
  withContext(db, { workspaceId: f.workspaceId, userId }, fn);

async function destination(
  workspaceId: string,
  kind: 's3' | 'webdav' | 'fdv',
  opts: { kinds?: string[]; status?: string; deleteWithMontra?: boolean; canDelete?: boolean } = {},
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into app.storage_destination
       (workspace_id, kind, label, secret_enc, folder, file_kinds, status, delete_with_montra, can_delete)
     values ($1, $2, $3, decode('00', 'hex'), 'Montra/Test', $4, $5, $6, $7) returning id`,
    [
      workspaceId,
      kind,
      kind === 'fdv' ? 'Family Document Vault' : 'Mine',
      opts.kinds ?? ['statement', 'receipt', 'invoice'],
      opts.status ?? 'active',
      opts.deleteWithMontra ?? false,
      opts.canDelete ?? true,
    ],
  );
  return rows[0]!.id;
}

const dropDestinations = (workspaceId: string) =>
  admin.query(`delete from app.storage_destination where workspace_id = $1`, [workspaceId]);

async function file(workspaceId: string, kind: string, sealed = false): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into app.file (workspace_id, kind, storage_key, file_name, mime, bytes, sha256, sealed)
     values ($1, $2, $3, 'paper.pdf', 'application/pdf', 10, repeat('a', 64), $4) returning id`,
    [workspaceId, kind, `${workspaceId}/${kind}/${newId()}`, sealed],
  );
  return rows[0]!.id;
}

const vaultRows = async (fileId: string) =>
  (
    await admin.query<{ status: string; destination_id: string }>(
      `select status, destination_id from app.vault_item where file_id = $1`,
      [fileId],
    )
  ).rows;

const mirrorRows = async (fileId: string) =>
  (await admin.query(`select destination_id from app.storage_mirror_item where file_id = $1`, [fileId])).rows;

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
  a = await createWorkspace(db, 'vault-owner@example.com');
  b = await createWorkspace(db, 'vault-other@example.com');
  adminId = await addMember(db, a, 'vault-admin@example.com', 'admin');
  memberId = await addMember(db, a, 'vault-member@example.com', 'member');
  viewerId = await addMember(db, a, 'vault-viewer@example.com', 'viewer');
  partnerId = await addMember(db, a, 'vault-partner@example.com', 'partner');
});

afterAll(async () => {
  await admin.end();
  await db.destroy();
});

describe('connections: one mirror and one vault per workspace (ADR-0054 §1)', () => {
  afterAll(() => dropDestinations(a.workspaceId));

  it('lets a workspace have a mirror and a vault, but not two of either', async () => {
    await destination(a.workspaceId, 's3');
    await expect(destination(a.workspaceId, 'webdav')).rejects.toThrow(/storage_destination_one_mirror/);
    await destination(a.workspaceId, 'fdv');
    await expect(destination(a.workspaceId, 'fdv')).rejects.toThrow(/storage_destination_one_vault/);
    const { rows } = await admin.query(
      `select kind from app.storage_destination where workspace_id = $1 order by kind`,
      [a.workspaceId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['fdv', 's3']);
  });

  it('keeps `needs_vault` for vault connections, and refuses kinds it doesn’t know', async () => {
    await expect(destination(b.workspaceId, 's3', { status: 'needs_vault' })).rejects.toThrow(
      /storage_destination_needs_vault/,
    );
    await expect(destination(b.workspaceId, 'gdrive' as 'fdv')).rejects.toThrow(
      /storage_destination_kind_check/,
    );
    const id = await destination(b.workspaceId, 'fdv', { status: 'needs_vault' });
    expect(id).toBeTruthy();
    await dropDestinations(b.workspaceId);
  });

  it('keeps a disconnected vault connection without its key, and only that (§10, migration 0068)', async () => {
    await expect(destination(b.workspaceId, 's3', { status: 'disconnected' })).rejects.toThrow(
      /storage_destination_disconnected/,
    );
    const id = await destination(b.workspaceId, 'fdv');
    await expect(
      admin.query(`update app.storage_destination set secret_enc = null where id = $1`, [id]),
    ).rejects.toThrow(/storage_destination_secret_held/);
    await admin.query(`update app.storage_destination set secret_enc = null, status = 'disconnected' where id = $1`, [
      id,
    ]);
    await admin.query(`insert into app.vault_connection_state (workspace_id, destination_id) values ($1, $2)`, [
      b.workspaceId,
      id,
    ]);
    // Never due: with no key there is nothing the job can do.
    await admin.query(
      `update app.vault_connection_state set next_check_at = now() - interval '1 hour' where destination_id = $1`,
      [id],
    );
    const due = await admin.query(`select * from app.vault_due() where workspace_id = $1`, [b.workspaceId]);
    expect(due.rows).toEqual([]);
    // Its members can tell, without seeing the connection.
    const told = await withContext(db, { workspaceId: b.workspaceId, userId: b.ownerId }, (trx) =>
      sql<{ d: boolean }>`select app.vault_disconnected() as d`.execute(trx),
    );
    expect(told.rows[0]!.d).toBe(true);
    // Bringing files back is a time and a choice together.
    await expect(
      admin.query(`update app.vault_connection_state set bring_back_at = now() where destination_id = $1`, [id]),
    ).rejects.toThrow(/vault_connection_state_bring_back/);
    await dropDestinations(b.workspaceId);
  });

  it('hangs the vault’s state and outbox only off a vault connection', async () => {
    const mirror = (
      await admin.query<{ id: string }>(
        `select id from app.storage_destination where workspace_id = $1 and kind = 's3'`,
        [a.workspaceId],
      )
    ).rows[0]!.id;
    await expect(
      admin.query(`insert into app.vault_connection_state (workspace_id, destination_id) values ($1, $2)`, [
        a.workspaceId,
        mirror,
      ]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      admin.query(`insert into app.vault_item (workspace_id, destination_id, file_id) values ($1, $2, $3)`, [
        a.workspaceId,
        mirror,
        newId(),
      ]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      admin.query(
        `insert into app.vault_item (workspace_id, destination_id, destination_kind, file_id)
         values ($1, $2, 's3', $3)`,
        [a.workspaceId, mirror, newId()],
      ),
    ).rejects.toThrow(/vault_item_destination_kind_check/);
  });
});

describe('the outbox’s rules (ADR-0054 §4)', () => {
  let vault: string;
  beforeAll(async () => {
    vault = await destination(b.workspaceId, 'fdv');
  });
  afterAll(() => dropDestinations(b.workspaceId));

  const item = (values: Record<string, unknown>) => {
    const cols = ['workspace_id', 'destination_id', 'file_id', ...Object.keys(values)];
    const params = [b.workspaceId, vault, newId(), ...Object.values(values)];
    return admin.query(
      `insert into app.vault_item (${cols.join(', ')}) values (${params.map((_, i) => `$${i + 1}`).join(', ')})
       returning file_id`,
      params,
    );
  };

  it('keeps an id once it is saved, and never the same id twice on one connection', async () => {
    const { rows } = await item({ status: 'pending', vault_ref: 'ref-one' });
    const fileId = rows[0]!.file_id as string;
    await expect(
      admin.query(`update app.vault_item set vault_ref = 'ref-two' where file_id = $1`, [fileId]),
    ).rejects.toThrow(/chosen once and never changes/);
    await expect(
      admin.query(`update app.vault_item set vault_ref = null where file_id = $1`, [fileId]),
    ).rejects.toThrow(/chosen once and never changes/);
    // Saving the same value again, and changing anything else, is fine.
    await admin.query(`update app.vault_item set vault_ref = 'ref-one', attempts = 1 where file_id = $1`, [
      fileId,
    ]);
    await expect(item({ status: 'pending', vault_ref: 'ref-one' })).rejects.toThrow(/vault_item_ref/);
    // A row with no id yet can be given one.
    const queued = (await item({})).rows[0]!.file_id as string;
    await admin.query(`update app.vault_item set vault_ref = 'ref-three' where file_id = $1`, [queued]);
  });

  it('needs an id past sending, a time for filed, a document for out of reach, and words for not kept', async () => {
    await expect(item({ status: 'received' })).rejects.toThrow(/check constraint/);
    await expect(item({ status: 'filed', vault_ref: 'r-filed', vault_document_id: 'doc-0' })).rejects.toThrow(
      /check constraint/,
    );
    // Migration 0064: a vault that lets Montra send but not read says only that it filed the item.
    await item({
      status: 'filed',
      vault_ref: 'r-filed-unseen',
      filed_at: new Date(),
      content_available: false,
    });
    await expect(item({ status: 'out_of_reach', vault_ref: 'r-oor' })).rejects.toThrow(/check constraint/);
    await expect(item({ status: 'not_kept', vault_ref: 'r-nk' })).rejects.toThrow(/check constraint/);
    await expect(item({ source_removed_at: new Date() })).rejects.toThrow(/check constraint/);
    await expect(item({ auto_resends: 2 })).rejects.toThrow(/check constraint/);
    await expect(item({ vault_sha256: 'not-a-hash' })).rejects.toThrow(/check constraint/);
    await item({
      status: 'filed',
      vault_ref: 'r-ok',
      vault_document_id: 'doc-1',
      filed_at: new Date(),
      vault_sha256: 'b'.repeat(64),
    });
    await item({ status: 'not_kept', vault_ref: 'r-nk-ok', not_kept_reason: 'The family removed it' });
  });

  it('keeps a key change’s state and its time together', async () => {
    await expect(
      admin.query(
        `insert into app.vault_connection_state (workspace_id, destination_id, key_rotation) values ($1, $2, 'made')`,
        [b.workspaceId, vault],
      ),
    ).rejects.toThrow(/check constraint/);
    await admin.query(
      `insert into app.vault_connection_state (workspace_id, destination_id) values ($1, $2)`,
      [b.workspaceId, vault],
    );
    await admin.query(
      `update app.vault_connection_state set key_rotation = 'registered', key_rotation_at = now()
        where destination_id = $1`,
      [vault],
    );
  });
});

describe('who sees the vault’s tables (ADR-0054 §11)', () => {
  let vault: string;
  beforeAll(async () => {
    vault = await destination(a.workspaceId, 'fdv');
    await admin.query(
      `insert into app.vault_connection_state (workspace_id, destination_id) values ($1, $2)`,
      [a.workspaceId, vault],
    );
    await admin.query(
      `insert into app.vault_item (workspace_id, destination_id, file_id) values ($1, $2, $3)`,
      [a.workspaceId, vault, newId()],
    );
  });
  afterAll(() => dropDestinations(a.workspaceId));

  const counts = (f: Fixture, userId: string) =>
    as(f, userId, async (trx) => ({
      state: (await trx.selectFrom('app.vault_connection_state').select('destination_id').execute()).length,
      items: (await trx.selectFrom('app.vault_item').select('file_id').execute()).length,
    }));

  it('shows them to owners and admins only, and only their own workspace’s', async () => {
    expect(await counts(a, a.ownerId)).toEqual({ state: 1, items: 1 });
    expect(await counts(a, adminId)).toEqual({ state: 1, items: 1 });
    for (const userId of [memberId, viewerId, partnerId]) {
      expect(await counts(a, userId)).toEqual({ state: 0, items: 0 });
    }
    expect(await counts(b, b.ownerId)).toEqual({ state: 0, items: 0 });
  });

  it('lets an admin write them, and nobody else', async () => {
    await as(a, adminId, (trx) =>
      trx
        .updateTable('app.vault_connection_state')
        .set({ clock_offset_ms: 120 })
        .where('destination_id', '=', vault)
        .execute(),
    );
    const write = (userId: string) =>
      as(a, userId, (trx) =>
        trx
          .insertInto('app.vault_item')
          .values({ workspace_id: a.workspaceId, destination_id: vault, file_id: newId() })
          .execute(),
      );
    await expect(write(memberId)).rejects.toThrow(/row-level security/);
    await expect(write(partnerId)).rejects.toThrow(/row-level security/);
    await expect(write(a.ownerId)).resolves.toBeDefined();
  });

  it('gives staff nothing: no table, no function (ADR-0020)', async () => {
    for (const role of ['montra_admin', 'montra_support']) {
      await asRole(role, async (c) => {
        for (const table of ['vault_connection_state', 'vault_item']) {
          await expect(c.query(`select 1 from app.${table} limit 1`)).rejects.toThrow(/permission denied/);
        }
        await expect(c.query(`select * from app.vault_due()`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`select app.vault_next()`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`select app.vault_file_busy(gen_random_uuid())`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          c.query(`select * from app.vault_file_states(array[gen_random_uuid()])`),
        ).rejects.toThrow(/permission denied/);
        await expect(c.query(`select * from app.vault_file_open(gen_random_uuid())`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(c.query(`select app.vault_disconnected()`)).rejects.toThrow(/permission denied/);
      });
    }
  });
});

describe('a file’s place (ADR-0054 §5, §5a)', () => {
  it('is Montra’s by default, and missing needs both a time and a reason', async () => {
    const id = await file(b.workspaceId, 'receipt');
    const { rows } = await admin.query(
      `select location, missing_since, missing_reason, replaced_sha256 from app.file where id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      location: 'montra',
      missing_since: null,
      missing_reason: null,
      replaced_sha256: null,
    });
    await expect(
      admin.query(`update app.file set missing_since = now() where id = $1`, [id]),
    ).rejects.toThrow(/file_missing_reason/);
    await expect(admin.query(`update app.file set location = 'cloud' where id = $1`, [id])).rejects.toThrow(
      /file_location_check/,
    );
    await expect(
      admin.query(`update app.file set replaced_sha256 = 'nope' where id = $1`, [id]),
    ).rejects.toThrow(/check constraint/);
    await admin.query(
      `update app.file set missing_since = now(), missing_reason = 'The vault didn''t return it' where id = $1`,
      [id],
    );
  });
});

describe('the triggers (ADR-0054 §3, §6, §10)', () => {
  let mirror: string;
  let vault: string;
  beforeAll(async () => {
    mirror = await destination(b.workspaceId, 's3', {
      kinds: ['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other', 'tax_form'],
    });
    vault = await destination(b.workspaceId, 'fdv', { kinds: ['statement', 'receipt', 'invoice'] });
  });
  afterAll(() => dropDestinations(b.workspaceId));

  it('queues a file for the vault when its group is on, and copies it to the mirror as before', async () => {
    const receipt = await file(b.workspaceId, 'receipt');
    expect(await vaultRows(receipt)).toEqual([{ status: 'queued', destination_id: vault }]);
    expect(await mirrorRows(receipt)).toEqual([{ destination_id: mirror }]);
  });

  it('leaves out a group that is off: payslips here go to the mirror only', async () => {
    const payslip = await file(b.workspaceId, 'payslip');
    expect(await vaultRows(payslip)).toEqual([]);
    expect(await mirrorRows(payslip)).toEqual([{ destination_id: mirror }]);
  });

  it('never queues sealed copies, logos or exports', async () => {
    await admin.query(
      `update app.storage_destination set file_kinds = array['statement', 'receipt', 'payslip', 'lease', 'invoice',
                                                              'other', 'tax_form']
        where id = $1`,
      [vault],
    );
    try {
      for (const [kind, sealed] of [
        ['other', true],
        ['receipt', true],
        ['logo', false],
        ['export', false],
      ] as const) {
        const id = await file(b.workspaceId, kind, sealed);
        expect(await vaultRows(id), `${kind} sealed=${sealed}`).toEqual([]);
        expect(await mirrorRows(id), `${kind} sealed=${sealed}`).toEqual([]);
      }
    } finally {
      await admin.query(
        `update app.storage_destination set file_kinds = array['statement', 'receipt', 'invoice'] where id = $1`,
        [vault],
      );
    }
  });

  it('sends nothing while the vault connection is paused or switched off', async () => {
    await admin.query(`update app.storage_destination set status = 'paused' where id = $1`, [vault]);
    const paused = await file(b.workspaceId, 'statement');
    await admin.query(
      `update app.storage_destination set status = 'active', mirror_files = false where id = $1`,
      [vault],
    );
    const off = await file(b.workspaceId, 'statement');
    await admin.query(`update app.storage_destination set mirror_files = true where id = $1`, [vault]);
    expect(await vaultRows(paused)).toEqual([]);
    expect(await vaultRows(off)).toEqual([]);
  });

  it('withdraws an Inbox item, keeps a filed document, and drops the rest when a file is deleted for good', async () => {
    const received = await file(b.workspaceId, 'receipt');
    const filed = await file(b.workspaceId, 'receipt');
    const queued = await file(b.workspaceId, 'receipt');
    await admin.query(
      `update app.vault_item set status = 'received', vault_ref = 'in-' || file_id where file_id = $1`,
      [received],
    );
    await admin.query(
      `update app.vault_item set status = 'filed', vault_ref = 'f-' || file_id, vault_document_id = 'doc-' || file_id,
              filed_at = now()
        where file_id = $1`,
      [filed],
    );
    await admin.query(`delete from app.file where id = any ($1)`, [[received, filed, queued]]);
    expect(await vaultRows(received)).toEqual([{ status: 'delete', destination_id: vault }]);
    expect(await vaultRows(filed)).toEqual([]);
    expect(await vaultRows(queued)).toEqual([]);
  });

  it('deletes a filed document in the vault only when the owner asked and the vault allows it', async () => {
    const filed = async () => {
      const id = await file(b.workspaceId, 'statement');
      await admin.query(
        `update app.vault_item set status = 'filed', vault_ref = 'f-' || file_id,
                vault_document_id = 'doc-' || file_id, filed_at = now()
          where file_id = $1`,
        [id],
      );
      await admin.query(`delete from app.file where id = $1`, [id]);
      return vaultRows(id);
    };
    await admin.query(
      `update app.storage_destination set delete_with_montra = true, can_delete = false where id = $1`,
      [vault],
    );
    expect(await filed()).toEqual([]);
    await admin.query(`update app.storage_destination set can_delete = true where id = $1`, [vault]);
    expect(await filed()).toEqual([{ status: 'delete', destination_id: vault }]);
    await admin.query(`update app.storage_destination set delete_with_montra = false where id = $1`, [vault]);
  });
});

describe('the job’s functions (ADR-0054 §12)', () => {
  let vault: string;
  let mirror: string;
  beforeAll(async () => {
    vault = await destination(a.workspaceId, 'fdv');
    mirror = await destination(a.workspaceId, 's3');
    await admin.query(
      `insert into app.vault_connection_state (workspace_id, destination_id, next_check_at)
       values ($1, $2, now() + interval '1 day')`,
      [a.workspaceId, vault],
    );
  });
  afterAll(() => dropDestinations(a.workspaceId));

  const due = () =>
    asRole('montra_app', async (c) => {
      const { rows } = await c.query<{ destination_id: string; user_id: string }>(
        `select destination_id, user_id from app.vault_due() where workspace_id = $1`,
        [a.workspaceId],
      );
      return rows;
    });
  const mirrorDue = () =>
    asRole('montra_app', async (c) => {
      const { rows } = await c.query(
        `select destination_id from app.storage_mirror_due() where workspace_id = $1`,
        [a.workspaceId],
      );
      return rows;
    });

  it('is due for a row that is due, acting as an owner, and the mirror’s job never sees the vault', async () => {
    expect(await due()).toEqual([]);
    const id = await file(a.workspaceId, 'receipt');
    expect(await due()).toEqual([{ destination_id: vault, user_id: a.ownerId }]);
    expect(await mirrorDue()).toEqual([{ destination_id: mirror }]);
    const next = await asRole(
      'montra_app',
      async (c) => (await c.query(`select app.vault_next() as t`)).rows[0].t,
    );
    expect(next).toBeInstanceOf(Date);
    await admin.query(`delete from app.file where id = $1`, [id]);
    await admin.query(`delete from app.storage_mirror_item where destination_id = $1`, [mirror]);
  });

  it('wakes the vault’s job a little after a file is queued (migration 0064)', async () => {
    await admin.query(`delete from app.job where type = 'storage.vault' and status = 'queued'`);
    const id = await file(a.workspaceId, 'receipt');
    const { rows } = await admin.query(
      `select run_after > now() + interval '1 minute' as later from app.job
        where type = 'storage.vault' and status = 'queued' and workspace_id is null`,
    );
    expect(rows).toEqual([{ later: true }]);
    await admin.query(`delete from app.job where type = 'storage.vault' and status = 'queued'`);
    await admin.query(`delete from app.file where id = $1`, [id]);
  });

  it('says whether Montra is still reading a file, to owners and admins only (§3)', async () => {
    const id = await file(a.workspaceId, 'receipt');
    const busy = (userId: string) =>
      as(a, userId, async (trx) => {
        const { rows } = await sql<{
          busy: boolean;
        }>`select app.vault_file_busy(${id}::uuid) as busy`.execute(trx);
        return rows[0]!.busy;
      });
    expect(await busy(a.ownerId)).toBe(false);
    const entity = (
      await admin.query(`select id from app.entity where workspace_id = $1 limit 1`, [a.workspaceId])
    ).rows[0].id;
    const receipt = (
      await admin.query(
        `insert into app.receipt (workspace_id, entity_id, attachment_ids, status, retain_until)
         values ($1, $2, array[$3::uuid], 'processing', '2033-01-01') returning id`,
        [a.workspaceId, entity, id],
      )
    ).rows[0].id;
    expect(await busy(a.ownerId)).toBe(true);
    await admin.query(`update app.receipt set status = 'needs_review' where id = $1`, [receipt]);
    expect(await busy(a.ownerId)).toBe(true);
    await admin.query(`update app.receipt set status = 'inbox' where id = $1`, [receipt]);
    expect(await busy(a.ownerId)).toBe(false);
    await admin.query(`update app.receipt set status = 'processing' where id = $1`, [receipt]);
    // Not for anyone else to ask.
    expect(await busy(memberId)).toBe(false);
    await admin.query(`delete from app.receipt where id = $1`, [receipt]);
    await admin.query(`delete from app.file where id = $1`, [id]);
  });

  it('gives a file’s badge for the current workspace only (§13)', async () => {
    const id = await file(a.workspaceId, 'receipt');
    const states = (f: Fixture, userId: string) =>
      as(f, userId, async (trx) => {
        const { rows } = await sql<{ file_id: string; status: string }>`
          select file_id, status from app.vault_file_states(array[${id}::uuid])`.execute(trx);
        return rows;
      });
    expect(await states(a, memberId)).toEqual([{ file_id: id, status: 'queued' }]);
    expect(await states(b, b.ownerId)).toEqual([]);
    await admin.query(`delete from app.file where id = $1`, [id]);
  });

  it('is due when its changes feed is, while active, and never because of it while it needs a person (migration 0065)', async () => {
    await admin.query(`delete from app.vault_item where destination_id = $1`, [vault]);
    await admin.query(`update app.storage_destination set status = 'active' where id = $1`, [vault]);
    await admin.query(
      `update app.vault_connection_state set next_check_at = now() + interval '1 day', feed_next_at = null
        where destination_id = $1`,
      [vault],
    );
    expect(await due()).toEqual([]);
    await admin.query(
      `update app.vault_connection_state set feed_next_at = now() - interval '1 second' where destination_id = $1`,
      [vault],
    );
    expect(await due()).toEqual([{ destination_id: vault, user_id: a.ownerId }]);
    const next = await asRole(
      'montra_app',
      async (c) => (await c.query(`select app.vault_next() as t`)).rows[0].t as Date,
    );
    expect(next.getTime()).toBeLessThanOrEqual(Date.now());
    await admin.query(`update app.storage_destination set status = 'needs_vault' where id = $1`, [vault]);
    expect(await due()).toEqual([]);
    await admin.query(`update app.storage_destination set status = 'active' where id = $1`, [vault]);
    await admin.query(`update app.vault_connection_state set feed_next_at = null where destination_id = $1`, [
      vault,
    ]);
  });

  it('says which document to open for a file, to members of its workspace only (§9, migration 0065)', async () => {
    const id = await file(a.workspaceId, 'receipt');
    await admin.query(
      `update app.vault_item set status = 'filed', vault_ref = 'm1-open', filed_at = now(), vault_document_id = 'doc-9'
        where file_id = $1`,
      [id],
    );
    const target = (f: Fixture, userId: string) =>
      as(f, userId, async (trx) => {
        const { rows } = await sql<{
          destination_id: string;
          document_id: string;
          status: string;
          user_id: string;
        }>`
          select * from app.vault_file_open(${id}::uuid)`.execute(trx);
        return rows;
      });
    const expected = [{ destination_id: vault, document_id: 'doc-9', status: 'filed', user_id: a.ownerId }];
    expect(await target(a, memberId)).toEqual(expected);
    expect(await target(a, viewerId)).toEqual(expected);
    expect(await target(b, b.ownerId)).toEqual([]);
    // A link is never kept: nothing in the vault's tables has a place for one.
    const { rows } = await admin.query(
      `select column_name from information_schema.columns
        where table_schema = 'app' and table_name in ('vault_item', 'vault_connection_state')
          and column_name ~ '(link|url)'`,
    );
    expect(rows).toEqual([]);
    await admin.query(`delete from app.file where id = $1`, [id]);
  });

  it('looks only at its check while the vault needs a person, and at nothing while paused', async () => {
    await file(a.workspaceId, 'receipt');
    await admin.query(`update app.storage_destination set status = 'needs_vault' where id = $1`, [vault]);
    expect(await due()).toEqual([]);
    await admin.query(
      `update app.vault_connection_state set next_check_at = now() where destination_id = $1`,
      [vault],
    );
    expect(await due()).toEqual([{ destination_id: vault, user_id: a.ownerId }]);
    await admin.query(`update app.storage_destination set status = 'paused' where id = $1`, [vault]);
    expect(await due()).toEqual([]);
  });
});
