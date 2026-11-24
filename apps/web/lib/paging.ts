/**
 * "Load more" on the web lists (Transactions, Review, Receipts): the API hands back a cursor with each page, and the next
 * page is asked for with the same filters. Pure, so it is tested without a browser.
 */

/**
 * The next page added after the rows shown. A row already shown isn't shown twice: a row edited between pages can sort
 * into the next page too.
 */
export function appendPage<T>(shown: readonly T[], next: readonly T[], id: (row: T) => string): T[] {
  const seen = new Set(shown.map(id));
  return [...shown, ...next.filter((r) => !seen.has(id(r)))];
}

/**
 * What sits under a list: a Load more button while the window has more pages, and only once it is all loaded, the
 * window line with Show older.
 */
export const listFooter = (nextCursor: string | null | undefined): 'more' | 'window' =>
  nextCursor ? 'more' : 'window';
