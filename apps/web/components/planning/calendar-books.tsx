'use client';

import { useRef, useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { toggleHidden, type CalendarBook } from '@/lib/calendar';
import { StatusLine, useAction } from '../use-action';

/**
 * The calendar's Books list (FLOW-05), as Google Calendar's calendars: a tick box per book with its colour. The choice
 * is the person's own, saved on the server so the phone shows the same; the page re-renders with the books shown.
 */
export function CalendarBooks({
  workspaceId,
  books,
  hidden: initial,
}: {
  workspaceId: string;
  books: CalendarBook[];
  hidden: string[];
}) {
  const { message, run, t } = useAction();
  const [hidden, setHidden] = useState(initial);
  // Saves go one after another, so the last tick is the one kept.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  function toggle(id: string, shown: boolean) {
    const next = toggleHidden(books, hidden, id, shown);
    const before = hidden;
    setHidden(next);
    queue.current = queue.current.then(async () => {
      const saved = await run(() => browserApi.setCalendarBooks(workspaceId, { hiddenEntityIds: next }));
      if (!saved) setHidden(before);
    });
  }

  return (
    <fieldset className="card space-y-2" aria-describedby="cal-books-hint">
      <legend className="section-h">{t('calendar.books')}</legend>
      <p id="cal-books-hint" className="text-xs text-muted">
        {t('calendar.books_hint')}
      </p>
      <ul className="space-y-1">
        {books.map((b) => {
          const shown = !hidden.includes(b.id);
          return (
            <li key={b.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(e) => toggle(b.id, e.target.checked)}
                  data-testid={`cal-book-${b.id}`}
                />
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: b.color }}
                />
                <span className="min-w-0 truncate">{b.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <StatusLine message={message} />
    </fieldset>
  );
}
