import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import {
  DEFAULT_POLICY,
  judgePassword,
  personalWords,
  strengthOf,
  type PasswordPolicy,
  type PasswordProblem,
  type Strength,
} from '@montra/password';
import type { MailPort } from '../mail/mail.service.js';
import { templates } from '../mail/mail.service.js';
import { TURNSTILE_FIELD, withoutCaptchaField, type CaptchaOptions, type CaptchaResult } from './captcha.js';
import {
  delayFor,
  keyOf,
  liveFailures,
  lockedFor,
  RULES,
  type Bucket,
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
/** Shown when a new password doesn't meet the policy (ADR-0043). */
export const WEAK_PASSWORD_ID = 4000901;
/**
 * ADR-0049 §6: a number is changed through the API, which texts it a code; Kratos's own texted code can't be entered
 * (its settings flow never names the verification flow). So a settings save that would change it is turned away.
 */
export const PHONE_IN_APP_ID = 4000902;
const PHONE_IN_APP_TEXT =
  'Change your mobile number in its own section of your security settings, where we text it a code to confirm it.';

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
  /**
   * Which CAPTCHA threshold applies to a browser submission (ADR-0056): a password sign-in's failures, or the address's
   * sign-ups. Null for everything else.
   */
  captcha: 'failures' | 'sign_ups' | null;
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
  logger?: FastifyServerOptions['logger'];
  /** A CAPTCHA for browsers after repeated failures (ADR-0056). Absent, none is ever asked for. */
  captcha?: CaptchaOptions;
  /** The admin console's password policy (ADR-0043). Defaults to 12 characters and a score of 3. */
  policy?: () => Promise<PasswordPolicy>;
  /** Scores a password; the entrypoint runs this on a worker thread. */
  strength?: (password: string, words: string[]) => Promise<Strength>;
}

/** A new password being set: at sign-up, or in settings (including after a recovery). */
export interface PasswordChange {
  kind: 'registration' | 'settings';
  flowId: string | null;
  json: boolean;
  password: string;
  email: string | null;
  name: string | null;
}

type Fields = Record<string, string>;

export function parseFields(contentType: string | undefined, raw: Buffer | undefined): Fields {
  if (!raw?.length) return {};
  const text = raw.toString('utf8');
  if (contentType?.includes('application/json')) {
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object') return {};
      // One level of nesting, named as the browser's form names it: `traits.email`.
      const out: Fields = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
        else if (v && typeof v === 'object' && !Array.isArray(v))
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>))
            if (typeof v2 === 'string') out[`${k}.${k2}`] = v2;
      }
      return out;
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
  if (!kind) return null;
  const flowId = new URLSearchParams(query).get('flow');
  const contentType = header(req.headers, 'content-type');
  const json =
    Boolean(contentType?.includes('application/json')) ||
    Boolean(header(req.headers, 'accept')?.includes('application/json'));
  const fields = parseFields(contentType, req.body);
  const method = fields.method ?? '';
  const at = (rule: Rule, value: string): Check => ({ rule, key: keyOf(secret, rule.name, value) });
  const base = {
    kind,
    flowId,
    json,
    identifier: null,
    countAlways: false,
    clearOnSuccess: [] as string[],
    captcha: null,
  };

  if (kind === 'registration')
    return { ...base, checks: [at(RULES.sign_up, ip)], countAlways: true, captcha: 'sign_ups' };

  /** A text with a code is about to go to this number (ADR-0049 §6): limited per number and per address. */
  const texted = (phone: string): Attempt => ({
    ...base,
    checks: [at(RULES.sms_send, `number:${phone}`), at(RULES.sms_send, ip)],
    countAlways: true,
  });
  const phoneIn = (...values: (string | undefined)[]) =>
    values.map((v) => v?.trim().replace(/[\s().-]/g, '')).find((v) => v && /^\+[1-9]\d{6,14}$/.test(v)) ??
    null;

  // Settings: nothing is limited here. A number isn't changed in Kratos's settings (`phoneChangeOf`), so nothing in
  // them texts.
  if (kind === 'settings') return null;

  const emailed = (): Attempt | null => {
    if (fields.code) {
      const checks = [at(RULES.code, ip)];
      if (flowId) checks.push(at(RULES.code, `flow:${flowId}`));
      // A texted second factor: wrong codes count against the session, as an authenticator's do.
      const session = kind === 'login' ? sessionOf(req.headers) : null;
      if (session) checks.unshift(at(RULES.second_factor, session));
      return { ...base, checks, clearOnSuccess: session ? [checks[0]!.key] : [] };
    }
    const phone = phoneIn(fields.address, fields.phone, fields.identifier, fields.email);
    if (phone) return texted(phone);
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
    return {
      ...base,
      identifier,
      checks,
      clearOnSuccess: identifier ? [checks[0]!.key] : [],
      captcha: 'failures',
    };
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

/** A password being set, when this request sets one; null otherwise. */
export function passwordChangeOf(req: {
  method: string;
  url: string;
  headers: FastifyRequest['headers'];
  body?: Buffer;
}): PasswordChange | null {
  if (req.method !== 'POST') return null;
  const [path, query = ''] = req.url.split('?', 2) as [string, string?];
  const kind = SUBMIT.exec(path)?.[1];
  if (kind !== 'registration' && kind !== 'settings') return null;
  const contentType = header(req.headers, 'content-type');
  const fields = parseFields(contentType, req.body);
  if (fields.method !== 'password' || !fields.password) return null;
  return {
    kind,
    flowId: new URLSearchParams(query).get('flow'),
    json:
      Boolean(contentType?.includes('application/json')) ||
      Boolean(header(req.headers, 'accept')?.includes('application/json')),
    password: fields.password,
    email: fields['traits.email'] ?? null,
    name: fields['traits.name'] ?? null,
  };
}

/**
 * A settings profile save that carries a number (`traits.phone`), with the number as sent (spaces dropped; empty means
 * none). The handler turns it away unless it's the number the identity already has. Null for anything else.
 */
export function phoneChangeOf(req: {
  method: string;
  url: string;
  headers: FastifyRequest['headers'];
  body?: Buffer;
}): { flowId: string | null; json: boolean; phone: string | null } | null {
  if (req.method !== 'POST') return null;
  const [path, query = ''] = req.url.split('?', 2) as [string, string?];
  if (SUBMIT.exec(path)?.[1] !== 'settings') return null;
  const contentType = header(req.headers, 'content-type');
  const fields = parseFields(contentType, req.body);
  if (fields.method !== 'profile' || !('traits.phone' in fields)) return null;
  return {
    flowId: new URLSearchParams(query).get('flow'),
    json:
      Boolean(contentType?.includes('application/json')) ||
      Boolean(header(req.headers, 'accept')?.includes('application/json')),
    phone: fields['traits.phone']!.replace(/[\s().-]/g, '') || null,
  };
}

/** What to tell someone whose new password doesn't meet the policy. */
export function weakPasswordText(
  problems: PasswordProblem[],
  policy: PasswordPolicy,
  warning: string | null,
): string {
  const parts: string[] = [];
  if (problems.includes('too_short')) parts.push(`Use at least ${policy.minLength} characters.`);
  if (problems.includes('too_weak'))
    parts.push(
      `This password is too easy to guess.${warning ? ` ${warning}` : ''} Try a few unrelated words together.`,
    );
  return parts.join(' ');
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
  const readFlow = async (
    req: FastifyRequest,
    a: { kind: FlowKind; flowId: string | null },
  ): Promise<FlowLike | null> => {
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

  /** Who is changing their password, for words it shouldn't be built from. */
  const whoami = async (
    req: FastifyRequest,
  ): Promise<{ email: string | null; name: string | null; phone: string | null }> => {
    const res = await forward(req, '/sessions/whoami', 'GET').catch(() => null);
    const body = res?.ok
      ? ((await res.json().catch(() => null)) as { identity?: { traits?: Record<string, unknown> } } | null)
      : null;
    const traits = body?.identity?.traits ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return { email: str(traits.email), name: str(traits.name), phone: str(traits.phone) };
  };

  /**
   * Whether a browser's next submission of this kind needs a CAPTCHA (ADR-0056): the email's or the address's failures,
   * or the address's sign-ups, have reached the threshold. Never for JSON (the phone), and never when it's off.
   */
  const captchaDue = (a: Attempt, buckets: Map<string, Bucket>, at: Date): boolean => {
    if (!opts.captcha || a.json || !a.captcha) return false;
    const limit = a.captcha === 'failures' ? opts.captcha.afterFailures : opts.captcha.afterSignUps;
    return a.checks.some((c) => liveFailures(buckets.get(c.key), c.rule, at) >= limit);
  };

  /** A redirect Kratos made back to the same flow's form on the web, with `notice=captcha_required` added. */
  const withCaptchaNotice = (a: Attempt, location: string): string | null => {
    let to: URL;
    try {
      to = new URL(location, `${web}/`);
    } catch {
      return null;
    }
    const form = new URL(UI_PATH[a.kind], `${web}/`);
    if (to.origin !== form.origin || to.pathname !== form.pathname) return null;
    if (!a.flowId || to.searchParams.get('flow') !== a.flowId || to.searchParams.has('notice')) return null;
    to.searchParams.set('notice', 'captcha_required');
    return to.toString();
  };

  const lockedMessage = (seconds: number) => {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`;
  };

  app.all('/*', async (req, reply) => {
    let body = req.body as Buffer | undefined;
    const ip = req.ip;
    const attempt = attemptOf(
      { method: req.method, url: req.url, headers: req.headers, body },
      opts.secret,
      ip,
    );

    let buckets = new Map<string, Bucket>();
    if (attempt) {
      buckets = await opts.store.get(attempt.checks.map((c) => c.key));
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
      // A CAPTCHA after repeated failures (ADR-0056). A refused one reaches nothing and counts nothing.
      if (opts.captcha && captchaDue(attempt, buckets, at)) {
        const token = parseFields(header(req.headers, 'content-type'), body)[TURNSTILE_FIELD];
        const result: CaptchaResult = token
          ? await opts.captcha
              .verify(token, ip)
              .catch((): CaptchaResult => ({ ok: false, reason: 'unreachable' }))
          : { ok: false, reason: 'missing' };
        if (!result.ok) {
          if (result.reason === 'unreachable')
            req.log.warn({ codes: result.codes }, 'Could not check a CAPTCHA, so the attempt was refused');
          const q = new URLSearchParams({ notice: 'captcha_required' });
          if (attempt.flowId) q.set('flow', attempt.flowId);
          return reply.code(303).header('location', `${web}${UI_PATH[attempt.kind]}?${q}`).send();
        }
      }
      const wait = Math.max(
        0,
        ...attempt.checks.map((c) => delayFor(liveFailures(buckets.get(c.key), c.rule, at), c.rule)),
      );
      if (wait > 0) await sleep(wait);
    }
    // Kratos never sees the widget's field.
    if (opts.captcha) body = withoutCaptchaField(header(req.headers, 'content-type'), body);

    // A new password: the admin console's policy, before Kratos ever stores it (ADR-0043).
    const change = passwordChangeOf({ method: req.method, url: req.url, headers: req.headers, body });
    if (change) {
      const policy = await (opts.policy ? opts.policy() : Promise.resolve(DEFAULT_POLICY)).catch(
        () => DEFAULT_POLICY,
      );
      let { email, name } = change;
      if (change.kind === 'settings') {
        const who = await whoami(req);
        email ??= who.email;
        name ??= who.name;
      }
      const score = opts.strength ?? ((p: string, w: string[]) => Promise.resolve(strengthOf(p, w)));
      const strength = await score(change.password, personalWords({ email, name })).catch((err: Error) => {
        // Without a score only the length is checked here; Kratos still checks length and breach lists.
        req.log.warn({ err }, 'Could not score a new password');
        return null;
      });
      const judged = judgePassword(
        change.password,
        strength ? policy : { ...policy, minScore: 0 },
        strength ?? { score: 4, warning: null, suggestions: [] },
      );
      if (!judged.ok) {
        // A refused sign-up still counts towards the address's sign-up limit.
        if (attempt?.countAlways) for (const c of attempt.checks) await opts.store.fail(c.key, c.rule, now());
        const text = weakPasswordText(judged.problems, policy, strength?.warning ?? null);
        if (!change.json) {
          const q = new URLSearchParams({
            notice: 'weak_password',
            problems: judged.problems.join(','),
            min: String(policy.minLength),
          });
          if (change.flowId) q.set('flow', change.flowId);
          return reply.code(303).header('location', `${web}${UI_PATH[change.kind]}?${q}`).send();
        }
        const message = {
          id: WEAK_PASSWORD_ID,
          type: 'error',
          text,
          context: { problems: judged.problems, min_length: policy.minLength, min_score: policy.minScore },
        };
        const flow = await readFlow(req, change);
        const payload = flow?.ui
          ? { ...flow, ui: { ...flow.ui, messages: [message] } }
          : { error: { id: 'weak_password', code: 400, status: 'Bad Request', message: text } };
        return reply.code(400).header('content-type', 'application/json').send(JSON.stringify(payload));
      }
    }

    // A number changes only through the API (ADR-0049 §6): the same number passes, as the web's profile form sends it.
    const phoneChange = phoneChangeOf({ method: req.method, url: req.url, headers: req.headers, body });
    if (phoneChange && phoneChange.phone !== (await whoami(req)).phone) {
      if (!phoneChange.json) {
        const q = new URLSearchParams({ notice: 'phone_in_app' });
        if (phoneChange.flowId) q.set('flow', phoneChange.flowId);
        return reply.code(303).header('location', `${web}${UI_PATH.settings}?${q}`).send();
      }
      const message = { id: PHONE_IN_APP_ID, type: 'error', text: PHONE_IN_APP_TEXT };
      const flow = await readFlow(req, { kind: 'settings', flowId: phoneChange.flowId });
      const out = flow?.ui
        ? { ...flow, ui: { ...flow.ui, messages: [message] } }
        : { error: { id: 'phone_in_app', code: 400, status: 'Bad Request', message: PHONE_IN_APP_TEXT } };
      return reply.code(400).header('content-type', 'application/json').send(JSON.stringify(out));
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
    let location = res.headers.get('location');
    if (attempt) {
      const outcome = await outcomeOf(req, attempt, res);
      const at = now();
      if (outcome === 'failure' || attempt.countAlways) {
        for (const c of attempt.checks) {
          const { bucket, locked } = await opts.store.fail(c.key, c.rule, at);
          buckets.set(c.key, bucket);
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
        for (const key of attempt.clearOnSuccess) buckets.delete(key);
      }
      // Back to the form, and the next try needs a CAPTCHA: say so now, so the page shows the widget straight away.
      if (location && res.status >= 300 && res.status < 400 && captchaDue(attempt, buckets, at))
        location = withCaptchaNotice(attempt, location) ?? location;
    }

    void reply.code(res.status);
    res.headers.forEach((value, name) => {
      if (name === 'set-cookie' || DROP_RESPONSE.has(name)) return;
      void reply.header(name, name === 'location' && location ? location : value);
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
