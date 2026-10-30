/**
 * Session handling for the web BFF (docs/design/08 §2). Two modes:
 * - `dev`: the signed-in email lives in an HttpOnly cookie and becomes `Authorization: Bearer dev:<email>`.
 * - `kratos`: Ory Kratos owns the session cookie (ADR-0006); the BFF forwards `ory_kratos_session` to the API.
 * Neither value is ever readable from browser JavaScript.
 */
export type AuthMode = 'dev' | 'kratos';

export const AUTH_MODE: AuthMode = process.env.NEXT_PUBLIC_AUTH_MODE === 'kratos' ? 'kratos' : 'dev';

export const DEV_COOKIE = 'montra_dev_email';
export const KRATOS_COOKIE = 'ory_kratos_session';

/** The cookie whose presence means "signed in" for the current mode. */
export const sessionCookieName = (mode: AuthMode = AUTH_MODE) =>
  mode === 'kratos' ? KRATOS_COOKIE : DEV_COOKIE;
export const SESSION_COOKIE = sessionCookieName();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

/** Kratos session cookie values are opaque tokens; refuse anything that could smuggle another header. */
const isCookieSafe = (v: string) => /^[A-Za-z0-9._~+/=-]+$/.test(v);

/** Headers the API needs for this session. */
export function authHeaders(
  sessionValue: string | undefined,
  mode: AuthMode = AUTH_MODE,
): Record<string, string> {
  if (!sessionValue) return {};
  if (mode === 'kratos')
    return isCookieSafe(sessionValue) ? { cookie: `${KRATOS_COOKIE}=${sessionValue}` } : {};
  return isValidEmail(sessionValue) ? { authorization: `Bearer dev:${sessionValue}` } : {};
}

/** Token for the WebSocket subscribe message: dev bearer value; Kratos relies on the cookie. */
export function wsToken(sessionValue: string | undefined, mode: AuthMode = AUTH_MODE): string | null {
  return mode === 'dev' && sessionValue && isValidEmail(sessionValue) ? `dev:${sessionValue}` : null;
}

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
/** Kratos public API as reached from the Next.js server. */
export const KRATOS_PUBLIC_URL = (process.env.KRATOS_PUBLIC_URL ?? 'http://localhost:4433').replace(
  /\/+$/,
  '',
);
/** Kratos public API as reached from the browser (flow init redirects, form actions, scripts). */
export const KRATOS_BROWSER_URL = (process.env.NEXT_PUBLIC_KRATOS_URL ?? 'http://localhost:4433').replace(
  /\/+$/,
  '',
);
/** This app's public origin, for absolute `return_to` URLs Kratos accepts. */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Where to send the user when the API asks for a stronger or fresher sign-in (AUTH-04, AUTH-09). */
export function stepUpHref(code: string, returnTo: string): string | null {
  const back = encodeURIComponent(returnTo.startsWith('/') ? APP_URL + returnTo : returnTo);
  if (code === 'mfa.required') return `/sign-in?aal=aal2&return_to=${back}`;
  if (code === 'reauth.required') return `/sign-in?refresh=true&return_to=${back}`;
  if (code === 'email.unverified') return '/auth/verification';
  return null;
}
