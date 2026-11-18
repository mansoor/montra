import { describe, expect, it } from 'vitest';
import {
  DisconnectVaultRequest,
  FILE_KINDS,
  FileStorageStatesQuery,
  RetryVaultItemsRequest,
  VAULT_GROUP_MODES_OFFERED,
  vaultEffectiveModes,
  vaultSuggestKind,
  vaultTypeKept,
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
  VAULT_GROUP_MODES,
  VaultConnectionDto,
  vaultFileKinds,
  vaultGroupModes,
  vaultGroupOf,
  VaultItemsQuery,
  vaultKeepsCopy,
  vaultModeOf,
  vaultSends,
  ReplaceVaultKeyRequest,
  type FileKind,
  type VaultGroup,
  type VaultGroupMode,
} from '../src/index.js';

const ID = '11111111-1111-4111-8111-111111111111';

// ADR-0054 §6: one mode per group, mapped from Montra's file kinds (the owner's clarification, 2026-11-17).
describe('the vault’s document groups (ADR-0054 §6, VLT-02, VLT-07)', () => {
  const every = (mode: VaultGroupMode) =>
    Object.fromEntries(VAULT_GROUPS.map((g) => [g, mode])) as Record<VaultGroup, VaultGroupMode>;

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

  it('never sends sealed copies, logos or exports, whatever the modes say, and always keeps them', () => {
    for (const mode of ['sent_keep_copy', 'sent_no_copy'] as const) {
      const all = every(mode);
      for (const kind of FILE_KINDS) {
        expect(vaultSends({ kind, sealed: true }, all), kind).toBe(false);
        expect(vaultKeepsCopy({ kind, sealed: true }, all), kind).toBe(true);
      }
      expect(vaultSends({ kind: 'logo', sealed: false }, all)).toBe(false);
      expect(vaultSends({ kind: 'export', sealed: false }, all)).toBe(false);
      expect(vaultModeOf({ kind: 'export', sealed: false }, all)).toBe('not_sent');
      expect(vaultFileKinds(all)).toEqual([...STORAGE_FILE_KINDS]);
    }
  });

  it('starts with receipts, statements and bills sent with a copy kept, and the rest not sent', () => {
    expect(VAULT_GROUP_MODES).toEqual(['not_sent', 'sent_keep_copy', 'sent_no_copy']);
    expect(VAULT_GROUP_DEFAULTS).toEqual({
      receipts: 'sent_keep_copy',
      statements: 'sent_keep_copy',
      bills: 'sent_keep_copy',
      payslips: 'not_sent',
      tax_documents: 'not_sent',
      other: 'not_sent',
    });
    expect(vaultFileKinds()).toEqual(['statement', 'receipt', 'invoice']);
    expect(vaultSends({ kind: 'payslip', sealed: false })).toBe(false);
    expect(vaultSends({ kind: 'tax_form', sealed: false })).toBe(false);
    expect(vaultSends({ kind: 'receipt', sealed: false })).toBe(true);
    expect([...VAULT_RESTRICTED_GROUPS].sort()).toEqual(['payslips', 'tax_documents']);
  });

  it('sends payslips and tax documents only when they are given a sent mode', () => {
    expect(vaultFileKinds({ payslips: 'sent_keep_copy' })).toEqual([
      'statement',
      'receipt',
      'payslip',
      'invoice',
    ]);
    expect(vaultFileKinds({ tax_documents: 'sent_no_copy', receipts: 'not_sent' })).toEqual([
      'statement',
      'invoice',
      'tax_form',
    ]);
    expect(vaultSends({ kind: 'payslip', sealed: false }, { payslips: 'sent_keep_copy' })).toBe(true);
    expect(vaultSends({ kind: 'tax_form', sealed: false }, { tax_documents: 'sent_no_copy' })).toBe(true);
  });

  it('keeps Montra’s copy unless the group is sent with no local copy', () => {
    const receipt = { kind: 'receipt' as const, sealed: false };
    expect(vaultKeepsCopy(receipt)).toBe(true);
    expect(vaultKeepsCopy(receipt, { receipts: 'not_sent' })).toBe(true);
    expect(vaultKeepsCopy(receipt, { receipts: 'sent_keep_copy' })).toBe(true);
    expect(vaultKeepsCopy(receipt, { receipts: 'sent_no_copy' })).toBe(false);
    // Another group's mode doesn't reach it.
    expect(vaultKeepsCopy(receipt, { statements: 'sent_no_copy' })).toBe(true);
    expect(vaultSends(receipt, { receipts: 'sent_no_copy' })).toBe(true);
  });

  it('fills in the defaults for groups not given, and can send nothing', () => {
    expect(vaultGroupModes({ statements: 'not_sent' })).toEqual({
      ...VAULT_GROUP_DEFAULTS,
      statements: 'not_sent',
    });
    expect(vaultFileKinds(every('not_sent'))).toEqual([]);
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
    newKey: null,
    actingAs: 'Sam',
    groups: VAULT_GROUPS.map((group) => ({ group, mode: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
    vaultKinds: [{ key: 'receipt', name: 'Receipt' }],
    describeMore: false,
    deleteWithMontra: false,
    canDelete: true,
    items: { queued: 0, pending: 1, received: 2, filed: 3, notKept: 0, failed: 0, outOfReach: 0 },
    heldUntil: { sending: null, reading: null },
    dailyLimit: { files: 100, filesToday: 3 },
    clockOffsetMs: null,
    feedReadAt: null,
    files: { onlyInVault: 2, missing: 1 },
    mirrorGroups: ['receipts'],
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
      groups: [
        { group: 'payslips', mode: 'sent_keep_copy' },
        { group: 'receipts', vaultKind: 'receipt' },
        { group: 'statements', mode: 'sent_no_copy' },
      ],
    });
    expect(ok.groups).toHaveLength(3);
    expect(
      UpdateVaultConnectionRequest.safeParse({
        version: 3,
        groups: [
          { group: 'receipts', mode: 'not_sent' },
          { group: 'receipts', mode: 'sent_keep_copy' },
        ],
      }).success,
    ).toBe(false);
    expect(
      UpdateVaultConnectionRequest.safeParse({ version: 3, groups: [{ group: 'logos', mode: 'not_sent' }] })
        .success,
    ).toBe(false);
    expect(
      UpdateVaultConnectionRequest.safeParse({ version: 3, groups: [{ group: 'receipts', on: true }] })
        .success,
    ).toBe(false);
    // The connection-wide role and backup choice gave way to each group's mode (2026-11-17).
    expect(UpdateVaultConnectionRequest.safeParse({ version: 3, role: 'record' }).success).toBe(false);
    expect(UpdateVaultConnectionRequest.safeParse({ version: 3, backup: 'none' }).success).toBe(false);
    // An inbox or a person to file to is the vault's decision (owner's answer 3).
    expect(UpdateVaultConnectionRequest.safeParse({ version: 3, inbox: 'Sam' }).success).toBe(false);
  });

  it('replaces the key, or cancels a new key not yet confirmed', () => {
    expect(ReplaceVaultKeyRequest.parse({ version: 2 })).toEqual({ version: 2, cancel: false });
    expect(ReplaceVaultKeyRequest.parse({ version: 2, cancel: true })).toEqual({ version: 2, cancel: true });
    expect(ReplaceVaultKeyRequest.safeParse({ version: 2, privateKey: 'x' }).success).toBe(false);
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
        kind: 'Bank statement',
        newerVersion: false,
        notKeptReason: null,
        canOpen: true,
      },
    });
    expect(state.vault?.title).toBe('Bank statement, October 2026');
    // §9: whether "Open in the vault" is offered, never a link.
    expect(state.vault?.canOpen).toBe(true);
    expect(JSON.stringify(state)).not.toMatch(/https?:/);
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

describe('sending (ADR-0054 §3, D8; As built: PR 3)', () => {
  it('offers all three modes, sending with no local copy included, now that Montra removes its copy safely (PR 5b)', () => {
    expect(VAULT_GROUP_MODES_OFFERED).toEqual(['not_sent', 'sent_keep_copy', 'sent_no_copy']);
  });

  it('sends a group only once it is mapped to one of the vault’s kinds', () => {
    const modes = vaultEffectiveModes([
      { group: 'receipts', mode: 'sent_keep_copy', vaultKind: 'receipt' },
      { group: 'statements', mode: 'sent_keep_copy', vaultKind: null },
      { group: 'payslips', mode: 'not_sent', vaultKind: 'pay_statement' },
    ]);
    expect(modes.receipts).toBe('sent_keep_copy');
    expect(modes.statements).toBe('not_sent');
    expect(modes.payslips).toBe('not_sent');
    // A group not given is unmapped, so not sent, whatever its default.
    expect(modes.bills).toBe('not_sent');
    expect(vaultFileKinds(modes)).toEqual(['receipt']);
  });

  it('keeps statement exports in Montra, and anything the vault doesn’t take (D8)', () => {
    const accepted = ['application/pdf', 'image/jpeg', 'image/png'];
    expect(vaultTypeKept({ mime: 'application/pdf', fileName: 'October.pdf' }, accepted)).toBe(true);
    expect(vaultTypeKept({ mime: 'image/png', fileName: 'lunch.png' }, accepted)).toBe(true);
    expect(vaultTypeKept({ mime: 'image/heic', fileName: 'lunch.heic' }, accepted)).toBe(false);
    for (const [mime, fileName] of [
      ['text/csv', 'checking.csv'],
      ['application/vnd.ms-excel', 'checking.xls'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'checking.xlsx'],
      ['application/x-ofx', 'checking.ofx'],
      ['application/octet-stream', 'checking.qfx'],
    ]) {
      // Even a vault that says it takes everything doesn't get them.
      expect(vaultTypeKept({ mime: mime!, fileName: fileName! }, [...accepted, mime!, '*/*']), fileName).toBe(
        false,
      );
    }
    expect(vaultTypeKept({ mime: 'image/webp', fileName: 'x.webp' }, ['image/*'])).toBe(true);
    expect(vaultTypeKept({ mime: 'application/pdf', fileName: 'x.pdf' }, [])).toBe(false);
  });

  it('suggests the vault’s obvious kind for each group, and nothing when there is none', () => {
    const kinds = [
      { key: 'bank_statement', name: 'Bank statement' },
      { key: 'utility_bill', name: 'Utility / bill' },
      { key: 'pay_statement', name: 'Pay statement / payslip' },
    ];
    expect(vaultSuggestKind('statements', kinds)).toBe('bank_statement');
    expect(vaultSuggestKind('bills', kinds)).toBe('utility_bill');
    expect(vaultSuggestKind('payslips', kinds)).toBe('pay_statement');
    expect(vaultSuggestKind('receipts', kinds)).toBeNull();
    expect(vaultSuggestKind('tax_documents', [{ key: 'tax_form', name: 'Tax form' }])).toBe('tax_form');
  });

  it('reads the files a badge asks about, and retries by id', () => {
    expect(FileStorageStatesQuery.parse({ ids: `${ID}, ${ID}` }).ids).toEqual([ID]);
    expect(() => FileStorageStatesQuery.parse({ ids: '' })).toThrow();
    expect(() => FileStorageStatesQuery.parse({ ids: 'not-an-id' })).toThrow();
    expect(RetryVaultItemsRequest.parse({})).toEqual({});
    expect(() => RetryVaultItemsRequest.parse({ fileIds: [] })).toThrow();
  });
});
