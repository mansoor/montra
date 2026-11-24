import { describe, expect, it } from 'vitest';
import {
  VaultConnectionDto as VaultConnectionSchema,
  VAULT_GROUP_DEFAULTS,
  VAULT_GROUPS,
  vaultUnkeptDefault,
} from '@montra/schemas';
import type { FileStorageStateDto, VaultConnectionDto } from '@montra/api-client';
import {
  canManageVault,
  canSeeVault,
  cleanPastedCode,
  vaultActsAsLine,
  vaultConnectInput,
  vaultHost,
  vaultKeyLine,
  vaultKeyPermissions,
  vaultReplaceInput,
  vaultStatusLine,
  vaultStep,
  vaultBadge,
  vaultCounts,
  vaultEstimate,
  vaultGroupChanges,
  vaultGroupRows,
  vaultMirrorKeeps,
  vaultOnlyPage,
  inVaultRedirect,
  vaultTone,
  vaultUnmapped,
  isPersonOpening,
  vaultFeedLine,
  vaultName,
  vaultOpenHref,
  vaultOpenOutcome,
  vaultOpenProblemHref,
  vaultOpenProblemKey,
  vaultDisconnectChoice,
  vaultMoveQuestion,
  vaultOriginalsNote,
  vaultSendAgainIds,
  VAULT_OPEN_PROBLEMS,
} from './vault';
import { catalogs } from '@montra/i18n';

const en = catalogs.en!;

// The Family Document Vault card in Settings → Storage (ADR-0054 §2, §13).
const connection = (over: Partial<VaultConnectionDto> = {}): VaultConnectionDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  stage: 'connected',
  status: 'active',
  address: 'https://vault.example.com',
  householdName: 'The Smiths',
  key: {
    clientId: 'fdvc_AAAAAAAAAAAAAAAAAAAAAA',
    name: 'Montra',
    permissions: ['documents.send', 'documents.read'],
    createdAt: '2026-11-17T09:00:00.000Z',
    expiresAt: '2027-02-15T09:00:00.000Z',
    expiresSoon: false,
  },
  keyProblem: null,
  actsAs: 'app',
  actingAs: 'Montra',
  groups: VAULT_GROUPS.map((group) => ({
    group,
    mode: VAULT_GROUP_DEFAULTS[group],
    vaultKind: null,
    unkept: vaultUnkeptDefault(group),
  })),
  vaultKinds: [{ key: 'utility_bill', name: 'Utility / bill' }],
  describeMore: false,
  coverNumber: 'last4',
  deleteWithMontra: false,
  canDelete: false,
  items: { queued: 0, pending: 0, received: 0, filed: 0, notKept: 0, failed: 0, outOfReach: 0, converted: 0 },
  heldUntil: { sending: null, reading: null },
  dailyLimit: { files: 100, filesToday: 4 },
  feedReadAt: '2026-11-17T10:05:00.000Z',
  files: { onlyInVault: 0, missing: 0 },
  bringingBack: null,
  mirrorGroups: [],
  lastSuccessAt: '2026-11-17T10:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  createdAt: '2026-11-17T09:00:00.000Z',
  version: 3,
  ...over,
});

describe('who sees the vault card', () => {
  it('shows it to owners and admins whose plan has the vault, and lets only an owner change it', () => {
    expect(canSeeVault('owner', ['ownStorage', 'familyVault'])).toBe(true);
    expect(canSeeVault('admin', ['familyVault'])).toBe(true);
    expect(canSeeVault('owner', ['ownStorage'])).toBe(false);
    for (const role of ['partner', 'viewer', 'accountant', 'member'] as const) {
      expect(canSeeVault(role, ['familyVault']), role).toBe(false);
    }
    expect(canManageVault('owner')).toBe(true);
    expect(canManageVault('admin')).toBe(false);
  });
});

describe('vaultStep and vaultStatusLine', () => {
  it('walks the steps of connecting', () => {
    expect(vaultStep(null)).toBe('start');
    // Only a connection begun before API keys is still at `register`: it needs a key.
    const begun = connection({
      stage: 'register',
      status: 'needs_vault',
      householdName: null,
      keyProblem: 'signed',
    });
    expect(vaultStep(begun)).toBe('register');
    expect(vaultStatusLine(begun)).toEqual({ key: 'vault.status_needs_key' });
    expect(vaultStatusLine(connection({ stage: 'approval', status: 'needs_vault' }))).toEqual({
      key: 'vault.status_approval',
      values: { name: 'The Smiths' },
    });
    expect(vaultStatusLine(connection({ stage: 'approval', householdName: null })).key).toBe(
      'vault.status_approval_unnamed',
    );
    expect(vaultStatusLine(connection())).toEqual({
      key: 'vault.status_connected',
      values: { name: 'The Smiths' },
    });
  });

  it('says when the connection needs someone, is failing or is paused', () => {
    expect(vaultStatusLine(connection({ status: 'needs_vault' })).key).toBe('vault.status_needs_vault');
    expect(vaultStatusLine(connection({ status: 'failing' })).key).toBe('vault.status_failing');
    expect(vaultStatusLine(connection({ status: 'paused' })).key).toBe('vault.status_paused');
    expect(vaultTone(connection())).toBe('good');
    expect(vaultTone(connection({ status: 'needs_vault' }))).toBe('bad');
    expect(vaultTone(connection({ status: 'paused' }))).toBe('muted');
    expect(vaultTone(connection({ stage: 'approval', status: 'needs_vault' }))).toBe('muted');
  });

  it('says a key that needs replacing before anything else', () => {
    for (const problem of ['revoked', 'expired', 'invalid', 'signed'] as const) {
      const d = connection({ status: 'needs_vault', keyProblem: problem, lastError: 'The vault key …' });
      expect(vaultStatusLine(d).key, problem).toBe('vault.status_needs_key');
      expect(vaultTone(d)).toBe('bad');
    }
  });
});

describe('the vault key (API keys, vault 0.9.0-dev.63)', () => {
  it('says why a key needs replacing, else when it expires, warning within 14 days, in words that exist', () => {
    for (const problem of ['revoked', 'expired', 'invalid', 'signed'] as const) {
      const line = vaultKeyLine(connection({ keyProblem: problem }));
      expect(line).toEqual({ key: `vault.key_problem.${problem}`, tone: 'bad' });
      expect(en[line!.key], problem).toMatch(/needs to (paste|generate)/);
    }
    expect(en['vault.key_problem.revoked']).toBe(
      'The vault key was revoked — an owner needs to paste a new key.',
    );
    expect(vaultKeyLine(connection())).toEqual({
      key: 'vault.key_expires',
      values: { date: '2027-02-15' },
      tone: 'muted',
    });
    const soon = connection({
      key: { ...connection().key!, expiresAt: '2026-11-25T09:00:00.000Z', expiresSoon: true },
    });
    expect(vaultKeyLine(soon)).toEqual({
      key: 'vault.key_expires_soon',
      values: { date: '2026-11-25' },
      tone: 'warn',
    });
    expect(vaultKeyLine(connection({ key: { ...connection().key!, expiresAt: null } }))?.key).toBe(
      'vault.key_never_expires',
    );
    expect(vaultKeyLine(connection({ key: null }))).toBeNull();
    for (const k of [
      'vault.key_expires',
      'vault.key_expires_soon',
      'vault.key_never_expires',
      'vault.status_needs_key',
    ])
      expect(en[k], k).toBeTruthy();
  });

  it('lists what the key may do, in the vault’s order, in words that exist', () => {
    const d = connection({
      key: { ...connection().key!, permissions: ['documents.delete', 'documents.send', 'documents.links'] },
    });
    expect(vaultKeyPermissions(d)).toEqual([
      'vault.permission.send',
      'vault.permission.links',
      'vault.permission.delete',
    ]);
    for (const k of vaultKeyPermissions(d)) expect(en[k], k).toBeTruthy();
    expect(vaultKeyPermissions(connection({ key: null }))).toEqual([]);
  });

  it('shows whether Montra acts as itself or as a person', () => {
    expect(vaultActsAsLine(connection())).toEqual({
      key: 'vault.acts_as_itself',
      values: { name: 'Montra' },
    });
    expect(vaultActsAsLine(connection({ actsAs: 'person', actingAs: 'Sam' }))).toEqual({
      key: 'vault.acts_as_person',
      values: { name: 'Sam' },
    });
    // Member fields may be null (APP8).
    expect(vaultActsAsLine(connection({ actsAs: 'person', actingAs: null }))?.key).toBe(
      'vault.acts_as_person_unnamed',
    );
    expect(vaultActsAsLine(connection({ actsAs: null }))).toBeNull();
    for (const k of ['vault.acts_as_itself', 'vault.acts_as_person', 'vault.acts_as_person_unnamed'])
      expect(en[k], k).toBeTruthy();
  });

  it('sends what was pasted as the API takes it, the secret only when there is one', () => {
    expect(vaultConnectInput('  fdvapp2.ab\ncd ', '')).toEqual({ connectionString: 'fdvapp2.abcd' });
    expect(vaultConnectInput('fdvapp2.x', ' fdvs_y ', 4)).toEqual({
      connectionString: 'fdvapp2.x',
      secret: 'fdvs_y',
      version: 4,
    });
    expect(vaultConnectInput('  ', 'fdvs_y')).toBeNull();
    expect(vaultReplaceInput('fdvapp2.x', '', 3)).toEqual({ version: 3, connectionString: 'fdvapp2.x' });
    expect(vaultReplaceInput(' fdvc_abc ', 'fdvs_y', 3)).toEqual({
      version: 3,
      clientId: 'fdvc_abc',
      secret: 'fdvs_y',
    });
    expect(vaultReplaceInput('', 'fdvs_y', 3)).toBeNull();
  });
});

describe('small helpers', () => {
  it('shows the vault’s host and cleans a pasted connection string', () => {
    expect(vaultHost('https://vault.example.com:8443')).toBe('vault.example.com:8443');
    expect(vaultHost(null)).toBe('');
    expect(cleanPastedCode('  fdvapp2.eyJ1\ncmwi OiJ \r\n')).toBe('fdvapp2.eyJ1cmwiOiJ');
  });

  it('keeps its fixture in step with the API’s DTO, which never carries the key’s secret', () => {
    expect(VaultConnectionSchema.parse(connection())).toEqual(connection());
    expect(JSON.stringify(connection())).not.toMatch(/secret|privateKey|publicKey|fingerprint/i);
  });
});

// ADR-0054 §6, §12, §13 (PR 3): what each group does, how sending is going, and the badge on a file.
describe('Send these to the vault', () => {
  const kinds = [
    { key: 'bank_statement', name: 'Bank statement' },
    { key: 'utility_bill', name: 'Utility / bill' },
    { key: 'pay_statement', name: 'Pay statement / payslip' },
  ];

  it('offers an owner all three modes, suggesting the vault’s obvious kind for a group not mapped', () => {
    const rows = vaultGroupRows(connection({ vaultKinds: kinds }), 'owner');
    expect(rows.map((r) => r.group)).toEqual([...VAULT_GROUPS]);
    const statements = rows.find((r) => r.group === 'statements')!;
    expect(statements).toMatchObject({
      mode: 'sent_keep_copy',
      vaultKind: 'bank_statement',
      mapped: false,
      editable: true,
      modes: ['not_sent', 'sent_keep_copy', 'sent_no_copy'],
    });
    expect(rows.find((r) => r.group === 'payslips')).toMatchObject({ restricted: true, mode: 'not_sent' });
    // Sending without a local copy is offered from PR 5b, for every group, to an owner only.
    expect(rows.every((r) => r.modes.includes('sent_no_copy'))).toBe(true);
    expect(
      vaultGroupRows(connection({ vaultKinds: kinds }), 'admin').some((r) =>
        r.modes.includes('sent_no_copy'),
      ),
    ).toBe(false);
  });

  it('lets an admin only turn payslips or tax documents off (D4)', () => {
    const d = connection({
      vaultKinds: kinds,
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: group === 'payslips' ? 'sent_keep_copy' : VAULT_GROUP_DEFAULTS[group],
        vaultKind: group === 'payslips' ? 'pay_statement' : null,
        unkept: vaultUnkeptDefault(group),
      })),
    });
    const rows = vaultGroupRows(d, 'admin');
    expect(rows.find((r) => r.group === 'payslips')).toMatchObject({
      editable: true,
      modes: ['not_sent', 'sent_keep_copy'],
    });
    expect(rows.find((r) => r.group === 'tax_documents')).toMatchObject({
      editable: false,
      modes: ['not_sent'],
    });
    expect(rows.find((r) => r.group === 'receipts')).toMatchObject({ editable: false });
  });

  it('saves only what changed, a suggested kind included, and warns before payslips or tax documents go', () => {
    const d = connection({ vaultKinds: kinds });
    const draft = vaultGroupRows(d, 'owner').map((r) => ({
      group: r.group,
      mode: r.mode,
      vaultKind: r.vaultKind,
    }));
    expect(vaultGroupChanges(d, draft)).toEqual({
      groups: [
        { group: 'statements', vaultKind: 'bank_statement' },
        { group: 'bills', vaultKind: 'utility_bill' },
      ],
      warn: [],
      noCopy: [],
    });
    const payslipsOn = draft.map((g) =>
      g.group === 'payslips' ? { ...g, mode: 'sent_keep_copy' as const, vaultKind: 'pay_statement' } : g,
    );
    const changes = vaultGroupChanges(d, payslipsOn);
    expect(changes.warn).toEqual(['payslips']);
    expect(changes.groups).toContainEqual({
      group: 'payslips',
      mode: 'sent_keep_copy',
      vaultKind: 'pay_statement',
    });
    // §5a: a group that starts going without a local copy is warned about; one already so isn't, again.
    const noCopy = draft.map((g) => (g.group === 'receipts' ? { ...g, mode: 'sent_no_copy' as const } : g));
    expect(vaultGroupChanges(d, noCopy).noCopy).toEqual(['receipts']);
    const already = connection({
      vaultKinds: kinds,
      groups: d.groups.map((g) => (g.group === 'receipts' ? { ...g, mode: 'sent_no_copy' as const } : g)),
    });
    expect(vaultGroupChanges(already, noCopy).noCopy).toEqual([]);
    // Turning a group off leaves its kind as it was.
    const off = draft.map((g) => (g.group === 'receipts' ? { ...g, mode: 'not_sent' as const } : g));
    expect(vaultGroupChanges(d, off).groups).toContainEqual({ group: 'receipts', mode: 'not_sent' });
  });

  it('says when the owner’s own storage still keeps a copy of a group sent without one', () => {
    const d = connection({ mirrorGroups: ['receipts', 'statements'] });
    expect(vaultMirrorKeeps(d, 'receipts', 'sent_no_copy')).toBe(true);
    expect(vaultMirrorKeeps(d, 'receipts', 'sent_keep_copy')).toBe(false);
    expect(vaultMirrorKeeps(d, 'bills', 'sent_no_copy')).toBe(false);
  });

  it('says which sent groups aren’t mapped, so aren’t sent', () => {
    expect(vaultUnmapped(connection())).toEqual(['receipts', 'statements', 'bills']);
    const mapped = connection({
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: VAULT_GROUP_DEFAULTS[group],
        vaultKind: VAULT_GROUP_DEFAULTS[group] === 'not_sent' ? null : 'utility_bill',
        unkept: vaultUnkeptDefault(group),
      })),
    });
    expect(vaultUnmapped(mapped)).toEqual([]);
  });
});

describe('how sending is going', () => {
  it('counts what is waiting, in an Inbox, filed, not taken and failed, leaving out noughts', () => {
    expect(vaultCounts(connection())).toEqual([]);
    expect(
      vaultCounts(
        connection({
          items: {
            queued: 2,
            pending: 1,
            received: 4,
            filed: 9,
            notKept: 1,
            failed: 0,
            outOfReach: 0,
            converted: 0,
          },
        }),
      ),
    ).toEqual([
      { key: 'vault.count_sending', n: 3 },
      { key: 'vault.count_inbox', n: 4 },
      { key: 'vault.count_filed', n: 9 },
      { key: 'vault.count_not_kept', n: 1 },
    ]);
    // §5, §5a: files kept only in the vault, and those to upload again.
    expect(vaultCounts(connection({ files: { onlyInVault: 7, missing: 2 } }))).toEqual([
      { key: 'vault.count_only_in_vault', n: 7 },
      { key: 'vault.count_missing', n: 2 },
    ]);
  });

  it('says how long existing documents take at the vault’s daily limit', () => {
    expect(vaultEstimate({ count: 0, groups: [], perDay: 100, days: 0 }).key).toBe('vault.existing_none');
    expect(vaultEstimate({ count: 40, groups: [], perDay: null, days: null })).toEqual({
      key: 'vault.existing_count',
      values: { count: '40' },
    });
    expect(vaultEstimate({ count: 40, groups: [], perDay: 100, days: 1 }).key).toBe('vault.existing_today');
    expect(vaultEstimate({ count: 250, groups: [], perDay: 100, days: 3 })).toEqual({
      key: 'vault.existing_days',
      values: { count: '250', days: '3' },
    });
  });

  it('badges a file by where it is with the vault, and nothing for one not sent', () => {
    const state = (status: string, more: Record<string, unknown> = {}): FileStorageStateDto => ({
      fileId: '00000000-0000-4000-8000-000000000009',
      location: 'montra',
      missing: null,
      vault: {
        status: status as never,
        title: null,
        kind: null,
        newerVersion: false,
        notKeptReason: null,
        canOpen: false,
        converted: null,
        ...more,
      },
    });
    expect(vaultBadge(undefined)).toBeNull();
    expect(vaultBadge({ ...state('filed'), vault: null })).toBeNull();
    expect(vaultBadge(state('pending'))?.key).toBe('vault.badge_sending');
    expect(vaultBadge(state('received'))?.key).toBe('vault.badge_inbox');
    expect(vaultBadge(state('filed', { title: 'Bank statement, October 2026' }))).toEqual({
      key: 'vault.badge_filed',
      tone: 'good',
      title: 'Bank statement, October 2026',
    });
    expect(vaultBadge(state('not_kept', { notKeptReason: 'Not a type the vault keeps.' }))).toEqual({
      key: 'vault.badge_not_kept',
      tone: 'muted',
      title: 'Not a type the vault keeps.',
    });
    expect(vaultBadge(state('failed'))?.tone).toBe('bad');
    expect(vaultBadge(state('delete'))).toBeNull();
    // §5: kept only in the vault; §5a: missing, whatever the vault's status, with the reason in words.
    expect(vaultBadge({ ...state('filed'), location: 'vault' })?.key).toBe('vault.badge_only_in_vault');
    expect(
      vaultBadge({
        ...state('filed'),
        location: 'vault',
        missing: {
          since: '2026-11-17T10:00:00.000Z',
          reason: 'Family Document Vault didn’t give this file back.',
        },
      }),
    ).toEqual({
      key: 'vault.badge_missing',
      tone: 'bad',
      title: 'Family Document Vault didn’t give this file back.',
    });
  });
});

// Keeping in step and opening a document in the vault (ADR-0054 §9, PR 4).
describe('what the vault calls a document, and opening it', () => {
  const ws = '00000000-0000-4000-8000-0000000000aa';
  const file = '00000000-0000-4000-8000-0000000000bb';
  const filed = (more: Record<string, unknown>): FileStorageStateDto => ({
    fileId: file,
    location: 'montra',
    missing: null,
    vault: {
      status: 'filed',
      title: null,
      kind: null,
      newerVersion: false,
      notKeptReason: null,
      canOpen: true,
      converted: null,
      ...more,
    },
  });

  it('names a document as the vault does: its title, else its kind', () => {
    expect(vaultName(filed({ title: 'October statement', kind: 'Bank statement' }))).toBe(
      'October statement',
    );
    expect(vaultName(filed({ kind: 'Bank statement' }))).toBe('Bank statement');
    expect(vaultName(filed({}))).toBeNull();
    expect(vaultName(undefined)).toBeNull();
    expect(vaultBadge(filed({ kind: 'Bank statement' }))?.title).toBe('Bank statement');
    expect(vaultBadge(filed({ status: 'out_of_reach' }))?.key).toBe('vault.badge_out_of_reach');
  });

  it('opens through the web app’s own route, never with a link in the page', () => {
    expect(vaultOpenHref(ws, file)).toBe(`/w/${ws}/vault/${file}/open?mode=view`);
    expect(vaultOpenHref(ws, file, 'download')).toBe(`/w/${ws}/vault/${file}/open?mode=download`);
    expect(vaultOpenProblemHref(ws, file, 'links_full', 12)).toBe(
      `/w/${ws}/vault/${file}?problem=links_full&minutes=12`,
    );
    expect(vaultOpenProblemHref(ws, file, 'out_of_reach', null)).toBe(
      `/w/${ws}/vault/${file}?problem=out_of_reach`,
    );
  });

  it('sends the browser on to an https link at once, and anything else to words', () => {
    const go = 'https://vault.example.com/api/v1/app-links/abc';
    expect(vaultOpenOutcome({ status: 303, location: go, retryAfter: null, code: null })).toEqual({ go });
    // Never anything but https, whatever answered.
    expect(
      vaultOpenOutcome({ status: 303, location: 'javascript:alert(1)', retryAfter: null, code: null }),
    ).toEqual({ problem: 'failed', minutes: null });
    expect(
      vaultOpenOutcome({ status: 303, location: 'http://vault.example.com/x', retryAfter: null, code: null }),
    ).toEqual({ problem: 'failed', minutes: null });
    // The vault's hourly limit on links: a wait, in minutes.
    expect(
      vaultOpenOutcome({ status: 429, location: null, retryAfter: '600', code: 'vault.links_full' }),
    ).toEqual({
      problem: 'links_full',
      minutes: 10,
    });
    expect(
      vaultOpenOutcome({ status: 429, location: null, retryAfter: '5', code: 'vault.links_full' }),
    ).toEqual({
      problem: 'links_full',
      minutes: 1,
    });
    expect(vaultOpenOutcome({ status: 429, location: null, retryAfter: null, code: null })).toEqual({
      problem: 'links_full',
      minutes: 60,
    });
    expect(
      vaultOpenOutcome({ status: 410, location: null, retryAfter: null, code: 'vault.out_of_reach' }),
    ).toEqual({
      problem: 'out_of_reach',
      minutes: null,
    });
    expect(
      vaultOpenOutcome({ status: 422, location: null, retryAfter: null, code: 'vault.cannot_view' }),
    ).toMatchObject({ problem: 'cannot_view' });
    expect(
      vaultOpenOutcome({ status: 404, location: null, retryAfter: null, code: 'not_found' }),
    ).toMatchObject({ problem: 'not_found' });
    expect(
      vaultOpenOutcome({ status: 404, location: null, retryAfter: null, code: 'vault.not_in_vault' }),
    ).toMatchObject({ problem: 'not_filed' });
    expect(vaultOpenOutcome({ status: 502, location: null, retryAfter: null, code: null })).toMatchObject({
      problem: 'failed',
    });
  });

  it('says each problem in words, and the general words for anything it doesn’t know', () => {
    expect(vaultOpenProblemKey('out_of_reach')).toBe('vault.open_out_of_reach');
    expect(vaultOpenProblemKey('links_full')).toBe('vault.open_links_full');
    expect(vaultOpenProblemKey('<script>')).toBe('vault.open_failed');
    expect(vaultOpenProblemKey(undefined)).toBe('vault.open_failed');
  });

  it('makes a link only for a person’s click: never for a prefetch or another site', () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
    expect(isPersonOpening(h({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }))).toBe(true);
    expect(isPersonOpening(h({}))).toBe(true);
    expect(isPersonOpening(h({ 'sec-purpose': 'prefetch' }))).toBe(false);
    expect(isPersonOpening(h({ 'sec-purpose': 'prefetch;prerender' }))).toBe(false);
    expect(isPersonOpening(h({ purpose: 'prefetch' }))).toBe(false);
    expect(isPersonOpening(h({ 'next-router-prefetch': '1' }))).toBe(false);
    expect(isPersonOpening(h({ rsc: '1' }))).toBe(false);
    expect(isPersonOpening(h({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isPersonOpening(h({ 'sec-fetch-dest': 'image' }))).toBe(false);
  });

  it('says when the vault’s changes were last read, or that the vault doesn’t let Montra read them', () => {
    expect(vaultFeedLine(connection())).toEqual({ key: 'vault.feed_read', at: '2026-11-17T10:05:00.000Z' });
    expect(vaultFeedLine(connection({ feedReadAt: null }))).toEqual({ key: 'vault.feed_not_read', at: null });
    expect(VaultConnectionSchema.parse(connection())).toBeTruthy();
  });
});

// Sent with no local copy (ADR-0054 §5, PR 5b): a file only the vault holds is opened there, never previewed here.
describe('a file kept only in the vault', () => {
  const ws = '00000000-0000-4000-8000-0000000000aa';
  const file = '00000000-0000-4000-8000-0000000000bb';
  const state = (more: Partial<FileStorageStateDto>): FileStorageStateDto => ({
    fileId: file,
    location: 'vault',
    missing: null,
    vault: {
      status: 'filed',
      title: null,
      kind: null,
      newerVersion: false,
      notKeptReason: null,
      canOpen: true,
      converted: null,
    },
    ...more,
  });

  it('shows the viewer’s notice with “Open it in the vault” instead of the page', () => {
    expect(vaultOnlyPage([state({})], ws, file)).toEqual({
      openHref: vaultOpenHref(ws, file),
      missing: false,
    });
    // Nothing to open yet (the feed hasn't shown it), or missing: the notice, without the link.
    expect(vaultOnlyPage([state({ vault: { ...state({}).vault!, canOpen: false } })], ws, file)).toEqual({
      openHref: null,
      missing: false,
    });
    expect(
      vaultOnlyPage([state({ missing: { since: '2026-11-17T00:00:00.000Z', reason: 'x' } })], ws, file),
    ).toEqual({ openHref: null, missing: true });
    // Montra holds it, or nothing is known yet: shown as always.
    expect(vaultOnlyPage([state({ location: 'montra' })], ws, file)).toBeNull();
    expect(vaultOnlyPage([], ws, file)).toBeNull();
  });

  it('sends a person who followed a link to such a file to the page that says so (409 file.in_vault)', () => {
    const path = ['v1', 'workspaces', ws, 'receipts', '00000000-0000-4000-8000-0000000000cc', 'files', file];
    expect(inVaultRedirect(path, 409, 'file.in_vault')).toBe(
      vaultOpenProblemHref(ws, file, 'in_vault', null),
    );
    expect(vaultOpenProblemKey('in_vault')).toBe('vault.open_in_vault_only');
    // Anything else goes through as it came.
    expect(inVaultRedirect(path, 409, 'version.conflict')).toBeNull();
    expect(inVaultRedirect(path, 410, 'file.in_vault')).toBeNull();
    expect(inVaultRedirect(['v1', 'workspaces', ws, 'files', 'not-an-id'], 409, 'file.in_vault')).toBeNull();
    expect(inVaultRedirect([...path, 'extra'], 409, 'file.in_vault')).toBeNull();
    expect(inVaultRedirect(['v1', 'me', 'files', file], 409, 'file.in_vault')).toBeNull();
  });
});

describe('the vault as the record, the rest (ADR-0054 §5, §10; PR 5b2)', () => {
  it('asks “Move these N files too?” only when there is something to move', () => {
    expect(vaultMoveQuestion({ count: 0, groups: [] })).toBeNull();
    expect(vaultMoveQuestion({ count: 1, groups: [{ group: 'receipts', count: 1 }] })).toEqual({
      key: 'vault.move_offer_one',
      values: { count: '1' },
    });
    expect(vaultMoveQuestion({ count: 12, groups: [{ group: 'receipts', count: 12 }] })).toEqual({
      key: 'vault.move_offer',
      values: { count: '12' },
    });
  });

  it('offers the disconnect choice only while files are kept only in the vault', () => {
    expect(vaultDisconnectChoice(connection())).toBe('confirm');
    expect(vaultDisconnectChoice(connection({ files: { onlyInVault: 3, missing: 0 } }))).toBe('choose');
    // Missing ones count: the connection is how the same vault would give them back.
    expect(vaultDisconnectChoice(connection({ files: { onlyInVault: 2, missing: 2 } }))).toBe('choose');
    expect(
      vaultDisconnectChoice(
        connection({ files: { onlyInVault: 3, missing: 0 }, bringingBack: { then: 'keep' } }),
      ),
    ).toBe('bringing_back');
  });

  it('shows a disconnected connection as its own step, and says when files are being brought back', () => {
    const off = connection({ status: 'disconnected' });
    expect(vaultStep(off)).toBe('disconnected');
    expect(vaultStatusLine(off)).toEqual({ key: 'vault.status_disconnected' });
    expect(vaultTone(off)).toBe('bad');
    // Connecting again starts at the code, as any connection.
    expect(vaultStep(connection({ status: 'needs_vault', stage: 'register' }))).toBe('register');
    expect(vaultStatusLine(connection({ bringingBack: { then: 'disconnect' } }))).toEqual({
      key: 'vault.status_bringing_back',
    });
    expect(VaultConnectionSchema.parse(off)).toEqual(off);
  });

  it('says in words that nothing opens in a vault Montra is disconnected from', () => {
    expect(
      vaultOpenOutcome({ status: 409, location: null, retryAfter: null, code: 'vault.disconnected' }),
    ).toEqual({ problem: 'disconnected', minutes: null });
    expect(vaultOpenProblemKey('disconnected')).toBe('vault.open_disconnected');
  });

  it('has every message these use', () => {
    const keys = [
      'vault.move_offer',
      'vault.move_offer_one',
      'vault.status_disconnected',
      'vault.status_bringing_back',
      ...VAULT_OPEN_PROBLEMS.map(vaultOpenProblemKey),
    ];
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    expect(en['vault.move_offer']).toContain('{count}');
  });
});

describe('statements the vault doesn’t keep, sent as PDFs (ADR-0057)', () => {
  const converted = (
    more: Partial<NonNullable<NonNullable<FileStorageStateDto['vault']>['converted']>>,
    reason: string | null = null,
  ): FileStorageStateDto => ({
    fileId: '00000000-0000-4000-8000-0000000000cc',
    location: 'montra',
    missing: null,
    vault: {
      status: 'converted',
      title: null,
      kind: null,
      newerVersion: false,
      notKeptReason: reason,
      canOpen: false,
      converted: {
        state: 'rendered',
        attached: true,
        parts: 1,
        waiting: 0,
        received: 0,
        filed: 0,
        notKept: 0,
        failed: 0,
        earlier: 0,
        canSendAgain: true,
        ...more,
      },
    },
  });

  it('offers the three choices to an owner for statements only, and shows the choice to others', () => {
    const d = connection();
    const owner = vaultGroupRows(d, 'owner');
    expect(owner.find((r) => r.group === 'statements')).toMatchObject({
      unkept: 'convert_attach',
      unkeptChoices: ['dont_send', 'convert', 'convert_attach'],
    });
    expect(owner.find((r) => r.group === 'receipts')).toMatchObject({
      unkept: 'dont_send',
      unkeptChoices: ['dont_send'],
    });
    expect(vaultGroupRows(d, 'admin').find((r) => r.group === 'statements')!.unkeptChoices).toEqual([
      'convert_attach',
    ]);
  });

  it('saves a changed choice, and says what happens to originals sent with no local copy', () => {
    const d = connection();
    const draft = d.groups.map((g) => ({ ...g, unkept: g.group === 'statements' ? 'convert' : g.unkept }));
    expect(vaultGroupChanges(d, draft as never).groups).toEqual([{ group: 'statements', unkept: 'convert' }]);
    expect(vaultOriginalsNote({ group: 'statements', mode: 'sent_no_copy', unkept: 'convert_attach' })).toBe(
      'vault.originals_go',
    );
    expect(vaultOriginalsNote({ group: 'statements', mode: 'sent_no_copy', unkept: 'convert' })).toBe(
      'vault.originals_stay',
    );
    expect(vaultOriginalsNote({ group: 'statements', mode: 'sent_keep_copy', unkept: 'convert' })).toBeNull();
    expect(vaultOriginalsNote({ group: 'receipts', mode: 'sent_no_copy', unkept: 'dont_send' })).toBeNull();
  });

  it('badges a converted file: converting, sent, filed, couldn’t be converted, import undone', () => {
    expect(vaultBadge(converted({ state: 'rendering', parts: 0 }))?.key).toBe('vault.badge_converting');
    expect(vaultBadge(converted({ waiting: 1 }))?.key).toBe('vault.badge_converted_sending');
    expect(vaultBadge(converted({ received: 1 }))).toMatchObject({
      key: 'vault.badge_converted_sent',
      tone: 'good',
    });
    expect(vaultBadge(converted({ filed: 1 }))?.key).toBe('vault.badge_converted_filed');
    expect(vaultBadge(converted({ failed: 1 }))?.key).toBe('vault.badge_failed');
    expect(vaultBadge(converted({ state: 'not_converted', parts: 0 }, 'why'))).toEqual({
      key: 'vault.badge_not_converted',
      tone: 'muted',
      title: 'why',
    });
    expect(vaultBadge(converted({ state: 'import_undone', received: 1 }))?.key).toBe(
      'vault.badge_import_undone',
    );
    expect(vaultCounts(connection({ items: { ...connection().items, converted: 3 } }))).toEqual([
      { key: 'vault.count_converted', n: 3 },
    ]);
  });

  it('offers “Send again” only for a file whose PDFs the vault has', () => {
    const a = converted({ received: 1 });
    const b = { ...converted({ waiting: 1, canSendAgain: false }), fileId: 'other' };
    expect(vaultSendAgainIds([a, b])).toEqual([a.fileId]);
  });

  it('has words for every new key', () => {
    for (const key of [
      'vault.badge_converted_filed',
      'vault.badge_converted_sending',
      'vault.badge_converted_sent',
      'vault.badge_converting',
      'vault.badge_import_undone',
      'vault.badge_not_converted',
      'vault.count_converted',
      'vault.cover.full',
      'vault.cover.last4',
      'vault.cover.none',
      'vault.cover_full_warning',
      'vault.originals_go',
      'vault.originals_stay',
      'vault.unkept.convert',
      'vault.unkept.convert_attach',
      'vault.unkept.dont_send',
    ]) {
      expect(en[key], key).toBeTruthy();
    }
  });
});
