/**
 * Texts and the mobile number on the phone (ADR-0049 §6), by the web's rules:
 * - Nothing about texts shows where this service doesn't send them (`texts.available`): a number couldn't be verified.
 * - Security alerts and reminders by text can be switched only for a verified number.
 * - The number is Kratos's (`traits.phone`), changed in a settings flow like the web's Settings → Security.
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
  if (!input.trim()) return { ok: false, error: 'mobile.phone.required' };
  const phone = normalizePhone(input);
  return phone ? { ok: true, phone } : { ok: false, error: 'mobile.phone.invalid' };
}

interface TraitNode {
  group?: string;
  attributes?: { name?: string; value?: unknown };
}

/**
 * The identity's traits from a settings flow's profile form, with the number set or removed. Kratos replaces every
 * trait on a profile save, so the others go back as they were.
 */
export function traitsWithPhone(nodes: readonly TraitNode[], phone: string | null): Record<string, unknown> {
  const traits: Record<string, unknown> = {};
  for (const n of nodes) {
    const name = n.attributes?.name;
    const value = n.attributes?.value;
    if (!name?.startsWith('traits.') || value === undefined || value === null || value === '') continue;
    const path = name.slice('traits.'.length).split('.');
    let at = traits;
    for (const key of path.slice(0, -1)) {
      if (typeof at[key] !== 'object' || at[key] === null) at[key] = {};
      at = at[key] as Record<string, unknown>;
    }
    at[path[path.length - 1]!] = value;
  }
  if (phone) traits.phone = phone;
  else delete traits.phone;
  return traits;
}

/** The number on the identity and whether Kratos has verified it, from a settings flow. */
export function phoneOf(flow: {
  ui?: { nodes?: readonly TraitNode[] };
  identity?: { verifiable_addresses?: ReadonlyArray<{ via?: string; value?: string; verified?: boolean }> };
}): { phone: string | null; verified: boolean } {
  const raw = flow.ui?.nodes?.find((n) => n.attributes?.name === 'traits.phone')?.attributes?.value;
  const phone = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const verified = Boolean(
    phone &&
    flow.identity?.verifiable_addresses?.some((a) => a.via === 'sms' && a.value === phone && a.verified),
  );
  return { phone, verified };
}
