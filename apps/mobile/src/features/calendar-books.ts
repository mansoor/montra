/**
 * The calendar by book (FLOW-05), as on the web: each book has a colour, and each person hides the books they don't
 * want to see. The server returns every book's items and keeps the person's choice; this file is the pure part the
 * agenda uses, so it works the same on the copy cached for offline use.
 */
import { bookColors } from '@montra/domain';
import type { CalendarItemDto, EntityDto } from '@montra/schemas';

export interface BookChip {
  id: string;
  name: string;
  color: string;
  shown: boolean;
}

/**
 * The workspace's books in order, each with its colour (picked, or the palette's by id) and whether it's shown.
 * A workspace saved by an older version has no colours: they count as unpicked.
 */
export function bookChips(
  entities: readonly (Pick<EntityDto, 'id' | 'name'> & { color?: string | null })[],
  hidden: readonly string[],
): BookChip[] {
  const colors = bookColors(entities);
  const h = new Set(hidden);
  return entities.map((e) => ({ id: e.id, name: e.name, color: colors.get(e.id)!, shown: !h.has(e.id) }));
}

/**
 * Items in the books that are shown. A hidden id that isn't a book any more changes nothing; an item cached before
 * items carried their book (no `entityId`) always shows.
 */
export function visibleCalendarItems<T extends { entityId?: CalendarItemDto['entityId'] }>(
  items: readonly T[],
  hidden: readonly string[],
): T[] {
  if (!hidden.length) return [...items];
  const h = new Set(hidden);
  return items.filter((i) => !i.entityId || !h.has(i.entityId));
}

/** What's still to come in the items shown, by currency: paid items are left out. */
export function calendarTotals(
  items: readonly Pick<CalendarItemDto, 'amount' | 'status' | 'currency'>[],
): { currency: string; in: bigint; out: bigint }[] {
  const by = new Map<string, { currency: string; in: bigint; out: bigint }>();
  for (const i of items) {
    if (i.status === 'paid') continue;
    const v = BigInt(i.amount);
    if (v === 0n) continue;
    const t = by.get(i.currency) ?? { currency: i.currency, in: 0n, out: 0n };
    if (v > 0n) t.in += v;
    else t.out -= v;
    by.set(i.currency, t);
  }
  return [...by.values()];
}

/** The hidden list after showing or hiding a book, in the books' order (ids that aren't books drop out). */
export function toggleBook(
  books: readonly { id: string }[],
  hidden: readonly string[],
  id: string,
): string[] {
  const h = new Set(hidden);
  if (h.has(id)) h.delete(id);
  else h.add(id);
  return books.map((b) => b.id).filter((b) => h.has(b));
}
