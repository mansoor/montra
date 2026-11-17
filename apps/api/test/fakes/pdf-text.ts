/**
 * The text of a PDF that pdf-lib wrote (payroll's forms), per page, as lines: what a text layer gives the doc-worker.
 * Runs on the same baseline are one line, left to right; runs far apart are separated by a tab, as the columns of a
 * form are. Test-only: it reads `x y Tm <hex> Tj` and nothing more.
 */
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, type PDFRef } from 'pdf-lib';

/** WinAnsi characters pdf-lib's standard fonts use that aren't Latin-1. */
const WIN_ANSI: Record<number, string> = { 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };

const decodeHex = (hex: string) =>
  (hex.match(/../g) ?? [])
    .map((h) => parseInt(h, 16))
    .map((c) => WIN_ANSI[c] ?? String.fromCharCode(c))
    .join('');

export async function pdfTextPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: PDFRawStream[] =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => pdf.context.lookup(ref as PDFRef) as PDFRawStream)
        : [contents as unknown as PDFRawStream];
    const ops = streams
      .map((s) => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()))
      .join('\n');
    const runs: { x: number; y: number; text: string }[] = [];
    for (const m of ops.matchAll(/(-?[\d.]+) (-?[\d.]+) Tm\s+\/?[\w-]*\s*<([0-9A-Fa-f]*)> Tj/g)) {
      const text = decodeHex(m[3]!);
      if (text.trim()) runs.push({ x: Number(m[1]), y: Number(m[2]), text });
    }
    const lines: { y: number; runs: typeof runs }[] = [];
    for (const r of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
      const line = lines.find((l) => Math.abs(l.y - r.y) < 1.5);
      if (line) line.runs.push(r);
      else lines.push({ y: r.y, runs: [r] });
    }
    return lines
      .map((l) =>
        l.runs
          .sort((a, b) => a.x - b.x)
          .map((r, i, all) => (i > 0 && r.x - all[i - 1]!.x > 12 ? `\t${r.text}` : r.text))
          .join(' ')
          .replace(/ \t/g, '\t'),
      )
      .join('\n');
  });
}
