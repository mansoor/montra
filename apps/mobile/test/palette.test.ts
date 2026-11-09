/**
 * Every text-on-fill pair the components use stays readable (WCAG 2.2 AA: 4.5:1 for text, 3:1 for icons and control
 * outlines), in light and dark.
 */
import { describe, expect, it } from 'vitest';
import { darkPalette, lightPalette, type Palette } from '../src/ui/palette';

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

type Pair = [fg: keyof Palette, bg: keyof Palette];
const TEXT: Pair[] = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surfaceAlt'],
  ['text', 'primarySoft'],
  ['text', 'dangerSoft'],
  ['text', 'warningSoft'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surfaceAlt'],
  ['onPrimary', 'primary'],
  ['primary', 'surface'],
  ['primary', 'primarySoft'],
  ['danger', 'surface'],
  ['success', 'surface'],
];
const ICONS: Pair[] = [
  ['danger', 'dangerSoft'],
  ['warning', 'warningSoft'],
  ['muted', 'surfaceAlt'],
];

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
])('%s palette (AA)', (_name, p) => {
  it.each(TEXT)('%s text on %s', (fg, bg) => {
    expect(contrast(p[fg], p[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(ICONS)('%s icons on %s', (fg, bg) => {
    expect(contrast(p[fg], p[bg])).toBeGreaterThanOrEqual(3);
  });
});
