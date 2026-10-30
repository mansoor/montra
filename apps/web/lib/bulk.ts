/** Bulk edit (TXN-10, UP-08): turns a toolbar action into the API's `set` object and summarizes results. */
import type { BulkEditInput, BulkEditResult } from '@montra/api-client';
import { parseTags } from './transaction-edit';

export type BulkAction =
  | { kind: 'category'; categoryId: string }
  | { kind: 'entity'; entityId: string }
  | { kind: 'member'; memberId: string | null }
  | { kind: 'addTags'; tags: string }
  | { kind: 'removeTags'; tags: string }
  | { kind: 'reviewed' };

export function toBulkSet(action: BulkAction): BulkEditInput['set'] | { error: string } {
  switch (action.kind) {
    case 'category':
      return action.categoryId ? { categoryId: action.categoryId } : { error: 'Choose a category' };
    case 'entity':
      return action.entityId ? { entityId: action.entityId } : { error: 'Choose where to move them' };
    case 'member':
      return { memberId: action.memberId };
    case 'addTags':
    case 'removeTags': {
      const tags = parseTags(action.tags);
      if (!tags.length) return { error: 'Enter at least one tag' };
      return action.kind === 'addTags' ? { addTags: tags } : { removeTags: tags };
    }
    case 'reviewed':
      return { reviewState: 'reviewed' };
  }
}

const REASONS: Record<string, string> = {
  'transaction.reconciled': 'reconciled',
  'period.locked': 'in a closed period',
  'transaction.is_transfer': 'a transfer',
  'transaction.void': 'deleted',
};

/** One-line, plain-language result, e.g. "Updated 3. Skipped 1 (reconciled)." */
export function summarizeBulk(result: BulkEditResult): string {
  const parts = [`Updated ${result.updated.length}.`];
  if (result.skipped.length) {
    const reasons = [...new Set(result.skipped.map((s) => REASONS[s.reason] ?? s.reason))];
    parts.push(`Skipped ${result.skipped.length} (${reasons.join(', ')}).`);
  }
  return parts.join(' ');
}

/** Toggles one id in a selection; `all` selects or clears everything visible. */
export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string | 'all',
  visible: string[],
): Set<string> {
  if (id === 'all') return selected.size === visible.length ? new Set() : new Set(visible);
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
