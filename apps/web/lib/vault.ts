/**
 * The household's Family Document Vault in Settings → Storage (ADR-0054 §2, §13): who sees the card, where connecting
 * has got to, and its status in words.
 */
import type { VaultConnectionDto, WorkspaceDto } from '@montra/api-client';

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
