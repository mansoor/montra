/**
 * How Montra reaches a household's Family Document Vault (ADR-0054 §8). The vault's client package takes a `fetch`; this
 * is the one Montra gives it:
 *
 * - **Public HTTPS always**, in production and on a self-hosted install alike, whatever `STORAGE_DESTINATIONS_PRIVATE`
 *   says (that switch is for S3/WebDAV), and with no loopback exception (D6), even though the package itself would
 *   accept plain http to the same machine.
 * - The address is checked as each connection is made, through the socket's `lookup`, so a name that later resolves to
 *   a private address is refused (DNS rebinding).
 * - Redirects are never followed, every request has a connect and a total timeout, and answers are size-limited.
 * - Nothing here logs: not the headers (which carry signatures), not the body, not the address.
 *
 * Tests and the e2e run use the package's own fake vault instead, in this process, behind `FAMILY_VAULT_FAKE=on`, which
 * production refuses to start with (`config.ts`). Montra never talks to a real vault in tests.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { FetchLike, RequestInitLike, ResponseLike } from '@fdv/client';
import { guardedLookup, isBlockedAddress } from '../destinations/guard.js';
import { VaultError } from '../destinations/vault.js';

export const VAULT_TRANSPORT = Symbol('VAULT_TRANSPORT');

/** What the vault's adapter is given: the `fetch` for the package, and why the last request was refused, if it was. */
export interface VaultTransport {
  readonly fetch: FetchLike;
  /**
   * The package turns any failed `fetch` into "offline", so the reason Montra refused a request (an address that
   * resolved somewhere private) is kept here for the adapter to say in words. Cleared at the start of each request.
   */
  readonly refused: () => VaultError | null;
  /** Set only for the in-process fake (tests and e2e). */
  readonly fake?: unknown;
}

/**
 * Refuses a vault address before any connection is tried: https, an origin only, and not a private, loopback,
 * link-local or local-only host (§8, D6). Returns the parsed origin.
 */
export function assertVaultAddress(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new VaultError('not_allowed_host', { detail: 'unparseable' });
  }
  if (url.protocol !== 'https:') throw new VaultError('not_allowed_host', { detail: 'not https' });
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new VaultError('not_allowed_host', { detail: 'not an origin' });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new VaultError('not_allowed_host', { detail: 'private address' });
  } else if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.')
  ) {
    throw new VaultError('not_allowed_host', { detail: 'local name' });
  }
  return url;
}

export interface GuardedFetchOptions {
  /** Until the socket is connected (and TLS done). */
  connectTimeoutMs?: number;
  /** For the whole request, answer included. */
  totalTimeoutMs?: number;
  /** The most an answer may be. Larger is refused, not truncated. */
  maxBytes?: number;
  /**
   * Tests only: reach an http server on this machine, to exercise timeouts, redirects and size limits at the socket.
   * Never set from configuration.
   */
  insecureLoopbackForTests?: boolean;
}

const DEFAULTS = { connectTimeoutMs: 10_000, totalTimeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 };

class Answer implements ResponseLike {
  constructor(
    readonly status: number,
    private readonly head: Record<string, string | string[] | undefined>,
    private readonly body: Buffer,
  ) {}
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  readonly headers = {
    get: (name: string): string | null => {
      const v = this.head[name.toLowerCase()];
      return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
    },
  };
  async json(): Promise<unknown> {
    return JSON.parse(this.body.toString('utf8'));
  }
  async text(): Promise<string> {
    return this.body.toString('utf8');
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.buffer.slice(
      this.body.byteOffset,
      this.body.byteOffset + this.body.byteLength,
    ) as ArrayBuffer;
  }
}

/** The real transport: public HTTPS only, guarded at the socket, no redirects, timeouts and a size limit. */
export function guardedVaultTransport(options: GuardedFetchOptions = {}): VaultTransport {
  const opts = { ...DEFAULTS, ...options };
  let refused: VaultError | null = null;

  const fetch: FetchLike = (address: string, init: RequestInitLike) => {
    refused = null;
    return new Promise<ResponseLike>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(address);
        if (opts.insecureLoopbackForTests) {
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('loopback only');
        } else {
          assertVaultAddress(url.origin);
        }
      } catch (e) {
        refused = e instanceof VaultError ? e : new VaultError('not_allowed_host', { detail: 'refused' });
        return reject(refused);
      }
      const body =
        init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? Buffer.from(init.body, 'utf8')
            : init.body instanceof Uint8Array
              ? Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
              : null;
      if (body === null) return reject(new Error('Only bytes or text are sent to the vault'));
      const headers: Record<string, string> = { ...init.headers };
      if (body) headers['content-length'] = String(body.length);
      // Without keep-alive, so nothing lingers between runs; every socket is looked up through the guard.
      const agent = opts.insecureLoopbackForTests
        ? undefined
        : new https.Agent({ keepAlive: false, lookup: guardedLookup as never });
      const request = (opts.insecureLoopbackForTests ? http : https).request(
        url,
        { method: init.method, headers, ...(agent ? { agent } : {}) },
        (res) => {
          const status = res.statusCode ?? 0;
          // Redirects are never followed: a 3xx is an answer like any other, which the package reads as a failure.
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > opts.maxBytes) {
              clearTimeout(total);
              reject(new Error('answer too large'));
              res.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            clearTimeout(total);
            resolve(new Answer(status, res.headers, Buffer.concat(chunks)));
          });
          res.on('error', (e) => {
            clearTimeout(total);
            reject(e);
          });
        },
      );
      const total = setTimeout(() => request.destroy(new Error('timeout')), opts.totalTimeoutMs);
      request.setTimeout(opts.connectTimeoutMs, () => request.destroy(new Error('connect timeout')));
      request.on('socket', (socket) => {
        socket.once(opts.insecureLoopbackForTests ? 'connect' : 'secureConnect', () =>
          request.setTimeout(opts.totalTimeoutMs),
        );
      });
      request.on('error', (e) => {
        clearTimeout(total);
        if ((e as { code?: string }).code === 'not_allowed_host' || e instanceof VaultError) {
          refused = new VaultError('not_allowed_host', { detail: 'resolved to a private address' });
        }
        reject(refused ?? e);
      });
      request.end(body);
    });
  };

  return { fetch, refused: () => refused };
}
