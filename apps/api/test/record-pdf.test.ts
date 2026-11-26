import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  jpegOrientation,
  orientationMatrix,
  RecordPdfError,
  renderRecordPdf,
} from '../src/renditions/record-pdf.js';
import { jpeg } from './fakes/jpeg.js';

// VLT-14 (ADR-0059 §1): a record's pages drawn as one PDF, without a database.
const AT = new Date('2026-11-25T10:00:00Z');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Where the matrix puts a point of the image's unit square. */
const at = (m: number[], u: number, v: number) => [
  m[0]! * u + m[2]! * v + m[4]!,
  m[1]! * u + m[3]! * v + m[5]!,
];

describe('record PDFs (ADR-0059 §1)', () => {
  it('reads a JPEG’s EXIF orientation, and 1 when it says none', () => {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(jpegOrientation(jpeg({ width: 4, height: 2, orientation: o, note: 'x' }))).toBe(o);
    }
    expect(jpegOrientation(jpeg({ width: 4, height: 2 }))).toBe(1);
    expect(jpegOrientation(PNG)).toBe(1);
    expect(jpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 1]))).toBe(1);
  });

  it('draws each orientation upright: the stored top-left corner lands where a person sees it', () => {
    const w = 100;
    const h = 300;
    // The stored image's top-left is (0, 1) in the unit square; its top-right (1, 1); its bottom-left (0, 0).
    const corners = (o: number) => {
      const m = orientationMatrix(o, w, h);
      return { topLeft: at(m, 0, 1), topRight: at(m, 1, 1), bottomLeft: at(m, 0, 0) };
    };
    expect(corners(1)).toEqual({ topLeft: [0, h], topRight: [w, h], bottomLeft: [0, 0] });
    expect(corners(3)).toEqual({ topLeft: [w, 0], topRight: [0, 0], bottomLeft: [w, h] });
    // Held turned a quarter right: the stored top row is the right edge, read downwards.
    expect(corners(6)).toEqual({ topLeft: [w, h], topRight: [w, 0], bottomLeft: [0, h] });
    // Turned a quarter left: the stored top row is the left edge, read upwards.
    expect(corners(8)).toEqual({ topLeft: [0, 0], topRight: [0, h], bottomLeft: [w, 0] });
    expect(corners(2)).toEqual({ topLeft: [w, h], topRight: [0, h], bottomLeft: [w, 0] });
    expect(corners(4)).toEqual({ topLeft: [0, 0], topRight: [w, 0], bottomLeft: [0, h] });
    expect(corners(5)).toEqual({ topLeft: [0, h], topRight: [0, 0], bottomLeft: [w, h] });
    expect(corners(7)).toEqual({ topLeft: [w, 0], topRight: [w, h], bottomLeft: [0, 0] });
  });

  it('keeps a JPEG’s bytes, copies a PDF’s pages, and gives the same bytes for the same pages', async () => {
    const photo = jpeg({ width: 300, height: 100, orientation: 6, note: 'slip' });
    const src = await PDFDocument.create();
    src.addPage([200, 100]).drawText('Invoice 42');
    const pages = [
      { bytes: photo, mime: 'image/jpeg' },
      { bytes: PNG, mime: 'image/png' },
      { bytes: await src.save(), mime: 'application/pdf' },
    ];
    const made = await renderRecordPdf({ pages, title: 'slip', at: AT });
    expect(made.pages).toBe(3);
    expect(Buffer.from(made.bytes).includes(Buffer.from(photo))).toBe(true);
    const doc = await PDFDocument.load(made.bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBe('slip');
    expect(doc.getProducer()).toBe('Montra');
    const sizes = doc
      .getPages()
      .map((p) => [Number(p.getWidth().toFixed(0)), Number(p.getHeight().toFixed(0))]);
    expect(sizes).toEqual([
      [612, 1836],
      [612, 612],
      [200, 100],
    ]);
    const again = await renderRecordPdf({ pages, title: 'slip', at: AT });
    expect(Buffer.from(again.bytes).equals(Buffer.from(made.bytes))).toBe(true);
  });

  it('keeps a very tall photo within the largest page a reader shows', async () => {
    const made = await renderRecordPdf({
      pages: [{ bytes: jpeg({ width: 100, height: 5000 }), mime: 'image/jpeg' }],
      title: 't',
      at: AT,
    });
    const page = (await PDFDocument.load(made.bytes)).getPage(0);
    expect(Number(page.getHeight().toFixed(0))).toBe(14_400);
    expect(Number(page.getWidth().toFixed(0))).toBe(288);
  });

  it('decodes a WebP photo and draws it upright, at its shape', async () => {
    // 40 × 20 stored, EXIF orientation 6 (turn 90° clockwise to view): it shows 20 wide and 40 tall.
    const webp = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#c33' } })
      .webp()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const made = await renderRecordPdf({
      pages: [
        { bytes: webp, mime: 'image/webp' },
        { bytes: jpeg({ width: 10, height: 10, note: 'after webp' }), mime: 'image/jpeg' },
      ],
      title: 'w',
      at: AT,
    });
    expect(made.pages).toBe(2);
    const page = (await PDFDocument.load(made.bytes)).getPage(0);
    expect(Number(page.getWidth().toFixed(0))).toBe(612);
    expect(Number(page.getHeight().toFixed(0))).toBe(1224);
  });

  it('refuses a page it can’t put in a PDF: another kind of image, a damaged WebP, or a PDF it can’t open', async () => {
    await expect(
      renderRecordPdf({ pages: [{ bytes: Buffer.from('heic?'), mime: 'image/heic' }], title: 'h', at: AT }),
    ).rejects.toMatchObject({ reason: 'unsupported' });
    const broken = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    await expect(
      renderRecordPdf({ pages: [{ bytes: broken, mime: 'image/webp' }], title: 'w', at: AT }),
    ).rejects.toMatchObject({ reason: 'unreadable' });
    await expect(
      renderRecordPdf({
        pages: [{ bytes: Buffer.from('not a pdf'), mime: 'application/pdf' }],
        title: 'p',
        at: AT,
      }),
    ).rejects.toBeInstanceOf(RecordPdfError);
    await expect(
      renderRecordPdf({ pages: [{ bytes: Buffer.from([1, 2, 3]), mime: 'image/jpeg' }], title: 'j', at: AT }),
    ).rejects.toMatchObject({ reason: 'unreadable' });
  });
});
