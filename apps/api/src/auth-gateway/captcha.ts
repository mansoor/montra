/**
 * A CAPTCHA after repeated failures (AUTH-08, ADR-0056): Cloudflare Turnstile, checked by the auth gateway. Off unless
 * `TURNSTILE_SECRET_KEY` is set, which is the default and right for LAN and self-hosted installs.
 *
 * The web form posts the widget's token as `cf-turnstile-response`; the gateway checks it with Turnstile's siteverify
 * and strips it before the submission reaches Kratos.
 */

/** The form field the Turnstile widget fills in. */
export const TURNSTILE_FIELD = 'cf-turnstile-response';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Turnstile's tokens are at most 2048 characters; anything longer is refused without asking. */
const MAX_TOKEN = 2048;
/** siteverify's error codes that mean the check couldn't be made, rather than that the person failed it. */
const OUR_FAULT = new Set(['internal-error', 'missing-input-secret', 'invalid-input-secret']);

export type CaptchaResult =
  | { ok: true }
  /**
   * `missing`: no token was sent. `rejected`: siteverify said no. `unreachable`: siteverify couldn't be asked or gave
   * no answer, which also refuses (sign-in stops rather than going unprotected, as when Postgres is down).
   */
  | { ok: false; reason: 'missing' | 'rejected' | 'unreachable'; codes?: string[] };

/** Checks one token for one client address. */
export type CaptchaVerifier = (token: string, ip: string) => Promise<CaptchaResult>;

/** What the gateway needs to ask for a CAPTCHA. Absent, it never asks. */
export interface CaptchaOptions {
  verify: CaptchaVerifier;
  /** Failed passwords for one email, or from one address, after which a browser sign-in needs a CAPTCHA. */
  afterFailures: number;
  /** Sign-up submissions from one address in the hour after which a browser sign-up needs a CAPTCHA. */
  afterSignUps: number;
}

/** Just the part of `fetch` the verifier uses, so tests can hand in their own. */
export type HttpPost = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Turnstile's server-side check. The secret stays inside this closure: it's sent to Cloudflare and nowhere else, never
 * logged and never part of a result.
 */
export function turnstileVerifier(opts: {
  secret: string;
  post?: HttpPost;
  timeoutMs?: number;
  url?: string;
}): CaptchaVerifier {
  const post: HttpPost = opts.post ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const url = opts.url ?? SITEVERIFY_URL;
  return async (token, ip) => {
    if (!token || token.length > MAX_TOKEN) return { ok: false, reason: 'missing' };
    const body = new URLSearchParams({ secret: opts.secret, response: token });
    if (ip) body.set('remoteip', ip);
    let res: Awaited<ReturnType<HttpPost>>;
    try {
      res = await post(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    if (!res.ok) return { ok: false, reason: 'unreachable', codes: [`http_${res.status}`] };
    const answer = (await res.json().catch(() => null)) as {
      success?: unknown;
      'error-codes'?: unknown;
    } | null;
    if (!answer || typeof answer.success !== 'boolean') return { ok: false, reason: 'unreachable' };
    if (answer.success) return { ok: true };
    const codes = Array.isArray(answer['error-codes'])
      ? answer['error-codes'].filter((c): c is string => typeof c === 'string')
      : [];
    // Cloudflare's fault or a wrong secret, not the person's: still refused, but logged as something to fix.
    const ours = codes.some((c) => OUR_FAULT.has(c));
    return { ok: false, reason: ours ? 'unreachable' : 'rejected', codes };
  };
}

/** A browser form submission without the widget's field, for Kratos. Unchanged when the field isn't there. */
export function withoutCaptchaField(
  contentType: string | undefined,
  body: Buffer | undefined,
): Buffer | undefined {
  if (!body?.length || !contentType?.includes('application/x-www-form-urlencoded')) return body;
  const params = new URLSearchParams(body.toString('utf8'));
  if (!params.has(TURNSTILE_FIELD)) return body;
  params.delete(TURNSTILE_FIELD);
  return Buffer.from(params.toString(), 'utf8');
}
