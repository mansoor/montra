/** Your own storage for files and backups (BAK-03, BAK-05; ADR-0030). Secrets go in and never come back out. */
import { z } from 'zod';
import { Id } from './common.js';

export const StorageDestinationKind = z.enum(['s3', 'webdav']);
export type StorageDestinationKind = z.infer<typeof StorageDestinationKind>;

/** The kinds of file that can be copied. Exports never are: backups have their own folder. */
export const STORAGE_FILE_KINDS = ['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other'] as const;
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
  /** Also copy the files already in Montra (ADR-0030 §5). */
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
  kind: StorageDestinationKind,
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
