/**
 * Fonts for PDFs in any script (ADR-0032). Noto Sans first, then one font per script it lacks; each run of text takes
 * the first font that has all its characters. Fonts are read from their npm packages once per process and embedded as
 * subsets, so a PDF carries only the glyphs it uses.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// fontkit's Indic shaper (Devanagari) is built with generators compiled for regenerator's runtime, a global it expects.
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

const require = createRequire(import.meta.url);

/** In the order they're tried. `bold` false: the script has no bold here, so bold text uses the regular weight. */
const CHAIN = [
  // Latin, Greek, Cyrillic, Vietnamese and Devanagari.
  { pkg: 'noto-sans', file: 'NotoSans', bold: true },
  { pkg: 'noto-sans-arabic', file: 'NotoSansArabic', bold: true },
  { pkg: 'noto-sans-hebrew', file: 'NotoSansHebrew', bold: true },
  { pkg: 'noto-sans-thai', file: 'NotoSansThai', bold: true },
  // Simplified Chinese; it also has Japanese kana. The bold weight is another 10 MB, so CJK prints in regular only.
  { pkg: 'noto-sans-sc', file: 'NotoSansSC', bold: false },
] as const;

type Weight = 'regular' | 'bold';
const bytesCache = new Map<string, Uint8Array>();
const coverage: { hasGlyphForCodePoint(cp: number): boolean }[] = [];

function fontBytes(i: number, weight: Weight): Uint8Array {
  const f = CHAIN[i]!;
  const w = weight === 'bold' && f.bold ? '700Bold' : '400Regular';
  const key = `${f.pkg}/${w}`;
  let b = bytesCache.get(key);
  if (!b) {
    b = new Uint8Array(readFileSync(require.resolve(`@expo-google-fonts/${f.pkg}/${w}/${f.file}_${w}.ttf`)));
    bytesCache.set(key, b);
  }
  return b;
}

/** Which font of the chain has `cp`, or -1. Coverage is the same for both weights. */
function fontFor(cp: number): number {
  for (let i = 0; i < CHAIN.length; i++) {
    coverage[i] ??= fontkit.create(fontBytes(i, 'regular') as Buffer) as unknown as (typeof coverage)[number];
    if (coverage[i]!.hasGlyphForCodePoint(cp)) return i;
  }
  return -1;
}

// Characters that take the font of the text around them rather than starting a run of their own. A right-to-left run
// (Arabic, Hebrew) is laid out right to left as a whole, so only spaces join it: digits and Latin punctuation inside it
// would come out reversed.
const NEUTRAL = /[\s\p{P}\p{N}\p{S}]/u;
const RTL = new Set([1, 2]);
const joins = (font: number, ch: string) => (RTL.has(font) ? /\s/u.test(ch) : NEUTRAL.test(ch));

export interface Run {
  font: number;
  text: string;
}

/**
 * Splits text into runs by font. Spaces, digits and punctuation stay in the run they're in, if its font has them.
 * A character no font has becomes "?" in the first font.
 */
export function fontRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const current = runs[runs.length - 1];
    if (current && joins(current.font, ch) && coversCp(current.font, cp)) {
      current.text += ch;
      continue;
    }
    let font = fontFor(cp);
    let out = ch;
    if (font === -1) {
      font = 0;
      out = '?';
    }
    if (current && current.font === font) current.text += out;
    else runs.push({ font, text: out });
  }
  return runs;
}

function coversCp(font: number, cp: number): boolean {
  coverage[font] ??= fontkit.create(
    fontBytes(font, 'regular') as Buffer,
  ) as unknown as (typeof coverage)[number];
  return coverage[font]!.hasGlyphForCodePoint(cp);
}

export interface ShapedRun {
  font: PDFFont;
  text: string;
  width: number;
}

/** The fonts of one document, embedded the first time a run needs them. */
export class FontSet {
  private readonly embedded = new Map<string, PDFFont>();
  constructor(private readonly pdf: PDFDocument) {
    pdf.registerFontkit(fontkit);
  }

  private async font(i: number, weight: Weight): Promise<PDFFont> {
    const key = `${i}:${weight === 'bold' && CHAIN[i]!.bold ? 'bold' : 'regular'}`;
    let f = this.embedded.get(key);
    if (!f) {
      f = await this.pdf.embedFont(fontBytes(i, weight), { subset: true });
      this.embedded.set(key, f);
    }
    return f;
  }

  /**
   * The runs of `text` with their embedded fonts and their width at size 1 (widths scale with the size): measure and
   * draw from these, so each run is laid out once.
   */
  async shape(text: string, weight: Weight): Promise<ShapedRun[]> {
    const out: ShapedRun[] = [];
    for (const r of fontRuns(text)) {
      const font = await this.font(r.font, weight);
      out.push({ font, text: r.text, width: font.widthOfTextAtSize(r.text, 1) });
    }
    return out;
  }
}
