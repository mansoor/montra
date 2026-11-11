/**
 * Fonts for PDFs in any script (ADR-0032). Noto Sans first, then one font per script it lacks; each run of text takes
 * the first font that has all its characters.
 *
 * Two things pdf-lib can't do here, done by hand:
 * - **Subsetting.** pdf-lib's own subsetter drops most glyphs of these fonts, so each font is cut down with HarfBuzz
 *   (`subset-font`, layout tables kept) to the characters the document uses, and that small font is embedded whole.
 * - **Positioning.** pdf-lib places glyphs by their plain advance widths, but Arabic joins its letters through GPOS
 *   cursive attachment. Each run is laid out with fontkit and drawn with its glyph positions (a `TJ` array), so Arabic
 *   connects and Latin text keeps its kerning.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// fontkit's Indic shaper (Devanagari) is built with generators compiled for regenerator's runtime, a global it expects.
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFHexString,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  setTextRise,
  type Color,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import subsetFont from 'subset-font';

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

/** The parts of a fontkit font this file uses. */
interface FkFont {
  unitsPerEm: number;
  characterSet: number[];
  glyphForCodePoint(cp: number): { id: number };
  hasGlyphForCodePoint(cp: number): boolean;
  layout(text: string): {
    glyphs: { id: number; advanceWidth: number }[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
}

const bytesCache = new Map<string, Buffer>();
const coverage: FkFont[] = [];

const weightOf = (i: number, weight: Weight) =>
  weight === 'bold' && CHAIN[i]!.bold ? '700Bold' : '400Regular';

function fontBytes(i: number, weight: Weight): Buffer {
  const f = CHAIN[i]!;
  const w = weightOf(i, weight);
  const key = `${f.pkg}/${w}`;
  let b = bytesCache.get(key);
  if (!b) {
    b = readFileSync(require.resolve(`@expo-google-fonts/${f.pkg}/${w}/${f.file}_${w}.ttf`));
    bytesCache.set(key, b);
  }
  return b;
}

function covers(i: number, cp: number): boolean {
  coverage[i] ??= fontkit.create(fontBytes(i, 'regular')) as unknown as FkFont;
  return coverage[i]!.hasGlyphForCodePoint(cp);
}

/** Which font of the chain has `cp`, or -1. Coverage is the same for both weights. */
function fontFor(cp: number): number {
  for (let i = 0; i < CHAIN.length; i++) if (covers(i, cp)) return i;
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
    if (current && joins(current.font, ch) && covers(current.font, cp)) {
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
  // A right-to-left run is laid out as a whole, so a space at its end would print at its left. Spaces at either end
  // go to their own run, in reading order.
  const split = runs.flatMap((r) => {
    if (!RTL.has(r.font)) return [r];
    const [, lead = '', body = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/u.exec(r.text) ?? [];
    return [
      ...(lead ? [{ font: 0, text: lead }] : []),
      ...(body ? [{ font: r.font, text: body }] : []),
      ...(trail ? [{ font: 0, text: trail }] : []),
    ];
  });
  return split.reduce<Run[]>((out, r) => {
    const last = out[out.length - 1];
    if (last && last.font === r.font && !RTL.has(r.font)) last.text += r.text;
    else out.push({ ...r });
    return out;
  }, []);
}

/** A run laid out: what to draw and how wide it is at size 1. */
export interface ShapedRun {
  font: PDFFont;
  text: string;
  width: number;
  /**
   * Glyph ids in drawing order; the width the PDF gives each, in thousandths of an em; and where the layout puts it,
   * in font units.
   */
  glyphs: { id: number; pdfWidth: number; xAdvance: number; xOffset: number; yOffset: number }[];
  unitsPerEm: number;
}

interface Embedded {
  pdf: PDFFont;
  fk: FkFont;
  /**
   * The glyphs pdf-lib writes a width for: only those its character map reaches. A glyph that shaping substitutes
   * (an Arabic joining form, a Devanagari half form) takes the PDF's default width, a whole em.
   */
  listed: ReadonlySet<number>;
}

/** The fonts of one document: cut down to its characters, embedded, then used to lay out and draw its text. */
export class FontSet {
  private readonly embedded = new Map<string, Promise<Embedded>>();
  private chars = '?: ';

  constructor(private readonly pdf: PDFDocument) {
    pdf.registerFontkit(fontkit);
  }

  /**
   * Every string the document will print, before anything is drawn. Each font is cut down to all of the document's
   * characters it has, so a line broken differently later still finds its glyphs.
   */
  prepare(texts: readonly string[]): void {
    this.chars = [...new Set([...`${texts.join('')}?: `].filter((c) => !/[\r\n\t]/.test(c)))].join('');
  }

  private embed(i: number, weight: Weight): Promise<Embedded> {
    const key = `${i}:${weightOf(i, weight)}`;
    let e = this.embedded.get(key);
    if (!e) {
      e = (async () => {
        const text = [...this.chars].filter((c) => covers(i, c.codePointAt(0)!)).join('') || '?';
        const bytes = await subsetFont(fontBytes(i, weight), text, { targetFormat: 'truetype' });
        const fk = fontkit.create(bytes) as unknown as FkFont;
        return {
          pdf: await this.pdf.embedFont(bytes, { subset: false }),
          fk,
          listed: new Set(fk.characterSet.map((cp) => fk.glyphForCodePoint(cp).id)),
        };
      })();
      this.embedded.set(key, e);
    }
    return e;
  }

  /** The runs of `text`, laid out. Measure and draw from these, so each run is laid out once. */
  async shape(text: string, weight: Weight): Promise<ShapedRun[]> {
    const out: ShapedRun[] = [];
    for (const r of fontRuns(text)) {
      const { pdf, fk, listed } = await this.embed(r.font, weight);
      const { glyphs, positions } = fk.layout(r.text);
      const shaped = glyphs.map((g, i) => ({
        id: g.id,
        pdfWidth: listed.has(g.id) ? (g.advanceWidth * 1000) / fk.unitsPerEm : 1000,
        xAdvance: positions[i]!.xAdvance,
        xOffset: positions[i]!.xOffset,
        yOffset: positions[i]!.yOffset,
      }));
      const width = shaped.reduce((w, g) => w + g.xAdvance, 0) / fk.unitsPerEm;
      out.push({ font: pdf, text: r.text, width, glyphs: shaped, unitsPerEm: fk.unitsPerEm });
    }
    return out;
  }
}

const hex = (id: number) => id.toString(16).padStart(4, '0');

/**
 * Draws laid-out runs from `x` on the baseline `y`. In a `TJ` array a number moves the next glyph left by that many
 * thousandths of the font size, so each glyph lands where the layout put it rather than where its plain width would.
 */
export function drawRuns(
  page: PDFPage,
  runs: readonly ShapedRun[],
  x: number,
  y: number,
  size: number,
  color: Color,
): void {
  const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setFillingColor(color)];
  let at = x;
  for (const r of runs) {
    const key = page.node.newFontDictionary(r.font.name, r.font.ref);
    const k = 1000 / r.unitsPerEm;
    ops.push(setFontAndSize(key, size), setTextMatrix(1, 0, 0, 1, at, y));
    // One TJ per stretch at the same height; a mark raised or lowered (yOffset) gets its own, with a text rise.
    let parts: (PDFHexString | PDFNumber)[] = [];
    let rise = 0;
    const flush = () => {
      if (parts.length === 0) return;
      ops.push(setTextRise((rise * size) / r.unitsPerEm));
      ops.push(PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [page.doc.context.obj(parts)]));
      parts = [];
    };
    for (const g of r.glyphs) {
      if (g.yOffset !== rise) {
        flush();
        rise = g.yOffset;
      }
      if (g.xOffset) parts.push(PDFNumber.of(-g.xOffset * k));
      parts.push(PDFHexString.of(hex(g.id)));
      // The PDF moves on by its width for the glyph (and back from the offset); the layout wants xAdvance.
      const adjust = g.pdfWidth - (g.xAdvance - g.xOffset) * k;
      if (adjust) parts.push(PDFNumber.of(adjust));
    }
    flush();
    if (rise) ops.push(setTextRise(0));
    at += r.width * size;
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}
