/**
 * Editing the settings on the phone (OPS-13), by the web's rules and with the web's API calls. Pure, so it is tested
 * without React Native:
 *
 * - **Profile**: your name and your own time zone (`PATCH /v1/me`), as on the web's Settings → Profile. Everyone.
 * - **Family**: add, rename, change the relationship, archive and restore (`/family-members`), as on Settings → Family.
 *   Owners, admins and partners: the database refuses anyone else (RLS `family_member_insert/update`, 0041).
 * - **Books**: add business or rental books, rename, archive and restore, pick the calendar colour (`/entities`), as on
 *   Settings → Entities. Owners and admins (the API's `requireWorkspaceAdmin`). The personal books take only a colour.
 *   Adding is limited by the plan; the API says so (402 `plan.required`, 422 `plan.limit`).
 * - **AI mode** (`PATCH /ai/settings`): owners and admins. A mode that needs something only the web can enter (an API
 *   key, a model server's URL, Azure's deployment) is offered only once it has been entered there, by the same checks the
 *   web makes before saving.
 * - **Quiet hours and the daily cap** (`PATCH /v1/me/notification-prefs`): everyone, for themselves.
 *
 * The workspace's base currency and time zone are set when it is created; there is no API to change them, on the web
 * either, so they stay read-only.
 */
import { BOOK_PALETTE, bookColors } from '@montra/domain';
import {
  providerNeedsKey,
  type AiMode,
  type AiSettingsDto,
  type FamilyMemberDto,
  type MemberRole,
  type UpdateAiSettingsRequest,
  type UpdateEntityRequest,
  type UpdateFamilyMemberRequest,
  type UpdateMeRequest,
  type UpdateNotificationPrefsRequest,
} from '@montra/schemas';
import type { EntityDetailDto } from '../api/client';
import { isAdminRole } from './roles';

export type { EntityDetailDto };

/** A result to send, or the i18n key of what's wrong. */
export type Built<T> = { ok: true; value: T } | { ok: false; error: string };

// ----- Who may change what ------------------------------------------------------------------------------------

export interface SettingsAbilities {
  /** Add, rename and archive family members: owners, admins and partners (the database's rule). */
  family: boolean;
  /** Add, rename, archive and colour books: owners and admins. */
  books: boolean;
  /** Where AI runs: owners and admins (the web's `ai.owner_only`). */
  ai: boolean;
}

export function settingsAbilities(role: MemberRole): SettingsAbilities {
  const admin = isAdminRole(role);
  return { family: admin || role === 'partner', books: admin, ai: admin };
}

// ----- Errors -------------------------------------------------------------------------------------------------

/** Problem codes with a plain-language message in the catalog, as the web's `friendlyMessage` has them. */
const CODE_KEYS: Record<string, string> = {
  forbidden: 'errors.forbidden',
  'mfa.required': 'errors.mfa_required',
  'mfa.setup_required': 'errors.mfa_setup_required',
  'reauth.required': 'errors.reauth_required',
  'version.conflict': 'errors.version_conflict',
};

/**
 * What to show when a save fails, as the web shows it: no connection, a known problem in plain words, else the
 * server's own message (it is written for people: "Rental books aren't included in this workspace's plan").
 */
export function errorText(err: unknown, t: (key: string) => string): string {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || typeof e.status !== 'number') return t('errors.generic');
  if (e.status === 0) return t('errors.network');
  const key = typeof e.code === 'string' ? CODE_KEYS[e.code] : undefined;
  if (key) return t(key);
  return typeof e.message === 'string' && e.message ? e.message : t('errors.generic');
}

// ----- Profile ------------------------------------------------------------------------------------------------

const NAME_MAX = 100;

/** The API's own check (`UpdateMeRequest`): a zone this device's Intl knows. */
export function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** This phone's own zone, to offer as a one-tap choice; null where Intl can't say. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * The profile change: only what differs, trimmed. The name may be blank, as on the web (it then shows the email).
 * Nothing changed is an empty change, and the screen keeps Save off for it.
 */
export function profileRequest(
  draft: { displayName: string; timeZone: string },
  me: { displayName: string; timeZone: string },
): Built<UpdateMeRequest> {
  const displayName = draft.displayName.trim();
  const timeZone = draft.timeZone.trim();
  if (displayName.length > NAME_MAX) return { ok: false, error: 'mobile.settings.name_too_long' };
  if (!isTimeZone(timeZone)) return { ok: false, error: 'mobile.settings.time_zone_invalid' };
  const value: UpdateMeRequest = {};
  if (displayName !== me.displayName) value.displayName = displayName;
  if (timeZone !== me.timeZone) value.timeZone = timeZone;
  return { ok: true, value };
}

// ----- Family -------------------------------------------------------------------------------------------------

export const RELATIONSHIPS = ['self', 'spouse_partner', 'child', 'parent', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export interface FamilyDraft {
  name: string;
  relationship: Relationship;
  isDependent: boolean;
}

/** A new person, as the web's add form sends it (default relationship: child). */
export function newFamilyMember(draft: FamilyDraft): Built<{
  name: string;
  relationship: Relationship;
  isDependent: boolean;
}> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: 'mobile.settings.name_required' };
  if (name.length > NAME_MAX) return { ok: false, error: 'mobile.settings.name_too_long' };
  return { ok: true, value: { name, relationship: draft.relationship, isDependent: draft.isDependent } };
}

/** Renaming or a new relationship: null while nothing changed (Save is off, as on the web). */
export function familyMemberPatch(
  member: Pick<FamilyMemberDto, 'name' | 'relationship'>,
  draft: { name: string; relationship: Relationship },
): Built<UpdateFamilyMemberRequest> | null {
  const name = draft.name.trim();
  if (name === member.name && draft.relationship === member.relationship) return null;
  if (!name) return { ok: false, error: 'mobile.settings.name_required' };
  if (name.length > NAME_MAX) return { ok: false, error: 'mobile.settings.name_too_long' };
  return { ok: true, value: { name, relationship: draft.relationship } };
}

/** Archive keeps the person's history; restore brings them back to the pickers. */
export function familyStatusChange(member: Pick<FamilyMemberDto, 'status'>): {
  patch: UpdateFamilyMemberRequest;
  label: string;
  done: string;
} {
  return member.status === 'active'
    ? { patch: { status: 'inactive' }, label: 'common.archive', done: 'common.archived_kept' }
    : { patch: { status: 'active' }, label: 'common.restore', done: 'common.restored' };
}

// ----- Books (entities) ---------------------------------------------------------------------------------------

export const NEW_BOOK_TYPES = ['business', 'rental'] as const;
export type NewBookType = (typeof NEW_BOOK_TYPES)[number];

const BOOK_NAME_MAX = 200;

export function newBooks(type: NewBookType, name: string): Built<{ type: NewBookType; name: string }> {
  const n = name.trim();
  if (!n) return { ok: false, error: 'mobile.settings.name_required' };
  if (n.length > BOOK_NAME_MAX) return { ok: false, error: 'mobile.settings.name_too_long' };
  return { ok: true, value: { type, name: n } };
}

/** Renaming: null while unchanged or blank (Rename is off, as on the web). Not the personal books. */
export function renameBooks(
  entity: Pick<EntityDetailDto, 'type' | 'name'>,
  name: string,
): UpdateEntityRequest | null {
  const n = name.trim();
  if (entity.type === 'personal' || !n || n === entity.name || n.length > BOOK_NAME_MAX) return null;
  return { name: n };
}

/** Archive or restore; the personal books can't be archived (the API changes only their colour). */
export function archiveBooks(entity: Pick<EntityDetailDto, 'type' | 'archived'>): {
  patch: UpdateEntityRequest;
  label: string;
  done: string;
} | null {
  if (entity.type === 'personal') return null;
  return entity.archived
    ? { patch: { archived: false }, label: 'common.unarchive', done: 'common.unarchived' }
    : { patch: { archived: true }, label: 'common.archive', done: 'common.archived_kept' };
}

export interface ColorChoice {
  /** What is saved: null for automatic. */
  value: string | null;
  /** What it looks like. */
  hex: string;
  /** The words for it: an i18n key, or the colour itself for one picked outside the palette. */
  labelKey: string | null;
  label: string | null;
}

/**
 * The calendar colours a book can take (FLOW-05), as the web offers them: automatic (what the palette gives it among
 * the open books, as the calendar does), the palette, and a colour picked outside the palette, kept selectable.
 */
export function colorChoices(entities: readonly EntityDetailDto[], entity: EntityDetailDto): ColorChoice[] {
  const open = entities.filter((e) => !e.archived);
  const pool = open.some((e) => e.id === entity.id)
    ? open.map((e) => (e.id === entity.id ? { ...e, color: null } : e))
    : [{ id: entity.id }];
  const auto = bookColors(pool).get(entity.id)!;
  const out: ColorChoice[] = [
    { value: null, hex: auto, labelKey: 'entities.color_auto', label: null },
    ...BOOK_PALETTE.map((p) => ({
      value: p.hex as string,
      hex: p.hex as string,
      labelKey: `calendar.color_${p.name}`,
      label: null,
    })),
  ];
  const current = entity.color?.toLowerCase() ?? null;
  if (current && !out.some((o) => o.value === current))
    out.push({ value: current, hex: current, labelKey: null, label: current });
  return out;
}

/** Which choice is on: the saved colour, lower-cased as the API stores it. */
export const colorChosen = (entity: Pick<EntityDetailDto, 'color'>): string | null =>
  entity.color?.toLowerCase() ?? null;

// ----- AI mode ------------------------------------------------------------------------------------------------

export const AI_MODES = ['builtin', 'byok', 'local', 'off'] as const satisfies readonly AiMode[];

export type AiModeSettings = Pick<AiSettingsDto, 'mode' | 'provider' | 'endpoint' | 'models' | 'hasKey'>;

/**
 * Why this mode can't be chosen on the phone: it needs something typed on the web first. The same checks, in the same
 * order, as the web makes before saving (`needsEndpoint`, Azure's URL, `deploymentMissing`, `keyMissing` with nothing
 * typed), and as the API makes. Null when it can be chosen.
 */
export function aiModeBlocked(mode: AiMode, s: AiModeSettings): string | null {
  if (mode === 'local' && !s.endpoint?.trim()) return 'ai.endpoint_required';
  if (mode !== 'byok') return null;
  if (s.provider === 'azure_openai') {
    if (!s.endpoint?.trim()) return 'ai.azure_endpoint_required';
    if (!(s.models.small || s.models.vision || s.models.large)?.trim()) return 'ai.deployment_required';
  }
  if (providerNeedsKey(s.provider) && !s.hasKey) return 'ai.key_required';
  return null;
}

/**
 * The change the web sends for a new mode: local mode always speaks to an OpenAI-compatible server; any other mode
 * keeps the saved provider, key, URL and models.
 */
export function aiModeRequest(mode: AiMode): UpdateAiSettingsRequest {
  return mode === 'local' ? { mode, provider: 'openai_compatible' } : { mode };
}

// ----- Quiet hours and the daily cap --------------------------------------------------------------------------

/** 22:00 to 07:00 when quiet hours are first switched on, as on the web. */
export const QUIET_DEFAULT = { start: 1320, end: 420 } as const;

export const minutesToTime = (m: number | null): string =>
  m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "22:00" or "7:30" (no time picker on the phone, so an hour without its leading zero is fine). */
export function timeToMinutes(text: string): number | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export interface TimingDraft {
  quiet: boolean;
  start: string;
  end: string;
  cap: string;
}

/** Quiet hours go together, both set or both off (the API refuses one alone); the cap is 0 to 50. */
export function timingRequest(
  draft: TimingDraft,
): Built<Pick<UpdateNotificationPrefsRequest, 'quietStart' | 'quietEnd' | 'dailyCap'>> {
  const quietStart = draft.quiet ? timeToMinutes(draft.start) : null;
  const quietEnd = draft.quiet ? timeToMinutes(draft.end) : null;
  if (draft.quiet && (quietStart === null || quietEnd === null))
    return { ok: false, error: 'notify.quiet_invalid' };
  const cap = draft.cap.trim();
  if (!/^\d{1,2}$/.test(cap) || Number(cap) > 50) return { ok: false, error: 'mobile.notify.cap_invalid' };
  return { ok: true, value: { quietStart, quietEnd, dailyCap: Number(cap) } };
}
