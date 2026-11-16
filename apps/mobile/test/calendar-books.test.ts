import { describe, expect, it } from 'vitest';
import { BOOK_PALETTE } from '@montra/domain';
import { catalogs } from '@montra/i18n';
import { CALENDAR_ITEM_KINDS, type CalendarItemDto } from '@montra/schemas';
import { bookChips, calendarTotals, toggleBook, visibleCalendarItems } from '../src/features/calendar-books';

const P = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const R = '00000000-0000-4000-8000-000000000003';

type Item = Pick<CalendarItemDto, 'amount' | 'status' | 'currency'> & { entityId?: string };
const item = (entityId: string | undefined, amount: string, over: Partial<Item> = {}): Item => ({
  entityId,
  amount,
  currency: 'USD',
  status: 'upcoming',
  ...over,
});

describe('the agenda by book (FLOW-05)', () => {
  it('colours each book: a picked colour, else the palette’s, also for a workspace cached without colours', () => {
    const chips = bookChips(
      [
        { id: P, name: 'Personal' },
        { id: B, name: 'Studio', color: '#AA0000' },
        { id: R, name: 'Flats', color: null },
      ],
      [R],
    );
    expect(chips.map((c) => [c.name, c.shown])).toEqual([
      ['Personal', true],
      ['Studio', true],
      ['Flats', false],
    ]);
    expect(chips[1]!.color).toBe('#aa0000');
    const palette = BOOK_PALETTE.map((p) => p.hex as string);
    expect(palette).toContain(chips[0]!.color);
    expect(palette).toContain(chips[2]!.color);
    expect(chips[0]!.color).not.toBe(chips[2]!.color);
  });

  it('hides the hidden books’ items, ignores ids that aren’t books, and keeps items cached without a book', () => {
    const items = [item(P, '-1000'), item(B, '5000'), item(R, '-200'), item(undefined, '-1')];
    expect(visibleCalendarItems(items, [])).toEqual(items);
    expect(visibleCalendarItems(items, [B, 'gone']).map((i) => i.entityId)).toEqual([P, R, undefined]);
  });

  it('totals what is shown and still to come, by currency', () => {
    const items = [
      item(P, '-1000'),
      item(B, '5000'),
      item(R, '-200', { currency: 'EUR' }),
      item(P, '-9999', { status: 'paid' }),
      item(P, '700', { status: 'overdue' }),
      item(P, '0'),
    ];
    expect(calendarTotals(items)).toEqual([
      { currency: 'USD', in: 5700n, out: 1000n },
      { currency: 'EUR', in: 0n, out: 200n },
    ]);
    expect(calendarTotals(visibleCalendarItems(items, [B, R]))).toEqual([
      { currency: 'USD', in: 700n, out: 1000n },
    ]);
  });

  it('shows and hides a book, keeping the books’ order', () => {
    const books = [{ id: P }, { id: B }, { id: R }];
    expect(toggleBook(books, [], R)).toEqual([R]);
    expect(toggleBook(books, [R], P)).toEqual([P, R]);
    expect(toggleBook(books, [P, R], P)).toEqual([R]);
    expect(toggleBook(books, ['gone'], B)).toEqual([B]);
  });

  it('has a word for every kind of item', () => {
    const en = catalogs.en!;
    for (const k of CALENDAR_ITEM_KINDS) expect(en[`calendar.kind_${k}`]).toBeTruthy();
    expect(en['calendar.in_book']).toContain('{name}');
  });
});
