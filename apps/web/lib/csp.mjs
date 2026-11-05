/**
 * The Content-Security-Policy (NFR-01). A plain script, because next.config.mjs runs before anything is compiled. It's worked out at build
 * time, which is why each environment's web image is built with its own NEXT_PUBLIC_KRATOS_URL.
 */
import { URL } from 'node:url';

/**
 * Sign in with Apple and Google (AUTH-01). Browsers apply form-action to redirects as well: the sign-in form posts to Kratos, which redirects
 * here, and Chromium blocks the whole thing unless these are listed. A new OIDC provider needs adding too.
 */
const OIDC_PROVIDERS = ['https://appleid.apple.com', 'https://accounts.google.com'];

/**
 * @param {{ kratosUrl?: string, dev?: boolean }} options
 * @returns {string}
 */
export function contentSecurityPolicy({ kratosUrl, dev = false } = {}) {
  const kratos = new URL(kratosUrl || 'http://localhost:4433').origin;
  return [
    "default-src 'self'",
    // Inline for the theme script and Next's own bootstrap. Kratos for webauthn.js, without which passkeys and security keys don't work.
    `script-src 'self' 'unsafe-inline' ${kratos}${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Wide because local AI mode calls an endpoint on the person's own network, whatever they've named it.
    'connect-src * ws: wss:',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self' ${kratos} ${OIDC_PROVIDERS.join(' ')}`,
    "object-src 'none'",
  ].join('; ');
}
