/**
 * Texts and the mobile number on the phone (ADR-0049 §6), by the web's rules:
 * - Nothing about texts shows where this service doesn't send them (`texts.available`): a number couldn't be verified.
 * - Security alerts and reminders by text can be switched only for a verified number.
 * - The number is changed through the API, which confirms it with a code it texts, as on the web's Settings →
 *   Security. (Kratos's own texted code can't be entered: its settings flow never names the verification flow.)
 */
import { normalizePhone } from '@montra/domain';
import type { NotificationPrefsDto } from '@montra/schemas';

export type TextsPrefs = NotificationPrefsDto['texts'];

export interface TextsView {
  /** The i18n key and values for the line under the heading. */
  line: { key: string; values?: Record<string, string> };
  /** Offer the way to add or verify the number. */
  addNumber: boolean;
  /** The switches work only for a verified number. */
  canSwitch: boolean;
  /** The number replied STOP: nothing is texted until it changes. */
  optedOut: boolean;
}

/** What the notification settings' Texts section shows, or null where texts aren't on (the section is hidden). */
export function textsView(texts: TextsPrefs | null | undefined): TextsView | null {
  if (!texts?.available) return null;
  const verified = Boolean(texts.phone && texts.verified);
  return {
    line: verified
      ? { key: 'notify.texts_to', values: { phone: texts.phone! } }
      : { key: texts.phone ? 'notify.texts_unverified' : 'notify.texts_no_phone' },
    addNumber: !verified,
    canSwitch: texts.verified,
    optedOut: texts.optedOut,
  };
}

/** The number as typed, in the form Kratos accepts (`+` and the country code), or an error key. */
export function parsePhone(input: string): { ok: true; phone: string } | { ok: false; error: string } {
  if (!input.trim()) return { ok: false, error: 'phone.required' };
  const phone = normalizePhone(input);
  return phone ? { ok: true, phone } : { ok: false, error: 'phone.invalid' };
}
