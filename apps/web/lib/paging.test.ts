import { describe, expect, it } from 'vitest';
import { appendPage, listFooter } from './paging';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const id = (r: { id: string }) => r.id;

describe('load more', () => {
  it('adds the next page after the rows shown, in order', () => {
    expect(appendPage(rows('a', 'b'), rows('c', 'd'), id).map(id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shows a row only once when it turns up on the next page too', () => {
    expect(appendPage(rows('a', 'b'), rows('b', 'c'), id).map(id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the rows shown when the next page is empty', () => {
    expect(appendPage(rows('a'), [], id).map(id)).toEqual(['a']);
  });

  it('offers Load more while there are pages, and Show older only once the window is all loaded', () => {
    expect(listFooter('abc')).toBe('more');
    expect(listFooter(null)).toBe('window');
    expect(listFooter(undefined)).toBe('window');
    expect(listFooter('')).toBe('window');
  });
});
