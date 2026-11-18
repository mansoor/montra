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

/**
 * What happens to one group's documents (§6, as the owner clarified it on 2026-11-17). The vault is additional
 * storage, and a document filed there is the household's record in either sent mode; "local" means where Montra
 * normally keeps the file (its own storage), while the owner's S3/WebDAV mirror keeps following its own setting.
 *
 * - `not_sent`: kept only locally.
 * - `sent_keep_copy`: sent to the vault, and Montra keeps its copy.
 * - `sent_no_copy`: sent to the vault, and once the vault has filed it Montra removes its own copy; when Montra needs
 *   the file again it asks the vault, then a person (§5, §5a).
 */
export const VAULT_GROUP_MODES = ['not_sent', 'sent_keep_copy', 'sent_no_copy'] as const;
export const VaultGroupMode = z.enum(VAULT_GROUP_MODES);
export type VaultGroupMode = z.infer<typeof VaultGroupMode>;

/** Whether a mode sends the group's documents to the vault. */
export const isSentMode = (mode: VaultGroupMode): boolean => mode !== 'not_sent';

/**
 * §6: each group's mode when a connection is made. Receipts, statements and bills are sent with a copy kept; payslips
 * and tax documents are restricted in Montra and start not sent, as do other papers.
 */
export const VAULT_GROUP_DEFAULTS: Readonly<Record<VaultGroup, VaultGroupMode>> = {
  receipts: 'sent_keep_copy',
  statements: 'sent_keep_copy',
  bills: 'sent_keep_copy',
  payslips: 'not_sent',
  tax_documents: 'not_sent',
  other: 'not_sent',
};

/** §6: groups only an owner may send (either sent mode), after a warning; an admin may set them to `not_sent`. */
export const VAULT_RESTRICTED_GROUPS: readonly VaultGroup[] = ['payslips', 'tax_documents'];

/**
 * §6: the group a file belongs to, or `never` for what never goes to the vault whatever the modes say: sealed copies
 * of identity documents (ADR-0034 §3, including the documents kept with an I-9), logos and exports.
 */
export function vaultGroupOf(file: { kind: FileKind; sealed: boolean }): VaultGroup | 'never' {
  if (file.sealed) return 'never';
  for (const group of VAULT_GROUPS) {
    if ((VAULT_GROUP_KINDS[group] as readonly string[]).includes(file.kind)) return group;
  }
  return 'never';
}

/** Each group's mode, with the defaults filled in for any not given. */
export function vaultGroupModes(
  modes: Partial<Record<VaultGroup, VaultGroupMode>> = {},
): Record<VaultGroup, VaultGroupMode> {
  return Object.fromEntries(VAULT_GROUPS.map((g) => [g, modes[g] ?? VAULT_GROUP_DEFAULTS[g]])) as Record<
    VaultGroup,
    VaultGroupMode
  >;
}

/**
 * The connection's `file_kinds` (§11), derived from the groups that are sent (either mode), in `STORAGE_FILE_KINDS`
 * order, so the trigger on `app.file` keeps working by kind. Groups not given take their defaults.
 */
export function vaultFileKinds(modes: Partial<Record<VaultGroup, VaultGroupMode>> = {}): StorageFileKind[] {
  const all = vaultGroupModes(modes);
  return STORAGE_FILE_KINDS.filter((kind) => {
    const group = vaultGroupOf({ kind, sealed: false });
    return group !== 'never' && isSentMode(all[group]);
  });
}

/** What happens to one file with these modes: `not_sent` for what never goes. */
export function vaultModeOf(
  file: { kind: FileKind; sealed: boolean },
  modes: Partial<Record<VaultGroup, VaultGroupMode>> = {},
): VaultGroupMode {
  const group = vaultGroupOf(file);
  return group === 'never' ? 'not_sent' : vaultGroupModes(modes)[group];
}

/** Whether a file goes to the vault with these modes. */
export function vaultSends(
  file: { kind: FileKind; sealed: boolean },
  modes: Partial<Record<VaultGroup, VaultGroupMode>> = {},
): boolean {
  return isSentMode(vaultModeOf(file, modes));
}

/**
 * §5: whether Montra keeps its own copy of a file once the vault has filed it: always, unless its group is
 * `sent_no_copy`. A file that isn't sent is always kept.
 */
export function vaultKeepsCopy(
  file: { kind: FileKind; sealed: boolean },
  modes: Partial<Record<VaultGroup, VaultGroupMode>> = {},
): boolean {
  return vaultModeOf(file, modes) !== 'sent_no_copy';
}

/**
 * The modes Settings offers. `sent_no_copy` is offered from PR 5b, which removes Montra's copy safely (§5) and asks the
 * vault, then a person, for a file again (§5a); PR 3 to 5a offered only the first two.
 */
export const VAULT_GROUP_MODES_OFFERED: readonly VaultGroupMode[] = VAULT_GROUP_MODES;

/**
 * Each group's mode as sending sees it (§3): a sent group with no vault kind mapped to it isn't sent. This is what the
 * connection's `file_kinds` is derived from, so the trigger on `app.file` queues nothing for an unmapped group.
 */
export function vaultEffectiveModes(
  groups: readonly { group: VaultGroup; mode: VaultGroupMode; vaultKind: string | null }[],
): Record<VaultGroup, VaultGroupMode> {
  const set = vaultGroupModes(Object.fromEntries(groups.map((g) => [g.group, g.mode])));
  for (const group of VAULT_GROUPS) {
    const mapped = groups.find((g) => g.group === group)?.vaultKind ?? null;
    if (!mapped) set[group] = 'not_sent';
  }
  return set;
}

/**
 * D8: exports of statements (CSV, spreadsheets, OFX, QFX, QIF) stay in Montra, whatever the vault says it takes: they
 * are data Montra imports, not papers a household files.
 */
const KEPT_IN_MONTRA_TYPES = [
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/x-ofx',
  'application/ofx',
  'application/vnd.intu.qfx',
  'application/x-qfx',
  'application/qif',
  'application/x-qif',
];
const KEPT_IN_MONTRA_EXTENSIONS = ['csv', 'tsv', 'xls', 'xlsx', 'ofx', 'qfx', 'qif'];

/**
 * §3, D8: whether the vault keeps a file of this type: one of the types the vault said it takes, and never a statement
 * export. Anything else stays in Montra only and is shown as "not a type the vault keeps".
 */
export function vaultTypeKept(
  file: { mime: string; fileName: string },
  accepted: readonly string[],
): boolean {
  const mime = file.mime.toLowerCase().split(';')[0]!.trim();
  const ext = file.fileName.toLowerCase().split('.').pop() ?? '';
  if (KEPT_IN_MONTRA_TYPES.includes(mime)) return false;
  if (file.fileName.includes('.') && KEPT_IN_MONTRA_EXTENSIONS.includes(ext)) return false;
  return accepted.some((a) => {
    const t = a.toLowerCase().trim();
    return t === mime || (t.endsWith('/*') && mime.startsWith(t.slice(0, -1)));
  });
}

/** What each group usually is in a vault, by the words of the vault's own kinds: the suggestion Settings starts with. */
const VAULT_KIND_HINTS: Readonly<Record<VaultGroup, readonly string[]>> = {
  receipts: ['receipt'],
  statements: ['bank statement', 'bank_statement', 'statement'],
  bills: ['bill', 'invoice', 'utility'],
  payslips: ['pay statement', 'pay_statement', 'payslip', 'pay stub', 'paystub'],
  tax_documents: ['tax form', 'tax_form', 'tax document', 'w-2', 'w2', '1099'],
  other: ['lease', 'other'],
};

/**
 * §3: "Montra suggests the obvious ones". The first of the vault's kinds whose key or name has one of the group's
 * words, or null; the owner chooses, and nothing is sent until they save.
 */
export function vaultSuggestKind(
  group: VaultGroup,
  kinds: readonly { key: string; name: string }[],
): string | null {
  for (const word of VAULT_KIND_HINTS[group]) {
    const found = kinds.find((k) => k.key.toLowerCase() === word || k.name.toLowerCase().includes(word));
    if (found) return found.key;
  }
  return null;
}

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

/** A group's mode, and the vault kind it maps to. A sent group that isn't mapped isn't sent (§3). */
export const VaultGroupSettingDto = z.object({
  group: VaultGroup,
  mode: VaultGroupMode,
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
  /**
   * `disconnected` (§10, PR 5b2): the owner disconnected while files were held only in the vault. Nothing is sent and
   * the key is gone; the connection and its outbox are kept so that connecting the same vault again reads those files
   * back. Connecting again starts at `register`.
   */
  status: z.enum(['active', 'paused', 'failing', 'needs_vault', 'disconnected']),
  /** The vault's address, once the code was accepted. */
  address: z.string().nullable(),
  /** The household's name, as the vault last reported it. */
  householdName: z.string().nullable(),
  publicKey: z.string(),
  fingerprint: z.string(),
  /**
   * §2 "Replace the key": the new public key and its fingerprint, made and sealed, waiting for the code the vault gives
   * once someone there has added it. Montra keeps signing with the current key until then.
   */
  newKey: z.object({ publicKey: z.string(), fingerprint: z.string() }).nullable(),
  /** Who Montra acts as in the vault, as the vault last said; the vault decides whose Inbox each document lands in. */
  actingAs: z.string().nullable(),
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
  /** §12: how many documents the vault takes from Montra a day, and how many it has today, as of the last check. */
  dailyLimit: z.object({ files: z.number().int(), filesToday: z.number().int() }).nullable(),
  /** §7: Montra's clock against the vault's, in milliseconds; shown when it is large. */
  clockOffsetMs: z.number().int().nullable(),
  /** §9: when Montra last read the vault's changes feed; null until it has (or while the vault doesn't let it read). */
  feedReadAt: z.string().nullable(),
  /**
   * §5, §5a: files whose copy Montra removed because the vault is their record (`onlyInVault`), and of those, files the
   * vault didn't give back that wait in Review for a person to provide again (`missing`).
   */
  files: z.object({ onlyInVault: z.number().int(), missing: z.number().int() }),
  /**
   * §10 "Bring the files back" in progress: every file held only in the vault is being copied back into Montra, one at
   * a time, and then the connection stays (`keep`) or is disconnected (`disconnect`). Null when none are.
   */
  bringingBack: z.object({ then: z.enum(['keep', 'disconnect']) }).nullable(),
  /**
   * §1, §13: the groups whose kinds the owner's own S3/WebDAV storage is set to copy. For a group sent with no local
   * copy, Settings says the owner's storage still holds one; Montra never changes that setting on its own.
   */
  mirrorGroups: z.array(VaultGroup),
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

/** §6, §13: a change to the connection. Groups not named keep their mode and mapping. */
export const UpdateVaultConnectionRequest = z
  .object({
    version: z.number().int().positive(),
    groups: z
      .array(
        z
          .object({
            group: VaultGroup,
            mode: VaultGroupMode.optional(),
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

/**
 * §2: "Replace the key": makes a new pair, sealed beside the current one, whose code is then pasted as when connecting.
 * `cancel` drops a new key that hasn't been confirmed yet, and Montra goes on with the current one.
 */
export const ReplaceVaultKeyRequest = z
  .object({ version: z.number().int().positive(), cancel: z.boolean().default(false) })
  .strict();
export type ReplaceVaultKeyRequest = z.output<typeof ReplaceVaultKeyRequest>;

/**
 * §12: "Send existing documents": every file of the groups that are sent, not in the trash. For a group sent with no
 * local copy it is a move (§5 then removes each source once filed). `expected` is the count the person was shown, so a
 * different number is refused rather than surprising them.
 */
export const SendExistingToVaultRequest = z
  .object({ expected: z.number().int().min(0).max(1_000_000) })
  .strict();
export type SendExistingToVaultRequest = z.output<typeof SendExistingToVaultRequest>;

/**
 * §10: disconnect. With files held only in the vault the owner chooses: `bringBack` copies them back into Montra first
 * and disconnects once they are back; `anyway` disconnects now, keeping the connection's references
 * (`disconnected`) while those files become missing. Neither, with such files, is refused (409
 * `vault.files_only_in_vault`) so the choice is shown. A disconnected connection with no such files left is removed.
 */
export const DisconnectVaultRequest = z
  .object({ anyway: z.boolean().default(false), bringBack: z.boolean().default(false) })
  .strict()
  .refine((r) => !(r.anyway && r.bringBack), 'Choose one: bring the files back, or disconnect anyway');
export type DisconnectVaultRequest = z.output<typeof DisconnectVaultRequest>;

/**
 * §5, §12 "Move existing documents": files of groups sent with no local copy that the vault filed while Montra kept a
 * copy (filed before the group was switched), by group. Moving removes Montra's copy of each, one at a time, under §5's
 * conditions. `groups` narrows it (the offer made right after saving a group's mode).
 */
export const VaultMoveDto = z.object({
  count: z.number().int(),
  groups: z.array(z.object({ group: VaultGroup, count: z.number().int() })),
});
export type VaultMoveDto = z.infer<typeof VaultMoveDto>;

export const VaultMoveQuery = z.object({
  groups: z
    .string()
    .transform((s) => [
      ...new Set(
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(VaultGroup).min(1).max(VAULT_GROUPS.length))
    .optional(),
});
export type VaultMoveQuery = z.output<typeof VaultMoveQuery>;

/** "Move these N files too?": `expected` is the count the person confirmed, so a different number is refused. */
export const MoveToVaultRequest = z
  .object({
    expected: z.number().int().min(0).max(1_000_000),
    groups: z.array(VaultGroup).min(1).max(VAULT_GROUPS.length).optional(),
  })
  .strict();
export type MoveToVaultRequest = z.output<typeof MoveToVaultRequest>;

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

/**
 * §12 "Send existing documents": how many files of the groups being sent are in Montra and not yet sent, by group, and
 * how many days that takes at the vault's daily limit (null until the vault has said its limit).
 */
export const VaultExistingDto = z.object({
  count: z.number().int(),
  groups: z.array(z.object({ group: VaultGroup, count: z.number().int() })),
  perDay: z.number().int().nullable(),
  days: z.number().int().nullable(),
});
export type VaultExistingDto = z.infer<typeof VaultExistingDto>;

/**
 * §4, §13: "Try again" for files that failed, and "Send again" for one the vault didn't keep when a resend is allowed.
 * Without `fileIds`, every failed file is tried again; a file not kept is sent again only when named.
 */
export const RetryVaultItemsRequest = z.object({ fileIds: z.array(Id).min(1).max(200).optional() }).strict();
export type RetryVaultItemsRequest = z.output<typeof RetryVaultItemsRequest>;

export const RetryVaultItemsResponse = z.object({ retried: z.number().int() });
export type RetryVaultItemsResponse = z.infer<typeof RetryVaultItemsResponse>;

/** Where a file's bytes are (§5): Montra's own storage, or only the vault. */
export const FileLocation = z.enum(['montra', 'vault']);
export type FileLocation = z.infer<typeof FileLocation>;

/** §9, §13: what a file's badge says about the vault. */
export const FileVaultSummaryDto = z.object({
  status: VaultItemStatus,
  /** What the vault calls the document, from its changes feed ("Bank statement, October 2026"). */
  title: z.string().nullable(),
  /** The vault's kind for the document, by the name the vault shows, from its changes feed. */
  kind: z.string().nullable(),
  /** The family put a newer version in the vault; Montra doesn't re-read it on its own. */
  newerVersion: z.boolean(),
  notKeptReason: z.string().nullable(),
  /**
   * §9: "Open in the vault" is offered: the document is filed and the changes feed has shown it to Montra. The link is
   * made only when the person clicks; nothing here holds one.
   */
  canOpen: z.boolean(),
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

/** The badges for some files (§13): their ids, comma-separated, at most 100. */
export const FileStorageStatesQuery = z.object({
  ids: z
    .string()
    .transform((s) => [
      ...new Set(
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(Id).min(1).max(100)),
});
export type FileStorageStatesQuery = z.output<typeof FileStorageStatesQuery>;

export const FileStorageStatesResponse = z.object({ data: z.array(FileStorageStateDto) });
export type FileStorageStatesResponse = z.infer<typeof FileStorageStatesResponse>;

/**
 * §9: "Open in the vault" for one file: `view` shows the vault's pages, `download` the file. The API answers with a
 * redirect to a single-use link made for this click; the link is never in a body, a log or the database.
 */
export const VaultOpenQuery = z.object({ mode: z.enum(['view', 'download']).default('view') }).strict();
export type VaultOpenQuery = z.output<typeof VaultOpenQuery>;

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
