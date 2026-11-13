import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { MailPort } from '../mail/mail.service.js';
import { templates } from '../mail/mail.service.js';
import {
  delayFor,
  keyOf,
  liveFailures,
  lockedFor,
  RULES,
  type Rule,
  type ThrottleStore,
} from './throttle.js';

/**
 * The auth gateway (AUTH-08, ADR-0042): the only way in to Kratos's public API. It passes every request through
 * unchanged, and for the form submissions that can be guessed at (passwords, second-factor codes, emailed codes) it
 * counts failures, slows repeated ones down and pauses them once there are too many. Kratos itself has no such limits
 * when self-hosted.
 */

export type FlowKind = 'login' | 'registration' | 'recovery' | 'verification' | 'settings';

const SUBMIT = /^\/self-service\/(login|registration|recovery|verification|settings)\/?$/;
const SESSION_COOKIE = 'ory_kratos_session';

/** Where the web app shows each flow, for sending a paused browser back to its form. */
const UI_PATH: Record<FlowKind, string> = {
  login: '/sign-in',
  registration: '/sign-up',
  recovery: '/auth/recovery',
  verification: '/auth/verification',
  settings: '/settings/security',
};

/** Shown on a paused native (phone) flow, in Kratos's own message shape. */
export const TOO_MANY_ATTEMPTS_ID = 4290001;

export interface Check {
  rule: Rule;
  key: string;
}

export interface Attempt {
  kind: FlowKind;
  flowId: string | null;
  /** The client wants JSON back (the phone, or a browser using fetch), not a redirect. */
  json: boolean;
  /** The email typed for a password sign-in, lower-cased. */
  identifier: string | null;
  checks: Check[];
  /** Counted whatever happens (emails asked for, sign-ups), not only on failure. */
  countAlways: boolean;
  /** Cleared when the attempt succeeds. */
  clearOnSuccess: string[];
}

export interface GatewayOptions {
  kratosUrl: string;
  webUrl: string;
  secret: string;
  store: Pick<ThrottleStore, 'get' | 'fail' | 'clear' | 'noteLockout'>;
  mail: MailPort;
  trustProxy?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger?: boolean;
}

type Fields = Record<string, string>;

export function parseFields(contentType: string | undefined, raw: Buffer | undefined): Fields {
  if (!raw?.length) return {};
  const text = raw.toString('utf8');
  if (contentType?.includes('application/json')) {
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object') return {};
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string]),
      );
    } catch {
      return {};
    }
  }
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    const out: Fields = {};
    for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
    return out;
  }
  return {};
}

function header(headers: FastifyRequest['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

/** The Kratos session the request carries: the phone's token or the browser's cookie. */
export function sessionOf(headers: FastifyRequest['headers']): string | null {
  const token = header(headers, 'x-session-token');
  if (token) return token;
  for (const part of (header(headers, 'cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE && rest.length) return rest.join('=');
  }
  return null;
}

/** What a request is trying, when it is something the gateway limits; null passes straight through. */
export function attemptOf(
  req: { method: string; url: string; headers: FastifyRequest['headers']; body?: Buffer },
  secret: string,
  ip: string,
): Attempt | null {
  if (req.method !== 'POST') return null;
  const [path, query = ''] = req.url.split('?', 2) as [string, string?];
  const kind = SUBMIT.exec(path)?.[1] as FlowKind | undefined;
  if (!kind || kind === 'settings') return null;
  const flowId = new URLSearchParams(query).get('flow');
  const contentType = header(req.headers, 'content-type');
  const json =
    Boolean(contentType?.includes('application/json')) ||
    Boolean(header(req.headers, 'accept')?.includes('application/json'));
  const fields = parseFields(contentType, req.body);
  const method = fields.method ?? '';
  const at = (rule: Rule, value: string): Check => ({ rule, key: keyOf(secret, rule.name, value) });
  const base = { kind, flowId, json, identifier: null, countAlways: false, clearOnSuccess: [] as string[] };

  if (kind === 'registration') return { ...base, checks: [at(RULES.sign_up, ip)], countAlways: true };

  const emailed = (): Attempt | null => {
    if (fields.code) {
      const checks = [at(RULES.code, ip)];
      if (flowId) checks.push(at(RULES.code, `flow:${flowId}`));
      return { ...base, checks };
    }
    if (fields.email || fields.identifier || kind !== 'login')
      return { ...base, checks: [at(RULES.email_send, ip)], countAlways: true };
    return null;
  };

  if (kind === 'recovery' || kind === 'verification') return emailed();

  // Login.
  if (method === 'password') {
    const identifier = (fields.identifier ?? '').trim().toLowerCase() || null;
    const checks = [at(RULES.address, ip)];
    if (identifier) checks.unshift(at(RULES.account, identifier));
    return { ...base, identifier, checks, clearOnSuccess: identifier ? [checks[0]!.key] : [] };
  }
  if (method === 'totp' || method === 'lookup_secret') {
    const session = sessionOf(req.headers);
    const checks = [at(RULES.code, ip)];
    if (session) checks.unshift(at(RULES.second_factor, session));
    return { ...base, checks, clearOnSuccess: session ? [checks[0]!.key] : [] };
  }
  if (method === 'code') return emailed();
  // Passkeys, security keys and social sign-in can't be guessed at.
  return null;
}

/** Hop-by-hop headers, and the ones the gateway sets itself. */
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length',
  'accept-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

interface FlowLike {
  state?: string;
  ui?: {
    messages?: Array<{ id?: number; type?: string; text?: string; context?: unknown }>;
    nodes?: Array<{ messages?: Array<{ type?: string }> }>;
  };
}

const hasError = (flow: FlowLike): boolean =>
  Boolean(
    flow.ui?.messages?.some((m) => m.type === 'error') ||
    flow.ui?.nodes?.some((n) => n.messages?.some((m) => m.type === 'error')),
  );

export function buildAuthGateway(opts: GatewayOptions): FastifyInstance {
  const kratos = opts.kratosUrl.replace(/\/+$/, '');
  const web = opts.webUrl.replace(/\/+$/, '');
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const app = Fastify({
    logger: opts.logger ?? false,
    // A hop count, which Fastify accepts though its types only list the other forms.
    trustProxy: opts.trustProxy ? (opts.trustProxy as unknown as boolean) : false,
    bodyLimit: 1_048_576,
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  /** Forwards a request to Kratos as it came, with the client's address. */
  const forward = (req: FastifyRequest, url: string, method: string, body?: Buffer) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('accept-encoding', 'identity');
    headers.set('x-forwarded-for', req.ip);
    headers.set('x-forwarded-proto', req.protocol);
    if (req.headers.host) headers.set('x-forwarded-host', req.headers.host);
    return fetch(`${kratos}${url}`, {
      method,
      headers,
      body: body?.length && method !== 'GET' && method !== 'HEAD' ? new Uint8Array(body) : undefined,
      redirect: 'manual',
    });
  };

  /** The flow as Kratos holds it now, read with the client's own cookies or token. */
  const readFlow = async (req: FastifyRequest, a: Attempt): Promise<FlowLike | null> => {
    if (!a.flowId) return null;
    const res = await forward(
      req,
      `/self-service/${a.kind}/flows?id=${encodeURIComponent(a.flowId)}`,
      'GET',
    ).catch(() => null);
    if (!res?.ok) return null;
    return (await res.json().catch(() => null)) as FlowLike | null;
  };

  const outcomeOf = async (
    req: FastifyRequest,
    a: Attempt,
    res: Response,
  ): Promise<'success' | 'failure' | 'neutral'> => {
    if (a.json) {
      if (res.status === 200) return 'success';
      return res.status === 400 || res.status === 401 || res.status === 403 ? 'failure' : 'neutral';
    }
    if (res.headers.getSetCookie().some((c) => new RegExp(`^${SESSION_COOKIE}=[^;]+`).test(c)))
      return 'success';
    const location = res.headers.get('location') ?? '';
    if (!(res.status >= 300 && res.status < 400) || !a.flowId || !location.includes(a.flowId))
      return 'neutral';
    // Back to the same form: the flow says whether it was an error or, for an emailed code, done.
    const flow = await readFlow(req, a);
    if (!flow) return 'neutral';
    if (flow.state === 'passed_challenge') return 'success';
    return hasError(flow) ? 'failure' : 'neutral';
  };

  const lockedMessage = (seconds: number) => {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`;
  };

  app.all('/*', async (req, reply) => {
    const body = req.body as Buffer | undefined;
    const ip = req.ip;
    const attempt = attemptOf(
      { method: req.method, url: req.url, headers: req.headers, body },
      opts.secret,
      ip,
    );

    if (attempt) {
      const buckets = await opts.store.get(attempt.checks.map((c) => c.key));
      const at = now();
      const locked = Math.max(0, ...attempt.checks.map((c) => lockedFor(buckets.get(c.key), at)));
      if (locked > 0) {
        void reply.header('retry-after', String(locked));
        if (!attempt.json) {
          const q = new URLSearchParams({ notice: 'too_many_attempts', retry: String(locked) });
          if (attempt.flowId) q.set('flow', attempt.flowId);
          return reply.code(303).header('location', `${web}${UI_PATH[attempt.kind]}?${q}`).send();
        }
        const message = {
          id: TOO_MANY_ATTEMPTS_ID,
          type: 'error',
          text: lockedMessage(locked),
          context: { retry_after_seconds: locked },
        };
        const flow = await readFlow(req, attempt);
        const payload = flow?.ui
          ? { ...flow, ui: { ...flow.ui, messages: [message] } }
          : {
              error: {
                id: 'too_many_attempts',
                code: 429,
                status: 'Too Many Requests',
                message: message.text,
              },
            };
        return reply.code(429).header('content-type', 'application/json').send(JSON.stringify(payload));
      }
      const wait = Math.max(
        0,
        ...attempt.checks.map((c) => delayFor(liveFailures(buckets.get(c.key), c.rule, at), c.rule)),
      );
      if (wait > 0) await sleep(wait);
    }

    let res: Response;
    try {
      res = await forward(req, req.url, req.method, body);
    } catch (err) {
      req.log.error({ err }, 'Kratos is unreachable');
      return reply
        .code(502)
        .header('content-type', 'application/json')
        .send(
          JSON.stringify({
            error: { code: 502, status: 'Bad Gateway', message: 'Sign-in is unavailable right now' },
          }),
        );
    }

    const payload = Buffer.from(await res.arrayBuffer());
    if (attempt) {
      const outcome = await outcomeOf(req, attempt, res);
      const at = now();
      if (outcome === 'failure' || attempt.countAlways) {
        for (const c of attempt.checks) {
          const { bucket, locked } = await opts.store.fail(c.key, c.rule, at);
          if (locked && c.rule.name === 'account' && attempt.identifier?.includes('@')) {
            void alertLockout(
              attempt.identifier,
              ip,
              header(req.headers, 'user-agent') ?? null,
              bucket.lockedUntil!,
            );
          }
        }
      } else if (outcome === 'success') {
        await opts.store.clear(attempt.clearOnSuccess);
      }
    }

    void reply.code(res.status);
    res.headers.forEach((value, name) => {
      if (name === 'set-cookie' || DROP_RESPONSE.has(name)) return;
      void reply.header(name, value);
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length) void reply.header('set-cookie', cookies);
    return reply.send(payload);
  });

  const alertLockout = async (email: string, ip: string, userAgent: string | null, until: Date) => {
    try {
      const known = await opts.store.noteLockout(email, { ip, userAgent, until: until.toISOString() });
      if (known)
        await opts.mail.send(
          templates.signInLocked({ to: email, ip, until, url: `${web}/settings/security` }),
        );
    } catch (err) {
      app.log.warn({ err }, 'Could not record or announce a sign-in lockout');
    }
  };

  return app;
}
