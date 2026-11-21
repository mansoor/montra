import { describe, expect, it } from 'vitest';
import { checksVersion, DEFAULT_UPDATE_URL, refused, updateNeeded } from '../src/features/app-update';

// OPS-04: a phone app too old for the server it connects to is sent to get a newer one.
describe('whether the app needs updating', () => {
  const req = (minVersion: string, updateUrl = 'https://example.test/get-montra') => ({
    platform: 'android' as const,
    minVersion,
    updateUrl,
  });

  it('asks for an update only below the server’s minimum', () => {
    expect(updateNeeded('0.5.0', req('0.5.0'))).toBeNull();
    expect(updateNeeded('0.6.1', req('0.6.0'))).toBeNull();
    expect(updateNeeded('0.4.9', req('0.5.0'))).toEqual({
      minVersion: '0.5.0',
      url: 'https://example.test/get-montra',
    });
    expect(updateNeeded('0.10.0', req('0.9.0'))).toBeNull();
    expect(updateNeeded('0.5.0', null)).toBeNull();
  });

  it('opens only an https link, else the project’s releases', () => {
    expect(updateNeeded('0.1.0', req('0.5.0', 'javascript:alert(1)'))!.url).toBe(DEFAULT_UPDATE_URL);
    expect(updateNeeded('0.1.0', req('0.5.0', ''))!.url).toBe(DEFAULT_UPDATE_URL);
    expect(DEFAULT_UPDATE_URL).toBe('https://github.com/mansoor/montra/releases/latest');
  });

  it('after a refusal, sends to the releases until the server says more', () => {
    expect(refused(null)).toEqual({ minVersion: null, url: DEFAULT_UPDATE_URL });
    const known = { minVersion: '0.6.0', url: 'https://example.test/x' };
    expect(refused(known)).toBe(known);
    expect(checksVersion('android')).toBe(true);
    expect(checksVersion('ios')).toBe(true);
    expect(checksVersion('web')).toBe(false);
  });
});
