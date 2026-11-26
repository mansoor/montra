import { describe, expect, it } from 'vitest';
import { movePage, removePage } from './record-pages';

describe('fixing a record’s pages (ADR-0059 §4)', () => {
  const pages = ['a', 'b', 'c'];

  it('moves a page up or down, and not past either end', () => {
    expect(movePage(pages, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(movePage(pages, 1, 1)).toEqual(['a', 'c', 'b']);
    expect(movePage(pages, 0, -1)).toBeNull();
    expect(movePage(pages, 2, 1)).toBeNull();
    expect(movePage(pages, 5, -1)).toBeNull();
    // The list it was given stays as it was.
    expect(pages).toEqual(['a', 'b', 'c']);
  });

  it('removes a page, but never the only one', () => {
    expect(removePage(pages, 0)).toEqual(['b', 'c']);
    expect(removePage(pages, 2)).toEqual(['a', 'b']);
    expect(removePage(['a'], 0)).toBeNull();
    expect(removePage(pages, 3)).toBeNull();
  });
});
