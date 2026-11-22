import { describe, expect, it } from 'vitest';
import { backHref, LAST_URLS_KEY, MAX_REMEMBERED, rememberUrl, type UrlStore } from './back-links';

const memory = (): UrlStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

const list = '/w/ws1/transactions';

describe('back links that remember the list (owner, 2026-11-21)', () => {
  it('return to the filter the list was left on', () => {
    const s = memory();
    rememberUrl(s, list, 'filter=review');
    rememberUrl(s, `${list}/t1`, '');
    expect(backHref(s, list)).toBe(`${list}?filter=review`);
    // Choosing All again is remembered too.
    rememberUrl(s, list, '');
    expect(backHref(s, list)).toBe(list);
  });

  it('go to the plain page when it hasn’t been shown in this tab, or the link names its own query', () => {
    const s = memory();
    expect(backHref(s, '/w/ws1/receipts')).toBe('/w/ws1/receipts');
    rememberUrl(s, '/w/ws1/tax-forms', 'year=2025');
    expect(backHref(s, '/w/ws1/tax-forms?year=2026')).toBe('/w/ws1/tax-forms?year=2026');
  });

  it('keep each workspace’s lists apart', () => {
    const s = memory();
    rememberUrl(s, '/w/ws1/receipts', 'tab=matched');
    expect(backHref(s, '/w/ws2/receipts')).toBe('/w/ws2/receipts');
  });

  it('forget the oldest pages past the limit, and survive bad or full storage', () => {
    const s = memory();
    rememberUrl(s, '/first', 'a=1');
    for (let i = 0; i < MAX_REMEMBERED; i++) rememberUrl(s, `/p${i}`, 'x=1');
    expect(backHref(s, '/first')).toBe('/first');
    expect(backHref(s, `/p${MAX_REMEMBERED - 1}`)).toBe(`/p${MAX_REMEMBERED - 1}?x=1`);

    s.data.set(LAST_URLS_KEY, 'not json');
    expect(backHref(s, list)).toBe(list);
    const full: UrlStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => rememberUrl(full, list, 'filter=review')).not.toThrow();
  });
});
