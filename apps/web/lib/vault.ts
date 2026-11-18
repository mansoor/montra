/**
 * The household's Family Document Vault in Settings → Storage (ADR-0054 §2, §6, §13): who sees the card, where
 * connecting has got to, its status in words, what each group does, and the badge on a file.
 */
import type {
  FileStorageStateDto,
  VaultConnectionDto,
  VaultExistingDto,
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

/** Where connecting has got to (§2): nothing yet, the key waiting for its code, waiting for approval, or connected. */
export type VaultStep = 'start' | 'register' | 'approval' | 'connected';

export function vaultStep(d: VaultConnectionDto | null): VaultStep {
  return d ? d.stage : 'start';
}

/** One line on the connection, as an i18n key and its values. */
export function vaultStatusLine(d: VaultConnectionDto): { key: string; values?: Record<string, string> } {
  const name = d.householdName ?? '';
  if (d.stage === 'register') return { key: 'vault.status_register' };
  if (d.stage === 'approval') {
    return name
      ? { key: 'vault.status_approval', values: { name } }
      : { key: 'vault.status_approval_unnamed' };
  }
  if (d.status === 'paused') return { key: 'vault.status_paused' };
  if (d.status === 'needs_vault') return { key: 'vault.status_needs_vault' };
  if (d.status === 'failing') return { key: 'vault.status_failing' };
  return name
    ? { key: 'vault.status_connected', values: { name } }
    : { key: 'vault.status_connected_unnamed' };
}

/** The chip's tone: good when connected and well, bad when something needs a person, muted otherwise. */
export function vaultTone(d: VaultConnectionDto): 'good' | 'bad' | 'muted' {
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
 * Each group as Settings shows it. An owner chooses not sent or sent with a copy kept (sending with no local copy comes
 * with a later version); an admin may only set payslips or tax documents back to not sent (D4).
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
 * kind counts as a change for a group that is sent), and the restricted groups that start being sent, for the warning.
 */
export function vaultGroupChanges(
  d: VaultConnectionDto,
  draft: readonly { group: VaultGroup; mode: VaultGroupMode; vaultKind: string | null }[],
): {
  groups: { group: VaultGroup; mode?: VaultGroupMode; vaultKind?: string | null }[];
  warn: VaultGroup[];
} {
  const groups: { group: VaultGroup; mode?: VaultGroupMode; vaultKind?: string | null }[] = [];
  const warn: VaultGroup[] = [];
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
  }
  return { groups, warn };
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
  ].filter((c) => c.n > 0);
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
  const v = s?.vault;
  if (!v) return null;
  switch (v.status) {
    case 'queued':
    case 'pending':
      return { key: 'vault.badge_sending', tone: 'muted', title: null };
    case 'received':
      return { key: 'vault.badge_inbox', tone: 'muted', title: null };
    case 'filed':
      return { key: 'vault.badge_filed', tone: 'good', title: v.title };
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
