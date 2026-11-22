import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './csp.mjs';

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? [];

describe('contentSecurityPolicy', () => {
  it('lets Kratos’ script run and its forms submit, since passkeys and sign-in need them', () => {
    const csp = contentSecurityPolicy({ kratosUrl: 'https://auth.example.com' });
    expect(directive(csp, 'script-src')).toContain('https://auth.example.com');
    expect(directive(csp, 'form-action')).toContain('https://auth.example.com');
  });

  it('lets a sign-in form be redirected on to the OIDC providers, which browsers check too', () => {
    const action = directive(contentSecurityPolicy(), 'form-action');
    expect(action).toContain('https://appleid.apple.com');
    expect(action).toContain('https://accounts.google.com');
    expect(action).not.toContain('https:');
    expect(action).not.toContain('*');
  });

  it('uses the origin, whatever form the address came in', () => {
    const csp = contentSecurityPolicy({ kratosUrl: 'https://auth.example.com/some/path/' });
    expect(directive(csp, 'script-src')).toContain('https://auth.example.com');
    expect(csp).not.toContain('some/path');
  });

  it('falls back to the local auth gateway when the address is unset or empty, as in a build without one', () => {
    for (const kratosUrl of [undefined, '']) {
      expect(directive(contentSecurityPolicy({ kratosUrl }), 'script-src')).toContain(
        'http://localhost:4455',
      );
    }
  });

  it('allows scripts from nowhere else, and eval only in development', () => {
    const csp = contentSecurityPolicy({ kratosUrl: 'https://auth.example.com' });
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'unsafe-inline'", 'https://auth.example.com']);
    expect(directive(contentSecurityPolicy({ dev: true }), 'script-src')).toContain("'unsafe-eval'");
  });

  it('keeps the page from being framed, and plugins out', () => {
    const csp = contentSecurityPolicy();
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
  });
});

describe('securityHeaders', () => {
  const header = (h: { key: string; value: string }[], key: string) => h.find((x) => x.key === key)?.value;

  it('never lets a page be framed', () => {
    const h = securityHeaders();
    expect(header(h, 'X-Frame-Options')).toBe('DENY');
    expect(directive(header(h, 'Content-Security-Policy') ?? '', 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('lets only Montra’s own pages frame the files under /api, so the PDF viewer can show them', () => {
    const h = securityHeaders({ frameable: true });
    expect(header(h, 'X-Frame-Options')).toBe('SAMEORIGIN');
    expect(directive(header(h, 'Content-Security-Policy') ?? '', 'frame-ancestors')).toEqual(["'self'"]);
    expect(directive(header(h, 'Content-Security-Policy') ?? '', 'object-src')).toEqual(["'none'"]);
  });

  it('keeps the other headers the same either way', () => {
    for (const key of [
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
    ]) {
      expect(header(securityHeaders({ frameable: true }), key), key).toBe(header(securityHeaders(), key));
    }
  });
});

describe('Cloudflare Turnstile in the CSP (ADR-0056)', () => {
  const TURNSTILE = 'https://challenges.cloudflare.com';

  it('allows nothing from Cloudflare without a site key, and keeps frames to Montra’s own', () => {
    for (const turnstileSiteKey of [undefined, '', '  ']) {
      const csp = contentSecurityPolicy({ kratosUrl: 'https://auth.example.com', turnstileSiteKey });
      expect(csp).not.toContain(TURNSTILE);
      expect(directive(csp, 'frame-src')).toEqual([]);
      expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    }
  });

  it('allows Turnstile’s script and frame, and nothing more, with a site key', () => {
    const csp = contentSecurityPolicy({
      kratosUrl: 'https://auth.example.com',
      turnstileSiteKey: '1x00000000000000000000AA',
    });
    expect(directive(csp, 'script-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://auth.example.com',
      TURNSTILE,
    ]);
    // 'self' stays, for the receipt and payslip viewers' frames.
    expect(directive(csp, 'frame-src')).toEqual(["'self'", TURNSTILE]);
    expect(directive(csp, 'form-action')).not.toContain(TURNSTILE);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('passes the key through the headers for pages and for /api alike', () => {
    for (const frameable of [false, true]) {
      const value =
        securityHeaders({ frameable, turnstileSiteKey: '1x00000000000000000000AA' }).find(
          (h) => h.key === 'Content-Security-Policy',
        )?.value ?? '';
      expect(directive(value, 'frame-src')).toContain(TURNSTILE);
    }
  });
});
