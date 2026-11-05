import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './csp.mjs';

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

  it('falls back to local Kratos when the address is unset or empty, as in a build without one', () => {
    for (const kratosUrl of [undefined, '']) {
      expect(directive(contentSecurityPolicy({ kratosUrl }), 'script-src')).toContain(
        'http://localhost:4433',
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
