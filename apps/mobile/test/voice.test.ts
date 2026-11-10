import { describe, expect, it } from 'vitest';
import { speechLang, voiceErrorKey, withHeard } from '../src/features/voice';

describe('voice entry (TXN-07)', () => {
  it('listens in the app’s language', () => {
    expect(speechLang('en-US')).toBe('en-US');
    expect(speechLang('de-AT')).toBe('de-AT');
    expect(speechLang('en_GB')).toBe('en-GB');
    expect(speechLang('ja-JP-u-ca-japanese')).toBe('ja-JP');
    expect(speechLang('')).toBe('en-US');
    expect(speechLang(undefined)).toBe('en-US');
  });

  it('adds what’s heard after what was typed, each partial result replacing the last', () => {
    expect(withHeard('', 'lunch')).toBe('lunch');
    expect(withHeard('', 'lunch eighteen fifty')).toBe('lunch eighteen fifty');
    expect(withHeard('amex', ' client meeting ')).toBe('amex client meeting');
    expect(withHeard('amex ', '')).toBe('amex');
    expect(withHeard('', '')).toBe('');
  });

  it('explains what went wrong, and says nothing when you stopped it yourself', () => {
    expect(voiceErrorKey('aborted')).toBeNull();
    expect(voiceErrorKey('not-allowed')).toBe('mobile.capture.voice_denied');
    expect(voiceErrorKey('no-speech')).toBe('mobile.capture.voice_unheard');
    expect(voiceErrorKey('nomatch')).toBe('mobile.capture.voice_unheard');
    expect(voiceErrorKey('network')).toBe('mobile.capture.voice_network');
    expect(voiceErrorKey('language-not-supported')).toBe('mobile.capture.voice_unavailable');
    expect(voiceErrorKey('audio-capture')).toBe('mobile.capture.voice_failed');
  });
});
