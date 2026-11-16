import { describe, expect, it } from 'vitest';
import { parsePhone, phoneOf, textsView, traitsWithPhone, type TextsPrefs } from '../src/features/texts';

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
    expect(parsePhone('415 555 0123')).toEqual({ ok: false, error: 'mobile.phone.invalid' });
    expect(parsePhone('  ')).toEqual({ ok: false, error: 'mobile.phone.required' });
  });

  it('keeps every other trait as it was when the number changes or goes', () => {
    const nodes = [
      { group: 'default', attributes: { name: 'csrf_token', value: '' } },
      { group: 'profile', attributes: { name: 'traits.email', value: 'pat@example.test' } },
      { group: 'profile', attributes: { name: 'traits.phone', value: '+14155550100' } },
      { group: 'profile', attributes: { name: 'traits.name.first', value: 'Pat' } },
      { group: 'profile', attributes: { name: 'traits.name.last' } },
      { group: 'profile', attributes: { name: 'method', value: 'profile' } },
    ];
    expect(traitsWithPhone(nodes, '+447700900123')).toEqual({
      email: 'pat@example.test',
      phone: '+447700900123',
      name: { first: 'Pat' },
    });
    expect(traitsWithPhone(nodes, null)).toEqual({ email: 'pat@example.test', name: { first: 'Pat' } });
  });

  it('reads the number and whether Kratos confirmed that number', () => {
    const flow = (value: unknown, addresses: Array<{ via: string; value: string; verified: boolean }>) => ({
      ui: { nodes: [{ attributes: { name: 'traits.phone', value } }] },
      identity: { verifiable_addresses: addresses },
    });
    expect(phoneOf(flow('+14155550100', [{ via: 'sms', value: '+14155550100', verified: true }]))).toEqual({
      phone: '+14155550100',
      verified: true,
    });
    // An old number confirmed doesn't confirm a new one; nor does a confirmed email.
    expect(
      phoneOf(
        flow('+14155550100', [
          { via: 'sms', value: '+14155550199', verified: true },
          { via: 'email', value: '+14155550100', verified: true },
        ]),
      ),
    ).toEqual({ phone: '+14155550100', verified: false });
    expect(phoneOf(flow(undefined, []))).toEqual({ phone: null, verified: false });
  });
});
