import { describe, expect, it } from 'vitest';
import { pausedMinutes } from './gateway-notice';

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
