import { describe, expect, it } from 'vitest';
import { PHOTO_UPLOAD_DEFAULTS, type PhotoUploadSettings } from '@montra/schemas';
import { compressPhoto, jpegName, type PhotoTool } from '../src/features/photos';

const settings: PhotoUploadSettings = { ...PHOTO_UPLOAD_DEFAULTS, keepOriginal: false };

/** A manipulator whose JPEG size depends on the quality; files are kept in a map so removals can be checked. */
function fakeTool(
  size: { width: number; height: number } | null,
  original: number,
  sizeAt: (q: number) => number,
) {
  const files = new Map<string, number>([['file:///in', original]]);
  const encodes: { width: number; height: number; quality: number }[] = [];
  let n = 0;
  const tool: PhotoTool = {
    size: async () => size,
    encode: async (_uri, width, height, quality) => {
      encodes.push({ width, height, quality });
      const uri = `file:///out-${++n}.jpg`;
      files.set(uri, sizeAt(quality));
      return uri;
    },
    bytes: (uri) => files.get(uri) ?? 0,
    remove: (uri) => void files.delete(uri),
  };
  return { tool, files, encodes };
}

describe('compressPhoto on the phone (BAK-08)', () => {
  it('resizes a camera photo to the long edge and saves it as JPEG', async () => {
    const f = fakeTool({ width: 3024, height: 4032 }, 5_000_000, () => 700_000);
    const out = await compressPhoto({ uri: 'file:///in', type: 'image/jpeg' }, settings, f.tool);
    expect(f.encodes).toEqual([{ width: 1500, height: 2000, quality: 0.8 }]);
    expect(out).toEqual({ uri: 'file:///out-1.jpg', type: 'image/jpeg', compressed: true });
  });

  it('steps the quality down while over the target and removes the copies it drops', async () => {
    const f = fakeTool({ width: 4000, height: 4000 }, 9_000_000, (q) => (q >= 0.7 ? 1_500_000 : 900_000));
    const out = await compressPhoto({ uri: 'file:///in', type: 'image/png' }, settings, f.tool);
    expect(f.encodes.map((e) => e.quality)).toEqual([0.8, 0.7, 0.6]);
    expect(out.uri).toBe('file:///out-3.jpg');
    expect([...f.files.keys()]).toEqual(['file:///in', 'file:///out-3.jpg']);
  });

  it('keeps a small PNG when the JPEG would be bigger, and removes the JPEG', async () => {
    const f = fakeTool({ width: 600, height: 800 }, 40_000, () => 60_000);
    const out = await compressPhoto({ uri: 'file:///in', type: 'image/png' }, settings, f.tool);
    expect(out).toEqual({ uri: 'file:///in', type: 'image/png', compressed: false });
    expect([...f.files.keys()]).toEqual(['file:///in']);
  });

  it('leaves PDFs, unreadable photos, and photos when originals are kept', async () => {
    const f = fakeTool({ width: 4000, height: 3000 }, 5_000_000, () => 1);
    const pdf = await compressPhoto({ uri: 'file:///in', type: 'application/pdf' }, settings, f.tool);
    expect(pdf.compressed).toBe(false);
    const kept = await compressPhoto(
      { uri: 'file:///in', type: 'image/jpeg' },
      { ...settings, keepOriginal: true },
      f.tool,
    );
    expect(kept).toEqual({ uri: 'file:///in', type: 'image/jpeg', compressed: false });
    expect(f.encodes).toEqual([]);
    const unreadable = fakeTool(null, 5_000_000, () => 1);
    expect(
      (await compressPhoto({ uri: 'file:///in', type: 'image/webp' }, settings, unreadable.tool)).compressed,
    ).toBe(false);
  });

  it('names the compressed copy as a JPEG', () => {
    expect(jpegName('Screenshot 2026-11-01.png')).toBe('Screenshot 2026-11-01.jpg');
    expect(jpegName('page-01.jpg')).toBe('page-01.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
  });
});
