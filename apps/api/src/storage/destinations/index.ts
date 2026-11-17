import {
  S3Secret,
  S3Settings,
  WebDavSecret,
  WebDavSettings,
  type MirrorDestinationKind,
} from '@montra/schemas';
import type { HostPolicy } from './guard.js';
import { S3Destination } from './s3.js';
import type { StorageDestination } from './types.js';
import { WebDavDestination } from './webdav.js';

export * from './types.js';
export * from './vault.js';
export { assertAllowedUrl, isBlockedAddress, type HostPolicy } from './guard.js';
export { backupPath, cleanName, defaultFolder, filePath } from './paths.js';

/**
 * Opens a mirror from what's stored: settings from `config`, and the unsealed secret. Parsed again, so stored data is
 * checked. The vault (ADR-0054) is opened through its own adapter, which comes with the vault's client package.
 */
export function openDestination(
  kind: MirrorDestinationKind,
  settings: unknown,
  secret: unknown,
  policy: HostPolicy,
): StorageDestination {
  if (kind === 's3') return new S3Destination(S3Settings.parse(settings), S3Secret.parse(secret), policy);
  return new WebDavDestination(WebDavSettings.parse(settings), WebDavSecret.parse(secret), policy);
}
