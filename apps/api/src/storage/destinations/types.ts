import type { Readable } from 'node:stream';

/**
 * Storage the workspace owner connects (ADR-0030). Montra only ever writes and deletes there: it never reads a copy back, because
 * its own copy stays the one everything uses. Paths are relative to the connection's root and use `/`.
 *
 * Google Drive, OneDrive and Dropbox would implement this too, with a token refresh before each run (ADR-0030 §2).
 */
export interface StorageDestination {
  /** Writes a file, making folders as needed. Replaces a file of the same name. */
  put(path: string, body: Uint8Array | Readable, opts: { contentType: string; bytes: number }): Promise<void>;
  /** Fine if it's already gone. */
  delete(path: string): Promise<void>;
  close(): void;
}

export type DestinationErrorCode =
  'refused' | 'not_found' | 'unreachable' | 'full' | 'not_allowed_host' | 'invalid' | 'failed';

const MESSAGES: Record<DestinationErrorCode, string> = {
  refused:
    'The storage refused the user name, password or key. Check them, and that they may write to this folder.',
  not_found: 'The bucket or folder wasn’t found. Check its name and address.',
  unreachable:
    'Montra couldn’t reach the storage. Check the address, and that it’s reachable from the internet.',
  full: 'The storage is full, or the file is bigger than it accepts.',
  not_allowed_host: 'Montra can’t connect to that address. Use the storage’s public address, over https.',
  invalid: 'The storage didn’t understand the request. Check the address points at the storage itself.',
  failed: 'The storage couldn’t take the file just now.',
};

/** What went wrong, in words a person can act on. `detail` is for the log, never for a client. */
export class DestinationError extends Error {
  constructor(
    readonly code: DestinationErrorCode,
    readonly detail = '',
  ) {
    super(MESSAGES[code]);
    this.name = 'DestinationError';
  }

  /** The whole connection is at fault, not one file: no use trying the next file now. */
  get connectionLevel(): boolean {
    return this.code !== 'failed' && this.code !== 'full';
  }
}

const NETWORK = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Finds the reason inside whatever a client library threw. */
export function asDestinationError(e: unknown): DestinationError {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof DestinationError) return cur;
    const err = cur as { code?: string; name?: string; cause?: unknown; message?: string };
    if (err.code && NETWORK.has(err.code)) return new DestinationError('unreachable', err.code);
    if (err.name === 'TimeoutError' || err.code === 'ESOCKETTIMEDOUT')
      return new DestinationError('unreachable', 'timeout');
    cur = err.cause;
  }
  return new DestinationError('failed', (e as Error)?.message ?? String(e));
}

/** Writes a small file under the folder, then deletes it. A failed delete is allowed; it means Montra mustn't rely on deleting. */
export async function checkDestination(
  dest: StorageDestination,
  folder: string,
): Promise<{ canDelete: boolean }> {
  const path = `${folder}/.montra-connection-check`;
  const body = Buffer.from(`Montra checked it can write here on ${new Date().toISOString()}.\n`);
  await dest.put(path, body, { contentType: 'text/plain', bytes: body.length });
  try {
    await dest.delete(path);
    return { canDelete: true };
  } catch {
    return { canDelete: false };
  }
}
