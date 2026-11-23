import type { RetentionItemDto, RetentionItemRef } from '@montra/api-client';

/** One key per item, for selection: a receipt and a file can share an id only in theory, so the kind is part of it. */
export const retentionKey = (i: Pick<RetentionItemDto, 'kind' | 'id'>) => `${i.kind}:${i.id}`;

/** What is still waiting for an owner; approved items only wait for the next run. */
export const waitingItems = (items: readonly RetentionItemDto[]) => items.filter((i) => !i.approvedAt);

/**
 * The exact items an action covers (RCP-10): the waiting ones listed now, or only the selected among them. Never an
 * item found after the page was shown, since the request names each one.
 */
export function retentionRefs(
  items: readonly RetentionItemDto[],
  selected?: ReadonlySet<string>,
): RetentionItemRef[] {
  return waitingItems(items)
    .filter((i) => !selected || selected.has(retentionKey(i)))
    .map((i) => ({ kind: i.kind, id: i.id }));
}
