import { describe, expect, it } from 'vitest';
import { PHOTO_UPLOAD_DEFAULTS, type PhotoUploadSettings } from '@montra/schemas';
import { preparePhoto, type PhotoCodec } from './photo-upload';

const settings: PhotoUploadSettings = { ...PHOTO_UPLOAD_DEFAULTS, keepOriginal: false };

/** A codec whose JPEG size is set per quality; it records what it was asked for. */
function fakeCodec(width: number, height: number, sizeAt: (quality: number) => number) {
  const calls: { width: number; height: number; quality: number }[] = [];
  let closed = 0;
  const codec: PhotoCodec = {
    decode: async () => ({ width, height, source: {} as CanvasImageSource, close: () => void closed++ }),
    encode: async (_s, w, h, quality) => {
      calls.push({ width: w, height: h, quality });
      return new Blob([new Uint8Array(sizeAt(quality))], { type: 'image/jpeg' });
    },
  };
  return { codec, calls, closed: () => closed };
}

const photo = (name: string, type: string, bytes: number) =>
  new File([new Uint8Array(bytes)], name, { type, lastModified: 1 });

describe('preparePhoto (BAK-08)', () => {
  it('resizes a big photo to the long edge and saves it as JPEG at the quality set', async () => {
    const f = fakeCodec(4032, 3024, () => 600_000);
    const out = await preparePhoto(photo('IMG_1.HEIC.jpeg', 'image/jpeg', 4_000_000), settings, f.codec);
    expect(f.calls).toEqual([{ width: 2000, height: 1500, quality: 0.8 }]);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_1.HEIC.jpg');
    expect(out.size).toBe(600_000);
    expect(f.closed()).toBe(1);
  });

  it('steps the quality down while the photo is over about 1 MB, and stops at the floor', async () => {
    const f = fakeCodec(2000, 3000, (q) => (q > 0.65 ? 2_000_000 : 1_200_000));
    const out = await preparePhoto(photo('long.png', 'image/png', 9_000_000), settings, f.codec);
    expect(f.calls.map((c) => c.quality)).toEqual([0.8, 0.7, 0.6]);
    expect(out.name).toBe('long.jpg');
    expect(out.size).toBe(1_200_000);
  });

  it('re-encodes a small JPEG too, so its location never leaves the browser', async () => {
    const f = fakeCodec(800, 600, () => 90_000);
    const out = await preparePhoto(photo('small.jpg', 'image/jpeg', 80_000), settings, f.codec);
    expect(f.calls).toEqual([{ width: 800, height: 600, quality: 0.8 }]);
    expect(out.size).toBe(90_000);
  });

  it('keeps a small PNG as it is when the JPEG would be no smaller', async () => {
    const f = fakeCodec(800, 600, () => 90_000);
    const original = photo('shot.png', 'image/png', 50_000);
    expect(await preparePhoto(original, settings, f.codec)).toBe(original);
  });

  it('never touches a PDF or other files, nor a photo when originals are kept', async () => {
    const f = fakeCodec(4000, 3000, () => 1);
    const pdf = photo('invoice.pdf', 'application/pdf', 3_000_000);
    const csv = photo('orders.csv', 'text/csv', 10);
    const big = photo('big.jpg', 'image/jpeg', 8_000_000);
    expect(await preparePhoto(pdf, settings, f.codec)).toBe(pdf);
    expect(await preparePhoto(csv, settings, f.codec)).toBe(csv);
    expect(await preparePhoto(big, { ...settings, keepOriginal: true }, f.codec)).toBe(big);
    expect(f.calls).toEqual([]);
  });

  it("uploads the original when the browser can't read or encode it", async () => {
    const original = photo('odd.webp', 'image/webp', 500_000);
    const unreadable: PhotoCodec = { decode: async () => null, encode: async () => null };
    expect(await preparePhoto(original, settings, unreadable)).toBe(original);
    const noEncoder: PhotoCodec = {
      decode: async () => ({ width: 3000, height: 3000, source: {} as CanvasImageSource }),
      encode: async () => null,
    };
    expect(await preparePhoto(original, settings, noEncoder)).toBe(original);
  });

  it('uses the limits it is given', async () => {
    const f = fakeCodec(3000, 1500, () => 100);
    await preparePhoto(
      photo('a.jpg', 'image/jpeg', 1_000),
      { ...settings, maxEdgePx: 1200, quality: 70 },
      f.codec,
    );
    expect(f.calls).toEqual([{ width: 1200, height: 600, quality: 0.7 }]);
  });
});
