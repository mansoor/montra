import { describe, expect, it } from 'vitest';
import { BOOK_PALETTE, bookColors, bookPaletteName } from '../src/book-colors.js';

const ids = [
  '0b5c7c1e-1f0a-4c55-9d1e-6a8c3b7e0001',
  '0b5c7c1e-1f0a-4c55-9d1e-6a8c3b7e0002',
  '0b5c7c1e-1f0a-4c55-9d1e-6a8c3b7e0003',
];
const palette = BOOK_PALETTE.map((p) => p.hex as string);

// Contrast as WCAG computes it, for the swatch on the light and dark surfaces.
const channel = (hex: string, i: number) => {
  const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('book colours (FLOW-05)', () => {
  it('keeps a picked colour, in lower case', () => {
    const c = bookColors([{ id: ids[0]!, color: '#AABBCC' }]);
    expect(c.get(ids[0]!)).toBe('#aabbcc');
  });

  it('gives unpicked books a stable palette colour by id, whatever the order', () => {
    const books = ids.map((id) => ({ id, color: null }));
    const a = bookColors(books);
    const b = bookColors(books);
    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const id of ids) expect(palette).toContain(a.get(id));
    // One book alone gets the colour its id points at, wherever it sits in the list.
    const alone = bookColors([{ id: ids[1]! }]).get(ids[1]!);
    expect(bookColors([{ id: ids[1]! }, { id: 'x', color: '#000000' }]).get(ids[1]!)).toBe(alone);
  });

  it('gives different books different colours while the palette has one left', () => {
    const many = Array.from({ length: palette.length }, (_, i) => ({ id: `book-${i}` }));
    const colours = new Set(bookColors(many).values());
    expect(colours.size).toBe(palette.length);
    // A picked colour is taken: an unpicked book doesn't land on it.
    const picked = bookColors([{ id: ids[0]! }]).get(ids[0]!)!;
    const both = bookColors([{ id: ids[0]! }, { id: ids[1]!, color: picked }]);
    expect(both.get(ids[1]!)).toBe(picked);
    expect(both.get(ids[0]!)).not.toBe(picked);
  });

  it('treats a missing or broken colour as unset', () => {
    const c = bookColors([{ id: ids[0]! }, { id: ids[1]!, color: 'red' }]);
    expect(palette).toContain(c.get(ids[0]!));
    expect(palette).toContain(c.get(ids[1]!));
  });

  it('names palette colours, and only those', () => {
    expect(bookPaletteName('#3B82F6')).toBe('blue');
    expect(bookPaletteName('#123456')).toBeNull();
  });

  it('reads at 3:1 on the light and dark surfaces', () => {
    for (const hex of palette) {
      expect(contrast(hex, '#ffffff')).toBeGreaterThanOrEqual(3);
      expect(contrast(hex, '#263142')).toBeGreaterThanOrEqual(3);
      expect(contrast(hex, '#243041')).toBeGreaterThanOrEqual(3);
    }
  });
});
