/**
 * Back links that return to the list as it was left (owner, 2026-11-21): "← Transactions" after opening a transaction
 * from the "Needs review" filter goes back to that filter, not to All. Each page's last full URL (its filters and tabs
 * are in the query string) is kept per browser tab, and a back link to that page uses it.
 *
 * Only a back link with no query of its own is changed: one that names a query (the tax year, say) means it.
 */

/** Where the last URLs are kept: `sessionStorage`, so each browser tab has its own and nothing outlives it. */
export interface UrlStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAST_URLS_KEY = 'montra.lastUrls';
/** Enough for every list a person moves between; the oldest go first. */
export const MAX_REMEMBERED = 40;

function read(store: UrlStore): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(LAST_URLS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Notes the page just shown: `pathname` and its query string (without the `?`). */
export function rememberUrl(store: UrlStore, pathname: string, search: string): void {
  const urls = read(store);
  delete urls[pathname]; // re-added last, so it's the newest
  urls[pathname] = search ? `${pathname}?${search}` : pathname;
  const paths = Object.keys(urls);
  for (const old of paths.slice(0, Math.max(0, paths.length - MAX_REMEMBERED))) delete urls[old];
  try {
    store.setItem(LAST_URLS_KEY, JSON.stringify(urls));
  } catch {
    // Storage full or turned off: back links then go to the plain page, as before.
  }
}

/** Where a back link to `href` should go: the page as it was last shown in this tab, else `href` itself. */
export function backHref(store: UrlStore, href: string): string {
  if (href.includes('?') || href.includes('#')) return href;
  return read(store)[href] ?? href;
}
