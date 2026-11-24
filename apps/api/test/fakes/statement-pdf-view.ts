/**
 * Test-only views of a rendered statement PDF (VLT-13): the table rows the renderer drew (through its trace, since the
 * embedded fonts' text isn't plain in the file), and the files attached inside the PDF.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';
import { COL, type DrawnText } from '../../src/renditions/statement-pdf.js';

export interface DrawnRow {
  date: string;
  description: string;
  out: string | null;
  in: string | null;
  balance: string | null;
}

const at = (cells: DrawnText[], align: 'left' | 'right', x: number) =>
  cells.find((c) => c.align === align && Math.abs(c.x - x) < 0.01)?.text ?? null;

/** The table's rows of one part, in drawing order: a line with a date in the date column, on the pages after the cover. */
export function drawnRows(drawn: readonly DrawnText[], part = 1): DrawnRow[] {
  const body = drawn.filter((d) => d.part === part && d.page > 1);
  const lines = new Map<string, DrawnText[]>();
  for (const d of body) {
    const key = `${d.page}:${d.y}`;
    lines.set(key, [...(lines.get(key) ?? []), d]);
  }
  return [...lines.values()]
    .sort((a, b) => a[0]!.page - b[0]!.page || b[0]!.y - a[0]!.y)
    .map((cells) => ({ cells, date: at(cells, 'left', COL.date) }))
    .filter((l) => l.date && /^\d{4}-\d{2}-\d{2}$/.test(l.date))
    .map(({ cells, date }) => ({
      date: date!,
      description: at(cells, 'left', COL.description) ?? '',
      out: at(cells, 'right', COL.out),
      in: at(cells, 'right', COL.in),
      balance: at(cells, 'right', COL.balance),
    }));
}

/** A totals line ("Totals", "Statement totals", "Totals for part 1"): its money out, money in and balance. */
export function drawnTotals(drawn: readonly DrawnText[], label: string, part = 1) {
  const head = drawn.find((d) => d.part === part && d.text === label && d.x === COL.description);
  if (!head) return null;
  const cells = drawn.filter((d) => d.part === part && d.page === head.page && d.y === head.y);
  return {
    out: at(cells, 'right', COL.out),
    in: at(cells, 'right', COL.in),
    balance: at(cells, 'right', COL.balance),
  };
}

/** Everything drawn on a part's cover, as one string per line. */
export function coverText(drawn: readonly DrawnText[], part = 1): string {
  return drawn
    .filter((d) => d.part === part && d.page === 1)
    .map((d) => d.text)
    .join('\n');
}

/** The files attached inside a PDF (its EmbeddedFiles name tree), by name. */
export async function attachments(
  bytes: Uint8Array,
): Promise<Map<string, { bytes: Uint8Array; mime: string | null }>> {
  const pdf = await PDFDocument.load(bytes);
  const out = new Map<string, { bytes: Uint8Array; mime: string | null }>();
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const list = tree?.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (!list) return out;
  for (let i = 0; i < list.size(); i += 2) {
    const name = list.lookup(i) as PDFString | PDFHexString;
    const spec = list.lookup(i + 1, PDFDict);
    const ef = spec.lookup(PDFName.of('EF'), PDFDict);
    const stream = ef.lookup(PDFName.of('F')) as PDFRawStream;
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    out.set(name.decodeText(), {
      bytes: decodePDFRawStream(stream).decode(),
      mime: subtype instanceof PDFName ? subtype.decodeText() : null,
    });
  }
  return out;
}
