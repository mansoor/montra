import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { catalogs, createTranslator } from '@montra/i18n';
import {
  FileStorageStateDto,
  VaultConnectionDto,
  VaultOpenLinkDto,
  type FileStorageStateDto as FileState,
  type VaultConnectionDto as Connection,
} from '@montra/schemas';
import { ApiError, createApi } from '../src/api/client';
import { queuedStatus } from '../src/features/receipt-capture';
import {
  anyDuplicate,
  badgeIds,
  DUPLICATE_QUESTION,
  openInVault,
  showsVaultStatus,
  vaultBadge,
  vaultBadges,
  vaultCard,
  vaultCounts,
  vaultHost,
  vaultOnlyPage,
  vaultOpenMessage,
  vaultOpenProblem,
  vaultPhoneState,
  vaultStatusWords,
  VAULT_OPEN_PROBLEMS,
  type VaultOpenResult,
} from '../src/features/vault';

// The household's Family Document Vault on the phone (ADR-0054 §9, §13; VLT-10, PR 6): the status in Your data, the
// badges on files, opening a document through a single-use link, and the possible-duplicate question. Pure: the server
// decides who sees what.
const en = catalogs.en!;
const words = createTranslator('en', catalogs);
const say = (m: { key?: string; values?: Record<string, string | number> } | null) =>
  m?.key ? words.t(m.key, m.values) : '';

const FILE = '00000000-0000-4000-8000-0000000000f1';
const FILE2 = '00000000-0000-4000-8000-0000000000f2';

const connection = (over: Partial<Connection> = {}): Connection => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  stage: 'connected',
  status: 'active',
  address: 'https://vault.example.org',
  householdName: 'The Smiths',
  key: {
    clientId: 'fdvc_AAAAAAAAAAAAAAAAAAAAAA',
    name: 'Montra',
    permissions: ['documents.send', 'documents.read', 'documents.links'],
    createdAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2027-02-01T00:00:00.000Z',
    expiresSoon: false,
  },
  keyProblem: null,
  actsAs: 'app',
  actingAs: 'Montra',
  groups: [{ group: 'receipts', mode: 'sent_keep_copy', vaultKind: 'receipt', unkept: 'dont_send' }],
  vaultKinds: [{ key: 'receipt', name: 'Receipt' }],
  describeMore: false,
  coverNumber: 'last4',
  deleteWithMontra: false,
  canDelete: false,
  items: {
    queued: 1,
    pending: 1,
    received: 0,
    filed: 12,
    notKept: 0,
    failed: 2,
    outOfReach: 0,
    converted: 0,
  },
  heldUntil: { sending: null, reading: null },
  dailyLimit: { files: 50, filesToday: 3 },
  feedReadAt: '2026-11-18T09:00:00.000Z',
  files: { onlyInVault: 0, missing: 0 },
  bringingBack: null,
  mirrorGroups: [],
  lastSuccessAt: '2026-11-18T09:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  version: 3,
  ...over,
});

const state = (
  over: Partial<FileState> = {},
  vault: Partial<NonNullable<FileState['vault']>> = {},
): FileState => ({
  fileId: FILE,
  location: 'montra',
  missing: null,
  vault: {
    status: 'filed',
    title: 'Grocer, March 2026',
    kind: 'Receipt',
    newerVersion: false,
    notKeptReason: null,
    canOpen: true,
    converted: null,
    ...vault,
  },
  ...over,
});

describe('the vault’s status in Your data', () => {
  it('uses the API’s own shapes', () => {
    expect(VaultConnectionDto.parse(connection())).toEqual(connection());
    expect(FileStorageStateDto.parse(state())).toEqual(state());
    expect(VaultOpenLinkDto.parse({ url: 'https://vault.example.org/l/abc', mode: 'view' }).mode).toBe(
      'view',
    );
  });

  it('is for owners and admins, as the web’s card', () => {
    expect(showsVaultStatus('owner')).toBe(true);
    expect(showsVaultStatus('admin')).toBe(true);
    for (const role of ['partner', 'accountant', 'member', 'viewer'] as const) {
      expect(showsVaultStatus(role), role).toBe(false);
      expect(vaultCard(connection(), role, true), role).toBeNull();
    }
  });

  it('says connected, waiting, needs attention, key expiring, paused and disconnected', () => {
    expect(vaultPhoneState(null)).toBe('not_connected');
    expect(vaultPhoneState(connection())).toBe('connected');
    expect(vaultPhoneState(connection({ stage: 'approval', status: 'needs_vault' }))).toBe('waiting');
    expect(vaultPhoneState(connection({ status: 'needs_vault' }))).toBe('needs_attention');
    expect(vaultPhoneState(connection({ status: 'failing' }))).toBe('needs_attention');
    expect(vaultPhoneState(connection({ keyProblem: 'revoked', status: 'needs_vault' }))).toBe(
      'needs_attention',
    );
    expect(vaultPhoneState(connection({ status: 'paused' }))).toBe('paused');
    expect(vaultPhoneState(connection({ key: { ...connection().key!, expiresSoon: true } }))).toBe(
      'key_expiring',
    );
    expect(vaultPhoneState(connection({ status: 'disconnected', key: null }))).toBe('disconnected');
  });

  it('puts the status in the web’s words', () => {
    expect(say(vaultStatusWords(connection()))).toBe('Connected to The Smiths');
    expect(say(vaultStatusWords(connection({ stage: 'approval' })))).toBe(
      'Waiting for The Smiths to approve Montra',
    );
    expect(say(vaultStatusWords(connection({ keyProblem: 'expired' })))).toBe('Needs a new key');
    expect(say(vaultStatusWords(connection({ status: 'needs_vault' })))).toBe('Needs attention in the vault');
    expect(say(vaultStatusWords(connection({ status: 'disconnected' })))).toBe('Disconnected');
  });

  it('shows what the web’s card shows, read only, and sends changes to the web', () => {
    const card = vaultCard(connection(), 'owner', true)!;
    expect(card).toMatchObject({ state: 'connected', tone: 'good', missing: 0 });
    const lines = card.lines.map((l) => (l.key ? say(l as never) : l.text));
    expect(lines).toEqual([
      'Vault: The Smiths · vault.example.org',
      'Montra acts as itself in the vault, as Montra.',
      'The vault key expires on 2027-02-01.',
      'Waiting to send: 2',
      'Filed: 12',
      'Couldn’t send: 2'.replace('’', "'"),
      'Kept in step with the vault: last read 2026-11-18.',
    ]);
    expect(say(card.web)).toMatch(/on the web/);
    // An admin is told an owner changes it.
    expect(vaultCard(connection(), 'admin', true)!.web.key).toBe('mobile.vault.owner_on_web');
  });

  it('warns of a key expiring soon, and says why a key no longer works', () => {
    const soon = vaultCard(connection({ key: { ...connection().key!, expiresSoon: true } }), 'owner', true)!;
    expect(soon.tone).toBe('warn');
    expect(soon.lines.find((l) => l.testID === 'vault-key')).toMatchObject({
      key: 'mobile.vault.key_expires_soon',
      tone: 'warn',
    });
    const revoked = vaultCard(
      connection({ keyProblem: 'revoked', status: 'needs_vault', lastError: 'Revoked' }),
      'owner',
      true,
    )!;
    expect(revoked.tone).toBe('bad');
    expect(say(revoked.lines.find((l) => l.testID === 'vault-key') as never)).toMatch(/revoked/);
    // The key's words stand for the problem; the stored error isn't said twice.
    expect(revoked.lines.some((l) => l.testID === 'vault-error')).toBe(false);
    const never = vaultCard(connection({ key: { ...connection().key!, expiresAt: null } }), 'owner', true)!;
    expect(never.lines.find((l) => l.testID === 'vault-key')?.key).toBe('mobile.vault.key_never_expires');
  });

  it('gives the vault’s own words when it needs a person, and the holds for its daily limits', () => {
    const card = vaultCard(
      connection({
        status: 'needs_vault',
        lastError: 'Montra is paused in the vault.',
        heldUntil: { sending: '2026-11-19T00:00:00.000Z', reading: '2026-11-19T00:00:00.000Z' },
      }),
      'owner',
      true,
    )!;
    expect(card.lines).toContainEqual({
      text: 'Montra is paused in the vault.',
      tone: 'bad',
      testID: 'vault-error',
    });
    expect(card.lines).toContainEqual({ key: 'mobile.vault.held_sending', values: { date: '2026-11-19' } });
    expect(card.lines).toContainEqual({ key: 'mobile.vault.held_reading', values: { date: '2026-11-19' } });
  });

  it('says it is waiting for approval with the hint, and doesn’t speak of the feed yet', () => {
    const card = vaultCard(
      connection({ stage: 'approval', status: 'needs_vault', feedReadAt: null }),
      'owner',
      true,
    )!;
    expect(card.state).toBe('waiting');
    expect(card.lines.map((l) => l.key)).toContain('vault.approval_hint');
    expect(card.lines.map((l) => l.key)).not.toContain('vault.feed_not_read');
  });

  it('says a disconnected vault keeps files to provide again, and links to Review', () => {
    const card = vaultCard(
      connection({ status: 'disconnected', key: null, files: { onlyInVault: 3, missing: 3 } }),
      'owner',
      true,
    )!;
    expect(card).toMatchObject({ state: 'disconnected', tone: 'bad', missing: 3 });
    expect(say(card.lines[0] as never)).toMatch(/disconnected from The Smiths.*3 files kept only there/);
    expect(words.t('mobile.vault.missing_in_review', { count: 3 })).toBe('3 files to upload again in Review');
  });

  it('says not connected only where the plan has the vault', () => {
    expect(vaultCard(null, 'owner', false)).toBeNull();
    const card = vaultCard(null, 'owner', true)!;
    expect(card.state).toBe('not_connected');
    expect(card.web.key).toBe('mobile.vault.connect_on_web');
    expect(vaultCard(null, 'admin', true)!.web.key).toBe('mobile.vault.owner_on_web');
  });

  it('counts as the web does, leaving out noughts', () => {
    expect(vaultCounts(connection({ files: { onlyInVault: 4, missing: 1 } }))).toEqual([
      { key: 'vault.count_sending', n: 2 },
      { key: 'vault.count_filed', n: 12 },
      { key: 'vault.count_failed', n: 2 },
      { key: 'vault.count_only_in_vault', n: 4 },
      { key: 'vault.count_missing', n: 1 },
    ]);
    expect(vaultHost('https://vault.example.org:8443')).toBe('vault.example.org:8443');
    expect(vaultHost(null)).toBe('');
  });
});

describe('the badges on files', () => {
  it('says where a file is with the vault, as the web does', () => {
    expect(vaultBadge(undefined)).toBeNull();
    expect(vaultBadge(state({ vault: null }))).toBeNull();
    expect(vaultBadge(state({}, { status: 'queued' }))?.key).toBe('vault.badge_sending');
    expect(vaultBadge(state({}, { status: 'received' }))?.key).toBe('vault.badge_inbox');
    expect(vaultBadge(state())).toMatchObject({ key: 'vault.badge_filed', tone: 'good' });
    expect(vaultBadge(state({ location: 'vault' }))?.key).toBe('vault.badge_only_in_vault');
    expect(
      vaultBadge(state({}, { status: 'not_kept', notKeptReason: 'Not a type the vault keeps.' })),
    ).toEqual({
      key: 'vault.badge_not_kept',
      tone: 'muted',
      detail: 'Not a type the vault keeps.',
    });
    expect(vaultBadge(state({}, { status: 'failed' }))?.tone).toBe('bad');
    expect(say(vaultBadge(state({}, { status: 'out_of_reach', canOpen: false }))!)).toBe(
      'No longer available in Family Document Vault',
    );
    expect(
      vaultBadge(state({ location: 'vault', missing: { since: '2026-11-17', reason: 'Not given back.' } })),
    ).toEqual({ key: 'vault.badge_missing', tone: 'bad', detail: 'Not given back.' });
  });

  it('names the document as the vault does, notes a newer version, and offers to open what may be opened', () => {
    const b = vaultBadges(
      [
        state(),
        state({ fileId: FILE2, location: 'vault' }, { newerVersion: true, title: null, kind: 'Receipt' }),
      ],
      [FILE, FILE2],
    );
    expect(b.badges.map((x) => x.key)).toEqual(['vault.badge_filed', 'vault.badge_only_in_vault']);
    expect(say(b.name)).toBe('In the vault as: Grocer, March 2026');
    expect(b.newer).toBe(true);
    expect(words.t('vault.newer_version')).toBe('The vault has a newer version');
    expect(b.openable).toEqual([FILE, FILE2]);
    // Only the record's own files; nothing for files not sent; nothing to open when missing or not yet shown.
    expect(vaultBadges([state()], [FILE2])).toEqual({ badges: [], name: null, newer: false, openable: [] });
    expect(
      vaultBadges(
        [
          state({ location: 'vault', missing: { since: 'x', reason: 'Gone.' } }),
          state({ fileId: FILE2 }, { canOpen: false }),
        ],
        [FILE, FILE2],
      ).openable,
    ).toEqual([]);
  });

  it('shows a page kept only in the vault in words, with Open in the vault when it can be', () => {
    expect(vaultOnlyPage([state()], FILE)).toBeNull();
    expect(vaultOnlyPage([], FILE)).toBeNull();
    expect(vaultOnlyPage([state({ location: 'vault' })], FILE)).toEqual({ canOpen: true, missing: null });
    expect(
      vaultOnlyPage([state({ location: 'vault', missing: { since: 'x', reason: 'Gone.' } })], FILE),
    ).toEqual({ canOpen: false, missing: 'Gone.' });
  });

  it('asks about each file once, and at most the API’s hundred', () => {
    expect(badgeIds([FILE, FILE, FILE2])).toEqual([FILE, FILE2]);
    expect(badgeIds(Array.from({ length: 150 }, (_, i) => `id-${i}`))).toHaveLength(100);
  });
});

describe('opening a document in the vault', () => {
  const LINK = 'https://vault.example.org/api/v1/app-links/tok3n-of-forty-three-characters-xxxxxxxxxx';

  it('hands the link made on the tap straight to the browser, and keeps it nowhere', async () => {
    const openUrl = vi.fn(async () => true);
    const link = vi.fn(async () => ({ url: LINK, mode: 'view' as const }));
    const r = await openInVault({ link, openUrl });
    expect(r).toEqual({ opened: true, mode: 'view' });
    expect(link).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(LINK);
    expect(JSON.stringify(r)).not.toContain('tok3n');
    expect(vaultOpenMessage(r)).toBeNull();
  });

  it('says when the vault can’t show the type as pages, so it opens as a download', async () => {
    const r = await openInVault({
      link: async () => ({ url: LINK, mode: 'download' }),
      openUrl: async () => true,
    });
    expect(r).toEqual({ opened: true, mode: 'download' });
    expect(say(vaultOpenMessage(r))).toMatch(/as pages, so it opens as a download/);
  });

  it('never opens anything but an https link', async () => {
    const openUrl = vi.fn(async () => true);
    const r = await openInVault({
      link: async () => ({ url: 'http://vault.example.org/x', mode: 'view' }),
      openUrl,
    });
    expect(r).toEqual({ opened: false, problem: 'failed', minutes: null });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('says the vault’s hourly link limit with the minutes to wait', async () => {
    const r = await openInVault({
      link: async () => {
        throw new ApiError(429, 'vault.links_full', 'Too many', 125);
      },
      openUrl: async () => true,
    });
    expect(r).toEqual({ opened: false, problem: 'links_full', minutes: 3 });
    expect(say(vaultOpenMessage(r))).toBe(
      'Montra has opened as many documents from the vault as it may this hour. Try again in about 3 min.',
    );
    expect(vaultOpenProblem(new ApiError(429, 'vault.links_full', 'x'))).toEqual({
      problem: 'links_full',
      minutes: 60,
    });
  });

  it('says not allowed, no longer available, and a type the vault can’t show, in words', () => {
    const cases: Array<[ApiError, string, RegExp]> = [
      [new ApiError(403, 'forbidden', 'x'), 'not_allowed', /can't open this document/],
      [new ApiError(410, 'vault.out_of_reach', 'x'), 'out_of_reach', /No longer available/],
      [new ApiError(422, 'vault.cannot_view', 'x'), 'cannot_view', /can't show this kind of file as pages/],
      [new ApiError(422, 'vault.cannot_open', 'x'), 'cannot_open', /doesn't let Montra open documents/],
      [new ApiError(409, 'vault.needs_vault', 'x'), 'needs_vault', /See Your data/],
      [new ApiError(409, 'vault.disconnected', 'x'), 'disconnected', /disconnected/],
      [new ApiError(409, 'vault.not_filed', 'x'), 'not_filed', /isn't filed in the vault yet/],
      [new ApiError(404, 'vault.not_in_vault', 'x'), 'not_filed', /isn't filed in the vault yet/],
      [new ApiError(404, 'not_found', 'x'), 'not_found', /isn't here/],
      [new ApiError(0, 'network', 'x'), 'offline', /couldn't be reached/],
      [new ApiError(502, 'vault.failed', 'x'), 'failed', /couldn't open this/],
    ];
    for (const [err, problem, text] of cases) {
      const r: VaultOpenResult = { opened: false, ...vaultOpenProblem(err) };
      expect(r, err.code).toMatchObject({ problem });
      expect(say(vaultOpenMessage(r)), err.code).toMatch(text);
    }
    // A browser that couldn't take the link is a failure in words, without the link.
    expect(vaultOpenProblem(new Error('No app to open it'))).toEqual({ problem: 'failed', minutes: null });
  });

  it('has words for every problem', () => {
    for (const problem of VAULT_OPEN_PROBLEMS) {
      const m = vaultOpenMessage({ opened: false, problem, minutes: 5 })!;
      expect(m.key in en, m.key).toBe(true);
    }
  });
});

describe('the API calls', () => {
  type Call = { url: string; init: RequestInit };
  const api = (respond: (c: Call) => Response) => {
    const calls: Call[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      const c = { url, init };
      calls.push(c);
      return respond(c);
    }) as unknown as typeof fetch;
    return { calls, api: createApi({ baseUrl: 'http://api', token: async () => 'dev:a@b.co', fetch: f }) };
  };

  it('asks for the link with a POST, no idempotency key, and reads it from the body', async () => {
    const { calls, api: a } = api(
      () => new Response(JSON.stringify({ url: 'https://v.example/l/x', mode: 'view' }), { status: 200 }),
    );
    expect(await a.vaultOpenLink('w1', FILE)).toEqual({ url: 'https://v.example/l/x', mode: 'view' });
    await a.vaultOpenLink('w1', FILE, 'download');
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', `http://api/v1/workspaces/w1/family-vault/files/${FILE}/link`],
      ['POST', `http://api/v1/workspaces/w1/family-vault/files/${FILE}/link?mode=download`],
    ]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('idempotency-key');
  });

  it('keeps the wait the API asks for on a refusal', async () => {
    const { api: a } = api(
      () =>
        new Response(JSON.stringify({ code: 'vault.links_full', detail: 'Too many' }), {
          status: 429,
          headers: { 'retry-after': '90' },
        }),
    );
    await expect(a.vaultOpenLink('w1', FILE)).rejects.toMatchObject({
      status: 429,
      code: 'vault.links_full',
      retryAfterSeconds: 90,
    });
  });

  it('reads the connection and the badges at the web’s endpoints', async () => {
    const { calls, api: a } = api((c) =>
      c.url.endsWith('/family-vault')
        ? new Response(JSON.stringify({ connection: connection() }), { status: 200 })
        : new Response(JSON.stringify({ data: [state()] }), { status: 200 }),
    );
    expect((await a.vaultConnection('w1'))?.householdName).toBe('The Smiths');
    expect(await a.fileStorageStates('w1', [FILE, FILE2])).toEqual([state()]);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', 'http://api/v1/workspaces/w1/family-vault'],
      ['GET', `http://api/v1/workspaces/w1/family-vault/files?ids=${FILE},${FILE2}`],
    ]);
  });
});

describe('a possible duplicate on the phone’s own uploads (the owner’s clarification, 2026-11-18)', () => {
  it('asks when any upload is the bytes of a file Montra already holds', () => {
    expect(anyDuplicate([{ duplicateOf: null }, { duplicateOf: null }])).toBe(false);
    expect(anyDuplicate([])).toBe(false);
    expect(anyDuplicate([{ duplicateOf: null }, { duplicateOf: { fileId: FILE, receiptId: null } }])).toBe(
      true,
    );
  });

  it('asks in the web’s words, and says nothing was made when the person says no', () => {
    expect(words.t(DUPLICATE_QUESTION.body)).toBe(
      'This looks like a duplicate of a file already in Montra. Use it anyway?',
    );
    for (const k of Object.values(DUPLICATE_QUESTION)) expect(k in en, k).toBe(true);
  });

  it('shows a waiting receipt capture as a possible duplicate', () => {
    expect(queuedStatus({ state: 'duplicate', error: null, nextAttemptAt: null }, true, new Date())).toEqual({
      kind: 'duplicate',
    });
    expect(queuedStatus({ state: 'duplicate', error: null, nextAttemptAt: null }, false, new Date())).toEqual(
      {
        kind: 'duplicate',
      },
    );
  });
});

describe('the words the vault’s screens use', () => {
  it('are all in the catalog', () => {
    const root = join(__dirname, '..');
    const text = [
      'src/ui/Vault.tsx',
      'src/features/vault.ts',
      'app/receipts/index.tsx',
      'app/payslips/capture.tsx',
      'app/bills/capture.tsx',
    ]
      .map((p) => readFileSync(join(root, p), 'utf8'))
      .join('\n');
    const keys = [
      ...text.matchAll(/['`]((?:mobile\.vault|mobile\.files|vault|files)\.[a-z0-9_.]+)['`]/g),
    ].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    const dynamic = (['revoked', 'expired', 'invalid', 'signed'] as const).map(
      (k) => `vault.key_problem.${k}`,
    );
    expect([...keys, ...dynamic].filter((k) => !(k in en))).toEqual([]);
  });
});
