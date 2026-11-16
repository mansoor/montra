import { describe, expect, it } from 'vitest';
import { BOOK_PALETTE, calendarDate } from '@montra/domain';
import type { CalendarItemDto, EntityDto } from '@montra/schemas';
import { calendarBooks, calendarTotals, toggleHidden, visibleItems } from './calendar';

const P = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const R = '00000000-0000-4000-8000-000000000003';

const entity = (id: string, name: string, color: string | null): EntityDto => ({
  id,
  type: 'personal',
  name,
  functionalCurrency: 'USD',
  lockedThrough: null,
  color,
  access: 'write',
});

const item = (entityId: string, amount: string, over: Partial<CalendarItemDto> = {}): CalendarItemDto => ({
  date: calendarDate('2026-11-20'),
  kind: BigInt(amount) >= 0n ? 'payday' : 'bill',
  name: 'Item',
  amount,
  currency: 'USD',
  variable: false,
  sourceId: '00000000-0000-4000-8000-0000000000aa',
  accountId: null,
  entityId,
  status: 'upcoming',
  priceChange: null,
  ...over,
});

describe('the calendar by book (FLOW-05)', () => {
  it('colours each book: a picked colour, else the palette’s', () => {
    const books = calendarBooks([
      entity(P, 'Personal', null),
      entity(B, 'Studio', '#AA0000'),
      entity(R, 'Flats', null),
    ]);
    expect(books.map((b) => b.name)).toEqual(['Personal', 'Studio', 'Flats']);
    expect(books[1]!.color).toBe('#aa0000');
    const palette = BOOK_PALETTE.map((p) => p.hex as string);
    expect(palette).toContain(books[0]!.color);
    expect(palette).toContain(books[2]!.color);
    expect(books[0]!.color).not.toBe(books[2]!.color);
  });

  it('hides the hidden books’ items and ignores ids that aren’t books', () => {
    const items = [item(P, '-1000'), item(B, '5000'), item(R, '-200')];
    expect(visibleItems(items, [])).toEqual(items);
    expect(visibleItems(items, [B, 'gone']).map((i) => i.entityId)).toEqual([P, R]);
  });

  it('totals only what is shown and still to come', () => {
    const items = [
      item(P, '-1000'),
      item(B, '5000'),
      item(R, '-200'),
      item(P, '-9999', { status: 'paid' }),
      item(P, '700', { status: 'overdue' }),
    ];
    expect(calendarTotals(items)).toEqual({ in: 5700n, out: 1200n });
    expect(calendarTotals(visibleItems(items, [B]))).toEqual({ in: 700n, out: 1200n });
  });

  it('ticks and unticks a book, keeping the books’ order', () => {
    const books = [{ id: P }, { id: B }, { id: R }];
    expect(toggleHidden(books, [], R, false)).toEqual([R]);
    expect(toggleHidden(books, [R], P, false)).toEqual([P, R]);
    expect(toggleHidden(books, [P, R], P, true)).toEqual([R]);
    // A hidden id that's no longer a book drops out.
    expect(toggleHidden(books, ['gone', R], B, false)).toEqual([B, R]);
  });
});
