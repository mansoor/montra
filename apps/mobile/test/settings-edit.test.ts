import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOK_PALETTE } from '@montra/domain';
import { catalogs, createTranslator } from '@montra/i18n';
import { UpdateNotificationPrefsRequest } from '@montra/schemas';
import { ApiError, createApi, type EntityDetailDto } from '../src/api/client';
import {
  AI_MODES,
  RELATIONSHIPS,
  aiModeBlocked,
  aiModeRequest,
  archiveBooks,
  colorChoices,
  colorChosen,
  errorText,
  familyMemberPatch,
  familyStatusChange,
  isTimeZone,
  minutesToTime,
  newBooks,
  newFamilyMember,
  profileRequest,
  renameBooks,
  settingsAbilities,
  timeToMinutes,
  timingRequest,
  type AiModeSettings,
} from '../src/features/settings-edit';

const en = catalogs.en!;
const t = createTranslator('en-US', catalogs).t;

describe('who changes what (OPS-13, as the web and the API allow)', () => {
  it('lets owners and admins change everything, partners the family, and no one else anything', () => {
    expect(settingsAbilities('owner')).toEqual({ family: true, books: true, ai: true });
    expect(settingsAbilities('admin')).toEqual({ family: true, books: true, ai: true });
    expect(settingsAbilities('partner')).toEqual({ family: true, books: false, ai: false });
    for (const role of ['member', 'viewer', 'accountant'] as const)
      expect(settingsAbilities(role)).toEqual({ family: false, books: false, ai: false });
  });
});

describe('errors, shown as the web shows them', () => {
  it('names no connection, known problems in plain words, and otherwise the server’s message', () => {
    expect(errorText(new ApiError(0, 'network', 'Network request failed'), t)).toBe(en['errors.network']);
    expect(errorText(new ApiError(403, 'forbidden', 'Forbidden'), t)).toBe(en['errors.forbidden']);
    expect(
      errorText(
        new ApiError(402, 'plan.required', "Rental books aren't included in this workspace's plan"),
        t,
      ),
    ).toBe("Rental books aren't included in this workspace's plan");
    expect(errorText(new ApiError(422, 'ai.key_required', ''), t)).toBe(en['errors.generic']);
    expect(errorText(new Error('boom'), t)).toBe(en['errors.generic']);
    expect(errorText(null, t)).toBe(en['errors.generic']);
  });
});

describe('profile', () => {
  const me = { displayName: 'Sam', timeZone: 'America/New_York' };

  it('knows a time zone the way the API checks it', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });

  it('sends only what changed, trimmed', () => {
    expect(profileRequest({ displayName: ' Sam ', timeZone: 'America/New_York' }, me)).toEqual({
      ok: true,
      value: {},
    });
    expect(profileRequest({ displayName: 'Samira', timeZone: ' Europe/London ' }, me)).toEqual({
      ok: true,
      value: { displayName: 'Samira', timeZone: 'Europe/London' },
    });
    // A blank name is allowed, as on the web.
    expect(profileRequest({ displayName: '  ', timeZone: 'America/New_York' }, me)).toEqual({
      ok: true,
      value: { displayName: '' },
    });
  });

  it('refuses an unknown zone and a name over 100 characters', () => {
    expect(profileRequest({ displayName: 'Sam', timeZone: 'Nowhere/Here' }, me)).toEqual({
      ok: false,
      error: 'mobile.settings.time_zone_invalid',
    });
    expect(profileRequest({ displayName: 'x'.repeat(101), timeZone: 'UTC' }, me)).toEqual({
      ok: false,
      error: 'mobile.settings.name_too_long',
    });
  });
});

describe('family members', () => {
  it('adds a person as the web does', () => {
    expect(newFamilyMember({ name: ' Ava ', relationship: 'child', isDependent: true })).toEqual({
      ok: true,
      value: { name: 'Ava', relationship: 'child', isDependent: true },
    });
    expect(newFamilyMember({ name: ' ', relationship: 'child', isDependent: false })).toEqual({
      ok: false,
      error: 'mobile.settings.name_required',
    });
    expect(newFamilyMember({ name: 'x'.repeat(101), relationship: 'other', isDependent: false }).ok).toBe(
      false,
    );
    expect(RELATIONSHIPS).toEqual(['self', 'spouse_partner', 'child', 'parent', 'other']);
  });

  it('saves a rename or a new relationship, and nothing while unchanged', () => {
    const m = { name: 'Ava', relationship: 'child' as const };
    expect(familyMemberPatch(m, { name: ' Ava ', relationship: 'child' })).toBeNull();
    expect(familyMemberPatch(m, { name: 'Ava Lee', relationship: 'child' })).toEqual({
      ok: true,
      value: { name: 'Ava Lee', relationship: 'child' },
    });
    expect(familyMemberPatch(m, { name: 'Ava', relationship: 'other' })).toEqual({
      ok: true,
      value: { name: 'Ava', relationship: 'other' },
    });
    expect(familyMemberPatch(m, { name: '', relationship: 'child' })).toEqual({
      ok: false,
      error: 'mobile.settings.name_required',
    });
  });

  it('archives and restores, keeping history', () => {
    expect(familyStatusChange({ status: 'active' })).toEqual({
      patch: { status: 'inactive' },
      label: 'common.archive',
      done: 'common.archived_kept',
    });
    expect(familyStatusChange({ status: 'inactive' })).toEqual({
      patch: { status: 'active' },
      label: 'common.restore',
      done: 'common.restored',
    });
  });
});

const book = (over: Partial<EntityDetailDto> = {}): EntityDetailDto => ({
  id: 'b1',
  type: 'business',
  name: 'Studio',
  functionalCurrency: 'USD',
  businessType: null,
  fiscalYearStartMonth: 1,
  archived: false,
  lockedThrough: null,
  color: null,
  ...over,
});

describe('books', () => {
  it('adds business or rental books with a name', () => {
    expect(newBooks('rental', ' Elm St ')).toEqual({ ok: true, value: { type: 'rental', name: 'Elm St' } });
    expect(newBooks('business', '')).toEqual({ ok: false, error: 'mobile.settings.name_required' });
    expect(newBooks('business', 'x'.repeat(201))).toEqual({
      ok: false,
      error: 'mobile.settings.name_too_long',
    });
  });

  it('renames only a changed, non-blank name, and never the personal books (the API takes only their colour)', () => {
    expect(renameBooks(book(), 'Studio')).toBeNull();
    expect(renameBooks(book(), '  ')).toBeNull();
    expect(renameBooks(book(), ' Studio Two ')).toEqual({ name: 'Studio Two' });
    expect(renameBooks(book({ type: 'personal', name: 'Personal' }), 'Mine')).toBeNull();
  });

  it('archives and restores, but not the personal books', () => {
    expect(archiveBooks(book())).toEqual({
      patch: { archived: true },
      label: 'common.archive',
      done: 'common.archived_kept',
    });
    expect(archiveBooks(book({ archived: true }))).toEqual({
      patch: { archived: false },
      label: 'common.unarchive',
      done: 'common.unarchived',
    });
    expect(archiveBooks(book({ type: 'personal' }))).toBeNull();
  });

  it('offers automatic, the palette, and a colour picked elsewhere', () => {
    const personal = book({ id: 'p', type: 'personal', name: 'Personal' });
    const studio = book({ id: 's', color: '#ABCDEF' });
    const all = [personal, studio];
    const choices = colorChoices(all, studio);
    expect(choices[0]).toMatchObject({ value: null, labelKey: 'entities.color_auto' });
    expect(choices.slice(1, 1 + BOOK_PALETTE.length).map((c) => c.value)).toEqual(
      BOOK_PALETTE.map((p) => p.hex),
    );
    expect(choices.at(-1)).toEqual({ value: '#abcdef', hex: '#abcdef', labelKey: null, label: '#abcdef' });
    expect(colorChosen(studio)).toBe('#abcdef');
    // A palette colour isn't offered twice.
    const blue = book({ id: 's', color: BOOK_PALETTE[0].hex });
    expect(colorChoices([personal, blue], blue)).toHaveLength(1 + BOOK_PALETTE.length);
    // Automatic is what the calendar would give it unpicked; archived books don't take a palette slot.
    const auto = colorChoices([personal, studio], studio)[0]!.hex;
    expect(colorChoices([personal, book({ id: 'x', archived: true }), studio], studio)[0]!.hex).toBe(auto);
    for (const c of choices) if (c.labelKey) expect(en[c.labelKey], c.labelKey).toBeTruthy();
  });
});

describe('AI mode', () => {
  const s = (over: Partial<AiModeSettings> = {}): AiModeSettings => ({
    mode: 'builtin',
    provider: 'anthropic',
    endpoint: null,
    models: { small: null, vision: null, large: null },
    hasKey: false,
    ...over,
  });

  it('offers built-in and off always', () => {
    expect(aiModeBlocked('builtin', s())).toBeNull();
    expect(aiModeBlocked('off', s())).toBeNull();
  });

  it('offers local mode once a model server’s URL is saved', () => {
    expect(aiModeBlocked('local', s())).toBe('ai.endpoint_required');
    expect(aiModeBlocked('local', s({ endpoint: 'http://localhost:11434/v1' }))).toBeNull();
  });

  it('offers your own key once the key is saved, as the web checks before saving', () => {
    expect(aiModeBlocked('byok', s())).toBe('ai.key_required');
    expect(aiModeBlocked('byok', s({ hasKey: true }))).toBeNull();
    // An OpenAI-compatible server may not need a key.
    expect(aiModeBlocked('byok', s({ provider: 'openai_compatible' }))).toBeNull();
    // Azure OpenAI needs its resource URL and a deployment first.
    expect(aiModeBlocked('byok', s({ provider: 'azure_openai', hasKey: true }))).toBe(
      'ai.azure_endpoint_required',
    );
    expect(
      aiModeBlocked(
        'byok',
        s({ provider: 'azure_openai', hasKey: true, endpoint: 'https://r.openai.azure.com' }),
      ),
    ).toBe('ai.deployment_required');
    expect(
      aiModeBlocked(
        'byok',
        s({
          provider: 'azure_openai',
          hasKey: true,
          endpoint: 'https://r.openai.azure.com',
          models: { small: 'gpt-mini', vision: null, large: null },
        }),
      ),
    ).toBeNull();
  });

  it('sends the mode, with the OpenAI-compatible provider for local mode as the web does', () => {
    expect(aiModeRequest('local')).toEqual({ mode: 'local', provider: 'openai_compatible' });
    expect(aiModeRequest('byok')).toEqual({ mode: 'byok' });
    expect(aiModeRequest('off')).toEqual({ mode: 'off' });
    for (const m of AI_MODES) {
      expect(en[`ai.mode.${m}`]).toBeTruthy();
      expect(en[`ai.mode_hint.${m}`]).toBeTruthy();
    }
  });
});

describe('quiet hours and the daily cap', () => {
  it('reads and writes times', () => {
    expect(minutesToTime(1320)).toBe('22:00');
    expect(minutesToTime(425)).toBe('07:05');
    expect(minutesToTime(null)).toBe('');
    expect(timeToMinutes('22:00')).toBe(1320);
    expect(timeToMinutes('7:30')).toBe(450);
    expect(timeToMinutes(' 07.30 ')).toBe(450);
    expect(timeToMinutes('24:00')).toBeNull();
    expect(timeToMinutes('12:60')).toBeNull();
    expect(timeToMinutes('noon')).toBeNull();
  });

  it('sends both ends of quiet hours, or both off, with the cap, and the API accepts it', () => {
    const on = timingRequest({ quiet: true, start: '22:00', end: '7:00', cap: '5' });
    expect(on).toEqual({ ok: true, value: { quietStart: 1320, quietEnd: 420, dailyCap: 5 } });
    const off = timingRequest({ quiet: false, start: 'x', end: '', cap: '0' });
    expect(off).toEqual({ ok: true, value: { quietStart: null, quietEnd: null, dailyCap: 0 } });
    for (const r of [on, off])
      if (r.ok) expect(UpdateNotificationPrefsRequest.safeParse(r.value).success).toBe(true);
  });

  it('refuses a missing time or a cap past 50', () => {
    expect(timingRequest({ quiet: true, start: '22:00', end: '', cap: '5' })).toEqual({
      ok: false,
      error: 'notify.quiet_invalid',
    });
    for (const cap of ['51', '-1', '', '2.5'])
      expect(timingRequest({ quiet: false, start: '', end: '', cap })).toEqual({
        ok: false,
        error: 'mobile.notify.cap_invalid',
      });
  });
});

describe('the API calls, as the web makes them', () => {
  it('sends each change to the web’s endpoint', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const api = createApi({
      baseUrl: 'http://api',
      token: async () => 'dev:a@b.co',
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await api.updateMe({ timeZone: 'Europe/London' });
    await api.createFamilyMember('w1', { name: 'Ava', relationship: 'child', isDependent: false });
    await api.updateFamilyMember('w1', 'm1', { status: 'inactive' });
    await api.entities('w1');
    await api.createEntity('w1', { type: 'rental', name: 'Elm St' });
    await api.updateEntity('w1', 'e1', { color: null });
    await api.updateAiSettings('w1', { mode: 'off' });
    await api.updateNotificationPrefs({ quietStart: null, quietEnd: null, dailyCap: 3 });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://api', '')}`)).toEqual([
      'PATCH /v1/me',
      'POST /v1/workspaces/w1/family-members',
      'PATCH /v1/workspaces/w1/family-members/m1',
      'GET /v1/workspaces/w1/entities',
      'POST /v1/workspaces/w1/entities',
      'PATCH /v1/workspaces/w1/entities/e1',
      'PATCH /v1/workspaces/w1/ai/settings',
      'PATCH /v1/me/notification-prefs',
    ]);
    expect(calls[5]!.body).toEqual({ color: null });
  });
});

describe('the words the settings screens use', () => {
  it('are all in the catalog', () => {
    const root = join(__dirname, '..');
    const screens = [
      'app/settings.tsx',
      'app/profile.tsx',
      'app/family.tsx',
      'app/books.tsx',
      'app/ai-settings.tsx',
      'app/notification-settings.tsx',
      'app/_layout.tsx',
      'src/features/settings-edit.ts',
    ];
    const text = screens.map((p) => readFileSync(join(root, p), 'utf8')).join('\n');
    const literal = [...text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)].map((m) => m[1]!);
    // Keys the feature module returns, and the dynamic ones the screens build.
    const returned = [...text.matchAll(/'((?:mobile|common|notify|ai|entities|errors)\.[a-z0-9_.]+)'/g)].map(
      (m) => m[1]!,
    );
    const dynamic = [
      ...RELATIONSHIPS.map((r) => `members.relationship.${r}`),
      ...(['business', 'rental', 'personal'] as const).map((e) => `entity.type.${e}`),
      ...AI_MODES.flatMap((m) => [`ai.mode.${m}`, `ai.mode_hint.${m}`]),
      ...BOOK_PALETTE.map((p) => `calendar.color_${p.name}`),
    ];
    expect(literal.length).toBeGreaterThan(40);
    expect([...new Set([...literal, ...returned, ...dynamic])].filter((k) => !(k in en))).toEqual([]);
  });
});
