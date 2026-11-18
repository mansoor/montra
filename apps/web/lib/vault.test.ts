import { describe, expect, it } from 'vitest';
import {
  VaultConnectionDto as VaultConnectionSchema,
  VAULT_GROUP_DEFAULTS,
  VAULT_GROUPS,
} from '@montra/schemas';
import type { FileStorageStateDto, VaultConnectionDto } from '@montra/api-client';
import {
  canManageVault,
  canSeeVault,
  cleanPastedCode,
  clockIsOff,
  vaultHost,
  vaultStatusLine,
  vaultStep,
  vaultBadge,
  vaultCounts,
  vaultEstimate,
  vaultGroupChanges,
  vaultGroupRows,
  vaultTone,
  vaultUnmapped,
  isPersonOpening,
  vaultFeedLine,
  vaultName,
  vaultOpenHref,
  vaultOpenOutcome,
  vaultOpenProblemHref,
  vaultOpenProblemKey,
} from './vault';

// The Family Document Vault card in Settings → Storage (ADR-0054 §2, §13).
const connection = (over: Partial<VaultConnectionDto> = {}): VaultConnectionDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  stage: 'connected',
  status: 'active',
  address: 'https://vault.example.com',
  householdName: 'The Smiths',
  publicKey: 'ed25519:Bm0rbJ7Q8V3d8w7c2b1aXyZ0123456789abcdefghij',
  fingerprint: 'ce2d 6777 0439 61a5 d947 31bb 086a 4fb4',
  newKey: null,
  actingAs: 'Sam',
  groups: VAULT_GROUPS.map((group) => ({ group, mode: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
  vaultKinds: [{ key: 'utility_bill', name: 'Utility / bill' }],
  describeMore: false,
  deleteWithMontra: false,
  canDelete: false,
  items: { queued: 0, pending: 0, received: 0, filed: 0, notKept: 0, failed: 0, outOfReach: 0 },
  heldUntil: { sending: null, reading: null },
  dailyLimit: { files: 100, filesToday: 4 },
  clockOffsetMs: 120,
  feedReadAt: '2026-11-17T10:05:00.000Z',
  keyRotation: 'none',
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
  it('walks the three steps of connecting', () => {
    expect(vaultStep(null)).toBe('start');
    expect(vaultStep(connection({ stage: 'register', status: 'needs_vault', householdName: null }))).toBe(
      'register',
    );
    expect(vaultStatusLine(connection({ stage: 'register', status: 'needs_vault' }))).toEqual({
      key: 'vault.status_register',
    });
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
});

describe('small helpers', () => {
  it('shows the vault’s host, warns about a clock that is off, and cleans a pasted code', () => {
    expect(vaultHost('https://vault.example.com:8443')).toBe('vault.example.com:8443');
    expect(vaultHost(null)).toBe('');
    expect(clockIsOff(null)).toBe(false);
    expect(clockIsOff(30_000)).toBe(false);
    expect(clockIsOff(-180_000)).toBe(true);
    expect(cleanPastedCode('  fdvapp1.eyJ1\ncmwi OiJ \r\n')).toBe('fdvapp1.eyJ1cmwiOiJ');
  });

  it('keeps its fixture in step with the API’s DTO, which never carries a private key', () => {
    expect(VaultConnectionSchema.parse(connection())).toEqual(connection());
    expect(Object.keys(connection())).not.toContain('privateKey');
  });
});

// ADR-0054 §6, §12, §13 (PR 3): what each group does, how sending is going, and the badge on a file.
describe('Send these to the vault', () => {
  const kinds = [
    { key: 'bank_statement', name: 'Bank statement' },
    { key: 'utility_bill', name: 'Utility / bill' },
    { key: 'pay_statement', name: 'Pay statement / payslip' },
  ];

  it('offers an owner not sent or sent with a copy, suggesting the vault’s obvious kind for a group not mapped', () => {
    const rows = vaultGroupRows(connection({ vaultKinds: kinds }), 'owner');
    expect(rows.map((r) => r.group)).toEqual([...VAULT_GROUPS]);
    const statements = rows.find((r) => r.group === 'statements')!;
    expect(statements).toMatchObject({
      mode: 'sent_keep_copy',
      vaultKind: 'bank_statement',
      mapped: false,
      editable: true,
      modes: ['not_sent', 'sent_keep_copy'],
    });
    expect(rows.find((r) => r.group === 'payslips')).toMatchObject({ restricted: true, mode: 'not_sent' });
    // No group offers sending without a local copy yet (PR 5).
    expect(rows.every((r) => !r.modes.includes('sent_no_copy'))).toBe(true);
  });

  it('lets an admin only turn payslips or tax documents off (D4)', () => {
    const d = connection({
      vaultKinds: kinds,
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: group === 'payslips' ? 'sent_keep_copy' : VAULT_GROUP_DEFAULTS[group],
        vaultKind: group === 'payslips' ? 'pay_statement' : null,
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
    // Turning a group off leaves its kind as it was.
    const off = draft.map((g) => (g.group === 'receipts' ? { ...g, mode: 'not_sent' as const } : g));
    expect(vaultGroupChanges(d, off).groups).toContainEqual({ group: 'receipts', mode: 'not_sent' });
  });

  it('says which sent groups aren’t mapped, so aren’t sent', () => {
    expect(vaultUnmapped(connection())).toEqual(['receipts', 'statements', 'bills']);
    const mapped = connection({
      groups: VAULT_GROUPS.map((group) => ({
        group,
        mode: VAULT_GROUP_DEFAULTS[group],
        vaultKind: VAULT_GROUP_DEFAULTS[group] === 'not_sent' ? null : 'utility_bill',
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
          items: { queued: 2, pending: 1, received: 4, filed: 9, notKept: 1, failed: 0, outOfReach: 0 },
        }),
      ),
    ).toEqual([
      { key: 'vault.count_sending', n: 3 },
      { key: 'vault.count_inbox', n: 4 },
      { key: 'vault.count_filed', n: 9 },
      { key: 'vault.count_not_kept', n: 1 },
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
