/** Your own storage for files and backups (BAK-03, BAK-05; ADR-0031). Secrets go in and never come back out. */
import { z } from 'zod';
import { Id } from './common.js';

/** Every kind of connection: the mirrors (ADR-0031) and the household's Family Document Vault, `fdv` (ADR-0054). */
export const StorageDestinationKind = z.enum(['s3', 'webdav', 'fdv']);
export type StorageDestinationKind = z.infer<typeof StorageDestinationKind>;

/** The kinds that mirror files and take backups: what "Your own storage" connects. A workspace has at most one. */
export const MirrorDestinationKind = z.enum(['s3', 'webdav']);
export type MirrorDestinationKind = z.infer<typeof MirrorDestinationKind>;
export const MIRROR_DESTINATION_KINDS = MirrorDestinationKind.options;
export const isMirrorKind = (kind: string): kind is MirrorDestinationKind =>
  (MIRROR_DESTINATION_KINDS as readonly string[]).includes(kind);

/**
 * The kinds of file that can be copied, all of them by default. Exports never are: backups have their own folder. Tax
 * forms (ADR-0052) are their own kind, so a connection can leave them out.
 */
export const STORAGE_FILE_KINDS = [
  'statement',
  'receipt',
  'payslip',
  'lease',
  'invoice',
  'other',
  'tax_form',
] as const;
export const StorageFileKind = z.enum(STORAGE_FILE_KINDS);
export type StorageFileKind = z.infer<typeof StorageFileKind>;

const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine(
    (u) => !new URL(u).username && !new URL(u).password,
    'Put the user name and password in their own fields',
  );

// S3 bucket names (and the looser rules B2, R2 and MinIO allow): 3–63 lower-case letters, digits, dots and hyphens.
const BucketName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    'Use the bucket’s name: 3–63 lower-case letters, digits, dots or hyphens',
  );

export const S3Settings = z.object({
  /** Blank for AWS itself; otherwise the service's S3 endpoint, e.g. https://s3.us-west-004.backblazeb2.com. */
  endpoint: HttpUrl.optional(),
  region: z.string().trim().min(1).max(40).default('us-east-1'),
  bucket: BucketName,
  /** Most S3-compatible services and MinIO need path-style addresses. */
  pathStyle: z.boolean().default(false),
});
export type S3Settings = z.output<typeof S3Settings>;

export const S3Secret = z.object({
  accessKeyId: z.string().trim().min(1).max(128),
  secretAccessKey: z.string().min(1).max(256),
});
export type S3Secret = z.output<typeof S3Secret>;

export const WebDavSettings = z.object({
  /** The folder's WebDAV address, e.g. https://cloud.example.com/remote.php/dav/files/sam/ for Nextcloud. */
  url: HttpUrl,
  username: z.string().trim().min(1).max(200),
});
export type WebDavSettings = z.output<typeof WebDavSettings>;

export const WebDavSecret = z.object({ password: z.string().min(1).max(500) });
export type WebDavSecret = z.output<typeof WebDavSecret>;

/** Where to connect. The secret may be left out of a change or a test of a saved connection, to keep the stored one. */
export const StorageConnection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('s3'), s3: S3Settings, secret: S3Secret.optional() }),
  z.object({ kind: z.literal('webdav'), webdav: WebDavSettings, secret: WebDavSecret.optional() }),
]);
export type StorageConnection = z.output<typeof StorageConnection>;

/** A folder path inside the storage: no leading or trailing slash, no `..`, no backslashes. */
export const StorageFolder = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (f) =>
      !/^\/|\/$|\/\/|\\/.test(f) &&
      f.split('/').every((p) => p.trim() !== '' && p !== '.' && p !== '..') &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f<>:"|?*]/.test(f),
    'Use a folder like Montra/Our household: names separated by /, without : * ? " < > |',
  );

const Options = {
  label: z.string().trim().min(1).max(80),
  /** Defaults to `Montra/<workspace name>`. */
  folder: StorageFolder.optional(),
  mirrorFiles: z.boolean().optional(),
  fileKinds: z.array(StorageFileKind).min(1).optional(),
  deleteWithMontra: z.boolean().optional(),
  /** Backups Montra keeps in `backups/`; 0 keeps them all. */
  keepBackups: z.number().int().min(0).max(1000).optional(),
};

export const ConnectStorageRequest = z.object({
  ...Options,
  connection: StorageConnection,
  /** Also copy the files already in Montra (ADR-0031 §5). */
  copyExisting: z.boolean().default(true),
});
export type ConnectStorageRequest = z.output<typeof ConnectStorageRequest>;

export const UpdateStorageRequest = z.object({
  version: z.number().int().positive(),
  label: Options.label.optional(),
  folder: Options.folder,
  mirrorFiles: Options.mirrorFiles,
  fileKinds: Options.fileKinds,
  deleteWithMontra: Options.deleteWithMontra,
  keepBackups: Options.keepBackups,
  /** Paused copies nothing and keeps what's waiting. */
  paused: z.boolean().optional(),
  /** New address or credentials; tested before they're saved. */
  connection: StorageConnection.optional(),
});
export type UpdateStorageRequest = z.output<typeof UpdateStorageRequest>;

export const StorageTestResultDto = z.object({
  ok: z.boolean(),
  /** Montra could delete its test file. Pruning old backups and "delete my copy too" need it. */
  canDelete: z.boolean(),
  /** A reason a person can act on, when not ok. */
  error: z.string().nullable(),
  code: z
    .enum(['refused', 'not_found', 'unreachable', 'full', 'not_allowed_host', 'invalid', 'failed'])
    .nullable(),
});
export type StorageTestResultDto = z.infer<typeof StorageTestResultDto>;

export const StorageDestinationDto = z.object({
  id: Id,
  kind: MirrorDestinationKind,
  label: z.string(),
  s3: z
    .object({
      endpoint: z.string().nullable(),
      region: z.string(),
      bucket: z.string(),
      pathStyle: z.boolean(),
      /** The last four characters of the access key id. The secret itself is never returned. */
      accessKeyHint: z.string().nullable(),
    })
    .nullable(),
  webdav: z.object({ url: z.string(), username: z.string() }).nullable(),
  folder: z.string(),
  mirrorFiles: z.boolean(),
  fileKinds: z.array(StorageFileKind),
  deleteWithMontra: z.boolean(),
  keepBackups: z.number().int(),
  canDelete: z.boolean(),
  status: z.enum(['active', 'paused', 'failing']),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  files: z.object({
    pending: z.number().int(),
    done: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  /** The latest backup sent here. */
  lastBackup: z
    .object({
      exportId: Id,
      at: z.string(),
      status: z.enum(['pending', 'done', 'failed', 'pruned']),
      path: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type StorageDestinationDto = z.infer<typeof StorageDestinationDto>;

export const StorageItemDto = z.object({
  fileId: Id,
  fileName: z.string().nullable(),
  kind: z.string().nullable(),
  status: z.enum(['pending', 'done', 'failed', 'skipped', 'delete']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  path: z.string().nullable(),
  copiedAt: z.string().nullable(),
  nextAttemptAt: z.string(),
});
export type StorageItemDto = z.infer<typeof StorageItemDto>;

export const StorageItemsQuery = z.object({
  status: z.enum(['pending', 'done', 'failed', 'skipped']).default('failed'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type StorageItemsQuery = z.output<typeof StorageItemsQuery>;

// ----- The household's Family Document Vault (ADR-0054; VLT-01..11) ----------------------------------------------------
// Montra's side only, in Montra's words. Nothing here names the vault's routes, fields or codes: Montra talks to the vault
// through the vault's own published client package (owner's answer 1).

/** Every kind of file Montra stores (`app.file.kind`): the kinds that can be copied, and the two that never are. */
export const FILE_KINDS = [...STORAGE_FILE_KINDS, 'export', 'logo'] as const;
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

/** What a person switches on in "Send these to the vault" (§6): groups they recognise, not Montra's file kinds. */
export const VAULT_GROUPS = [
  'receipts',
  'statements',
  'bills',
  'payslips',
  'tax_documents',
  'other',
] as const;
export const VaultGroup = z.enum(VAULT_GROUPS);
export type VaultGroup = z.infer<typeof VaultGroup>;

/**
 * §6: the file kinds each group covers. Every kind in `STORAGE_FILE_KINDS` is in exactly one group; `export` and `logo`
 * are in none (tests pin both).
 */
export const VAULT_GROUP_KINDS: Readonly<Record<VaultGroup, readonly StorageFileKind[]>> = {
  receipts: ['receipt'],
  statements: ['statement'],
  // Household bills, a business's bills and invoice attachments are one kind in Montra.
  bills: ['invoice'],
  payslips: ['payslip'],
  tax_documents: ['tax_form'],
  other: ['lease', 'other'],
};

/** §6: on when a connection is made. Payslips and tax documents are restricted in Montra, so they start off. */
export const VAULT_GROUP_DEFAULTS: Readonly<Record<VaultGroup, boolean>> = {
  receipts: true,
  statements: true,
  bills: true,
  payslips: false,
  tax_documents: false,
  other: false,
};

/** §6: groups only an owner may turn on, after a warning (an admin may turn them off). */
export const VAULT_RESTRICTED_GROUPS: readonly VaultGroup[] = ['payslips', 'tax_documents'];

/**
 * §6: the group a file belongs to, or `never` for what never goes to the vault whatever the switches say: sealed copies
 * of identity documents (ADR-0034 §3, including the documents kept with an I-9), logos and exports.
 */
export function vaultGroupOf(file: { kind: FileKind; sealed: boolean }): VaultGroup | 'never' {
  if (file.sealed) return 'never';
  for (const group of VAULT_GROUPS) {
    if ((VAULT_GROUP_KINDS[group] as readonly string[]).includes(file.kind)) return group;
  }
  return 'never';
}

/** Each group's switch, with the defaults filled in for any not given. */
export function vaultGroupSwitches(
  on: Partial<Record<VaultGroup, boolean>> = {},
): Record<VaultGroup, boolean> {
  return Object.fromEntries(VAULT_GROUPS.map((g) => [g, on[g] ?? VAULT_GROUP_DEFAULTS[g]])) as Record<
    VaultGroup,
    boolean
  >;
}

/**
 * The connection's `file_kinds` (§11), derived from the groups that are on, in `STORAGE_FILE_KINDS` order, so the
 * trigger on `app.file` keeps working by kind. Groups not given take their defaults.
 */
export function vaultFileKinds(on: Partial<Record<VaultGroup, boolean>> = {}): StorageFileKind[] {
  const switches = vaultGroupSwitches(on);
  return STORAGE_FILE_KINDS.filter((kind) => {
    const group = vaultGroupOf({ kind, sealed: false });
    return group !== 'never' && switches[group];
  });
}

/** Whether a file goes to the vault with these switches. */
export function vaultSends(
  file: { kind: FileKind; sealed: boolean },
  on: Partial<Record<VaultGroup, boolean>> = {},
): boolean {
  const group = vaultGroupOf(file);
  return group !== 'never' && vaultGroupSwitches(on)[group];
}

/** §1: a copy, like a mirror, or the household's record of the documents sent there. */
export const VaultRole = z.enum(['copy', 'record']);
export type VaultRole = z.infer<typeof VaultRole>;

/** §1: for the record role, where the backup copy is kept: at Montra (default), the owner's own storage, or none. */
export const VaultBackup = z.enum(['montra', 'own_storage', 'none']);
export type VaultBackup = z.infer<typeof VaultBackup>;

/** §4, §11: a file's place in the vault's outbox. */
export const VAULT_ITEM_STATUSES = [
  'queued',
  'pending',
  'received',
  'filed',
  'not_kept',
  'failed',
  'out_of_reach',
  'delete',
] as const;
export const VaultItemStatus = z.enum(VAULT_ITEM_STATUSES);
export type VaultItemStatus = z.infer<typeof VaultItemStatus>;

/** §2: where connecting has got to: Montra made the key and waits for the code, the vault must approve, or done. */
export const VaultStage = z.enum(['register', 'approval', 'connected']);
export type VaultStage = z.infer<typeof VaultStage>;

/**
 * One kind of document the vault lets Montra send, as the vault reported it at the last check (§3). Montra shows the
 * vault's name and stores its key in the group's mapping; it never makes one up.
 */
export const VaultKindDto = z.object({ key: z.string().min(1).max(100), name: z.string().max(200) });
export type VaultKindDto = z.infer<typeof VaultKindDto>;

/** A group's switch, and the vault kind it maps to. A group switched on but not mapped isn't sent (§3). */
export const VaultGroupSettingDto = z.object({
  group: VaultGroup,
  on: z.boolean(),
  vaultKind: z.string().min(1).max(100).nullable(),
});
export type VaultGroupSettingDto = z.infer<typeof VaultGroupSettingDto>;

/**
 * The vault connection as owners and admins see it (§13). The private key is never in it; the public key and its
 * fingerprint aren't secret and are shown so they can be compared with the vault.
 */
export const VaultConnectionDto = z.object({
  id: Id,
  stage: VaultStage,
  status: z.enum(['active', 'paused', 'failing', 'needs_vault']),
  /** The vault's address, once the code was accepted. */
  address: z.string().nullable(),
  /** The household's name, as the vault last reported it. */
  householdName: z.string().nullable(),
  publicKey: z.string(),
  fingerprint: z.string(),
  role: VaultRole,
  backup: VaultBackup,
  groups: z.array(VaultGroupSettingDto),
  /** The kinds the vault lets Montra send, from the last check. */
  vaultKinds: z.array(VaultKindDto),
  /** §3, D5: amounts and account last-four digits too. Off by default. */
  describeMore: z.boolean(),
  /** §10, D10: "Also delete it in the vault when Montra deletes a file for good". Off by default. */
  deleteWithMontra: z.boolean(),
  /** The vault lets Montra delete what it sent. */
  canDelete: z.boolean(),
  items: z.object({
    queued: z.number().int(),
    pending: z.number().int(),
    received: z.number().int(),
    filed: z.number().int(),
    notKept: z.number().int(),
    failed: z.number().int(),
    outOfReach: z.number().int(),
  }),
  /** §12: waiting for the vault's daily limits, until then. Not failures. */
  heldUntil: z.object({ sending: z.string().nullable(), reading: z.string().nullable() }),
  /** §7: Montra's clock against the vault's, in milliseconds; shown when it is large. */
  clockOffsetMs: z.number().int().nullable(),
  /** §2: a key change in progress. */
  keyRotation: z.enum(['none', 'made', 'registered']),
  lastSuccessAt: z.string().nullable(),
  /** In words; for `needs_vault`, the vault's own message, which is written for people. */
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type VaultConnectionDto = z.infer<typeof VaultConnectionDto>;

/** §2 step 1: Montra makes a fresh key pair for the workspace. Nothing to send. */
export const StartVaultConnectionRequest = z.object({}).strict();
export type StartVaultConnectionRequest = z.output<typeof StartVaultConnectionRequest>;

/** §2 step 3: the code the vault gave, pasted back. Montra checks it names its key before anything else. */
export const PasteVaultCodeRequest = z
  .object({
    code: z.string().trim().min(1).max(4000),
    version: z.number().int().positive(),
  })
  .strict();
export type PasteVaultCodeRequest = z.output<typeof PasteVaultCodeRequest>;

/** §6, §13: a change to the connection. Groups not named keep their setting. */
export const UpdateVaultConnectionRequest = z
  .object({
    version: z.number().int().positive(),
    role: VaultRole.optional(),
    backup: VaultBackup.optional(),
    groups: z
      .array(
        z
          .object({
            group: VaultGroup,
            on: z.boolean().optional(),
            vaultKind: z.string().min(1).max(100).nullable().optional(),
          })
          .strict(),
      )
      .max(VAULT_GROUPS.length)
      .refine((gs) => new Set(gs.map((g) => g.group)).size === gs.length, 'Name each group once')
      .optional(),
    describeMore: z.boolean().optional(),
    deleteWithMontra: z.boolean().optional(),
    /** Paused sends nothing and keeps what's waiting. */
    paused: z.boolean().optional(),
  })
  .strict();
export type UpdateVaultConnectionRequest = z.output<typeof UpdateVaultConnectionRequest>;

/** §2: "Replace the key". */
export const ReplaceVaultKeyRequest = z.object({ version: z.number().int().positive() }).strict();
export type ReplaceVaultKeyRequest = z.output<typeof ReplaceVaultKeyRequest>;

/**
 * §12: "Send existing documents": every file of the groups that are on, not in the trash. On a record connection it is
 * a move (§5 then removes each source once filed). `expected` is the count the person was shown, so a different number
 * is refused rather than surprising them.
 */
export const SendExistingToVaultRequest = z
  .object({ expected: z.number().int().min(0).max(1_000_000) })
  .strict();
export type SendExistingToVaultRequest = z.output<typeof SendExistingToVaultRequest>;

/** §10: disconnect. With files held only in the vault, it is refused unless `anyway` (they keep their references). */
export const DisconnectVaultRequest = z.object({ anyway: z.boolean().default(false) }).strict();
export type DisconnectVaultRequest = z.output<typeof DisconnectVaultRequest>;

/** §10: "Bring the files back": what is still to download, over days if the vault's daily cap needs it. */
export const VaultBringBackDto = z.object({
  queued: z.number().int(),
  heldUntil: z.string().nullable(),
});
export type VaultBringBackDto = z.infer<typeof VaultBringBackDto>;

/** A file in the vault's outbox, for Settings' lists (as `StorageItemDto` for the mirror). */
export const VaultItemDto = z.object({
  fileId: Id,
  fileName: z.string().nullable(),
  group: VaultGroup.nullable(),
  status: VaultItemStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  /** §4.5: why the vault didn't keep it, in words, and whether a person may send it again. */
  notKeptReason: z.string().nullable(),
  resendAllowed: z.boolean(),
  receivedAt: z.string().nullable(),
  filedAt: z.string().nullable(),
  nextAttemptAt: z.string(),
});
export type VaultItemDto = z.infer<typeof VaultItemDto>;

export const VaultItemsQuery = z.object({
  status: VaultItemStatus.exclude(['delete']).default('failed'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type VaultItemsQuery = z.output<typeof VaultItemsQuery>;

/** Where a file's bytes are (§5): Montra's own storage, or only the vault. */
export const FileLocation = z.enum(['montra', 'vault']);
export type FileLocation = z.infer<typeof FileLocation>;

/** §9, §13: what a file's badge says about the vault. */
export const FileVaultSummaryDto = z.object({
  status: VaultItemStatus,
  /** What the vault calls the document, from its changes feed ("Bank statement, October 2026"). */
  title: z.string().nullable(),
  /** The family put a newer version in the vault; Montra doesn't re-read it on its own. */
  newerVersion: z.boolean(),
  notKeptReason: z.string().nullable(),
});
export type FileVaultSummaryDto = z.infer<typeof FileVaultSummaryDto>;

/**
 * A file's place, keyed by its id: Montra's records name their files by id, so this is served beside them rather than
 * inside each (§11's "FileDto"). `vault` is null when the file was never sent.
 */
export const FileStorageStateDto = z.object({
  fileId: Id,
  location: FileLocation,
  /** §5a: the vault didn't return it, and a person is asked to provide it again. */
  missing: z.object({ since: z.string(), reason: z.string() }).nullable(),
  vault: FileVaultSummaryDto.nullable(),
});
export type FileStorageStateDto = z.infer<typeof FileStorageStateDto>;

/** §5a: one entry in Review, "Files to provide again". */
export const MissingFileDto = z.object({
  fileId: Id,
  fileName: z.string(),
  group: VaultGroup.nullable(),
  /** When it was first stored in Montra. */
  uploadedAt: z.string(),
  missingSince: z.string(),
  reason: z.string(),
  /** What in Montra uses it, so the person knows which paper to look for. */
  usedBy: z.array(
    z.object({
      kind: z.enum(['receipt', 'statement', 'payslip', 'tax_form', 'bill', 'lease', 'document']),
      id: Id,
      label: z.string(),
    }),
  ),
});
export type MissingFileDto = z.infer<typeof MissingFileDto>;

export const MissingFilesResponse = z.object({ data: z.array(MissingFileDto) });
export type MissingFilesResponse = z.infer<typeof MissingFilesResponse>;

/** §5a: a missing file provided again, stored under the same id. A different hash is accepted and noted. */
export const FileProvidedAgainDto = z.object({
  fileId: Id,
  location: FileLocation,
  hashChanged: z.boolean(),
  /** Queued for the vault again, when its group is still on. */
  queuedForVault: z.boolean(),
});
export type FileProvidedAgainDto = z.infer<typeof FileProvidedAgainDto>;
