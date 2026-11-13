import { describe, expect, it } from 'vitest';
import { gatewayNotice, pausedMinutes } from './gateway-notice';

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

  it('reads a pause, and nothing else', () => {
    expect(gatewayNotice({ notice: 'too_many_attempts', retry: '120' })).toEqual({
      kind: 'paused',
      minutes: 2,
    });
    expect(gatewayNotice({})).toBeNull();
  });
});
