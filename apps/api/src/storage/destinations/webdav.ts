import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import type { WebDavSecret, WebDavSettings } from '@montra/schemas';
import { agentsFor, assertAllowedUrl, type HostPolicy } from './guard.js';
import { asDestinationError, DestinationError, type StorageDestination } from './types.js';

const TIMEOUT_MS = 120_000;

/**
 * WebDAV: Nextcloud, ownCloud, Synology, Apache and nginx (ADR-0031 §2). Montra needs only PUT, MKCOL and DELETE, so this is written
 * over `node:http` rather than taken as a dependency. Redirects aren't followed: the address given must be the folder itself.
 */
export class WebDavDestination implements StorageDestination {
  private readonly base: URL;
  private readonly auth: string;
  private readonly agent: http.Agent;
  private readonly agents: ReturnType<typeof agentsFor>;
  /** Folders known to exist in this run. */
  private readonly folders = new Set<string>();

  constructor(settings: WebDavSettings, secret: WebDavSecret, policy: HostPolicy) {
    this.base = new URL(settings.url.endsWith('/') ? settings.url : `${settings.url}/`);
    assertAllowedUrl(this.base, policy);
    this.auth = `Basic ${Buffer.from(`${settings.username}:${secret.password}`).toString('base64')}`;
    this.agents = agentsFor(policy);
    this.agent = this.base.protocol === 'https:' ? this.agents.httpsAgent : this.agents.httpAgent;
  }

  async put(path: string, body: Uint8Array | Readable, opts: { contentType: string; bytes: number }) {
    const parts = path.split('/');
    await this.ensureFolder(parts.slice(0, -1));
    const status = await this.request('PUT', parts, {
      body,
      headers: { 'content-type': opts.contentType, 'content-length': String(opts.bytes) },
    });
    if (status !== 200 && status !== 201 && status !== 204) throw davError(status);
  }

  async delete(path: string) {
    const status = await this.request('DELETE', path.split('/'));
    if (status !== 200 && status !== 204 && status !== 404) throw davError(status);
  }

  close() {
    this.agents.httpAgent.destroy();
    this.agents.httpsAgent.destroy();
  }

  private async ensureFolder(parts: string[]) {
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join('/');
      if (this.folders.has(key)) continue;
      const status = await this.request('MKCOL', parts.slice(0, i), { folder: true });
      // 201 made it; 405 (and 301 on some servers) means it's there already.
      if (status !== 201 && status !== 405 && status !== 301) throw davError(status);
      this.folders.add(key);
    }
  }

  private url(parts: string[], folder = false): URL {
    const path = parts.map((p) => encodeURIComponent(p)).join('/') + (folder ? '/' : '');
    return new URL(path, this.base);
  }

  private request(
    method: 'PUT' | 'MKCOL' | 'DELETE',
    parts: string[],
    opts: { body?: Uint8Array | Readable; headers?: Record<string, string>; folder?: boolean } = {},
  ): Promise<number> {
    const target = this.url(parts, opts.folder);
    const client = target.protocol === 'https:' ? https : http;
    return new Promise<number>((resolve, reject) => {
      const req = client.request(
        target,
        {
          method,
          agent: this.agent,
          headers: { authorization: this.auth, ...(opts.headers ?? {}) },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          res.resume(); // the body isn't needed
          res.on('end', () => resolve(res.statusCode ?? 0));
          res.on('error', (e) => reject(asDestinationError(e)));
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      req.on('error', (e) => reject(asDestinationError(e)));
      const body = opts.body;
      if (!body) req.end();
      else if (body instanceof Uint8Array) req.end(body);
      else {
        body.on('error', (e) => req.destroy(e));
        body.pipe(req);
      }
    });
  }
}

function davError(status: number): DestinationError {
  if (status === 401 || status === 403) return new DestinationError('refused', String(status));
  if (status === 404 || status === 409) return new DestinationError('not_found', String(status));
  if (status === 507 || status === 413) return new DestinationError('full', String(status));
  if (status >= 300 && status < 400) return new DestinationError('invalid', `redirect ${status}`);
  if (status === 400 || status === 405 || status === 501)
    return new DestinationError('invalid', String(status));
  return new DestinationError('failed', String(status));
}
