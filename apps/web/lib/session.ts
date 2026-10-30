/**
 * Development session: the signed-in email lives in an HttpOnly cookie and is turned into
 * `Authorization: Bearer dev:<email>` by the server (BFF). Never readable from browser JavaScript.
 *
 * Phase 1b: Kratos session — replace the cookie with the Kratos session cookie/token and forward it to the
 * API instead of the dev bearer.
 */
export const SESSION_COOKIE = 'montra_dev_email';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

/** Headers the API needs for this session. */
export function authHeaders(email: string | undefined): Record<string, string> {
  return email && isValidEmail(email) ? { authorization: `Bearer dev:${email}` } : {};
}

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
