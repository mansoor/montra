/**
 * A business logo is checked by its content (ADR-0032): a PNG or JPEG whose header parses, small enough, and one the
 * invoice PDF can actually draw. The name and declared type of an upload are never trusted.
 */
import { PDFDocument } from 'pdf-lib';
import { LOGO_MAX_BYTES, LOGO_MAX_PIXELS } from '@montra/schemas';

export interface LogoImage {
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;

/** The image's type and size from its header, or null when it isn't a PNG or JPEG. */
export function sniffLogo(b: Uint8Array): LogoImage | null {
  if (b.length > 24 && PNG.every((x, i) => b[i] === x)) {
    // The first chunk of a PNG is IHDR: width and height, big-endian.
    if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null;
    return { mediaType: 'image/png', width: u32(b, 16), height: u32(b, 20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the markers to the first start-of-frame (SOF0–SOF15, not DHT/JPG/DAC), which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan before any frame
      const len = u16(b, i + 2);
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mediaType: 'image/jpeg', height: u16(b, i + 5), width: u16(b, i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export type LogoCheck = { ok: true; image: LogoImage } | { ok: false; reason: 'type' | 'size' | 'pixels' };

/** The whole check: type, bytes, pixels, and that the PDF library can embed it. */
export async function checkLogo(bytes: Uint8Array): Promise<LogoCheck> {
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: 'size' };
  const image = sniffLogo(bytes);
  if (!image) return { ok: false, reason: 'type' };
  if (
    image.width < 1 ||
    image.height < 1 ||
    image.width > LOGO_MAX_PIXELS ||
    image.height > LOGO_MAX_PIXELS
  ) {
    return { ok: false, reason: 'pixels' };
  }
  try {
    const doc = await PDFDocument.create();
    if (image.mediaType === 'image/png') await doc.embedPng(bytes);
    else await doc.embedJpg(bytes);
  } catch {
    return { ok: false, reason: 'type' };
  }
  return { ok: true, image };
}
