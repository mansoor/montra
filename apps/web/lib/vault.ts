/**
 * The household's Family Document Vault in Settings → Storage (ADR-0054 §2, §6, §13): who sees the card, where
 * connecting has got to, its status in words, what each group does, and the badge on a file.
 */
import type {
  FileStorageStateDto,
  VaultConnectionDto,
  VaultExistingDto,
  VaultMoveDto,
  WorkspaceDto,
} from '@montra/api-client';
import {
  isSentMode,
  VAULT_GROUP_MODES_OFFERED,
  VAULT_RESTRICTED_GROUPS,
  vaultSuggestKind,
  type VaultGroup,
  type VaultGroupMode,
} from '@montra/schemas';

/** Owners and admins see the card, when the plan has the vault (D4, D11). Only an owner changes anything. */
export function canSeeVault(
  role: WorkspaceDto['role'] | null | undefined,
  features: readonly string[],
): boolean {
  return (role === 'owner' || role === 'admin') && features.includes('familyVault');
}

export const canManageVault = (role: WorkspaceDto['role'] | null | undefined): boolean => role === 'owner';

/**
 * Where connecting has got to (§2): nothing yet, the key waiting for its code, waiting for approval, or connected; or
 * disconnected with files kept only in the vault (§10), until it is connected again.
 */
export type VaultStep = 'start' | 'register' | 'approval' | 'connected' | 'disconnected';

export function vaultStep(d: VaultConnectionDto | null): VaultStep {
  if (!d) return 'start';
  return d.status === 'disconnected' ? 'disconnected' : d.stage;
}

/** One line on the connection, as an i18n key and its values. */
export function vaultStatusLine(d: VaultConnectionDto): { key: string; values?: Record<string, string> } {
  const name = d.householdName ?? '';
  if (d.status === 'disconnected') return { key: 'vault.status_disconnected' };
  if (d.stage === 'register') return { key: 'vault.status_register' };
  if (d.stage === 'approval') {
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

/** The chip's tone: good when connected and well, bad when something needs a person, muted otherwise. */
export function vaultTone(d: VaultConnectionDto): 'good' | 'bad' | 'muted' {
  if (d.status === 'disconnected') return 'bad';
  if (d.stage !== 'connected') return 'muted';
  if (d.status === 'active') return 'good';
  if (d.status === 'paused') return 'muted';
  return 'bad';
}

/** The vault's host, as shown: the address is always an https origin. */
export function vaultHost(address: string | null): string {
  if (!address) return '';
  try {
    return new URL(address).host;
  } catch {
    return '';
  }
}

/** Signatures are accepted only within a short window of the vault's clock (§7): warn well before that. */
export const CLOCK_WARNING_MS = 2 * 60_000;

export const clockIsOff = (offsetMs: number | null): boolean =>
  offsetMs !== null && Math.abs(offsetMs) > CLOCK_WARNING_MS;

/**
 * A pasted code, as the API takes it: people paste with line breaks or spaces from wherever they copied it, and a
 * code has none of its own.
 */
export function cleanPastedCode(text: string): string {
  return text.replace(/\s+/g, '');
}

/** One row of "Send these to the vault" (§6, §13), as the person looking at it may change it. */
export interface VaultGroupRow {
  group: VaultGroup;
  mode: VaultGroupMode;
  /** The vault kind it maps to; for a group not mapped yet, the obvious one, for the person to save. */
  vaultKind: string | null;
  mapped: boolean;
  /** Payslips and tax documents: only an owner sends them, after a warning (§6). */
  restricted: boolean;
  /** The modes this person may choose here. */
  modes: readonly VaultGroupMode[];
  editable: boolean;
}

/**
 * Each group as Settings shows it. An owner chooses any of the three modes; an admin may only set payslips or tax
 * documents back to not sent (D4).
 */
export function vaultGroupRows(
  d: VaultConnectionDto,
  role: WorkspaceDto['role'] | null | undefined,
): VaultGroupRow[] {
  const owner = role === 'owner';
  return d.groups.map((g) => {
    const restricted = VAULT_RESTRICTED_GROUPS.includes(g.group);
    const adminMayTurnOff = role === 'admin' && restricted && isSentMode(g.mode);
    const modes: readonly VaultGroupMode[] = owner
      ? VAULT_GROUP_MODES_OFFERED
      : adminMayTurnOff
        ? (['not_sent', g.mode] as VaultGroupMode[])
        : [g.mode];
    return {
      group: g.group,
      mode: g.mode,
      vaultKind: g.vaultKind ?? vaultSuggestKind(g.group, d.vaultKinds),
      mapped: g.vaultKind !== null,
      restricted,
      modes,
      editable: owner || adminMayTurnOff,
    };
  });
}

/**
 * What saving "Send these to the vault" changes: the groups whose mode or kind differs from what is saved (a suggested
 * kind counts as a change for a group that is sent), the restricted groups that start being sent, for the warning, and
 * the groups that start going without a local copy, for §5a's warning.
 */
export function vaultGroupChanges(
  d: VaultConnectionDto,
  draft: readonly { group: VaultGroup; mode: VaultGroupMode; vaultKind: string | null }[],
): {
  groups: { group: VaultGroup; mode?: VaultGroupMode; vaultKind?: string | null }[];
  warn: VaultGroup[];
  noCopy: VaultGroup[];
} {
  const groups: { group: VaultGroup; mode?: VaultGroupMode; vaultKind?: string | null }[] = [];
  const warn: VaultGroup[] = [];
  const noCopy: VaultGroup[] = [];
  for (const next of draft) {
    const saved = d.groups.find((g) => g.group === next.group);
    if (!saved) continue;
    const change: { group: VaultGroup; mode?: VaultGroupMode; vaultKind?: string | null } = {
      group: next.group,
    };
    if (next.mode !== saved.mode) change.mode = next.mode;
    const kind = isSentMode(next.mode) ? next.vaultKind : saved.vaultKind;
    if (kind !== saved.vaultKind) change.vaultKind = kind;
    if (change.mode !== undefined || change.vaultKind !== undefined) groups.push(change);
    if (VAULT_RESTRICTED_GROUPS.includes(next.group) && isSentMode(next.mode) && !isSentMode(saved.mode)) {
      warn.push(next.group);
    }
    if (next.mode === 'sent_no_copy' && saved.mode !== 'sent_no_copy') noCopy.push(next.group);
  }
  return { groups, warn, noCopy };
}

/**
 * §1, §13: a group sent with no local copy whose kinds the owner's own S3/WebDAV storage copies: Settings says that
 * storage still holds a copy (Montra never changes its setting on its own).
 */
export function vaultMirrorKeeps(
  d: Pick<VaultConnectionDto, 'mirrorGroups'>,
  group: VaultGroup,
  mode: VaultGroupMode,
): boolean {
  return mode === 'sent_no_copy' && d.mirrorGroups.includes(group);
}

/** §3: groups set to be sent but not mapped to one of the vault's kinds: they aren't sent, and Settings says so. */
export function vaultUnmapped(d: VaultConnectionDto): VaultGroup[] {
  return d.groups.filter((g) => isSentMode(g.mode) && !g.vaultKind).map((g) => g.group);
}

/** The counts Settings shows, in order, leaving out the ones at nought. */
export function vaultCounts(d: VaultConnectionDto): { key: string; n: number }[] {
  const i = d.items;
  return [
    { key: 'vault.count_sending', n: i.queued + i.pending },
    { key: 'vault.count_inbox', n: i.received },
    { key: 'vault.count_filed', n: i.filed },
    { key: 'vault.count_not_kept', n: i.notKept },
    { key: 'vault.count_failed', n: i.failed },
    { key: 'vault.count_out_of_reach', n: i.outOfReach },
    { key: 'vault.count_only_in_vault', n: d.files.onlyInVault },
    { key: 'vault.count_missing', n: d.files.missing },
  ].filter((c) => c.n > 0);
}

/**
 * §5 "Move these N files too?": what to ask right after a group is saved as "no local copy", or in "Move existing
 * documents". Null when there is nothing to move.
 */
export function vaultMoveQuestion(m: VaultMoveDto): { key: string; values: Record<string, string> } | null {
  if (m.count === 0) return null;
  return m.count === 1
    ? { key: 'vault.move_offer_one', values: { count: '1' } }
    : { key: 'vault.move_offer', values: { count: String(m.count) } };
}

/**
 * §10: what "Disconnect" asks. With no file kept only in the vault, a plain confirmation; with some, a choice between
 * bringing them back first and disconnecting anyway; while they are being brought back, nothing more.
 */
export function vaultDisconnectChoice(
  d: Pick<VaultConnectionDto, 'files' | 'bringingBack'>,
): 'confirm' | 'choose' | 'bringing_back' {
  // Files missing already count: the connection is how they would be read back from the same vault.
  if (d.bringingBack) return 'bringing_back';
  return d.files.onlyInVault > 0 ? 'choose' : 'confirm';
}

/** "Send existing documents" (§12): how many, and how long at the vault's daily limit. */
export function vaultEstimate(e: VaultExistingDto): { key: string; values?: Record<string, string> } {
  if (e.count === 0) return { key: 'vault.existing_none' };
  if (e.days === null) return { key: 'vault.existing_count', values: { count: String(e.count) } };
  return e.days <= 1
    ? { key: 'vault.existing_today', values: { count: String(e.count) } }
    : { key: 'vault.existing_days', values: { count: String(e.count), days: String(e.days) } };
}

/**
 * The small badge on a file (§13): where it is with the vault, or nothing for a file that isn't sent. The vault's
 * reason for not keeping a file is in words already, shown as the badge's title.
 */
export function vaultBadge(
  s: FileStorageStateDto | undefined,
): { key: string; tone: 'good' | 'muted' | 'bad'; title: string | null } | null {
  // §5a: the vault didn't give it back; Review asks for it again.
  if (s?.missing) return { key: 'vault.badge_missing', tone: 'bad', title: s.missing.reason };
  const v = s?.vault;
  if (!v) return null;
  switch (v.status) {
    case 'queued':
    case 'pending':
      return { key: 'vault.badge_sending', tone: 'muted', title: null };
    case 'received':
      return { key: 'vault.badge_inbox', tone: 'muted', title: null };
    case 'filed':
      return s?.location === 'vault'
        ? { key: 'vault.badge_only_in_vault', tone: 'good', title: vaultName(s) }
        : { key: 'vault.badge_filed', tone: 'good', title: vaultName(s) };
    case 'not_kept':
      return { key: 'vault.badge_not_kept', tone: 'muted', title: v.notKeptReason };
    case 'failed':
      return { key: 'vault.badge_failed', tone: 'bad', title: null };
    case 'out_of_reach':
      return { key: 'vault.badge_out_of_reach', tone: 'muted', title: null };
    default:
      return null;
  }
}

/**
 * §5: a page of a document whose file only the vault holds isn't shown from Montra (the API answers 409
 * `file.in_vault`): the viewer says so instead, with "Open it in the vault" when the vault has a document to open.
 * Null for a file Montra holds (or whose state isn't known), which is shown as always.
 */
export function vaultOnlyPage(
  states: readonly FileStorageStateDto[],
  workspaceId: string,
  fileId: string,
): { openHref: string | null; missing: boolean } | null {
  const s = states.find((x) => x.fileId === fileId);
  if (!s || s.location !== 'vault') return null;
  return {
    openHref: s.vault?.canOpen && !s.missing ? vaultOpenHref(workspaceId, fileId) : null,
    missing: s.missing !== null,
  };
}

/** §9: what the vault calls a document, as its changes feed last said: its title, else its kind. */
export function vaultName(s: FileStorageStateDto | undefined): string | null {
  return s?.vault?.title ?? s?.vault?.kind ?? null;
}

export type VaultOpenMode = 'view' | 'download';

/**
 * §9 "Open in the vault": where the browser goes when the person clicks. A route of the web app's own, which asks the
 * API for a single-use link and sends the browser straight on to it; the page never holds the link. A plain link, not
 * Next's `<Link>`, so nothing prefetches it.
 */
export function vaultOpenHref(workspaceId: string, fileId: string, mode: VaultOpenMode = 'view'): string {
  return `/w/${encodeURIComponent(workspaceId)}/vault/${encodeURIComponent(fileId)}/open?mode=${mode}`;
}

/** The page that says, in words, why a document didn't open. Only a code and a wait: never the link. */
export function vaultOpenProblemHref(
  workspaceId: string,
  fileId: string,
  problem: VaultOpenProblem,
  minutes: number | null,
): string {
  const q = new URLSearchParams({ problem });
  if (minutes !== null) q.set('minutes', String(minutes));
  return `/w/${encodeURIComponent(workspaceId)}/vault/${encodeURIComponent(fileId)}?${q.toString()}`;
}

export const VAULT_OPEN_PROBLEMS = [
  'in_vault',
  'out_of_reach',
  'links_full',
  'cannot_view',
  'cannot_open',
  'needs_vault',
  'disconnected',
  'not_filed',
  'not_found',
  'failed',
] as const;
export type VaultOpenProblem = (typeof VAULT_OPEN_PROBLEMS)[number];

const PROBLEM_KEYS: Record<VaultOpenProblem, string> = {
  in_vault: 'vault.open_in_vault_only',
  out_of_reach: 'vault.open_out_of_reach',
  links_full: 'vault.open_links_full',
  cannot_view: 'vault.open_cannot_view',
  cannot_open: 'vault.open_cannot_open',
  needs_vault: 'vault.open_needs_vault',
  disconnected: 'vault.open_disconnected',
  not_filed: 'vault.open_not_filed',
  not_found: 'vault.open_not_found',
  failed: 'vault.open_failed',
};

/** The words for a problem, by a code from the page's address (anything unknown is the general one). */
export function vaultOpenProblemKey(problem: string | null | undefined): string {
  return PROBLEM_KEYS[
    (VAULT_OPEN_PROBLEMS as readonly string[]).includes(problem ?? '')
      ? (problem as VaultOpenProblem)
      : 'failed'
  ];
}

/**
 * What the API's answer to "open" means for the browser (§9): a redirect on to the single-use link, or a problem with
 * the minutes to wait for the vault's hourly limit. Only an https link goes through; anything else is a problem.
 */
export function vaultOpenOutcome(answer: {
  status: number;
  location: string | null;
  retryAfter: string | null;
  code: string | null;
}): { go: string } | { problem: VaultOpenProblem; minutes: number | null } {
  if (answer.status === 303 && answer.location && /^https:\/\//.test(answer.location))
    return { go: answer.location };
  const code = (answer.code ?? '').replace(/^vault\./, '');
  const seconds = Number(answer.retryAfter);
  const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
  if (answer.status === 429 || code === 'links_full')
    return { problem: 'links_full', minutes: minutes ?? 60 };
  if (answer.status === 404 && code !== 'not_in_vault') return { problem: 'not_found', minutes: null };
  if (code === 'not_in_vault') return { problem: 'not_filed', minutes: null };
  if ((VAULT_OPEN_PROBLEMS as readonly string[]).includes(code))
    return { problem: code as VaultOpenProblem, minutes: null };
  if (answer.status === 410) return { problem: 'out_of_reach', minutes: null };
  return { problem: 'failed', minutes: null };
}

/**
 * Whether a request to open is a person's click and not a prefetch or another site's (§9: links are never prefetched).
 * Browsers mark prefetches (`Sec-Purpose`, `Purpose`, Next's router), and say where a navigation came from.
 */
export function isPersonOpening(headers: { get(name: string): string | null }): boolean {
  const purpose = `${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''}`.toLowerCase();
  if (purpose.includes('prefetch') || purpose.includes('prerender')) return false;
  if (headers.get('next-router-prefetch') || headers.get('rsc')) return false;
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const dest = headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  return true;
}

/**
 * §5 (PR 5a's 409 `file.in_vault`): a file only the vault holds isn't served as a preview; the person opens it in the
 * vault. For the API proxy: when a person's browser asked for a file at `…/files/<id>` and the answer was that code,
 * where to send them instead: the page that says so, with "Open it in the vault". Null for anything else.
 */
export function inVaultRedirect(path: readonly string[], status: number, code: string | null): string | null {
  if (status !== 409 || code !== 'file.in_vault') return null;
  if (path[0] !== 'v1' || path[1] !== 'workspaces') return null;
  const workspaceId = path[2] ?? '';
  const at = path.lastIndexOf('files');
  const fileId = at > 2 ? (path[at + 1] ?? '') : '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(workspaceId) || !uuid.test(fileId) || at !== path.length - 2) return null;
  return vaultOpenProblemHref(workspaceId, fileId, 'in_vault', null);
}

/** §9: "Kept in step with the vault" in Settings: when the changes feed was last read, or that it isn't read. */
export function vaultFeedLine(d: VaultConnectionDto): { key: string; at: string | null } {
  return d.feedReadAt
    ? { key: 'vault.feed_read', at: d.feedReadAt }
    : { key: 'vault.feed_not_read', at: null };
}
