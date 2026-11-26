/**
 * A receipt's or bill's pages as one PDF (ADR-0059 §1, VLT-14): one page per photo, in the record's order, and every
 * page of a PDF the record holds, copied as it is.
 *
 * - **JPEG** photos go in as they are (DCTDecode): the bytes are not decoded or compressed again, so the page is exactly
 *   the photo. Its EXIF orientation is applied by how the page draws it, never by re-encoding.
 * - **PNG** photos are lossless already; pdf-lib keeps their pixels (Flate). A 16-bit PNG is drawn at 8 bits.
 * - **PDF** pages are copied, not drawn again: text stays text.
 * - **WebP** can't go inside a PDF as it is, so sharp decodes it, turns it upright by its EXIF orientation and saves it as
 *   a lossless PNG, which goes in like any PNG. Any other kind of image is "not converted"
 *   (`RecordPdfError('unsupported')`), and the record's pages stay in Montra.
 *
 * A photo's page is 8.5 inches wide (Letter's width) and as tall as the photo's shape needs, up to the 200-inch limit
 * PDF readers keep to; the image keeps its full resolution whatever the page's size. The same pages and date give the
 * same bytes.
 */
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  type PDFImage,
} from 'pdf-lib';
import sharp from 'sharp';

export interface RecordPage {
  bytes: Uint8Array;
  mime: string;
}

export interface RecordPdfInput {
  pages: readonly RecordPage[];
  /** The document's title in its metadata. */
  title: string;
  /** Its creation and modification date: the same input gives the same bytes. */
  at: Date;
}

/** Why a record's PDF couldn't be made: a page Montra can't read, or one of a type it can't put in a PDF (WebP). */
export class RecordPdfError extends Error {
  constructor(readonly reason: 'unreadable' | 'unsupported') {
    super(
      reason === 'unsupported' ? 'A page is of a type Montra can’t put in a PDF' : 'A page couldn’t be read',
    );
    this.name = 'RecordPdfError';
  }
}

/** Letter's width, in points. */
export const PAGE_WIDTH = 612;
/** 200 inches: the largest page PDF readers are asked to show (PDF 1.7, Annex C). */
export const PAGE_MAX = 14_400;

export async function renderRecordPdf(input: RecordPdfInput): Promise<{ bytes: Uint8Array; pages: number }> {
  if (!input.pages.length) throw new RecordPdfError('unreadable');
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(input.title);
  pdf.setCreator('Montra');
  pdf.setProducer('Montra');
  pdf.setCreationDate(input.at);
  pdf.setModificationDate(input.at);

  for (const page of input.pages) {
    const mime = page.mime.toLowerCase();
    if (mime === 'application/pdf') {
      let src: PDFDocument;
      try {
        src = await PDFDocument.load(page.bytes, { updateMetadata: false });
      } catch {
        // An encrypted or damaged PDF: its pages can't be copied faithfully.
        throw new RecordPdfError('unreadable');
      }
      const indices = src.getPageIndices();
      if (!indices.length) throw new RecordPdfError('unreadable');
      for (const copied of await pdf.copyPages(src, indices)) pdf.addPage(copied);
      continue;
    }
    let image: PDFImage;
    let orientation = 1;
    try {
      if (mime === 'image/jpeg') {
        image = await pdf.embedJpg(page.bytes);
        orientation = jpegOrientation(page.bytes);
      } else if (mime === 'image/png') {
        image = await pdf.embedPng(page.bytes);
      } else if (mime === 'image/webp') {
        // Upright already: sharp applies the EXIF orientation and the PNG keeps none.
        image = await pdf.embedPng(await sharp(page.bytes).rotate().png().toBuffer());
      } else {
        throw new RecordPdfError('unsupported');
      }
    } catch (e) {
      if (e instanceof RecordPdfError) throw e;
      throw new RecordPdfError('unreadable');
    }
    drawPhoto(pdf, image, orientation);
  }
  const bytes = await pdf.save();
  return { bytes, pages: pdf.getPageCount() };
}

/** One page for a photo, drawn upright as its EXIF orientation says. */
function drawPhoto(pdf: PDFDocument, image: PDFImage, orientation: number): void {
  const turned = orientation >= 5 && orientation <= 8;
  // The photo as a person sees it.
  const seenW = turned ? image.height : image.width;
  const seenH = turned ? image.width : image.height;
  if (seenW <= 0 || seenH <= 0) throw new RecordPdfError('unreadable');
  const scale = Math.min(PAGE_WIDTH / seenW, PAGE_MAX / seenH);
  const w = seenW * scale;
  const h = seenH * scale;
  const page = pdf.addPage([w, h]);
  const name = page.node.newXObject('Image', image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...orientationMatrix(orientation, w, h)),
    drawObject(name),
    popGraphicsState(),
  );
}

/**
 * The matrix that draws an image's unit square so its EXIF `orientation` shows upright on a `w` × `h` page. In the unit
 * square the stored image's top row is at v = 1; each case says where the stored corners land.
 */
export function orientationMatrix(
  orientation: number,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: // mirrored left to right
      return [-w, 0, 0, h, w, 0];
    case 3: // upside down
      return [-w, 0, 0, -h, w, h];
    case 4: // mirrored top to bottom
      return [w, 0, 0, -h, 0, h];
    case 5: // mirrored, then turned a quarter left: the stored top-left stays top-left
      return [0, -h, -w, 0, w, h];
    case 6: // turned a quarter right: the stored top row becomes the right edge
      return [0, -h, w, 0, 0, h];
    case 7: // mirrored, then turned a quarter right: the stored top-left goes bottom-right
      return [0, h, w, 0, 0, 0];
    case 8: // turned a quarter left: the stored top row becomes the left edge
      return [0, h, -w, 0, w, 0];
    default:
      return [w, 0, 0, h, 0, 0];
  }
}

/** A JPEG's EXIF orientation (1–8), or 1 when it says none or can't be read. Reads the APP1 segment only. */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1;
    const marker = bytes[at + 1]!;
    // Start of scan or end of image: no more metadata segments.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2) return 1;
    const start = at + 4;
    if (marker === 0xe1 && start + 6 <= bytes.length && ascii(bytes, start, 6) === 'Exif\0\0') {
      return exifOrientation(bytes, start + 6, Math.min(at + 2 + length, bytes.length)) ?? 1;
    }
    at += 2 + length;
  }
  return 1;
}

function exifOrientation(b: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null;
  const order = ascii(b, tiff, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (o: number) =>
    o + 2 > end ? -1 : little ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!;
  const u32 = (o: number) =>
    o + 4 > end
      ? -1
      : little
        ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
        : ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  if (u16(tiff + 2) !== 42) return null;
  const ifd = u32(tiff + 4);
  if (ifd < 0) return null;
  const count = u16(tiff + ifd);
  if (count < 0) return null;
  for (let i = 0; i < count; i++) {
    const entry = tiff + ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!);
  return s;
}
