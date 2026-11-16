/**
 * Each book's colour on the calendar (FLOW-05), as Google Calendar's calendars. A book keeps the colour someone picked;
 * otherwise it gets one from this palette by its id, so the web and the phone, and every visit, agree. Two unpicked
 * books don't share a colour while the palette has one left.
 *
 * Every colour reads at 3:1 or better against the light surface (#ffffff) and the dark one (#263142), as an icon or a
 * swatch must (WCAG 2.2 1.4.11). Colour is never the only sign of a book: the name goes with it.
 */
export const BOOK_PALETTE = [
  { name: 'blue', hex: '#3b82f6' },
  { name: 'orange', hex: '#ea580c' },
  { name: 'green', hex: '#2f9e44' },
  { name: 'purple', hex: '#9061f9' },
  { name: 'pink', hex: '#e64980' },
  { name: 'teal', hex: '#0d9488' },
  { name: 'amber', hex: '#c77c02' },
  { name: 'cyan', hex: '#0891b2' },
] as const;

export type BookPaletteName = (typeof BOOK_PALETTE)[number]['name'];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** FNV-1a over the id: a small, stable number for the same id on every platform. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Each book's colour, `#rrggbb` in lower case. Books with a colour keep it; the rest, in the order given, take the
 * palette colour their id points at, or the next one no other book uses. `color` may be missing (an older cached
 * copy of the workspace) or invalid: both count as unset.
 */
export function bookColors(books: readonly { id: string; color?: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const b of books) {
    if (b.color && HEX.test(b.color)) {
      const c = b.color.toLowerCase();
      out.set(b.id, c);
      used.add(c);
    }
  }
  const n = BOOK_PALETTE.length;
  for (const b of books) {
    if (out.has(b.id)) continue;
    const start = hashId(b.id) % n;
    let pick: string = BOOK_PALETTE[start]!.hex;
    for (let k = 0; k < n; k++) {
      const c = BOOK_PALETTE[(start + k) % n]!.hex;
      if (!used.has(c)) {
        pick = c;
        break;
      }
    }
    out.set(b.id, pick);
    used.add(pick);
  }
  return out;
}

/** The palette's name for a colour (for a label), or null for a colour picked outside it. */
export function bookPaletteName(hex: string): BookPaletteName | null {
  const c = hex.toLowerCase();
  return BOOK_PALETTE.find((p) => p.hex === c)?.name ?? null;
}
