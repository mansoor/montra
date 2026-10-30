/** Bulk edit (TXN-10, UP-08): turns a toolbar action into the API's `set` object and summarizes results. */
import type { BulkEditInput, BulkEditResult } from '@montra/api-client';
import { parseTags } from './transaction-edit';
import { staticT } from './i18n-static';

type T = (key: string, values?: Record<string, string | number>) => string;

export type BulkAction =
  | { kind: 'category'; categoryId: string }
  | { kind: 'entity'; entityId: string }
  | { kind: 'member'; memberId: string | null }
  | { kind: 'addTags'; tags: string }
  | { kind: 'removeTags'; tags: string }
  | { kind: 'reviewed' };

export function toBulkSet(action: BulkAction, t: T = staticT): BulkEditInput['set'] | { error: string } {
  switch (action.kind) {
    case 'category':
      return action.categoryId ? { categoryId: action.categoryId } : { error: t('bulk.choose_category') };
    case 'entity':
      return action.entityId ? { entityId: action.entityId } : { error: t('bulk.choose_books') };
    case 'member':
      return { memberId: action.memberId };
    case 'addTags':
    case 'removeTags': {
      const tags = parseTags(action.tags);
      if (!tags.length) return { error: t('bulk.enter_tag') };
      return action.kind === 'addTags' ? { addTags: tags } : { removeTags: tags };
    }
    case 'reviewed':
      return { reviewState: 'reviewed' };
  }
}

const REASONS: Record<string, string> = {
  'transaction.reconciled': 'bulk.reason.reconciled',
  'period.locked': 'bulk.reason.locked',
  'transaction.is_transfer': 'bulk.reason.transfer',
  'transaction.void': 'bulk.reason.deleted',
};

/** One-line, plain-language result, e.g. "Updated 3. Skipped 1 (reconciled)." */
export function summarizeBulk(result: BulkEditResult, t: T = staticT): string {
  const parts = [t('bulk.updated', { count: result.updated.length })];
  if (result.skipped.length) {
    const reasons = [
      ...new Set(result.skipped.map((s) => (REASONS[s.reason] ? t(REASONS[s.reason]!) : s.reason))),
    ];
    parts.push(t('bulk.skipped', { count: result.skipped.length, reasons: reasons.join(', ') }));
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
