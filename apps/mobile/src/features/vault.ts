/**
 * The household's Family Document Vault on the phone (ADR-0054 §9, §13; VLT-10, PR 6). Read only: connecting, pasting
 * a key and choosing what is sent need copying between apps, so they stay on the web. The phone shows:
 *
 * - the connection's status in Your data, beside the owner's own storage, as the web's Settings card says it;
 * - the badges on the files of receipts, payslips, tax forms and bills: where each is with the vault, what the vault
 *   calls it, a newer version, "No longer available", and a file kept only in the vault;
 * - "Open in the vault": the API makes a single-use link on the tap and answers it in the body (a React Native client
 *   can't read a redirect's target), and the phone hands it straight to the system browser. The link is never kept: not
 *   in state, a cache, the offline store or a log, and nothing here returns it;
 * - the possible-duplicate question on the phone's own receipt, payslip and bill uploads.
 *
 * Pure, so each is tested without a device. The server decides everything: who sees the connection, which files, and
 * whether a document may be opened.
 */
import type { FileStorageStateDto, MemberRole, VaultConnectionDto, VaultOpenLinkDto } from '@montra/schemas';

export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

export type VaultTone = 'good' | 'warn' | 'bad' | 'muted';

// ----- Status (Your data) --------------------------------------------------------------------------------------------

/** Owners and admins see the connection, as on the web (D4); the API refuses anyone else. */
export const showsVaultStatus = (role: MemberRole): boolean => role === 'owner' || role === 'admin';

/**
 * Where the connection is, in the five words the phone's card is built on (plus paused and not connected):
 * waiting for approval, connected, needing attention (a key that no longer works, the vault needing a person, or the
 * vault out of reach), the key expiring soon, or disconnected with files kept only in the vault (§10).
 */
export type VaultPhoneState =
  'not_connected' | 'waiting' | 'connected' | 'key_expiring' | 'needs_attention' | 'paused' | 'disconnected';

export function vaultPhoneState(d: VaultConnectionDto | null): VaultPhoneState {
  if (!d) return 'not_connected';
  if (d.status === 'disconnected') return 'disconnected';
  if (d.keyProblem) return 'needs_attention';
  if (d.stage !== 'connected') return 'waiting';
  if (d.status === 'needs_vault' || d.status === 'failing') return 'needs_attention';
  if (d.status === 'paused') return 'paused';
  if (d.key?.expiresSoon) return 'key_expiring';
  return 'connected';
}

/** The status line's words: the web's `vaultStatusLine`, so both say the same. */
export function vaultStatusWords(d: VaultConnectionDto): Message {
  const name = d.householdName ?? '';
  if (d.status === 'disconnected') return { key: 'vault.status_disconnected' };
  if (d.keyProblem) return { key: 'vault.status_needs_key' };
  if (d.stage !== 'connected') {
    return name
      ? { key: 'vault.status_approval', values: { name } }
      : { key: 'vault.status_approval_unnamed' };
  }
  if (d.status === 'paused') return { key: 'vault.status_paused' };
  if (d.status === 'needs_vault') return { key: 'vault.status_needs_vault' };
  if (d.status === 'failing') return { key: 'vault.status_failing' };
  if (d.bringingBack) return { key: 'vault.status_bringing_back' };
  return name
    ? { key: 'vault.status_connected', values: { name } }
    : { key: 'vault.status_connected_unnamed' };
}

const STATE_TONE: Record<VaultPhoneState, VaultTone> = {
  not_connected: 'muted',
  waiting: 'muted',
  connected: 'good',
  key_expiring: 'warn',
  needs_attention: 'bad',
  paused: 'muted',
  disconnected: 'bad',
};

/** The vault's host, as shown: the address is always an https origin. */
export function vaultHost(address: string | null): string {
  if (!address) return '';
  try {
    return new URL(address).host;
  } catch {
    return '';
  }
}

/** One line of the card: words by key, or the server's own words (`text`, with no key), with a tone. */
export interface VaultCardLine {
  key?: string;
  values?: Record<string, string | number>;
  text?: string;
  tone?: VaultTone;
  testID?: string;
}

export interface VaultCard {
  state: VaultPhoneState;
  tone: VaultTone;
  /** The heading after "Family Document Vault". */
  status: Message;
  lines: VaultCardLine[];
  /** Files to upload again: the card links to Review. */
  missing: number;
  /** Where changing anything happens: the web. */
  web: Message;
}

/**
 * The card in Your data (§13), with what the web's Settings card says, read only: where, whom Montra acts as, the key
 * (why it needs replacing, or when it expires), a hold for the vault's daily limit, the vault's own words when it
 * needs a person, the counts, files being brought back, and when the vault's changes were last read. Null when there is
 * nothing to show: not an owner or admin, or no connection and a plan without the vault.
 */
export function vaultCard(
  d: VaultConnectionDto | null,
  role: MemberRole,
  planHasVault: boolean,
): VaultCard | null {
  if (!showsVaultStatus(role)) return null;
  const owner = role === 'owner';
  const web: Message = { key: owner ? 'mobile.vault.change_on_web' : 'mobile.vault.owner_on_web' };
  if (!d) {
    if (!planHasVault) return null;
    return {
      state: 'not_connected',
      tone: 'muted',
      status: { key: 'mobile.vault.not_connected' },
      lines: [],
      missing: 0,
      web: { key: owner ? 'mobile.vault.connect_on_web' : 'mobile.vault.owner_on_web' },
    };
  }
  const state = vaultPhoneState(d);
  const lines: VaultCardLine[] = [];
  if (state === 'disconnected') {
    lines.push({
      key: 'vault.disconnected_note',
      values: { name: d.householdName ?? 'Family Document Vault', count: d.files.onlyInVault },
    });
    return {
      state,
      tone: STATE_TONE[state],
      status: vaultStatusWords(d),
      lines,
      missing: d.files.missing,
      web,
    };
  }
  const host = vaultHost(d.address);
  if (d.householdName || host) {
    lines.push({
      key: 'mobile.vault.where',
      values: { where: [d.householdName, host].filter(Boolean).join(' · ') },
    });
  }
  if (d.actsAs) {
    const name = d.actingAs ?? '';
    lines.push(
      d.actsAs === 'app'
        ? { key: 'mobile.vault.acts_as_itself', values: { name } }
        : name
          ? { key: 'mobile.vault.acts_as_person', values: { name } }
          : { key: 'mobile.vault.acts_as_person_unnamed' },
    );
  }
  if (d.keyProblem)
    lines.push({ key: `vault.key_problem.${d.keyProblem}`, tone: 'bad', testID: 'vault-key' });
  else if (d.key?.expiresAt) {
    const date = d.key.expiresAt.slice(0, 10);
    lines.push(
      d.key.expiresSoon
        ? { key: 'mobile.vault.key_expires_soon', values: { date }, tone: 'warn', testID: 'vault-key' }
        : { key: 'mobile.vault.key_expires', values: { date }, testID: 'vault-key' },
    );
  } else if (d.key) lines.push({ key: 'mobile.vault.key_never_expires', testID: 'vault-key' });
  if (d.stage !== 'connected') lines.push({ key: 'vault.approval_hint' });
  // The vault's own message when it needs a person, which is written for people (§12).
  if (d.lastError && !d.keyProblem && state !== 'connected')
    lines.push({ text: d.lastError, tone: 'bad', testID: 'vault-error' });
  if (d.heldUntil.sending)
    lines.push({ key: 'mobile.vault.held_sending', values: { date: d.heldUntil.sending.slice(0, 10) } });
  if (d.heldUntil.reading)
    lines.push({ key: 'mobile.vault.held_reading', values: { date: d.heldUntil.reading.slice(0, 10) } });
  if (d.bringingBack) lines.push({ key: 'vault.bringing_back_note' });
  for (const c of vaultCounts(d)) lines.push({ key: c.key, values: { n: c.n } });
  if (d.stage === 'connected')
    lines.push(
      d.feedReadAt
        ? { key: 'mobile.vault.feed_read', values: { date: d.feedReadAt.slice(0, 10) } }
        : { key: 'vault.feed_not_read' },
    );
  return {
    state,
    tone: STATE_TONE[state],
    status: vaultStatusWords(d),
    lines,
    missing: d.files.missing,
    web,
  };
}

/** The counts, in the web's order, leaving out the ones at nought. */
export function vaultCounts(d: Pick<VaultConnectionDto, 'items' | 'files'>): { key: string; n: number }[] {
  const i = d.items;
  return [
    { key: 'vault.count_sending', n: i.queued + i.pending },
    { key: 'vault.count_inbox', n: i.received },
    { key: 'vault.count_filed', n: i.filed },
    { key: 'vault.count_not_kept', n: i.notKept },
    { key: 'vault.count_failed', n: i.failed },
    { key: 'vault.count_out_of_reach', n: i.outOfReach },
    { key: 'vault.count_converted', n: i.converted },
    { key: 'vault.count_only_in_vault', n: d.files.onlyInVault },
    { key: 'vault.count_missing', n: d.files.missing },
  ].filter((c) => c.n > 0);
}

// ----- Badges on files -----------------------------------------------------------------------------------------------

export interface VaultBadge {
  key: string;
  tone: VaultTone;
  /** The vault's reason, or the missing file's, in words; shown under the badge. */
  detail: string | null;
}

/** One file's badge, as the web's: where it is with the vault, or nothing for a file that isn't sent. */
export function vaultBadge(s: FileStorageStateDto | undefined): VaultBadge | null {
  // §5a: the vault didn't give it back; Review asks for it again.
  if (s?.missing) return { key: 'vault.badge_missing', tone: 'bad', detail: s.missing.reason };
  const v = s?.vault;
  if (!v) return null;
  switch (v.status) {
    case 'queued':
    case 'pending':
      return { key: 'vault.badge_sending', tone: 'muted', detail: null };
    case 'received':
      return { key: 'vault.badge_inbox', tone: 'muted', detail: null };
    case 'filed':
      return s?.location === 'vault'
        ? { key: 'vault.badge_only_in_vault', tone: 'good', detail: null }
        : { key: 'vault.badge_filed', tone: 'good', detail: null };
    case 'not_kept':
      return { key: 'vault.badge_not_kept', tone: 'muted', detail: v.notKeptReason };
    case 'failed':
      return { key: 'vault.badge_failed', tone: 'bad', detail: null };
    case 'out_of_reach':
      return { key: 'vault.badge_out_of_reach', tone: 'muted', detail: null };
    case 'converted': {
      // ADR-0057: a statement the vault doesn't keep, sent as PDFs (the phone shows no statements' files yet).
      const c = v.converted;
      if (!c || c.state === 'rendering')
        return { key: 'vault.badge_converting', tone: 'muted', detail: null };
      if (c.state === 'not_converted')
        return { key: 'vault.badge_not_converted', tone: 'muted', detail: v.notKeptReason };
      if (c.state === 'import_undone')
        return { key: 'vault.badge_import_undone', tone: 'muted', detail: null };
      if (c.failed > 0) return { key: 'vault.badge_failed', tone: 'bad', detail: null };
      if (c.waiting > 0 || c.parts === 0)
        return { key: 'vault.badge_converted_sending', tone: 'muted', detail: null };
      return { key: 'vault.badge_converted_sent', tone: 'good', detail: null };
    }
    default:
      return null;
  }
}

/** §9: what the vault calls a document, as its changes feed last said: its title, else its kind. */
export function vaultName(s: FileStorageStateDto | undefined): string | null {
  return s?.vault?.title ?? s?.vault?.kind ?? null;
}

export interface VaultBadges {
  /** Each badge once, in the order the files came. */
  badges: VaultBadge[];
  /** "In the vault as: …" for the first filed file the vault has named. */
  name: Message | null;
  /** The family put a newer version into a filed document (the vault's 0.9.0-dev.63: Montra still reads it). */
  newer: boolean;
  /** The files "Open in the vault" is offered for, in order: filed, shown by the feed, not missing. */
  openable: string[];
}

/** What a record's files say together (§13), as the web's `VaultBadges`. Empty for files that aren't sent. */
export function vaultBadges(states: readonly FileStorageStateDto[], fileIds: readonly string[]): VaultBadges {
  const mine = fileIds
    .map((id) => states.find((s) => s.fileId === id))
    .filter((s): s is FileStorageStateDto => s !== undefined);
  const badges: VaultBadge[] = [];
  for (const s of mine) {
    const b = vaultBadge(s);
    if (b && !badges.some((x) => x.key === b.key && x.detail === b.detail)) badges.push(b);
  }
  const named = mine.find((s) => s.vault?.status === 'filed' && vaultName(s));
  return {
    badges,
    name: named ? { key: 'vault.in_vault_as', values: { name: vaultName(named)! } } : null,
    newer: mine.some((s) => s.vault?.status === 'filed' && s.vault.newerVersion),
    openable: mine.filter((s) => s.vault?.canOpen && !s.missing).map((s) => s.fileId),
  };
}

/**
 * §5 (PR 5a's 409 `file.in_vault`): a page whose file only the vault holds isn't shown from Montra, so the phone doesn't
 * ask for it; it says so, with "Open in the vault" when the vault has a document to open, or that it is missing. Null
 * for a file Montra holds (or whose state isn't known), which is shown as always.
 */
export function vaultOnlyPage(
  states: readonly FileStorageStateDto[],
  fileId: string,
): { canOpen: boolean; missing: string | null } | null {
  const s = states.find((x) => x.fileId === fileId);
  if (!s || s.location !== 'vault') return null;
  return {
    canOpen: Boolean(s.vault?.canOpen) && !s.missing,
    missing: s.missing ? s.missing.reason : null,
  };
}

/** The ids the badges are asked for: each once, at most the API's 100. */
export function badgeIds(fileIds: readonly string[]): string[] {
  return [...new Set(fileIds)].slice(0, 100);
}

// ----- Open in the vault ---------------------------------------------------------------------------------------------

export const VAULT_OPEN_PROBLEMS = [
  'out_of_reach',
  'links_full',
  'cannot_view',
  'cannot_open',
  'needs_vault',
  'disconnected',
  'not_filed',
  'not_found',
  'not_allowed',
  'offline',
  'failed',
] as const;
export type VaultOpenProblem = (typeof VAULT_OPEN_PROBLEMS)[number];

/** How a tap on "Open in the vault" ended. Never the link: it went to the browser and nowhere else. */
export type VaultOpenResult =
  | { opened: true; mode: 'view' | 'download' }
  | { opened: false; problem: VaultOpenProblem; minutes: number | null };

/** An API error, as the phone's client throws it. */
interface OpenError {
  status?: unknown;
  code?: unknown;
  retryAfterSeconds?: unknown;
}

/** What a refusal to open means, in the problems the phone has words for (§9). */
export function vaultOpenProblem(err: unknown): { problem: VaultOpenProblem; minutes: number | null } {
  const e = (err ?? {}) as OpenError;
  const status = typeof e.status === 'number' ? e.status : -1;
  const code = (typeof e.code === 'string' ? e.code : '').replace(/^vault\./, '');
  const seconds = typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : NaN;
  const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
  if (status === 429 || code === 'links_full') return { problem: 'links_full', minutes: minutes ?? 60 };
  if (status === 0) return { problem: 'offline', minutes: null };
  if (code === 'not_in_vault') return { problem: 'not_filed', minutes: null };
  if (status === 403) return { problem: 'not_allowed', minutes: null };
  if (status === 404) return { problem: 'not_found', minutes: null };
  if ((VAULT_OPEN_PROBLEMS as readonly string[]).includes(code))
    return { problem: code as VaultOpenProblem, minutes: null };
  if (status === 410) return { problem: 'out_of_reach', minutes: null };
  return { problem: 'failed', minutes: null };
}

/**
 * The tap (§9): ask the API for a link made now, and hand it straight to the system browser. Only an https link goes
 * on. Nothing here keeps it, and the result doesn't carry it.
 */
export async function openInVault(deps: {
  link: () => Promise<VaultOpenLinkDto>;
  openUrl: (url: string) => Promise<unknown>;
}): Promise<VaultOpenResult> {
  let mode: 'view' | 'download';
  try {
    const answer = await deps.link();
    if (typeof answer?.url !== 'string' || !/^https:\/\//.test(answer.url))
      return { opened: false, problem: 'failed', minutes: null };
    mode = answer.mode === 'download' ? 'download' : 'view';
    await deps.openUrl(answer.url);
  } catch (err) {
    // A refusal from the API, or a browser that couldn't take the link (the link isn't in either error's words).
    return { opened: false, ...vaultOpenProblem(err) };
  }
  return { opened: true, mode };
}

const PROBLEM_KEYS: Record<VaultOpenProblem, string> = {
  out_of_reach: 'vault.open_out_of_reach',
  links_full: 'vault.open_links_full',
  cannot_view: 'vault.open_cannot_view',
  cannot_open: 'vault.open_cannot_open',
  needs_vault: 'mobile.vault.open_needs_vault',
  disconnected: 'vault.open_disconnected',
  not_filed: 'vault.open_not_filed',
  not_found: 'vault.open_not_found',
  not_allowed: 'mobile.vault.open_not_allowed',
  offline: 'mobile.vault.open_offline',
  failed: 'vault.open_failed',
};

/**
 * What to say after a tap: nothing when the vault's pages opened, that it opens as a download when the vault can't
 * show that type as pages, or the problem in words (with the minutes to wait for the vault's hourly limit).
 */
export function vaultOpenMessage(r: VaultOpenResult): Message | null {
  if (r.opened) return r.mode === 'download' ? { key: 'mobile.vault.opened_download' } : null;
  const key = PROBLEM_KEYS[r.problem];
  return r.problem === 'links_full' ? { key, values: { minutes: r.minutes ?? 60 } } : { key };
}

// ----- A possible duplicate (the owner's clarification, 2026-11-18) ----------------------------------------------------

/**
 * Whether any of the phone's uploads for one receipt, payslip or bill is the bytes of a file Montra already holds
 * (`duplicateOf` on the upload's answer), so the person is asked before anything is made from them.
 */
export function anyDuplicate(uploads: readonly { duplicateOf?: unknown }[]): boolean {
  return uploads.some((u) => u.duplicateOf !== null && u.duplicateOf !== undefined);
}

/** The question, and what to say when the person says no: nothing is made, and the upload is left unused. */
export const DUPLICATE_QUESTION = {
  title: 'mobile.files.duplicate_title',
  body: 'files.duplicate_confirm',
  useAnyway: 'mobile.files.duplicate_use',
  cancelled: 'mobile.files.duplicate_cancelled',
} as const;
