/**
 * How Montra reaches a bank feed provider (ADR-0055 §9): HTTPS to an allowed host only, every address the name
 * resolves to public (the storage guard's lookup, so DNS rebinding is refused too), no redirects followed, a time
 * limit and a size cap from the settings. Credentials go in a header, never in the URL, and nothing here logs.
 *
 * A stand-in on this machine over plain http is allowed only with SIMPLEFIN_ALLOW_LOCAL_HTTP=on, which production
 * refuses (config.ts).
 */
import http from 'node:http';
import https from 'node:https';
import { guardedLookup } from '../storage/destinations/guard.js';
import type { SimpleFinLimits } from './limits.js';
import { BankFeedError } from './provider.js';
import { urlProblem } from './simplefin.js';

export const FEED_TRANSPORT = Symbol('FEED_TRANSPORT');

export interface FeedRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers?: Record<string, string>;
}

export interface FeedResponse {
  status: number;
  body: Buffer;
}

export interface FeedTransport {
  send(req: FeedRequest): Promise<FeedResponse>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A request's failure as a code only: never the URL, a header or the body. */
const failure = (e: unknown): BankFeedError => {
  if (e instanceof BankFeedError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  // The guard's lookup refused an address the name resolved to.
  if (code === 'not_allowed_host')
    return new BankFeedError('not_allowed_host', 'resolved to a private address');
  return new BankFeedError(
    'unreachable',
    typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : null,
  );
};

export function guardedFeedTransport(
  limits: Pick<SimpleFinLimits, 'allowedHosts' | 'allowLocalHttp' | 'timeoutMs' | 'maxResponseBytes'>,
): FeedTransport {
  return {
    send(req) {
      const problem = urlProblem(req.url, limits);
      if (problem) return Promise.reject(new BankFeedError('not_allowed_host', problem));
      if (req.url.username || req.url.password)
        return Promise.reject(new BankFeedError('not_allowed_host', 'credentials in the url'));
      const local = limits.allowLocalHttp && LOOPBACK.has(req.url.hostname.toLowerCase());
      const lib = req.url.protocol === 'http:' ? http : https;
      const agent = local
        ? undefined
        : new https.Agent({
            keepAlive: false,
            lookup: guardedLookup as unknown as https.AgentOptions['lookup'],
          });
      return new Promise<FeedResponse>((resolve, reject) => {
        let done = false;
        const finish = (err: unknown, res?: FeedResponse) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) reject(failure(err));
          else resolve(res!);
        };
        const request = lib.request(
          req.url,
          {
            method: req.method,
            headers: {
              accept: 'application/json, text/plain',
              'user-agent': 'Montra',
              ...(req.method === 'POST' ? { 'content-length': '0' } : {}),
              ...(req.headers ?? {}),
            },
            ...(agent ? { agent } : {}),
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
              size += c.length;
              if (size > limits.maxResponseBytes) {
                res.destroy();
                finish(new BankFeedError('too_large'));
                return;
              }
              chunks.push(c);
            });
            res.on('end', () => finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
            res.on('error', (e) => finish(e));
          },
        );
        const timer = setTimeout(() => {
          request.destroy();
          finish(new BankFeedError('unreachable', 'TIMEOUT'));
        }, limits.timeoutMs);
        request.on('error', (e) => finish(e));
        request.end();
      });
    },
  };
}
