/**
 * The calendar by book (FLOW-05), as Google Calendar's calendars: each book has a colour, and each person hides the
 * books they don't want to see. The server returns every book's items; the page filters them.
 */
import { bookColors } from '@montra/domain';
import type { CalendarItemDto, EntityDto } from '@montra/schemas';

export interface CalendarBook {
  id: string;
  name: string;
  color: string;
}

/** The workspace's books in order, each with its colour (picked, or the palette's by id). */
export function calendarBooks(entities: readonly Pick<EntityDto, 'id' | 'name' | 'color'>[]): CalendarBook[] {
  const colors = bookColors(entities);
  return entities.map((e) => ({ id: e.id, name: e.name, color: colors.get(e.id)! }));
}

/** Items in the books that are shown. A hidden id that isn't a book any more changes nothing. */
export function visibleItems<T extends Pick<CalendarItemDto, 'entityId'>>(
  items: readonly T[],
  hidden: readonly string[],
): T[] {
  if (!hidden.length) return [...items];
  const h = new Set(hidden);
  return items.filter((i) => !h.has(i.entityId));
}

/** "Coming in" and "going out" for what's still to come: paid items are left out. */
export function calendarTotals(items: readonly Pick<CalendarItemDto, 'amount' | 'status'>[]): {
  in: bigint;
  out: bigint;
} {
  const totals = { in: 0n, out: 0n };
  for (const i of items) {
    if (i.status === 'paid') continue;
    const v = BigInt(i.amount);
    if (v >= 0n) totals.in += v;
    else totals.out -= v;
  }
  return totals;
}

/** The hidden list after ticking or unticking a book, in the books' order. */
export function toggleHidden(
  books: readonly { id: string }[],
  hidden: readonly string[],
  id: string,
  shown: boolean,
): string[] {
  const h = new Set(hidden);
  if (shown) h.delete(id);
  else h.add(id);
  return books.map((b) => b.id).filter((b) => h.has(b));
}
