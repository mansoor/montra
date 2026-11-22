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

/** Cloudflare Turnstile (ADR-0056): its script and the frame it draws the check in. Only with a site key. */
const TURNSTILE = 'https://challenges.cloudflare.com';

/**
 * @param {{ kratosUrl?: string, dev?: boolean, frameable?: boolean, turnstileSiteKey?: string }} options `frameable`:
 *   Montra's own pages may show the response in a frame (the files under /api the receipt and payslip viewers show);
 *   never another site. `turnstileSiteKey`: NEXT_PUBLIC_TURNSTILE_SITE_KEY; set, Turnstile's script and frame are
 *   allowed (ADR-0056).
 * @returns {string}
 */
export function contentSecurityPolicy({ kratosUrl, dev = false, frameable = false, turnstileSiteKey } = {}) {
  const kratos = new URL(kratosUrl || 'http://localhost:4455').origin;
  const turnstile = Boolean(turnstileSiteKey?.trim());
  return [
    "default-src 'self'",
    // Inline for the theme script and Next's own bootstrap. Kratos for webauthn.js, without which passkeys and security keys don't work.
    `script-src 'self' 'unsafe-inline' ${kratos}${turnstile ? ` ${TURNSTILE}` : ''}${dev ? " 'unsafe-eval'" : ''}`,
    // Without a site key, frames fall back to default-src ('self'), which the receipt and payslip viewers need.
    ...(turnstile ? [`frame-src 'self' ${TURNSTILE}`] : []),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Wide because local AI mode calls an endpoint on the person's own network, whatever they've named it.
    'connect-src * ws: wss:',
    frameable ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self' ${kratos} ${OIDC_PROVIDERS.join(' ')}`,
    "object-src 'none'",
  ].join('; ');
}

/**
 * The security headers (NFR-01) for a path. Pages can't be framed at all. Responses under /api can be framed by
 * Montra's own pages only: the receipt, payslip and bill viewers show a PDF through the /api proxy in an <iframe>,
 * which `X-Frame-Options: DENY` and `frame-ancestors 'none'` blocked.
 *
 * @param {{ kratosUrl?: string, dev?: boolean, frameable?: boolean, turnstileSiteKey?: string }} options
 * @returns {{ key: string, value: string }[]}
 */
export function securityHeaders({ kratosUrl, dev = false, frameable = false, turnstileSiteKey } = {}) {
  return [
    {
      key: 'Content-Security-Policy',
      value: contentSecurityPolicy({ kratosUrl, dev, frameable, turnstileSiteKey }),
    },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: frameable ? 'SAMEORIGIN' : 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}
