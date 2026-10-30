/** Polling side of real-time sync (PLT-06): which change-feed rows warrant re-rendering the page. */
import type { ChangeDto } from '@montra/api-client';

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
]);

export function needsRefresh(changes: ChangeDto[]): boolean {
  return changes.some((c) => VISIBLE_TABLES.has(c.table));
}

/** Larger of two decimal sequence strings (bigint-safe). */
export function maxSeq(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}
