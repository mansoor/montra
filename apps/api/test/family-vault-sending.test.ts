/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@fdv/client';
import { VaultError } from '../src/storage/destinations/vault.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../src/storage/storage.js';
import { MAX_ATTEMPTS } from '../src/storage/storage-mirror.jobs.js';
import { asVaultError, hintsOf, itemState, VaultConnection } from '../src/storage/vault/connection.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { NOT_KEPT_WORDS, VaultJobs, vaultRef } from '../src/storage/vault/vault.jobs.js';
import { VAULT_FAILING_AFTER } from '../src/storage/vault/vault.service.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Sending to the household's Family Document Vault (ADR-0054 §3, §4, §6, §12, PR 3), against the vault's own fake from
// `@fdv/client/testing`, in this process. No real vault is ever reached; failures at the network level are made by a
// `fetch` that rejects, and the vault's own states are set through the fake's own state and functions.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-send@example.com';
const ADMIN = 'admin-vault-send@example.com';
const PARTNER = 'partner-vault-send@example.com';
const KINDS = ['bank_statement', 'utility_bill', 'pay_statement'];

let h: Harness;
let c: Client;
let adminUser: Client;
let partner: Client;
let db: pg.Client;
let transport: VaultTransport & { fake: FakeVaultHandle };
let fake: FakeVaultHandle;
let jobs: VaultJobs;
let storage: StoragePort;
let wsId: string;
let appId: string;
let url: (p: string) => string;
let realFetch: VaultTransport['fetch'];

const run = () => jobs.run({ sendGapMs: 0, settleMs: 0 });
const vaultRow = async () =>
  (await db.query(`select * from app.storage_destination where workspace_id = $1 and kind = 'fdv'`, [wsId]))
    .rows[0];
const item = async (fileId: string) =>
  (await db.query(`select * from app.vault_item where file_id = $1`, [fileId])).rows[0];
const dueNow = () =>
  db.query(
    `update app.vault_item set next_attempt_at = now() - interval '1 second'
      where workspace_id = $1 and status in ('queued', 'pending', 'received', 'delete')`,
    [wsId],
  );
const app = () => fake.vault.state.connectedApps!.find((a) => a.id === appId)!;
const intake = (ref: string) => app().intake.get(ref) as any;
const get = async () => (await c.get(url('/family-vault'))).body.connection;
const patch = async (body: Record<string, unknown>, who: Client = c) =>
  who.patch(url('/family-vault'), { version: (await get()).version, ...body });
const notifications = async (type: string) =>
  (
    await db.query(
      `select u.email, count(*)::int as n from app.notification n join app.app_user u on u.id = n.user_id
        where n.workspace_id = $1 and n.type = $2 group by u.email order by u.email`,
      [wsId, type],
    )
  ).rows;

/** Runs `fn` as if the person signed in more than ten minutes ago (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** A file in Montra, as an upload stores it: its bytes in storage, its row (which fires the trigger). */
async function file(
  kind: string,
  name: string,
  opts: { mime?: string; bytes?: Buffer; ws?: string; sealed?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const ws = opts.ws ?? wsId;
  // Text only: the fake vault reads a multipart body as UTF-8, so binary bytes wouldn't hash as sent (As built: PR 3).
  const bytes =
    opts.bytes ??
    Buffer.from(`%PDF-1.4
% ${name} ${id}
%%EOF
`);
  const key = storageKey(ws, kind, id);
  await storage.put(key, bytes, opts.mime ?? 'image/png');
  await db.query(
    `insert into app.file (workspace_id, id, kind, storage_key, file_name, mime, bytes, sha256, sealed)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [ws, id, kind, key, name, opts.mime ?? 'image/png', bytes.length, sha256(bytes), opts.sealed ?? false],
  );
  return id;
}

/** Wraps the fake's `fetch` for one test: counts what is sent, and can drop an answer at the socket. */
function watch(onIntake?: (n: number) => Promise<'drop' | void>) {
  const seen = { intake: 0, inFlight: 0, maxInFlight: 0, refs: [] as string[] };
  (transport as any).fetch = async (u: string, init: any) => {
    const isIntake = u.endsWith('/api/v1/apps/intake') && init?.method === 'POST';
    if (!isIntake) return realFetch(u, init);
    seen.intake++;
    seen.inFlight++;
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    try {
      const body = Buffer.from(init.upload?.bytes ?? init.body ?? []).toString('latin1');
      const ref = /"external_id":"([^"]+)"/.exec(body)?.[1];
      if (ref) seen.refs.push(ref);
      await new Promise((r) => setTimeout(r, 5));
      const res = await realFetch(u, init);
      if ((await onIntake?.(seen.intake)) === 'drop') throw new TypeError('socket hang up');
      return res;
    } finally {
      seen.inFlight--;
    }
  };
  return seen;
}

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake', FAMILY_VAULT_FAKE: 'on' });
  transport = h.app.get(VAULT_TRANSPORT);
  fake = transport.fake;
  realFetch = transport.fetch;
  jobs = h.app.get(VaultJobs);
  storage = h.app.get(STORAGE_PORT);
  c = h.as(OWNER);
  adminUser = h.as(ADMIN);
  partner = h.as(PARTNER);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Vault sending', baseCurrency: 'USD', template: 'household' })
  ).body;
  wsId = ws.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  for (const [who, email, role] of [
    [adminUser, ADMIN, 'admin'],
    [partner, PARTNER, 'partner'],
  ] as const) {
    const invite = await c.post(url('/sharing/invites'), { email, role });
    expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  }
  const started = await c.post(url('/family-vault'));
  const registered = await fake.register(started.body.publicKey, { kinds: KINDS });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault/code'), {
    code: registered.code,
    version: started.body.version,
  });
  expect(pasted.body.stage).toBe('connected');
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

describe('the vault’s answers, in Montra’s terms (ADR-0054 §4, §12)', () => {
  it('waits when the vault is busy, as for a recipient paused at that moment: a retry, not a failure', () => {
    const busy = asVaultError(
      new ApiRequestError(503, 'busy', 'Try again shortly.', undefined, {
        retriable: true,
        retryAfterSeconds: 30,
      }),
      undefined,
      1_000_000,
    );
    expect(busy.code).toBe('retry_later');
    expect(busy.opts.retryAfter?.getTime()).toBe(1_030_000);
    expect(busy.stopsConnection).toBe(false);
  });

  it('reads every intake state, a filed one Montra may not see included', () => {
    const base = {
      external_id: 'm1-x',
      received_at: '2026-11-17T10:00:00Z',
      sha256: 'a'.repeat(64),
      byte_size: 10,
      document_id: null,
      version_id: null,
      filed_at: null,
      removed_reason: null,
      refusal: null,
      content_available: false,
    } as const;
    expect(itemState({ ...base, state: 'waiting' })).toEqual({
      state: 'received',
      sha256: 'a'.repeat(64),
      contentAvailable: false,
    });
    expect(itemState({ ...base, state: 'unavailable' })).toMatchObject({ state: 'filed', documentId: null });
    expect(
      itemState({
        ...base,
        state: 'filed',
        document_id: 'd1',
        filed_at: '2026-11-17T11:00:00Z',
        content_available: true,
      }),
    ).toMatchObject({ state: 'filed', documentId: 'd1', contentAvailable: true });
    expect(itemState({ ...base, state: 'removed', removed_reason: 'declined' })).toMatchObject({
      why: 'removed',
    });
    expect(itemState({ ...base, state: 'removed', removed_reason: 'expired' })).toMatchObject({
      why: 'lapsed',
    });
    expect(itemState({ ...base, state: 'refused', refusal: 'unsupported_type' })).toMatchObject({
      why: 'refused',
      refusal: 'type',
    });
  });

  it('says only the hints it was given: no amounts unless asked (D5)', () => {
    const doc = {
      ref: 'm1-x',
      vaultKind: 'pay_statement',
      title: 'October payslip',
      fileName: 'oct.pdf',
      mediaType: 'application/pdf',
      bytes: 1,
      sha256: 'a'.repeat(64),
      date: '2026-10-31',
      person: 'Alex',
    };
    expect(hintsOf(doc)).toEqual({
      kind: 'pay_statement',
      title: 'October payslip',
      issued: '2026-10-31',
      person: { name: 'Alex' },
    });
    expect(hintsOf({ ...doc, detail: { amounts: [{ amount: '12.50', currency: 'USD' }] } }).amount).toEqual({
      value: '12.50',
      currency: 'USD',
    });
  });
});

describe('each group’s mode (ADR-0054 §6; VLT-02, VLT-07)', () => {
  it('queues nothing for a group not yet mapped to one of the vault’s kinds', async () => {
    const row = await vaultRow();
    expect(row.mirror_files).toBe(true);
    expect(row.file_kinds).toEqual([]);
    const id = await file('receipt', 'Before mapping.png');
    expect(await item(id)).toBeUndefined();
  });

  it('maps groups to the vault’s kinds, refusing a kind it doesn’t offer and sending with no local copy', async () => {
    expect((await patch({ groups: [{ group: 'receipts', vaultKind: 'passport' }] })).body.code).toBe(
      'vault.kind_not_allowed',
    );
    const noCopy = await patch({
      groups: [{ group: 'receipts', mode: 'sent_no_copy', vaultKind: 'utility_bill' }],
    });
    expect(noCopy.status).toBe(422);
    expect(noCopy.body.code).toBe('vault.mode_not_offered');
    const res = await patch({
      groups: [
        { group: 'receipts', vaultKind: 'utility_bill' },
        { group: 'statements', vaultKind: 'bank_statement' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.groups.find((g: any) => g.group === 'receipts')).toEqual({
      group: 'receipts',
      mode: 'sent_keep_copy',
      vaultKind: 'utility_bill',
    });
    expect((await vaultRow()).file_kinds).toEqual(['statement', 'receipt']);
  });

  it('lets only an owner send payslips or tax documents, after a recent sign-in, and an admin turn them off', async () => {
    const on = { groups: [{ group: 'payslips', mode: 'sent_keep_copy', vaultKind: 'pay_statement' }] };
    expect((await patch(on, adminUser)).status).toBe(403);
    expect((await patch({ groups: [{ group: 'receipts', mode: 'not_sent' }] }, adminUser)).status).toBe(403);
    expect((await partner.patch(url('/family-vault'), { version: 1 })).status).toBe(403);
    expect((await stale(() => patch(on))).body.code).toBe('reauth.required');
    const res = await patch(on);
    expect(res.status).toBe(200);
    expect((await vaultRow()).file_kinds).toContain('payslip');
    // Recorded in the security log, with the group and whether it is sent; never a key or a file.
    const log = (
      await db.query(
        `select detail from app.security_event where workspace_id = $1 and kind = 'vault_changed' order by at`,
        [wsId],
      )
    ).rows.map((r) => r.detail);
    expect(log.at(-1)).toMatchObject({ restricted: [{ group: 'payslips', sent: true }] });
    // An admin may set it back to not sent (D4).
    const off = await patch({ groups: [{ group: 'payslips', mode: 'not_sent' }] }, adminUser);
    expect(off.status).toBe(200);
    expect((await vaultRow()).file_kinds).not.toContain('payslip');
  });

  it('keeps in Montra only what hadn’t reached the vault when a group is turned off', async () => {
    const id = await file('statement', 'Turned off.pdf', { mime: 'application/pdf' });
    expect((await item(id)).status).toBe('queued');
    await patch({ groups: [{ group: 'statements', mode: 'not_sent' }] });
    expect(await item(id)).toBeUndefined();
    await patch({ groups: [{ group: 'statements', mode: 'sent_keep_copy' }] });
  });
});

describe('sending (ADR-0054 §3, §4; VLT-03)', () => {
  it('waits while Montra is still reading a file, then sends it with its id saved first', async () => {
    const id = await file('receipt', 'Corner shop.png');
    const entity = (
      await db.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
    ).rows[0].id;
    const receipt = (
      await db.query(
        `insert into app.receipt (workspace_id, entity_id, attachment_ids, status, receipt_date, retain_until)
         values ($1, $2, array[$3::uuid], 'processing', '2026-11-03', '2033-12-31') returning id`,
        [wsId, entity, id],
      )
    ).rows[0].id;
    await run();
    expect(await item(id)).toMatchObject({ status: 'queued', vault_ref: null, attempts: 0 });

    await db.query(`update app.receipt set status = 'inbox' where id = $1`, [receipt]);
    await dueNow();
    let savedFirst: string | null = null;
    const seen = watch(async () => {
      savedFirst = (await item(id)).vault_ref;
    });
    await run();
    const row = await item(id);
    expect(row).toMatchObject({ status: 'received', attempts: 0, content_available: false });
    expect(row.vault_ref).toMatch(/^m1-[A-Za-z0-9_-]{40}$/);
    expect(row.vault_ref).toBe(vaultRef(wsId, id, row.created_at));
    expect(savedFirst).toBe(row.vault_ref);
    expect(seen.refs).toEqual([row.vault_ref]);
    // The vault has it under that id, with the file's own hash and what Montra says about it: no amounts (D5).
    const sent = intake(row.vault_ref);
    expect(sent.sha256).toBe(row.vault_sha256);
    expect(sent.hints).toMatchObject({ kind: 'utility_bill', title: 'Corner shop' });
    expect(sent.hints.issued).toBeDefined();
    expect(sent.hints.amount).toBeUndefined();
    expect(sent.hints.person).toBeUndefined();
  });

  it('asks about the id after a lost answer, instead of sending a second document', async () => {
    const id = await file('receipt', 'Lost answer.png');
    const seen = watch(async (n) => (n === 1 ? 'drop' : undefined));
    await run();
    const first = await item(id);
    expect(first.status).toBe('pending');
    expect(first.vault_ref).not.toBeNull();
    // The vault did get it; Montra didn't hear.
    expect(intake(first.vault_ref).state).toBe('waiting');
    const before = app().files_today;

    await dueNow();
    await run();
    const after = await item(id);
    expect(after).toMatchObject({ status: 'received', vault_ref: first.vault_ref });
    // Asked, not sent again: one send in all, one document in the vault.
    expect(seen.intake).toBe(1);
    expect(app().files_today).toBe(before);
  });

  it('marks it filed when the vault files it, even where Montra may not see the document', async () => {
    const id = await file('receipt', 'Filed.png');
    await run();
    const ref = (await item(id)).vault_ref;
    fake.vault.fileAppIntake(appId, ref, randomUUID());
    await dueNow();
    await run();
    const row = await item(id);
    expect(row).toMatchObject({ status: 'filed', vault_document_id: null, content_available: false });
    expect(row.filed_at).not.toBeNull();
    const dto = await get();
    expect(dto.items.filed).toBeGreaterThanOrEqual(1);
  });

  it('sends one at a time, oldest first, and existing documents only when the owner asks with the count shown', async () => {
    // Files from before the group was mapped are not in the outbox.
    const earlier = await db.query(
      `select id from app.file where workspace_id = $1 and kind in ('receipt', 'statement') and deleted_at is null
         and not exists (select 1 from app.vault_item i where i.file_id = app.file.id) order by created_at, id`,
      [wsId],
    );
    const ids = [...earlier.rows.map((r) => r.id)];
    for (const n of [1, 2, 3]) {
      const id = await file('receipt', `Old ${n}.png`);
      await db.query(`delete from app.vault_item where file_id = $1`, [id]);
      await db.query(
        `update app.file set created_at = now() - interval '1 day' + ($2 || ' seconds')::interval where id = $1`,
        [id, String(n)],
      );
    }
    const shown = (await c.get(url('/family-vault/existing'))).body;
    expect(shown.count).toBe(ids.length + 3);
    expect(shown.perDay).toBe(100);
    expect(shown.days).toBe(1);
    expect((await adminUser.post(url('/family-vault/existing'), { expected: shown.count })).status).toBe(403);
    expect(
      (await stale(() => c.post(url('/family-vault/existing'), { expected: shown.count }))).body.code,
    ).toBe('reauth.required');
    expect((await c.post(url('/family-vault/existing'), { expected: shown.count + 1 })).body.code).toBe(
      'vault.count_changed',
    );
    const res = await c.post(url('/family-vault/existing'), { expected: shown.count });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    const order = (
      await db.query(
        `select i.file_id, f.created_at from app.vault_item i join app.file f on f.id = i.file_id
          where i.workspace_id = $1 and i.status = 'queued' order by i.created_at, i.file_id`,
        [wsId],
      )
    ).rows;
    expect(order.length).toBe(shown.count);
    const byFile = [...order].sort((a, b) => a.created_at - b.created_at);
    expect(order.map((r) => r.file_id)).toEqual(byFile.map((r) => r.file_id));
    expect(
      (
        await db.query(
          `select detail from app.security_event where workspace_id = $1 and kind = 'vault_move_started'`,
          [wsId],
        )
      ).rows[0].detail,
    ).toMatchObject({ count: shown.count, keepCopy: true });

    const seen = watch();
    await run();
    expect(seen.maxInFlight).toBe(1);
    expect(seen.intake).toBe(shown.count);
    const refs = await Promise.all(order.map(async (r) => (await item(r.file_id)).vault_ref));
    expect(seen.refs).toEqual(refs);
  });

  it('keeps statement exports and types the vault doesn’t take in Montra, and never sends sealed copies (D8, §6)', async () => {
    const csv = await file('statement', 'checking.csv', {
      mime: 'text/csv',
      bytes: Buffer.from('date,amount\n'),
    });
    const heic = await file('receipt', 'lunch.heic', { mime: 'image/heic' });
    const pdf = await file('statement', 'October.pdf', { mime: 'application/pdf' });
    const sealed = await file('receipt', 'passport.png', { sealed: true });
    const seen = watch();
    await run();
    for (const id of [csv, heic]) {
      expect(await item(id)).toMatchObject({
        status: 'not_kept',
        not_kept_reason: NOT_KEPT_WORDS.type,
        resend_allowed: false,
      });
    }
    expect(await item(sealed)).toBeUndefined();
    expect((await item(pdf)).status).toBe('received');
    expect(seen.intake).toBe(1);
    const badges = (await partner.get(url(`/family-vault/files?ids=${csv},${pdf}`))).body.data;
    expect(badges.find((b: any) => b.fileId === csv).vault).toMatchObject({
      status: 'not_kept',
      notKeptReason: NOT_KEPT_WORDS.type,
    });
    expect(badges.find((b: any) => b.fileId === pdf).vault).toMatchObject({ status: 'received' });
  });
});

describe('the person a document belongs to (ADR-0054 §3, §6; vault 0.9.0-dev.60 routing)', () => {
  let alex: string;
  let employer: string;
  let entity: string;

  beforeAll(async () => {
    alex = randomUUID();
    entity = (
      await db.query(`select id from app.entity where workspace_id = $1 and type = 'personal'`, [wsId])
    ).rows[0].id;
    await db.query(
      `insert into app.family_member (workspace_id, id, name, relationship) values ($1, $2, 'Alex', 'spouse_partner')`,
      [wsId, alex],
    );
    const account = (
      await db.query(`select id from app.ledger_account where workspace_id = $1 and entity_id = $2 limit 1`, [
        wsId,
        entity,
      ])
    ).rows[0].id;
    employer = (
      await db.query(
        `insert into app.employer (workspace_id, entity_id, member_id, name, deposit_account_id)
         values ($1, $2, $3, 'Acme', $4) returning id`,
        [wsId, entity, alex, account],
      )
    ).rows[0].id;
    await patch({ groups: [{ group: 'payslips', mode: 'sent_keep_copy', vaultKind: 'pay_statement' }] });
  });

  const payslip = async (status: string) => {
    const id = await file('payslip', 'October payslip.pdf', { mime: 'application/pdf' });
    const p = (
      await db.query(
        `insert into app.payslip (workspace_id, entity_id, employer_id, member_id, currency, status, pay_date,
                                  attachment_ids, net_minor)
         values ($1, $2, $3, $4, 'USD', $5, '2026-10-31', array[$6::uuid], 412345) returning id`,
        [wsId, entity, employer, alex, status, id],
      )
    ).rows[0].id;
    return { id, payslip: p };
  };

  it('sends a member’s payslip with them as the hint, and the vault routes it to their Inbox', async () => {
    const { id, payslip: p } = await payslip('needs_review');
    await run();
    expect((await item(id)).status).toBe('queued');
    await db.query(`update app.payslip set status = 'posted' where id = $1`, [p]);
    await dueNow();
    await run();
    const row = await item(id);
    expect(row.status).toBe('received');
    const sent = intake(row.vault_ref);
    expect(sent.hints).toMatchObject({
      kind: 'pay_statement',
      person: { name: 'Alex' },
      issued: { date: '2026-10-31' },
    });
    // No amount unless the owner asks for more detail (D5).
    expect(sent.hints.amount).toBeUndefined();
    // The fake routes as the vault does: to the Inbox of the person it is about, an adult who signs in.
    expect(sent.inbox_member_id).toBe('fake-other-adult');
  });

  it('goes to the acting member’s Inbox when that person can’t receive it now, and says more when asked', async () => {
    fake.vault.state.suspensions.set('fake-other-adult', {
      reason: 'locked' as never,
      since: new Date().toISOString(),
      until: null,
      note: null,
      by: 'Fake Owner',
    });
    await patch({ describeMore: true });
    const { id } = await payslip('posted');
    await run();
    const sent = intake((await item(id)).vault_ref);
    expect(sent.hints.person).toEqual({ name: 'Alex' });
    expect(sent.hints.amount).toEqual({ value: '4123.45', currency: 'USD' });
    expect(sent.inbox_member_id).toBe(app().member_id);
    fake.vault.state.suspensions.delete('fake-other-adult');
    await patch({ describeMore: false, groups: [{ group: 'payslips', mode: 'not_sent' }] });
  });
});

describe('caps, retries and the connection (ADR-0054 §12; VLT-09)', () => {
  it('holds sending at the vault’s daily cap without counting it as a failure', async () => {
    app().daily_files = app().files_today;
    const id = await file('receipt', 'Over the cap.png');
    await run();
    expect(await item(id)).toMatchObject({ status: 'pending', attempts: 0 });
    const row = await vaultRow();
    expect(row).toMatchObject({ status: 'active', consecutive_failures: 0 });
    const dto = await get();
    expect(dto.heldUntil.sending).not.toBeNull();
    expect(new Date(dto.heldUntil.sending).getTime()).toBeGreaterThan(Date.now());

    // The next day: the cap resets.
    app().daily_files = 1000;
    await db.query(`update app.vault_connection_state set send_held_until = null where workspace_id = $1`, [
      wsId,
    ]);
    await dueNow();
    await run();
    expect((await item(id)).status).toBe('received');
  });

  it('waits as long as the vault asks, with jitter, and never gives up over it', async () => {
    const id = await file('receipt', 'Busy.png');
    const later = new Date(Date.now() + 10 * 60_000);
    vi.spyOn(VaultConnection.prototype, 'send').mockRejectedValue(
      new VaultError('retry_later', { retryAfter: later }),
    );
    await db.query(`update app.vault_item set attempts = $2 where file_id = $1`, [id, MAX_ATTEMPTS + 2]);
    await db.query(`update app.vault_item set status = 'pending' where file_id = $1`, [id]);
    await run();
    const row = await item(id);
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(later.getTime());
    expect((await vaultRow()).consecutive_failures).toBe(0);
    vi.restoreAllMocks();
    await dueNow();
    await run();
    expect((await item(id)).status).toBe('received');
  });

  it('retries a vault it can’t reach on Montra’s backoff, and turns failing after five in a row, telling owners once', async () => {
    const id = await file('receipt', 'Unreachable.png');
    (transport as any).fetch = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    for (let i = 0; i < VAULT_FAILING_AFTER + 1; i++) {
      await dueNow();
      await run();
    }
    const row = await vaultRow();
    expect(row.status).toBe('failing');
    expect((await item(id)).status).toBe('pending');
    expect((await item(id)).next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(await notifications('storage_failing')).toEqual([
      { email: ADMIN, n: 1 },
      { email: OWNER, n: 1 },
    ]);
    (transport as any).fetch = realFetch;
    await dueNow();
    await run();
    expect((await item(id)).status).toBe('received');
    expect((await vaultRow()).status).toBe('active');
  });

  it('stops the whole connection for a problem with it, telling owners once, until a check passes', async () => {
    app().paused = 'owner';
    const a = await file('receipt', 'Paused 1.png');
    const b = await file('receipt', 'Paused 2.png');
    await run();
    const row = await vaultRow();
    expect(row.status).toBe('needs_vault');
    expect(row.last_error).toBe('An owner has paused this app.');
    // Nothing was retried, and neither file counts an attempt.
    expect(await item(a)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await item(b)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await notifications('vault_attention')).toEqual([
      { email: ADMIN, n: 1 },
      { email: OWNER, n: 1 },
    ]);
    // While it needs the vault, only its check runs, and owners aren't told again.
    await dueNow();
    await db.query(`update app.vault_connection_state set next_check_at = now() where workspace_id = $1`, [
      wsId,
    ]);
    await run();
    expect((await vaultRow()).status).toBe('needs_vault');
    expect(await notifications('vault_attention')).toEqual([
      { email: ADMIN, n: 1 },
      { email: OWNER, n: 1 },
    ]);
    // Turned back on in the vault: the next check passes and what waited goes.
    app().paused = null;
    await db.query(`update app.vault_connection_state set next_check_at = now() where workspace_id = $1`, [
      wsId,
    ]);
    await run();
    expect((await vaultRow()).status).toBe('active');
    expect((await item(a)).status).toBe('received');
    expect((await item(b)).status).toBe('received');
  });
});

describe('what the vault didn’t keep (ADR-0054 §4.5)', () => {
  it('keeps Montra’s copy when the family removes it, tells owners, and sends it again only when asked', async () => {
    const id = await file('receipt', 'Declined.png');
    await run();
    const ref = (await item(id)).vault_ref;
    Object.assign(intake(ref), { state: 'removed', removed_reason: 'declined' });
    await dueNow();
    await run();
    expect(await item(id)).toMatchObject({
      status: 'not_kept',
      not_kept_reason: NOT_KEPT_WORDS.removed,
      resend_allowed: true,
    });
    expect((await db.query(`select 1 from app.file where id = $1`, [id])).rowCount).toBe(1);
    expect(
      (
        await db.query(
          `select title from app.notification where workspace_id = $1 and type = 'vault_attention'
             and title like 'Some documents%'`,
          [wsId],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
    // Not sent again on its own.
    await dueNow();
    await run();
    expect((await item(id)).status).toBe('not_kept');
    // "Send again": a new send, with a new id.
    const listed = (await c.get(url('/family-vault/items?status=not_kept'))).body.data;
    expect(listed.find((i: any) => i.fileId === id)).toMatchObject({
      group: 'receipts',
      resendAllowed: true,
      notKeptReason: NOT_KEPT_WORDS.removed,
    });
    expect((await adminUser.post(url('/family-vault/retry'), { fileIds: [id] })).body).toEqual({
      retried: 1,
    });
    await run();
    const again = await item(id);
    expect(again.status).toBe('received');
    expect(again.vault_ref).not.toBe(ref);
  });

  it('sends a lapsed document again once on its own, under the same id, then waits for a person', async () => {
    const id = await file('receipt', 'Lapsed.png');
    await run();
    const ref = (await item(id)).vault_ref;
    Object.assign(intake(ref), { state: 'removed', removed_reason: 'expired' });
    await dueNow();
    await run();
    expect(await item(id)).toMatchObject({ status: 'received', vault_ref: ref, auto_resends: 1 });
    Object.assign(intake(ref), { state: 'removed', removed_reason: 'expired' });
    await dueNow();
    await run();
    expect(await item(id)).toMatchObject({
      status: 'not_kept',
      not_kept_reason: NOT_KEPT_WORDS.lapsed,
      resend_allowed: true,
    });
  });

  it('says so in words when the vault no longer lets Montra send a kind', async () => {
    app().allowed_kinds = ['bank_statement', 'pay_statement'];
    const id = await file('receipt', 'Kind gone.png');
    await run();
    expect(await item(id)).toMatchObject({ status: 'not_kept', not_kept_reason: NOT_KEPT_WORDS.kind });
    app().allowed_kinds = KINDS;
  });

  it('fails a file whose hash the vault doesn’t match, lists it, and tries it again under the same id', async () => {
    const id = await file('receipt', 'Changed.png');
    const real = (await db.query(`select sha256 from app.file where id = $1`, [id])).rows[0].sha256;
    await db.query(`update app.file set sha256 = $2 where id = $1`, [id, 'f'.repeat(64)]);
    await run();
    const failed = await item(id);
    expect(failed.status).toBe('failed');
    expect(failed.last_error).toMatch(/different file/);
    const list = (await adminUser.get(url('/family-vault/items?status=failed'))).body.data;
    expect(list.map((i: any) => i.fileId)).toContain(id);
    await db.query(`update app.file set sha256 = $2 where id = $1`, [id, real]);
    expect((await adminUser.post(url('/family-vault/retry'), {})).body.retried).toBeGreaterThanOrEqual(1);
    const seen = watch();
    await run();
    expect(await item(id)).toMatchObject({ status: 'received', vault_ref: failed.vault_ref });
    expect(seen.intake).toBe(0);
  });

  it('withdraws an Inbox item when its file is deleted for good', async () => {
    const id = await file('receipt', 'Deleted.png');
    await run();
    const ref = (await item(id)).vault_ref;
    await db.query(`delete from app.file where id = $1`, [id]);
    expect((await item(id)).status).toBe('delete');
    await run();
    expect(await item(id)).toBeUndefined();
    expect(intake(ref)).toMatchObject({ state: 'removed', removed_reason: 'withdrawn' });
  });
});

describe('badges and pausing (ADR-0054 §13)', () => {
  it('shows a file’s badge to whoever can see the file, and nothing for another workspace’s', async () => {
    const id = await file('receipt', 'Badge.png');
    await run();
    const mine = (await partner.get(url(`/family-vault/files?ids=${id}`))).body.data;
    expect(mine).toEqual([
      {
        fileId: id,
        location: 'montra',
        missing: null,
        vault: {
          status: 'received',
          title: null,
          kind: null,
          newerVersion: false,
          notKeptReason: null,
          canOpen: false,
        },
      },
    ]);
    const other = (
      await c.post('/v1/workspaces', { name: 'Other', baseCurrency: 'USD', template: 'household' })
    ).body.id;
    const theirs = await file('receipt', 'Theirs.png', { ws: other });
    expect((await c.get(`/v1/workspaces/${other}/family-vault/files?ids=${id}`)).body.data).toEqual([]);
    expect((await partner.get(url(`/family-vault/files?ids=${theirs}`))).body.data).toEqual([]);
    expect((await partner.get(url('/family-vault/files?ids=nope'))).status).toBe(400);
  });

  it('sends nothing while paused, and checks the connection again when unpaused', async () => {
    expect((await patch({ paused: true }, adminUser)).status).toBe(403);
    await patch({ paused: true });
    const id = await file('receipt', 'While paused.png');
    expect(await item(id)).toBeUndefined();
    await run();
    await patch({ paused: false });
    expect((await vaultRow()).status).toBe('active');
    const s = (
      await db.query(`select next_check_at from app.vault_connection_state where workspace_id = $1`, [wsId])
    ).rows[0];
    expect(s.next_check_at.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
