/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NetworkError } from '@fdv/client';
import { VaultError } from '../src/storage/destinations/vault.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { asVaultError, feedPage } from '../src/storage/vault/connection.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { FEED_MS, VaultFeed } from '../src/storage/vault/vault.feed.js';
import { VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { VaultService } from '../src/storage/vault/vault.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Keeping in step with the household's Family Document Vault (ADR-0054 §9, PR 4): the changes feed for documents Montra
// sent, what the vault calls them, out of reach, starting over, and view links made when a person clicks. Against the
// vault's own fake from `@fdv/client/testing`, in this process; no real vault is ever reached. The vault's states are
// set through the fake's own state and functions, as its types offer.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-feed@example.com';
const PARTNER = 'partner-vault-feed@example.com';
const STRANGER = 'stranger-vault-feed@example.com';
const KINDS = ['bank_statement', 'utility_bill', 'pay_statement'];
const SCOPES = [
  'documents.send',
  'documents.read',
  'documents.download',
  'documents.links',
  'documents.delete',
];

let h: Harness;
let c: Client;
let partner: Client;
let stranger: Client;
let db: pg.Client;
let transport: VaultTransport & { fake: FakeVaultHandle };
let fake: FakeVaultHandle;
let jobs: VaultJobs;
let feed: VaultFeed;
let storage: StoragePort;
let wsId: string;
let appId: string;
let destinationId: string;
let url: (p: string) => string;
let realFetch: VaultTransport['fetch'];

const run = () => jobs.run({ sendGapMs: 0, settleMs: 0 });
const vaultRow = async () =>
  (await db.query(`select * from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [wsId]))
    .rows[0];
const state = async () =>
  (await db.query(`select * from app.vault_connection_state where workspace_id = $1`, [wsId])).rows[0];
const item = async (fileId: string) =>
  (await db.query(`select * from app.vault_item where file_id = $1`, [fileId])).rows[0];
const app = () => fake.vault.state.connectedApps!.find((a) => a.id === appId)! as any;
const vstate = () => fake.vault.state as any;
/** The feed is due now, and was last read long enough ago that opening a document catches it up first. */
const feedDue = () =>
  db.query(
    `update app.vault_connection_state
        set feed_next_at = now() - interval '1 second', feed_read_at = now() - interval '1 hour'
      where workspace_id = $1`,
    [wsId],
  );
const feedFresh = () =>
  db.query(
    `update app.vault_connection_state set feed_next_at = now() + interval '1 hour', feed_read_at = now()
      where workspace_id = $1`,
    [wsId],
  );
const changesCalls = () =>
  vstate().calls.filter((x: any) => x.path === '/api/v1/apps/changes').length as number;
const open = (fileId: string, who: Client = c, mode?: 'view' | 'download') =>
  who.post(url(`/family-vault/files/${fileId}/open${mode ? `?mode=${mode}` : ''}`));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** A file in Montra, as an upload stores it (text only: the fake reads a multipart body as UTF-8, As built: PR 3). */
async function file(kind: string, name: string): Promise<string> {
  const id = randomUUID();
  const bytes = Buffer.from(`%PDF-1.4\n% ${name} ${id}\n%%EOF\n`);
  const key = storageKey(wsId, kind, id);
  await storage.put(key, bytes, 'image/png');
  await db.query(
    `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256)
     values ($1, $2, $3, $4, $5, 'image/png', $6, $7)`,
    [wsId, id, kind, key, name, bytes.length, sha256(bytes)],
  );
  return id;
}

/** A document in the fake vault, with its file, as a person filing there makes one. */
function vaultDoc(opts: { title: string; type?: string; mime?: string; owned?: boolean }): string {
  const id = randomUUID();
  vstate().documents.push({
    id,
    title: opts.title,
    type_key: opts.type ?? 'utility_bill',
    visibility: 'household',
    sensitive: false,
    is_essential: false,
    issued: { date: daysAgo(10), precision: 'day' },
    expires: null,
    issued_by: null,
    extra: { amount: '99.00 USD', account_last4: '1234' },
    owner_member_id: null,
    household_owned: opts.owned ?? true,
  });
  addVersion(id, opts.mime ?? 'application/pdf', 1);
  return id;
}

function addVersion(documentId: string, mime: string, no: number) {
  const bytes = new TextEncoder().encode(`version ${no} of ${documentId}`);
  vstate().captures.set(`cap-${documentId}-${no}`, {
    kind: no === 1 ? 'capture' : 'version',
    document_id: documentId,
    version_id: randomUUID(),
    version_no: no,
    filename: 'paper.pdf',
    mime,
    byte_size: bytes.length,
    uploaded_at: new Date().toISOString(),
    bytes,
  });
}

const docOf = (id: string) => vstate().documents.find((d: any) => d.id === id);

/** A receipt's file, sent and then filed by a person in the fake vault as a document of its own. */
async function filed(name: string, opts: { mime?: string } = {}) {
  const fileId = await file('receipt', name);
  await run();
  const ref = (await item(fileId)).vault_ref as string;
  expect(ref).toBeTruthy();
  const doc = vaultDoc({ title: `${name} in the vault`, ...(opts.mime ? { mime: opts.mime } : {}) });
  fake.vault.fileAppIntake(appId, ref, doc);
  return { fileId, ref, doc };
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', FAMILY_VAULT_FAKE: 'on' });
  transport = h.app.get(VAULT_TRANSPORT);
  fake = transport.fake;
  realFetch = transport.fetch;
  jobs = h.app.get(VaultJobs);
  feed = h.app.get(VaultFeed);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(OWNER);
  partner = h.as(PARTNER);
  stranger = h.as(STRANGER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  wsId = (await c.post('/v1/workspaces', { name: 'Vault feed', baseCurrency: 'USD', template: 'household' }))
    .body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  const invite = await c.post(url('/sharing/invites'), { email: PARTNER, role: 'partner' });
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  await stranger.post('/v1/workspaces', { name: 'Someone else', baseCurrency: 'USD', template: 'household' });

  const started = await c.post(url('/family-vault'));
  const registered = await fake.register(started.body.publicKey, { kinds: KINDS, scopes: SCOPES });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault/code'), {
    code: registered.code,
    version: started.body.version,
  });
  expect(pasted.body.stage).toBe('connected');
  destinationId = pasted.body.id;
  const mapped = await c.patch(url('/family-vault'), {
    version: pasted.body.version,
    groups: [{ group: 'receipts', vaultKind: 'utility_bill' }],
  });
  expect(mapped.status).toBe(200);
});

afterEach(() => {
  (transport as any).fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.query(`delete from app.storage_destination where workspace_id = $1`, [wsId]);
  // Nothing of ours may wake a worker in another test file.
  await db.query(`delete from app.job where type = 'storage.vault'`);
  await db.end();
  await h.close();
});

describe('the feed in Montra’s terms (ADR-0054 §9)', () => {
  it('keeps what the vault calls a document, and nothing about amounts, issuers or digits', () => {
    const page = feedPage(
      {
        changes: [
          {
            change: 'changed',
            at: '2026-11-17T10:00:00Z',
            document: {
              id: 'doc-1',
              kind: { key: 'bank_statement', label: 'Bank statement', category: 'financial' },
              title: 'October 2026',
              paper_date: '2026-10-31',
              issued: { date: '2026-10-31', precision: 'month' },
              expires: null,
              due_date: null,
              amount: { text: '12.00 USD', value: '12.00', currency: 'USD' },
              issuer: 'Bank',
              account_last4: '9876',
              period: null,
              tax_year: null,
              status: { value: 'ok', label: 'OK' },
              version: { id: 'v-1', sha256: 'a'.repeat(64), byte_size: 3, content_type: 'application/pdf' },
              own: true,
              external_id: 'm1-abc',
              updated_at: '2026-11-17T10:00:00Z',
            },
          },
          { change: 'unavailable', at: '2026-11-17T10:00:01Z', document_id: 'doc-2' },
        ],
        cursor: 'next',
        more: false,
      } as any,
      false,
    );
    expect(page).toEqual({
      changes: [
        {
          documentId: 'doc-1',
          change: 'updated',
          own: true,
          ref: 'm1-abc',
          kind: { key: 'bank_statement', name: 'Bank statement' },
          title: 'October 2026',
          date: '2026-10-31',
          version: 'v-1',
          sha256: 'a'.repeat(64),
        },
        { documentId: 'doc-2', change: 'out_of_reach' },
      ],
      cursor: 'next',
      more: false,
      restart: false,
    });
    expect(JSON.stringify(page)).not.toMatch(/9876|12\.00|Bank"/);
  });

  it('says why the vault couldn’t be reached by its code alone, never an address (client 0.9.0-dev.61)', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), {
      code: 'ECONNREFUSED',
    });
    const coded = asVaultError(
      new NetworkError('offline', undefined, { cause: new TypeError('fetch failed', { cause: refused }) }),
    );
    expect(coded.code).toBe('unreachable');
    expect(coded.opts.detail).toBe('offline ECONNREFUSED');
    const worded = asVaultError(
      new NetworkError('offline', undefined, { cause: new Error('connect to 203.0.113.9 failed') }),
    );
    expect(worded.opts.detail).toBe('offline');
    expect(asVaultError(new NetworkError('timeout')).opts.detail).toBe('timeout');
  });

  it('turns the vault’s hourly link limit into a wait, not a failure', () => {
    const err = new VaultError('links_full', { retryAfter: new Date(Date.now() + 60_000) });
    expect(err.countsAsFailure).toBe(false);
    expect(err.stopsConnection).toBe(false);
    expect(new ApiRequestError(429, 'app_links_full', 'x').status).toBe(429);
  });
});

describe('keeping in step (ADR-0054 §9)', () => {
  it('reads the whole feed first, then only what changed, keeping the vault’s name and kind on the file', async () => {
    const a = await filed('Corner shop.png');
    const b = await filed('Hardware store.png');
    expect((await state()).feed_next_at).not.toBeNull();
    await feedDue();
    await run();
    const s = await state();
    expect(s.feed_cursor).toMatch(/^feed-\d+$/);
    expect(s.full_read_at).not.toBeNull();
    expect(s.full_read_started_at).toBeNull();
    expect(s.feed_next_at.getTime()).toBeGreaterThan(Date.now() + FEED_MS - 60_000);
    const rowA = await item(a.fileId);
    expect(rowA).toMatchObject({ status: 'filed', vault_document_id: a.doc });
    expect(rowA.vault_meta).toMatchObject({
      documentId: a.doc,
      kind: 'Utility / bill',
      kindKey: 'utility_bill',
      title: 'Corner shop.png in the vault',
      newerVersion: false,
    });
    expect(rowA.vault_meta).not.toHaveProperty('amount');
    expect(JSON.stringify(rowA.vault_meta)).not.toMatch(/99\.00|1234/);
    expect((await item(b.fileId)).vault_meta.title).toBe('Hardware store.png in the vault');

    // The family renames one in the vault: only that change is read, from where Montra left off.
    const before = s.feed_cursor;
    docOf(a.doc).title = 'Corner shop, October';
    await feedDue();
    await run();
    expect((await item(a.fileId)).vault_meta.title).toBe('Corner shop, October');
    expect((await state()).feed_cursor).not.toBe(before);
    const badge = (await partner.get(url(`/family-vault/files?ids=${a.fileId}`))).body.data[0];
    expect(badge.vault).toEqual({
      status: 'filed',
      title: 'Corner shop, October',
      kind: 'Utility / bill',
      newerVersion: false,
      notKeptReason: null,
      canOpen: true,
    });
    expect((await c.get(url('/family-vault'))).body.connection.feedReadAt).not.toBeNull();
  });

  it('never changes the books: the vault’s name, kind and amounts stay on the outbox row', async () => {
    const { fileId, doc } = await filed('Grocer.png');
    const entity = (
      await db.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
    ).rows[0].id;
    await db.query(
      `insert into app.receipt (workspace_id, entity_id, status, merchant, receipt_date, currency, total_minor,
                                attachment_ids, retain_until)
       values ($1, $2, 'inbox', 'Grocer', '2026-11-03', 'USD', 4250, array[$3::uuid], '2033-12-31')`,
      [wsId, entity, fileId],
    );
    expect(
      (
        await c.post(url('/accounts'), {
          name: 'Joint checking',
          kind: 'checking',
          openingBalance: { amount: '500000', currency: 'USD' },
          openingDate: '2026-11-01',
        })
      ).status,
    ).toBe(201);
    const books = async () =>
      (
        await db.query(
          `select
             (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from app.transaction t
               where t.workspace_id = $1) as transactions,
             (select md5(coalesce(string_agg(e::text, ',' order by e.id), '')) from app.journal_entry e
               where e.workspace_id = $1) as entries,
             (select md5(coalesce(string_agg(p::text, ',' order by p::text), '')) from app.posting p
               where p.workspace_id = $1) as postings,
             (select count(*)::int from app.posting p where p.workspace_id = $1) as n,
             (select md5(coalesce(string_agg(r::text, ',' order by r.id), '')) from app.receipt r
               where r.workspace_id = $1) as receipts,
             (select md5(f::text) from app.file f where f.id = $2) as file`,
          [wsId, fileId],
        )
      ).rows[0];
    const was = await books();
    expect(was.n).toBeGreaterThan(0);
    // The vault says it is another kind, with another title and an amount: the vault wins on the document only.
    Object.assign(docOf(doc), { title: 'Groceries, renamed in the vault', type_key: 'bank_statement' });
    docOf(doc).extra = { amount: '1.00 USD', account_last4: '0000' };
    await feedDue();
    await run();
    const row = await item(fileId);
    expect(row.vault_meta).toMatchObject({
      title: 'Groceries, renamed in the vault',
      kind: 'Bank statement',
    });
    expect(await books()).toEqual(was);
    expect(
      (
        await db.query(
          `select total_minor::text, merchant from app.receipt where $1 = any (attachment_ids)`,
          [fileId],
        )
      ).rows[0],
    ).toEqual({ total_minor: '4250', merchant: 'Grocer' });
  });

  it('says when the family put a newer version in the vault, and doesn’t re-read it', async () => {
    const { fileId, doc } = await filed('Newer.png');
    await feedDue();
    await run();
    const was = await item(fileId);
    // Montra may read a document beyond its own only through a grant (one it doesn't ask for); with one, the vault
    // shows the newer version as a change.
    app().grants = [{ category: 'bills', lookback_months: 12, sensitive_kinds: [] }];
    try {
      addVersion(doc, 'application/pdf', 2);
      await feedDue();
      await run();
      const row = await item(fileId);
      expect(row.vault_meta.newerVersion).toBe(true);
      expect(row.vault_version).toBe(was.vault_version);
      expect(row.status).toBe('filed');
      const badge = (await c.get(url(`/family-vault/files?ids=${fileId}`))).body.data[0];
      expect(badge.vault.newerVersion).toBe(true);
      // Montra's own file is as it was: nothing re-read, nothing replaced.
      expect((await db.query(`select sha256 from app.file where id = $1`, [fileId])).rows[0].sha256).toBe(
        (await item(fileId)).vault_sha256,
      );
    } finally {
      app().grants = [];
    }
  });

  it('never stores or imports a document it didn’t send, whatever the vault lets it read', async () => {
    const files = Number(
      (await db.query(`select count(*) from app.file where workspace_id = $1`, [wsId])).rows[0].count,
    );
    const items = Number(
      (await db.query(`select count(*) from app.vault_item where workspace_id = $1`, [wsId])).rows[0].count,
    );
    const theirs = vaultDoc({ title: 'A family paper filed straight into the vault' });
    app().grants = [{ category: 'bills', lookback_months: 12, sensitive_kinds: [] }];
    try {
      await feedDue();
      await run();
      expect(
        Number(
          (await db.query(`select count(*) from app.file where workspace_id = $1`, [wsId])).rows[0].count,
        ),
      ).toBe(files);
      expect(
        Number(
          (await db.query(`select count(*) from app.vault_item where workspace_id = $1`, [wsId])).rows[0]
            .count,
        ),
      ).toBe(items);
      const anywhere = await db.query(`select 1 from app.vault_item where vault_document_id = $1`, [theirs]);
      expect(anywhere.rows).toEqual([]);
      const named = await db.query(
        `select 1 from app.vault_item where vault_meta::text like '%family paper%'`,
      );
      expect(named.rows).toEqual([]);
    } finally {
      app().grants = [];
      vstate().documents = vstate().documents.filter((d: any) => d.id !== theirs);
    }
  });

  it('saves its place after each page and goes on from there', async () => {
    // A hundred and fifty of the family's papers the vault lets Montra read, so the full read takes two pages.
    const extra: string[] = [];
    for (let n = 0; n < 150; n++) extra.push(vaultDoc({ title: `Family paper ${n}` }));
    app().grants = [{ category: 'bills', lookback_months: 12, sensitive_kinds: [] }];
    try {
      await db.query(
        `update app.vault_connection_state set feed_cursor = 'not-a-position' where workspace_id = $1`,
        [wsId],
      );
      const ctx = { workspaceId: wsId, userId: (await vaultRow()).created_by };
      const row = await vaultRow();
      const conn = await h.app.get(VaultService).openRow(ctx, row);
      try {
        const first = await feed.read(ctx, destinationId, conn, Date.now() + 30_000, 1);
        expect(first).toMatchObject({ caughtUp: false, pages: 1, restarted: true });
        const mid = await state();
        expect(mid.feed_cursor).toMatch(/^snap-/);
        expect(mid.full_read_started_at).not.toBeNull();
        // Resumed from the saved place: the rest of the full read, then the end.
        const asked: (string | null)[] = [];
        const rest = await feed.read(
          ctx,
          destinationId,
          {
            changes: (cursor: string | null) => {
              asked.push(cursor);
              return conn.changes(cursor);
            },
          },
          Date.now() + 30_000,
        );
        expect(asked[0]).toBe(mid.feed_cursor);
        expect(rest.caughtUp).toBe(true);
        const done = await state();
        expect(done.full_read_started_at).toBeNull();
        expect(done.feed_cursor).toMatch(/^feed-\d+$/);
      } finally {
        conn.close();
      }
    } finally {
      app().grants = [];
      vstate().documents = vstate().documents.filter((d: any) => !extra.includes(d.id));
    }
  });

  it('marks a document the vault no longer shows as out of reach, and filed again when it shows it again', async () => {
    const { fileId, doc } = await filed('Hidden.png');
    await feedDue();
    await run();
    expect((await item(fileId)).status).toBe('filed');
    // The family moves it where Montra may not see it: the vault says only that it is unavailable.
    docOf(doc).visibility = 'private';
    await feedDue();
    await run();
    expect((await item(fileId)).status).toBe('out_of_reach');
    const badge = (await c.get(url(`/family-vault/files?ids=${fileId}`))).body.data[0];
    expect(badge.vault).toMatchObject({ status: 'out_of_reach', canOpen: false });
    // Montra keeps its copy: nothing else changes.
    expect(badge).toMatchObject({ location: 'montra', missing: null });
    expect((await c.get(url('/family-vault'))).body.connection.items.outOfReach).toBeGreaterThanOrEqual(1);
    expect((await open(fileId)).status).toBe(410);

    docOf(doc).visibility = 'household';
    await feedDue();
    await run();
    expect((await item(fileId)).status).toBe('filed');
  });

  it('reads the whole feed again when the vault says its place is too old, and treats what it doesn’t show as out of reach', async () => {
    const kept = await filed('Kept.png');
    const lost = await filed('Lost in a restore.png');
    await feedDue();
    await run();
    expect((await item(lost.fileId)).status).toBe('filed');
    // The vault was restored from a backup: the document is gone, its feed starts again, and Montra's place is too old.
    vstate().documents = vstate().documents.filter((d: any) => d.id !== lost.doc);
    app().feed_pruned_to = (app().feed.at(-1)?.seq ?? 0) + 1;
    await feedDue();
    await run();
    const s = await state();
    expect(s.full_read_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(s.full_read_started_at).toBeNull();
    expect((await item(lost.fileId)).status).toBe('out_of_reach');
    expect((await item(kept.fileId)).status).toBe('filed');
    // A place the vault doesn't know at all is the same: start over.
    await db.query(`update app.vault_connection_state set feed_cursor = 'garbage' where workspace_id = $1`, [
      wsId,
    ]);
    await feedDue();
    await run();
    expect((await state()).feed_cursor).toMatch(/^feed-\d+$/);
    expect((await item(kept.fileId)).status).toBe('filed');
  });

  it('stops the connection for a problem with it while reading the feed, and counts not reaching the vault', async () => {
    await feedFresh();
    // Can't reach it: a failure, and the feed waits on the backoff.
    (transport as any).fetch = async (u: string, init: any) => {
      if (u.includes('/api/v1/apps/changes')) throw new TypeError('socket hang up');
      return realFetch(u, init);
    };
    const failures = (await vaultRow()).consecutive_failures;
    await feedDue();
    await run();
    expect((await vaultRow()).consecutive_failures).toBe(failures + 1);
    expect((await state()).feed_next_at.getTime()).toBeGreaterThan(Date.now());
    (transport as any).fetch = realFetch;

    app().paused = 'owner';
    try {
      await feedDue();
      await run();
      expect((await vaultRow()).status).toBe('needs_vault');
    } finally {
      app().paused = null;
      await db.query(`update app.vault_connection_state set next_check_at = now() where workspace_id = $1`, [
        wsId,
      ]);
      await run();
      expect((await vaultRow()).status).toBe('active');
    }
  });

  it('never reads the feed when the vault doesn’t let Montra read', async () => {
    const was = app().scopes;
    app().scopes = ['documents.send'];
    try {
      expect((await c.post(url('/family-vault/check'))).status).toBe(200);
      expect((await state()).feed_next_at).toBeNull();
      const calls = changesCalls();
      await db.query(`update app.vault_connection_state set feed_read_at = null where workspace_id = $1`, [
        wsId,
      ]);
      await file('receipt', 'Send only.png');
      await run();
      expect(changesCalls()).toBe(calls);
    } finally {
      app().scopes = was;
      expect((await c.post(url('/family-vault/check'))).status).toBe(200);
      expect((await state()).feed_next_at).not.toBeNull();
    }
  });
});

describe('opening a document in the vault (ADR-0054 §9)', () => {
  let doc: { fileId: string; ref: string; doc: string };
  beforeAll(async () => {
    doc = await filed('To open.png');
    await feedDue();
    await run();
    app().links = [];
  });

  it('makes a single-use link when the person clicks, and answers with a redirect to it at once', async () => {
    const before = (app().links ?? []).length;
    const one = await open(doc.fileId, partner);
    expect(one.status).toBe(303);
    expect(one.headers.location).toMatch(/^https:\/\/fake\.example\/api\/v1\/app-links\/[A-Za-z0-9_-]+$/);
    expect(one.headers['cache-control']).toBe('no-store');
    expect(one.headers['referrer-policy']).toBe('no-referrer');
    expect(one.body).toBeUndefined();
    const two = await open(doc.fileId);
    expect(two.status).toBe(303);
    // Each click makes its own: one link is never handed out twice.
    expect(two.headers.location).not.toBe(one.headers.location);
    expect(app().links.length).toBe(before + 2);
    expect(app().links.at(-1).mode).toBe('view');
    // Audited: who and which file, never the link.
    const audit = (
      await db.query(
        `select a.diff, u.email from app.audit_log a join app.app_user u on u.id = a.actor_user_id
          where a.workspace_id = $1 and a.action = 'file.vault_link_made' and a.subject_id = $2 order by a.id`,
        [wsId, doc.fileId],
      )
    ).rows;
    expect(audit).toEqual([
      { diff: { mode: 'view' }, email: PARTNER },
      { diff: { mode: 'view' }, email: OWNER },
    ]);
  });

  it('never stores, logs or returns the link anywhere but the redirect', async () => {
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    let location: string;
    try {
      location = String((await open(doc.fileId, c, 'download')).headers.location);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const token = location.split('/').at(-1)!;
    expect(token.length).toBeGreaterThan(20);
    expect(written.join('')).not.toContain(token);
    // Nowhere in the database, in any table.
    const tables = (
      await db.query(
        `select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name as string);
    for (const t of tables) {
      const { rows } = await db.query(`select count(*)::int as n from app."${t}" x where x::text like $1`, [
        `%${token}%`,
      ]);
      expect(rows[0].n, t).toBe(0);
    }
    // Nor in what the badges and Settings say.
    const said = JSON.stringify([
      (await c.get(url(`/family-vault/files?ids=${doc.fileId}`))).body,
      (await c.get(url('/family-vault'))).body,
      (await c.get(url('/family-vault/items?status=filed'))).body,
    ]);
    expect(said).not.toContain(token);
    expect(said).not.toContain('app-links');
  });

  it('opens only for someone who can see the file, and only with a click (POST)', async () => {
    expect((await stranger.post(url(`/family-vault/files/${doc.fileId}/open`))).status).toBe(403);
    expect((await c.post(url(`/family-vault/files/${randomUUID()}/open`))).status).toBe(404);
    expect((await c.post(url('/family-vault/files/nope/open'))).status).toBe(400);
    expect((await c.get(url(`/family-vault/files/${doc.fileId}/open`))).status).toBe(404);
    const notSent = await file('lease', 'Lease.pdf');
    expect((await open(notSent)).body.code).toBe('vault.not_in_vault');
    const waiting = await file('receipt', 'Still in the Inbox.png');
    await run();
    expect((await open(waiting)).body.code).toBe('vault.not_filed');
  });

  it('waits out the vault’s hourly link limit, in words, without counting it as a failure', async () => {
    app().links = [];
    app().links_per_hour = 1;
    try {
      expect((await open(doc.fileId)).status).toBe(303);
      const full = await open(doc.fileId);
      expect(full.status).toBe(429);
      expect(full.body.code).toBe('vault.links_full');
      expect(full.body.detail).toMatch(/as many documents/);
      expect(Number(full.headers['retry-after'])).toBeGreaterThan(0);
      const row = await vaultRow();
      expect(row.status).toBe('active');
      expect(row.consecutive_failures).toBe(0);
    } finally {
      app().links_per_hour = 60;
      app().links = [];
    }
  });

  it('opens a type the vault can’t draw as a download when it may, and says so in words when it may not', async () => {
    const odd = await filed('Odd type.png', { mime: 'application/octet-stream' });
    await feedDue();
    await run();
    const res = await open(odd.fileId);
    expect(res.status).toBe(303);
    expect(app().links.at(-1).mode).toBe('download');
    const was = app().scopes;
    app().scopes = was.filter((s: string) => s !== 'documents.download');
    try {
      await c.post(url('/family-vault/check'));
      const words = await open(odd.fileId);
      expect(words.status).toBe(422);
      expect(words.body.code).toBe('vault.cannot_view');
      expect((await vaultRow()).status).toBe('active');
    } finally {
      app().scopes = was;
      await c.post(url('/family-vault/check'));
    }
  });

  it('says the vault doesn’t let Montra open documents, and goes on sending', async () => {
    const was = app().scopes;
    app().scopes = was.filter((s: string) => s !== 'documents.links');
    try {
      await c.post(url('/family-vault/check'));
      const res = await open(doc.fileId);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('vault.cannot_open');
      expect((await vaultRow()).status).toBe('active');
    } finally {
      app().scopes = was;
      await c.post(url('/family-vault/check'));
    }
  });

  it('catches up the feed before opening, so a document the vault no longer shows says so', async () => {
    const gone = await filed('Gone before opening.png');
    await feedDue();
    await run();
    await feedFresh();
    docOf(gone.doc).visibility = 'private';
    // Read recently: the vault's own answer to the link says it, and the job reads the feed again now.
    const refused = await open(gone.fileId);
    expect(refused.status).toBe(410);
    expect(refused.body.detail).toBe('No longer available in Family Document Vault.');
    expect((await state()).feed_next_at.getTime()).toBeLessThanOrEqual(Date.now());
    // Not read for a while: the feed is caught up first, and the row says it.
    docOf(gone.doc).visibility = 'household';
    await feedDue();
    await run();
    expect((await item(gone.fileId)).status).toBe('filed');
    docOf(gone.doc).visibility = 'private';
    await db.query(
      `update app.vault_connection_state set feed_read_at = now() - interval '1 hour' where workspace_id = $1`,
      [wsId],
    );
    const links = app().links.length;
    expect((await open(gone.fileId)).status).toBe(410);
    expect((await item(gone.fileId)).status).toBe('out_of_reach');
    expect(app().links.length).toBe(links);
  });
});
