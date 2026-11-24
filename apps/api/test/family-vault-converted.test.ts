/* eslint-disable @typescript-eslint/no-explicit-any -- test responses and the fake's state are untyped here */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import { RENDER_JOB, StatementRenditions } from '../src/renditions/statement-renditions.js';
import type { DrawnText } from '../src/renditions/statement-pdf.js';
import { FileBytes } from '../src/storage/file-bytes.js';
import type { FakeVaultHandle } from '../src/storage/vault/fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from '../src/storage/vault/transport.js';
import { NOT_CONVERTED_WORDS } from '../src/storage/vault/vault.conversions.js';
import { NOT_KEPT_WORDS, renditionTitle, VaultJobs } from '../src/storage/vault/vault.jobs.js';
import { ADMIN_URL } from './env.js';
import { attachments, coverText } from './fakes/statement-pdf-view.js';
import { startHarness, type Client, type Harness } from './harness.js';

// VLT-12 (ADR-0057 §1, §3, §4, §7): statements the vault doesn't keep (here, CSV exports) sent to the household's vault
// as PDFs rendered from their imported rows, per the statements group's "Files the vault doesn't keep", with the cover's
// account number as "Account number on the cover" says. Against the vault's own fake (`@fdv/client/testing`, in this
// process): no real vault is ever reached.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const OWNER = 'owner-vault-converted@example.com';
const ADMIN = 'admin-vault-converted@example.com';
const KINDS = ['bank_statement', 'utility_bill', 'pay_statement'];
const SCOPES = [
  'documents.send',
  'documents.read',
  'documents.download',
  'documents.links',
  'documents.delete',
];
/** The most rows one PDF holds here, so a five-row statement is two parts. */
const MAX_ROWS = 3;
/** The account's full number, as typed; it must never leave the cover. */
const FULL = '0012 3456 7890 4321';
const DIGITS = '0012345678904321';

let h: Harness;
let c: Client;
let adminUser: Client;
let db: pg.Client;
let worker: Worker;
let jobs: VaultJobs;
let renditions: StatementRenditions;
let fake: FakeVaultHandle;
let wsId: string;
let ownerId: string;
let appId: string;
let checking: string;
let url: (p: string) => string;
let drawn: DrawnText[] = [];

const run = (settleMs = 0) => jobs.run({ sendGapMs: 0, settleMs });
const vstate = () => fake.vault.state as any;
const app = () => vstate().connectedApps.find((a: any) => a.id === appId);
const intake = (ref: string) => app().intake.get(ref) as any;
const intakeBytes = (ref: string): Uint8Array => intake(ref).bytes ?? intake(ref).file.bytes;
const item = async (fileId: string) =>
  (await db.query(`select * from app.vault_item where file_id = $1`, [fileId])).rows[0];
const fileRow = async (fileId: string) =>
  (await db.query(`select * from app.file where id = $1`, [fileId])).rows[0];
/** The original's current PDFs, in part order. */
const parts = async (fileId: string) =>
  (
    await db.query(
      `select f.id, f.file_name, f.sha256, f.storage_key, f.location, i.status, i.vault_ref, i.carries_original
         from app.file f left join app.vault_item i on i.file_id = f.id
        where f.derived_from_file_id = $1 and f.superseded_at is null order by f.file_name`,
      [fileId],
    )
  ).rows;
const connection = async () => (await c.get(url('/family-vault'))).body.connection;
const patch = async (body: Record<string, unknown>, who: Client = c) =>
  who.patch(url('/family-vault'), { version: (await connection()).version, ...body });
const badge = async (fileId: string) =>
  (await c.get(url(`/family-vault/files?ids=${fileId}`))).body.data[0]?.vault;
const renderJobs = async () =>
  Number(
    (await db.query(`select count(*) from app.job where type = $1 and workspace_id = $2`, [RENDER_JOB, wsId]))
      .rows[0].count,
  );
const dueNow = () =>
  db.query(
    `update app.vault_item set next_attempt_at = now() - interval '1 second'
      where workspace_id = $1 and status in ('queued', 'pending', 'received', 'delete')`,
    [wsId],
  );

/** Runs `fn` as if the person signed in more than ten minutes ago (AUTH-09). */
async function stale<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** Everything the process writes while `fn` runs. */
async function output(fn: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    written.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return written.join('');
}

async function upload(fileName: string, bytes: Buffer) {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: url('/uploads'),
    headers: {
      authorization: `Bearer dev:${OWNER}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { fileId: string };
}

/** A CSV statement of `n` rows from 2026-05-01, imported into the checking account and committed. */
async function imported(name: string, n = 2) {
  const lines = Array.from(
    { length: n },
    (_, i) => `2026-05-${String(i + 1).padStart(2, '0')},Shop ${i + 1},-${i + 1}.25`,
  );
  const bytes = Buffer.from(`Date,Description,Amount\n${lines.join('\n')}\n`);
  const up = await upload(name, bytes);
  const batch = (await c.post(url('/imports'), { fileId: up.fileId, accountId: checking })).body;
  await worker.drain();
  expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('preview');
  await c.post(url(`/imports/${batch.id}/commit`));
  await worker.drain();
  expect((await c.get(url(`/imports/${batch.id}`))).body.status).toBe('committed');
  return {
    fileId: up.fileId,
    batchId: batch.id as string,
    bytes,
    end: `2026-05-${String(n).padStart(2, '0')}`,
  };
}

/** The vault's job converts what is ready, the worker renders it, and the job sends the PDFs. */
async function cycle() {
  await run();
  await worker.drain(['report']);
  await run();
}

/** A person in the fake vault files what Montra sent as a document of its own, from the bytes it received. */
function fileInVault(ref: string, name: string): string {
  const received = intakeBytes(ref);
  const doc = randomUUID();
  vstate().documents.push({
    id: doc,
    title: `${name} in the vault`,
    type_key: 'bank_statement',
    visibility: 'household',
    sensitive: false,
    is_essential: false,
    issued: { date: '2026-05-31', precision: 'day' },
    expires: null,
    issued_by: null,
    extra: {},
    owner_member_id: null,
    household_owned: true,
  });
  vstate().captures.set(`cap-${doc}`, {
    kind: 'capture',
    document_id: doc,
    version_id: randomUUID(),
    version_no: 1,
    filename: name,
    mime: 'application/pdf',
    byte_size: received.length,
    uploaded_at: new Date().toISOString(),
    bytes: received,
  });
  fake.vault.fileAppIntake(appId, ref, doc);
  return doc;
}

async function setStatements(group: Record<string, unknown>) {
  const res = await patch({ groups: [{ group: 'statements', ...group }] });
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  h = await startHarness({
    AI_PROVIDER: 'fake',
    FAMILY_VAULT_FAKE: 'on',
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'montra-storage-')),
    STATEMENT_PDF_MAX_ROWS: String(MAX_ROWS),
  });
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  renditions = h.app.get(StatementRenditions);
  renditions.register();
  renditions.trace = (t) => drawn.push(t);
  jobs = h.app.get(VaultJobs);
  fake = h.app.get<VaultTransport & { fake: FakeVaultHandle }>(VAULT_TRANSPORT).fake;
  c = h.as(OWNER);
  adminUser = h.as(ADMIN);
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  wsId = (
    await c.post('/v1/workspaces', { name: 'Vault converted', baseCurrency: 'USD', template: 'household' })
  ).body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  ownerId = (await db.query(`select id from app.app_user where email = $1`, [OWNER])).rows[0].id;
  const invite = await c.post(url('/sharing/invites'), { email: ADMIN, role: 'admin' });
  expect((await adminUser.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
  checking = (
    await c.post(url('/accounts'), {
      name: 'Everyday Checking',
      kind: 'checking',
      institution: 'First Bank',
      last4: '4321',
    })
  ).body.id;

  const registered = await fake.register({ kinds: KINDS, scopes: SCOPES });
  appId = registered.appId;
  const pasted = await c.post(url('/family-vault'), { connectionString: registered.codeWithSecret });
  expect(pasted.body.stage).toBe('connected');
  await setStatements({ vaultKind: 'bank_statement' });
});

beforeEach(() => {
  drawn = [];
});

afterAll(async () => {
  await db.query(`delete from app.storage_destination where workspace_id = $1`, [wsId]);
  // Nothing of ours may wake a worker in another test file.
  await db.query(`delete from app.job where type in ('storage.vault', 'storage.mirror', $1)`, [RENDER_JOB]);
  await db.query(`delete from app.job where workspace_id = $1 and status = 'queued'`, [wsId]);
  await db.end();
  await h.close();
});

describe('the settings (ADR-0057 §1, §3)', () => {
  it('converts statements with the original attached by default, and offers nothing else for other groups', async () => {
    const d = await connection();
    expect(d.coverNumber).toBe('last4');
    for (const g of d.groups) {
      expect(g.unkept).toBe(g.group === 'statements' ? 'convert_attach' : 'dont_send');
    }
    const refused = await patch({ groups: [{ group: 'receipts', unkept: 'convert' }] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('vault.unkept_not_offered');
    // An owner's choice.
    expect((await patch({ groups: [{ group: 'statements', unkept: 'convert' }] }, adminUser)).status).toBe(
      403,
    );
    expect((await patch({ coverNumber: 'none' }, adminUser)).status).toBe(403);
  });

  it('puts the full number on covers only for an owner with a recent sign-in, in the security log', async () => {
    expect((await patch({ coverNumber: 'full' }, adminUser)).status).toBe(403);
    expect((await stale(() => patch({ coverNumber: 'full' }))).body.code).toBe('reauth.required');
    expect((await connection()).coverNumber).toBe('last4');
    const res = await patch({ coverNumber: 'full' });
    expect(res.status).toBe(200);
    expect(res.body.coverNumber).toBe('full');
    const log = (
      await db.query(
        `select detail from app.security_event where workspace_id = $1 and kind = 'vault_changed'
          order by at desc limit 1`,
        [wsId],
      )
    ).rows[0].detail;
    expect(log).toEqual({ coverNumber: 'full' });
    const audit = await db.query(
      `select actor_user_id from app.audit_log where workspace_id = $1 and action = 'vault.cover_number_full'`,
      [wsId],
    );
    expect(audit.rows).toEqual([{ actor_user_id: ownerId }]);
    // Last four and none need no recent sign-in.
    expect((await stale(() => patch({ coverNumber: 'last4' }))).status).toBe(200);
  });
});

describe('each choice (ADR-0057 §1)', () => {
  it('“Convert to PDF, attach the original”: one PDF, sent with its hints, the original inside it', async () => {
    const s = await imported('may.csv');
    await cycle();
    const orig = await item(s.fileId);
    expect(orig).toMatchObject({
      status: 'converted',
      render_state: 'rendered',
      render_options: { detail: false, accountNumber: 'none', attachOriginal: true },
    });
    const [pdf, ...more] = await parts(s.fileId);
    expect(more).toEqual([]);
    expect(pdf).toMatchObject({ status: 'received', carries_original: true });
    const sent = intake(pdf.vault_ref);
    expect(sent.hints).toMatchObject({ kind: 'bank_statement', title: 'may.csv (PDF)' });
    expect(sent.hints.issued).toMatchObject({ date: s.end });
    const inside = await attachments(intakeBytes(pdf.vault_ref));
    expect(Buffer.from(inside.get('may.csv')!.bytes).equals(s.bytes)).toBe(true);
    // The original itself never goes.
    expect([...app().intake.keys()]).not.toContain(orig.vault_ref);
    expect(await badge(s.fileId)).toMatchObject({
      status: 'converted',
      canOpen: false,
      converted: { state: 'rendered', attached: true, parts: 1, received: 1, waiting: 0, canSendAgain: true },
    });
    expect((await connection()).items.converted).toBeGreaterThan(0);
  });

  it('“Convert to PDF and send”: the PDF without the original', async () => {
    await setStatements({ unkept: 'convert' });
    try {
      const s = await imported('june.csv');
      await cycle();
      const [pdf] = await parts(s.fileId);
      expect(pdf).toMatchObject({ status: 'received', carries_original: false });
      expect((await attachments(intakeBytes(pdf.vault_ref))).size).toBe(0);
      expect((await item(s.fileId)).render_options).toMatchObject({ attachOriginal: false });
      expect((await badge(s.fileId)).converted).toMatchObject({ attached: false, parts: 1 });
    } finally {
      await setStatements({ unkept: 'convert_attach' });
    }
  });

  it('“Don’t send”: kept in Montra as a type the vault doesn’t keep, with nothing rendered', async () => {
    await setStatements({ unkept: 'dont_send' });
    try {
      const before = await renderJobs();
      const s = await imported('july.csv');
      await run();
      expect(await item(s.fileId)).toMatchObject({
        status: 'not_kept',
        not_kept_reason: NOT_KEPT_WORDS.type,
        resend_allowed: false,
        render_state: null,
      });
      expect(await renderJobs()).toBe(before);
      expect(await parts(s.fileId)).toEqual([]);
      expect(await badge(s.fileId)).toMatchObject({ status: 'not_kept', converted: null });
    } finally {
      await setStatements({ unkept: 'convert_attach' });
    }
  });

  it('a file the import couldn’t read: “couldn’t be converted” without attaching, a cover with it', async () => {
    await setStatements({ unkept: 'convert' });
    const up = await upload('garbled.csv', Buffer.from('not,a\nstatement,at all\n'));
    await cycle();
    expect(await item(up.fileId)).toMatchObject({
      status: 'converted',
      render_state: 'not_converted',
      not_kept_reason: NOT_CONVERTED_WORDS.unreadable,
    });
    expect(await badge(up.fileId)).toMatchObject({
      status: 'converted',
      notKeptReason: NOT_CONVERTED_WORDS.unreadable,
      converted: { state: 'not_converted', parts: 0 },
    });
    // Choosing to attach the original makes the cover-only PDF, with the original inside.
    await setStatements({ unkept: 'convert_attach' });
    await cycle();
    const [pdf] = await parts(up.fileId);
    expect(pdf).toMatchObject({ status: 'received', carries_original: true });
    expect((await item(up.fileId)).render_state).toBe('rendered');
  });
});

describe('PDFs of their own (ADR-0057 §2, §4)', () => {
  it('splits a long statement into parts, each titled “part n of m”, the original in the first', async () => {
    const s = await imported('long.csv', 5);
    await cycle();
    const ps = await parts(s.fileId);
    expect(ps).toHaveLength(2);
    expect(ps.map((p: any) => intake(p.vault_ref).hints.title)).toEqual([
      'long.csv (PDF), part 1 of 2',
      'long.csv (PDF), part 2 of 2',
    ]);
    expect(ps.map((p: any) => intake(p.vault_ref).hints.issued.date)).toEqual([s.end, s.end]);
    expect(ps.map((p: any) => p.carries_original)).toEqual([true, false]);
    expect(renditionTitle(null, 'x.csv (PDF, part 2 of 3).pdf')).toBe('x.csv (PDF), part 2 of 3');
    expect(renditionTitle(null, 'x.csv (PDF).pdf')).toBe('x.csv (PDF)');
  });

  it('makes an unsent PDF again when the settings change, and the cover follows them', async () => {
    const s = await imported('august.csv');
    await run();
    await worker.drain(['report']);
    const [first] = await parts(s.fileId);
    expect(first.status).toBe('queued');
    expect(coverText(drawn)).not.toContain('4321');

    // More detail, with the last four: the PDF is made again before it goes, and the old one is gone.
    drawn = [];
    await patch({ describeMore: true });
    await run(60_000); // the new PDF settles; the original's row is looked at again
    await worker.drain(['report']);
    const [second] = await parts(s.fileId);
    expect(second.id).not.toBe(first.id);
    expect(await fileRow(first.id)).toBeUndefined();
    expect((await item(s.fileId)).render_options).toEqual({
      detail: true,
      accountNumber: 'last4',
      attachOriginal: true,
    });
    expect(coverText(drawn)).toContain('••••4321');

    // None: no number on the cover.
    drawn = [];
    await patch({ coverNumber: 'none' });
    await run(60_000);
    await worker.drain(['report']);
    expect(coverText(drawn)).not.toContain('4321');
    await run();
    const [sent] = await parts(s.fileId);
    expect(sent.status).toBe('received');
    await patch({ coverNumber: 'last4', describeMore: false });
  });

  it('keeps a PDF the vault has when the settings change, and “Send again” sends a new one', async () => {
    const s = await imported('september.csv');
    await cycle();
    const [sent] = await parts(s.fileId);
    expect(sent.status).toBe('received');
    const intakes = app().intake.size;

    await patch({ describeMore: true });
    await cycle();
    expect((await parts(s.fileId)).map((p: any) => p.id)).toEqual([sent.id]);
    expect(app().intake.size).toBe(intakes);
    expect((await item(s.fileId)).render_state).toBe('rendered');

    // Owners and admins may send it again: a new PDF, a new document; the first stays in the vault.
    const again = await adminUser.post(url('/family-vault/retry'), { fileIds: [s.fileId] });
    expect(again.body).toEqual({ retried: 1 });
    expect((await fileRow(sent.id)).superseded_at).not.toBeNull();
    await cycle();
    const [fresh] = await parts(s.fileId);
    expect(fresh.id).not.toBe(sent.id);
    expect(fresh.status).toBe('received');
    expect(fresh.vault_ref).not.toBe(sent.vault_ref);
    expect(intake(sent.vault_ref)).toBeDefined();
    expect(app().intake.size).toBe(intakes + 1);
    expect((await badge(s.fileId)).converted).toMatchObject({ parts: 1, earlier: 1, received: 1 });
    await patch({ describeMore: false });
  });

  it('leaves a sent PDF in the vault when its import is undone, and says “import undone”', async () => {
    const s = await imported('october.csv');
    await cycle();
    const [sent] = await parts(s.fileId);
    expect(sent.status).toBe('received');
    expect((await c.post(url(`/imports/${s.batchId}/undo`))).status).toBeLessThan(300);
    await worker.drain();
    expect((await c.get(url(`/imports/${s.batchId}`))).body.status).toBe('undone');
    await cycle();
    expect(await item(s.fileId)).toMatchObject({ status: 'converted', render_state: 'import_undone' });
    expect(await parts(s.fileId)).toMatchObject([{ id: sent.id, status: 'received' }]);
    expect((await badge(s.fileId)).converted).toMatchObject({
      state: 'import_undone',
      received: 1,
      canSendAgain: false,
    });

    // Undone before its PDF went: the PDF goes with the import, and nothing is sent.
    const u = await imported('undone-early.csv');
    await run();
    await worker.drain(['report']);
    const [unsent] = await parts(u.fileId);
    expect(unsent.status).toBe('queued');
    await c.post(url(`/imports/${u.batchId}/undo`));
    await worker.drain();
    await cycle();
    expect(await fileRow(unsent.id)).toBeUndefined();
    expect(await parts(u.fileId)).toEqual([]);
    expect(await item(u.fileId)).toMatchObject({ status: 'converted', render_state: 'import_undone' });
  });
});

describe('Montra’s copy of the original (ADR-0057 §7)', () => {
  beforeAll(async () => {
    await setStatements({ mode: 'sent_no_copy' });
  });
  afterAll(async () => {
    await setStatements({ mode: 'sent_keep_copy', unkept: 'convert_attach' });
  });

  it('goes once the vault files the PDF with it attached, and reads back from that PDF', async () => {
    const s = await imported('november.csv');
    await cycle();
    const [pdf] = await parts(s.fileId);
    // In someone's Inbox only: nothing goes.
    await run();
    expect(await fileRow(s.fileId)).toMatchObject({ location: 'montra' });

    fileInVault(pdf.vault_ref, 'november.csv (PDF).pdf');
    await dueNow();
    await run();
    await run();
    expect(await fileRow(pdf.id)).toMatchObject({ location: 'vault', storage_key: null });
    expect(await fileRow(s.fileId)).toMatchObject({ location: 'vault', storage_key: null });
    const moved = await db.query(
      `select diff from app.audit_log where subject_id = $1 and action = 'file.moved_to_vault'`,
      [s.fileId],
    );
    expect(moved.rows.map((r) => r.diff)).toEqual([expect.objectContaining({ insidePdf: pdf.id })]);

    const back = await h.app
      .get(FileBytes)
      .read({ workspaceId: wsId, userId: ownerId }, await fileRow(s.fileId));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.from).toBe('vault');
      expect(Buffer.from(back.bytes).equals(s.bytes)).toBe(true);
    }
  });

  it('stays when the PDF doesn’t carry it, and Settings can say why', async () => {
    await setStatements({ unkept: 'convert' });
    const s = await imported('december.csv');
    await cycle();
    const [pdf] = await parts(s.fileId);
    expect(pdf.carries_original).toBe(false);
    fileInVault(pdf.vault_ref, 'december.csv (PDF).pdf');
    await dueNow();
    await run();
    await run();
    // The PDF follows the group's mode like any sent file; the original keeps its copy.
    expect(await fileRow(pdf.id)).toMatchObject({ location: 'vault' });
    expect(await fileRow(s.fileId)).toMatchObject({ location: 'montra' });
    expect((await connection()).groups.find((g: any) => g.group === 'statements')).toMatchObject({
      mode: 'sent_no_copy',
      unkept: 'convert',
    });
  });
});

describe('the full account number (ADR-0057 §3, ACC-16)', () => {
  it('is on the cover only, never in a DTO, an error, a log or what the vault is told', async () => {
    expect((await c.patch(url(`/accounts/${checking}`), { accountNumber: FULL })).status).toBe(200);
    await patch({ describeMore: true, coverNumber: 'full' });
    let s: Awaited<ReturnType<typeof imported>> | undefined;
    const written = await output(async () => {
      s = await imported('full.csv');
      await cycle();
    });
    const [pdf] = await parts(s!.fileId);
    expect(pdf.status).toBe('received');
    expect(coverText(drawn).replace(/\s/g, '')).toContain(DIGITS);
    // Each cover made with the full number is audited, without it.
    const audit = await db.query(
      `select diff::text from app.audit_log where workspace_id = $1 and action = 'statement.full_number_on_cover'`,
      [wsId],
    );
    expect(audit.rows.length).toBeGreaterThan(0);

    const has = (x: unknown) => JSON.stringify(x).replace(/\s/g, '').includes(DIGITS);
    expect(written.replace(/\s/g, '')).not.toContain(DIGITS);
    expect(has(await connection())).toBe(false);
    expect(has((await c.get(url(`/family-vault/files?ids=${s!.fileId},${pdf.id}`))).body)).toBe(false);
    expect(has(intake(pdf.vault_ref).hints)).toBe(false);
    for (const q of [
      `select detail as x from app.security_event where workspace_id = $1`,
      `select diff as x from app.audit_log where workspace_id = $1`,
      `select payload as x from app.job where workspace_id = $1`,
      `select result as x from app.job where workspace_id = $1`,
      `select error as x from app.job where workspace_id = $1`,
      `select row_to_json(i) as x from app.vault_item i where workspace_id = $1`,
      `select config as x from app.storage_destination where workspace_id = $1`,
    ]) {
      expect(has((await db.query(q, [wsId])).rows), q).toBe(false);
    }
    // An admin choosing Full is refused in words that hold no number either.
    const refused = await patch({ coverNumber: 'none' }, adminUser);
    expect(has(refused.body)).toBe(false);
    await patch({ describeMore: false, coverNumber: 'last4' });
  });
});
