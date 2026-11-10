/**
 * Voice entry for quick add (TXN-07): what you say becomes the sentence, read by the same parser as a typed one
 * (TXN-06). The phone's speech service does the listening; this is the pure part, testable without a device.
 */

/** The recognizer's language: the app's locale as a BCP 47 tag, English when there is none. */
export function speechLang(locale: string | undefined): string {
  const tag = (locale ?? '').replace('_', '-').split('-u-')[0]!;
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : 'en-US';
}

/**
 * The sentence while you speak: what was already in the box, then what's heard so far. Each partial result replaces
 * the last one, so the words settle as the recognizer refines them, and typing before speaking isn't lost.
 */
export function withHeard(before: string, heard: string): string {
  const b = before.trim();
  const h = heard.trim();
  return b && h ? `${b} ${h}` : b || h;
}

/** Message keys for the recognizer's errors; null when nothing needs saying (you stopped it yourself). */
export function voiceErrorKey(code: string): string | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
      return 'mobile.capture.voice_denied';
    case 'no-speech':
    case 'speech-timeout':
    case 'nomatch':
      return 'mobile.capture.voice_unheard';
    case 'network':
      return 'mobile.capture.voice_network';
    case 'service-not-allowed':
    case 'language-not-supported':
      return 'mobile.capture.voice_unavailable';
    default:
      return 'mobile.capture.voice_failed';
  }
}
