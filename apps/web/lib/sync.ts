/** Client side of real-time sync (PLT-06, ADR-0008): message parsing, refresh decisions and backoff. */
import type { ChangeDto } from '@montra/api-client';

/** Fallback poll interval while the WebSocket is down. */
export const POLL_INTERVAL_MS = 15_000;

/** Tables whose changes are visible somewhere in the web app. */
const VISIBLE_TABLES = new Set([
  'transaction',
  'journal_entry',
  'posting',
  'transaction_tag',
  'ledger_account',
  'bank_account',
  'entity',
  'entity_grant',
  'family_member',
  'workspace',
  'workspace_member',
  'recurring_item',
  'period_lock',
  'tag',
  'payee',
  'import_batch',
  'reconciliation',
]);

/** Window event carrying each pulled batch of changes, for client components that hold their own state. */
export const CHANGES_EVENT = 'montra:changes';

export function announceChanges(changes: ChangeDto[]): void {
  window.dispatchEvent(new CustomEvent<ChangeDto[]>(CHANGES_EVENT, { detail: changes }));
}

/** Subscribes to pulled changes; returns the unsubscribe function. */
export function onChanges(listener: (changes: ChangeDto[]) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<ChangeDto[]>).detail);
  window.addEventListener(CHANGES_EVENT, handler);
  return () => window.removeEventListener(CHANGES_EVENT, handler);
}

export function needsRefresh(changes: ChangeDto[]): boolean {
  return changes.some((c) => VISIBLE_TABLES.has(c.table));
}

/** Larger of two decimal sequence strings (bigint-safe). */
export function maxSeq(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

export type ServerMessage =
  | { type: 'subscribed'; workspaceId: string }
  | { type: 'changes'; workspaceId: string }
  | { type: 'error'; code: string };

/** Parses a WebSocket frame from /v1/ws; anything unexpected is ignored. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string' || data.length > 4096) return null;
  try {
    const m = JSON.parse(data) as Record<string, unknown>;
    if ((m.type === 'subscribed' || m.type === 'changes') && typeof m.workspaceId === 'string') {
      return { type: m.type, workspaceId: m.workspaceId };
    }
    if (m.type === 'error' && typeof m.code === 'string') return { type: 'error', code: m.code };
  } catch {
    // not JSON
  }
  return null;
}

/** Reconnect delay: 1 s, 2 s, 4 s … capped at 30 s, with up to 20% jitter. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.floor(base * (0.8 + 0.2 * random()));
}

/** Errors after which reconnecting won't help until the user signs in again. */
export const isFatalSocketError = (code: string) => code === 'unauthenticated' || code === 'forbidden';
