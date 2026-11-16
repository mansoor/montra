import { describe, expect, it } from 'vitest';
import { parsePhone, textsView, type TextsPrefs } from '../src/features/texts';

const prefs = (over: Partial<TextsPrefs> = {}): TextsPrefs => ({
  available: true,
  phone: '+1 ••• 0123',
  verified: true,
  optedOut: false,
  security: false,
  reminders: false,
  ...over,
});

describe('texts in notification settings (ADR-0049 §6)', () => {
  it('hides the section where this service sends no texts', () => {
    expect(textsView(prefs({ available: false }))).toBeNull();
    expect(textsView(null)).toBeNull();
    expect(textsView(undefined)).toBeNull();
  });

  it('names a confirmed number and lets the switches work', () => {
    expect(textsView(prefs())).toEqual({
      line: { key: 'notify.texts_to', values: { phone: '+1 ••• 0123' } },
      addNumber: false,
      canSwitch: true,
      optedOut: false,
    });
  });

  it('asks for a number, or for it to be confirmed, and keeps the switches off until then', () => {
    expect(textsView(prefs({ phone: null, verified: false }))).toMatchObject({
      line: { key: 'notify.texts_no_phone' },
      addNumber: true,
      canSwitch: false,
    });
    expect(textsView(prefs({ verified: false }))).toMatchObject({
      line: { key: 'notify.texts_unverified' },
      addNumber: true,
      canSwitch: false,
    });
  });

  it('says when the number replied STOP', () => {
    expect(textsView(prefs({ optedOut: true }))?.optedOut).toBe(true);
  });
});

describe('the mobile number', () => {
  it('takes it with the country code, in the form Kratos accepts', () => {
    expect(parsePhone('+1 (415) 555-0123')).toEqual({ ok: true, phone: '+14155550123' });
    expect(parsePhone('0044 7700 900123')).toEqual({ ok: true, phone: '+447700900123' });
    expect(parsePhone('415 555 0123')).toEqual({ ok: false, error: 'phone.invalid' });
    expect(parsePhone('  ')).toEqual({ ok: false, error: 'phone.required' });
  });
});
