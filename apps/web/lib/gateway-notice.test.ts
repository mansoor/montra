import { describe, expect, it } from 'vitest';
import { captchaSiteKey, gatewayNotice, pausedMinutes } from './gateway-notice';

describe('pausedMinutes (AUTH-08)', () => {
  it('rounds the gateway’s seconds up to whole minutes', () => {
    expect(pausedMinutes({ notice: 'too_many_attempts', retry: '900' })).toBe(15);
    expect(pausedMinutes({ notice: 'too_many_attempts', retry: '61' })).toBe(2);
    expect(pausedMinutes({ notice: 'too_many_attempts', retry: '5' })).toBe(1);
  });

  it('says a minute when the retry is missing or odd, and nothing without the notice', () => {
    expect(pausedMinutes({ notice: 'too_many_attempts' })).toBe(1);
    expect(pausedMinutes({ notice: 'too_many_attempts', retry: 'soon' })).toBe(1);
    expect(pausedMinutes({ retry: '900' })).toBeNull();
    expect(pausedMinutes({ notice: 'other' })).toBeNull();
  });
});

describe('gatewayNotice (AUTH-02)', () => {
  it('reads a weak-password notice', () => {
    expect(gatewayNotice({ notice: 'weak_password', problems: 'too_short,too_weak', min: '16' })).toEqual({
      kind: 'weak_password',
      tooShort: true,
      tooWeak: true,
      minLength: 16,
    });
    expect(gatewayNotice({ notice: 'weak_password', problems: 'too_short', min: '999' })).toEqual({
      kind: 'weak_password',
      tooShort: true,
      tooWeak: false,
      minLength: 12,
    });
    expect(gatewayNotice({ notice: 'weak_password' })).toMatchObject({ tooWeak: true });
  });

  it('reads a number to change in its own section (ADR-0049 §6)', () => {
    expect(gatewayNotice({ notice: 'phone_in_app' })).toEqual({ kind: 'phone_in_app' });
  });

  it('reads a pause, and nothing else', () => {
    expect(gatewayNotice({ notice: 'too_many_attempts', retry: '120' })).toEqual({
      kind: 'paused',
      minutes: 2,
    });
    expect(gatewayNotice({})).toBeNull();
  });
});

describe('a CAPTCHA the gateway asked for (AUTH-08, ADR-0056)', () => {
  // Cloudflare's published always-pass test site key: never a real one in tests.
  const KEY = '1x00000000000000000000AA';

  it('shows the widget only when asked and the build has a site key', () => {
    expect(captchaSiteKey({ notice: 'captcha_required' }, KEY)).toBe(KEY);
    expect(captchaSiteKey({ notice: 'captcha_required' }, null)).toBeNull();
    expect(captchaSiteKey({}, KEY)).toBeNull();
    expect(captchaSiteKey({ notice: 'too_many_attempts' }, KEY)).toBeNull();
  });

  it('reads the notice, with or without a key to show the widget with', () => {
    expect(gatewayNotice({ notice: 'captcha_required', flow: 'f1' }, KEY)).toEqual({
      kind: 'captcha',
      siteKey: KEY,
    });
    expect(gatewayNotice({ notice: 'captcha_required' }, null)).toEqual({ kind: 'captcha', siteKey: null });
    // A pause is never mixed up with a CAPTCHA.
    expect(gatewayNotice({ notice: 'too_many_attempts', retry: '60' }, KEY)).toEqual({
      kind: 'paused',
      minutes: 1,
    });
  });
});
