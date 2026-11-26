import { describe, expect, it } from 'vitest';
import { hasSecondFactorCredential } from '../src/auth/kratos.adapter.js';

// ADR-0044: an owner with no second factor is sent to set one up, not to a sign-in step with nothing to enter.
describe('hasSecondFactorCredential', () => {
  it('is false for a password sign-up that Kratos left an empty webauthn entry on', () => {
    expect(
      hasSecondFactorCredential({
        password: { type: 'password' },
        webauthn: { type: 'webauthn', config: { credentials: [] } },
      }),
    ).toBe(false);
    expect(hasSecondFactorCredential({ webauthn: { type: 'webauthn', config: null } })).toBe(false);
    expect(hasSecondFactorCredential({ webauthn: { type: 'webauthn' } })).toBe(false);
  });

  it('is true for a registered security key, TOTP or recovery codes', () => {
    expect(
      hasSecondFactorCredential({ webauthn: { type: 'webauthn', config: { credentials: [{ id: 'k1' }] } } }),
    ).toBe(true);
    expect(hasSecondFactorCredential({ totp: { type: 'totp' } })).toBe(true);
    expect(hasSecondFactorCredential({ lookup_secret: { type: 'lookup_secret' } })).toBe(true);
  });

  it('is false with no credentials, or a password only', () => {
    expect(hasSecondFactorCredential(undefined)).toBe(false);
    expect(hasSecondFactorCredential({ password: { type: 'password' } })).toBe(false);
  });
});
