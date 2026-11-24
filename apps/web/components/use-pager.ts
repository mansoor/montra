'use client';

import { useCallback, useEffect, useState } from 'react';
import { friendlyMessage } from '@/lib/errors';
import { appendPage } from '@/lib/paging';
import { useI18n } from './i18n';

/**
 * A list's first page from the server, and the pages after it loaded here with "Load more". When the server sends a new
 * first page (other filters, or a refresh after an edit), the list starts again from it.
 */
export function usePager<T>(
  first: readonly T[],
  firstCursor: string | null,
  fetchPage: (cursor: string) => Promise<{ data: T[]; nextCursor: string | null }>,
  id: (row: T) => string,
) {
  const { t } = useI18n();
  const [rows, setRows] = useState<readonly T[]>(first);
  const [cursor, setCursor] = useState(firstCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(first);
    setCursor(firstCursor);
    setError(null);
  }, [first, firstCursor]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(cursor);
      setRows((shown) => appendPage(shown, page.data, id));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [cursor, fetchPage, id, t]);

  return { rows, cursor, loading, error, loadMore };
}
