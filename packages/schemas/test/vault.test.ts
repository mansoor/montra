import { describe, expect, it } from 'vitest';
import {
  DisconnectVaultRequest,
  FILE_KINDS,
  FileStorageStateDto,
  isMirrorKind,
  MissingFileDto,
  PasteVaultCodeRequest,
  SendExistingToVaultRequest,
  STORAGE_FILE_KINDS,
  StorageDestinationDto,
  StorageDestinationKind,
  UpdateVaultConnectionRequest,
  VAULT_GROUP_DEFAULTS,
  VAULT_GROUP_KINDS,
  VAULT_GROUPS,
  VAULT_RESTRICTED_GROUPS,
  VaultConnectionDto,
  vaultFileKinds,
  vaultGroupOf,
  vaultGroupSwitches,
  VaultItemsQuery,
  vaultSends,
  type FileKind,
  type VaultGroup,
} from '../src/index.js';

const ID = '11111111-1111-4111-8111-111111111111';

// ADR-0054 §6: one switch per group, mapped from Montra's file kinds.
describe('the vault’s document groups (ADR-0054 §6, VLT-02, VLT-07)', () => {
  const table: [FileKind, boolean, VaultGroup | 'never'][] = [
    ['receipt', false, 'receipts'],
    ['statement', false, 'statements'],
    ['invoice', false, 'bills'],
    ['payslip', false, 'payslips'],
    ['tax_form', false, 'tax_documents'],
    ['lease', false, 'other'],
    ['other', false, 'other'],
    ['export', false, 'never'],
    ['logo', false, 'never'],
    // Sealed copies of identity documents (ADR-0034 §3), whatever kind they're stored as.
    ...FILE_KINDS.map((kind): [FileKind, boolean, 'never'] => [kind, true, 'never']),
  ];

  it.each(table)('puts a %s file (sealed: %s) in %s', (kind, sealed, group) => {
    expect(vaultGroupOf({ kind, sealed })).toBe(group);
  });

  it('puts every kind that can be copied in exactly one group, and nothing else in any', () => {
    for (const kind of STORAGE_FILE_KINDS) {
      const groups = VAULT_GROUPS.filter((g) => VAULT_GROUP_KINDS[g].includes(kind));
      expect(groups, kind).toHaveLength(1);
      expect(vaultGroupOf({ kind, sealed: false })).toBe(groups[0]);
    }
    const covered = VAULT_GROUPS.flatMap((g) => [...VAULT_GROUP_KINDS[g]]).sort();
    expect(covered).toEqual([...STORAGE_FILE_KINDS].sort());
    expect(FILE_KINDS.filter((k) => vaultGroupOf({ kind: k, sealed: false }) === 'never')).toEqual([
      'export',
      'logo',
    ]);
  });

  it('never sends sealed copies, logos or exports, even with every switch on', () => {
    const all = Object.fromEntries(VAULT_GROUPS.map((g) => [g, true]));
    for (const kind of FILE_KINDS) {
      expect(vaultSends({ kind, sealed: true }, all), kind).toBe(false);
    }
    expect(vaultSends({ kind: 'logo', sealed: false }, all)).toBe(false);
    expect(vaultSends({ kind: 'export', sealed: false }, all)).toBe(false);
    expect(vaultFileKinds(all)).toEqual([...STORAGE_FILE_KINDS]);
  });

  it('starts with receipts, statements and bills on, and payslips, tax documents and other papers off', () => {
    expect(VAULT_GROUP_DEFAULTS).toEqual({
      receipts: true,
      statements: true,
      bills: true,
      payslips: false,
      tax_documents: false,
      other: false,
    });
    expect(vaultFileKinds()).toEqual(['statement', 'receipt', 'invoice']);
    expect(vaultSends({ kind: 'payslip', sealed: false })).toBe(false);
    expect(vaultSends({ kind: 'tax_form', sealed: false })).toBe(false);
    expect(vaultSends({ kind: 'receipt', sealed: false })).toBe(true);
    expect([...VAULT_RESTRICTED_GROUPS].sort()).toEqual(['payslips', 'tax_documents']);
  });

  it('sends payslips and tax documents only when they are switched on', () => {
    expect(vaultFileKinds({ payslips: true })).toEqual(['statement', 'receipt', 'payslip', 'invoice']);
    expect(vaultFileKinds({ tax_documents: true, receipts: false })).toEqual([
      'statement',
      'invoice',
      'tax_form',
    ]);
    expect(vaultSends({ kind: 'payslip', sealed: false }, { payslips: true })).toBe(true);
    expect(vaultSends({ kind: 'tax_form', sealed: false }, { tax_documents: true })).toBe(true);
  });

  it('fills in the defaults for groups not given, and can turn everything off', () => {
    expect(vaultGroupSwitches({ statements: false })).toEqual({ ...VAULT_GROUP_DEFAULTS, statements: false });
    const none = Object.fromEntries(VAULT_GROUPS.map((g) => [g, false]));
    expect(vaultFileKinds(none)).toEqual([]);
  });
});

describe('vault connection DTOs (ADR-0054 §11)', () => {
  const dto = {
    id: ID,
    stage: 'connected',
    status: 'active',
    address: 'https://vault.example.com',
    householdName: 'The Smiths',
    publicKey: 'MCowBQYDK2VwAyEA-public-part',
    fingerprint: 'SHA256:abcd',
    role: 'copy',
    backup: 'montra',
    groups: VAULT_GROUPS.map((group) => ({ group, on: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
    vaultKinds: [{ key: 'receipt', name: 'Receipt' }],
    describeMore: false,
    deleteWithMontra: false,
    canDelete: true,
    items: { queued: 0, pending: 1, received: 2, filed: 3, notKept: 0, failed: 0, outOfReach: 0 },
    heldUntil: { sending: null, reading: null },
    clockOffsetMs: null,
    keyRotation: 'none',
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    version: 1,
  };

  it('never carries a private key, whatever a server puts in', () => {
    const parsed = VaultConnectionDto.parse({ ...dto, privateKey: 'secret', secret: 'x', secretEnc: 'y' });
    expect(parsed).toEqual(dto);
    expect(JSON.stringify(parsed)).not.toMatch(/secret|private/i);
  });

  it('adds `fdv` as a kind of connection, but the mirror’s settings stay S3 and WebDAV', () => {
    expect(StorageDestinationKind.options).toEqual(['s3', 'webdav', 'fdv']);
    expect(isMirrorKind('s3')).toBe(true);
    expect(isMirrorKind('webdav')).toBe(true);
    expect(isMirrorKind('fdv')).toBe(false);
    expect(StorageDestinationDto.shape.kind.safeParse('fdv').success).toBe(false);
  });

  it('takes a pasted code, trimmed and bounded, with the version it was made against', () => {
    expect(PasteVaultCodeRequest.parse({ code: '  abc-123 \n', version: 1 })).toEqual({
      code: 'abc-123',
      version: 1,
    });
    expect(PasteVaultCodeRequest.safeParse({ code: '   ', version: 1 }).success).toBe(false);
    expect(PasteVaultCodeRequest.safeParse({ code: 'x'.repeat(4001), version: 1 }).success).toBe(false);
  });

  it('changes groups one at a time, each named once, and refuses what it doesn’t know', () => {
    const ok = UpdateVaultConnectionRequest.parse({
      version: 3,
      role: 'record',
      backup: 'own_storage',
      groups: [
        { group: 'payslips', on: true },
        { group: 'receipts', vaultKind: 'receipt' },
      ],
    });
    expect(ok.groups).toHaveLength(2);
    expect(
      UpdateVaultConnectionRequest.safeParse({
        version: 3,
        groups: [
          { group: 'receipts', on: true },
          { group: 'receipts', on: false },
        ],
      }).success,
    ).toBe(false);
    expect(
      UpdateVaultConnectionRequest.safeParse({ version: 3, groups: [{ group: 'logos', on: true }] }).success,
    ).toBe(false);
    expect(UpdateVaultConnectionRequest.safeParse({ version: 3, backup: 'cloud' }).success).toBe(false);
    // An inbox or a person to file to is the vault's decision (owner's answer 3).
    expect(UpdateVaultConnectionRequest.safeParse({ version: 3, inbox: 'Sam' }).success).toBe(false);
  });

  it('asks for the count shown before sending existing documents, and disconnects carefully by default', () => {
    expect(SendExistingToVaultRequest.safeParse({}).success).toBe(false);
    expect(SendExistingToVaultRequest.parse({ expected: 120 })).toEqual({ expected: 120 });
    expect(DisconnectVaultRequest.parse({})).toEqual({ anyway: false });
  });

  it('lists outbox rows by status, but not the deletes', () => {
    expect(VaultItemsQuery.parse({})).toEqual({ status: 'failed', limit: 50 });
    expect(VaultItemsQuery.parse({ status: 'not_kept', limit: '10' })).toEqual({
      status: 'not_kept',
      limit: 10,
    });
    expect(VaultItemsQuery.safeParse({ status: 'delete' }).success).toBe(false);
  });
});

describe('files held in the vault, and missing files (ADR-0054 §5a, §9)', () => {
  it('says where a file is and what the vault calls it', () => {
    const state = FileStorageStateDto.parse({
      fileId: ID,
      location: 'vault',
      missing: null,
      vault: {
        status: 'filed',
        title: 'Bank statement, October 2026',
        newerVersion: false,
        notKeptReason: null,
      },
    });
    expect(state.vault?.title).toBe('Bank statement, October 2026');
    expect(FileStorageStateDto.safeParse({ ...state, location: 'cloud' }).success).toBe(false);
  });

  it('describes a missing file by what it was and what uses it, and carries no link', () => {
    const missing = {
      fileId: ID,
      fileName: 'october.pdf',
      group: 'statements',
      uploadedAt: '2026-11-01T10:00:00.000Z',
      missingSince: '2026-11-17T10:00:00.000Z',
      reason: 'The vault didn’t return this file.',
      usedBy: [{ kind: 'statement', id: ID, label: 'Checking, October 2026' }],
    };
    expect(MissingFileDto.parse({ ...missing, link: 'https://vault.example.com/one-time' })).toEqual(missing);
  });
});
