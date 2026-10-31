/** HTTP transport for the sync endpoints (05 §3, ADR-0013). */
import type { SyncPullResponse, SyncPushRequest, SyncPushResponse } from '@montra/schemas';
import type { SyncPullParams, SyncTransport } from './types.js';

export class TransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Network failures, 5xx and 429: try again later. Anything else won't succeed by retrying as-is. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface FetchTransportOptions {
  baseUrl: string;
  workspaceId: string;
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}

export class FetchTransport implements SyncTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FetchTransportOptions) {
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  pull(params: SyncPullParams): Promise<SyncPullResponse> {
    const q = new URLSearchParams({ since: params.since });
    if (params.days !== undefined) q.set('days', String(params.days));
    if (params.limit !== undefined) q.set('limit', String(params.limit));
    return this.request<SyncPullResponse>('GET', `/sync/pull?${q.toString()}`);
  }

  push(req: SyncPushRequest): Promise<SyncPushResponse> {
    return this.request<SyncPushResponse>('POST', '/sync/push', req);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const url = `${base}/v1/workspaces/${encodeURIComponent(this.opts.workspaceId)}${path}`;
    const token = await this.opts.token();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new TransportError(0, 'network', (e as Error).message || 'Network error', true);
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.statusText || code;
      try {
        const problem = (await res.json()) as { code?: string; detail?: string; title?: string };
        if (problem.code) code = problem.code;
        message = problem.detail ?? problem.title ?? message;
      } catch {
        // not a problem document
      }
      throw new TransportError(res.status, code, message, res.status >= 500 || res.status === 429);
    }
    return (await res.json()) as T;
  }
}
