import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, phoneCountry, textAllowedTo } from '../src/phone.js';

describe('phone numbers for texts (ADR-0049 §6)', () => {
  it('keeps numbers in E.164 form', () => {
    expect(normalizePhone('+1 (415) 555-0123')).toBe('+14155550123');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('415 555 0123')).toBeNull();
    expect(normalizePhone('+0123456789')).toBeNull();
    expect(normalizePhone('+1234')).toBeNull();
  });

  it('tells the country, including within +1', () => {
    expect(phoneCountry('+14155550123')).toBe('US');
    expect(phoneCountry('+14165550123')).toBe('CA');
    expect(phoneCountry('+18765550123')).toBe('JM');
    expect(phoneCountry('+442079460958')).toBe('GB');
    expect(phoneCountry('+3531234567')).toBe('IE');
    expect(phoneCountry('+99912345678')).toBeNull();
  });

  it('texts only countries on the allowed list', () => {
    expect(textAllowedTo('+14155550123', ['US'])).toBe(true);
    expect(textAllowedTo('+14165550123', ['US'])).toBe(false);
    expect(textAllowedTo('+14165550123', ['us', 'ca'])).toBe(true);
    // An expensive destination, the usual target of SMS pumping, isn't on the list unless someone puts it there.
    expect(textAllowedTo('+8801712345678', ['US', 'CA'])).toBe(false);
  });

  it('shows only the country code and the last four digits', () => {
    expect(maskPhone('+14155550123')).toBe('+1 ••• 0123');
    expect(maskPhone('+442079460958')).toBe('+44 ••• 0958');
  });
});
