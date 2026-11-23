/**
 * BAK-08 on the phone: a photo is resized and re-encoded before it is queued or uploaded, with the limits the API sends
 * (`MeDto.photoLimits`, the same as the web's), unless the person keeps their originals (Profile). PDFs go as they are.
 * The image manipulator draws the photo upright from its EXIF orientation, and the JPEG it saves carries no EXIF, so a
 * photo's location stays on the phone. The manipulator itself is passed in (`photo-tool.ts`), so this is tested
 * without a device.
 */
import {
  nextPhotoQuality,
  photoSkipReason,
  photoTargetSize,
  pickPhotoUpload,
  type PhotoUploadSettings,
} from '@montra/schemas';

export interface PhotoTool {
  /** The photo's upright size, or null when it can't be read. */
  size(uri: string): Promise<{ width: number; height: number } | null>;
  /** A JPEG of the photo at `width` × `height` and `quality` (0–1), as a new file. */
  encode(uri: string, width: number, height: number, quality: number): Promise<string>;
  bytes(uri: string): number;
  remove(uri: string): void;
}

export interface PhotoFile<T extends string = string> {
  uri: string;
  type: T;
}

/** `page` compressed (a new JPEG file), or `page` itself when it isn't a photo, originals are kept or it can't help. */
export async function compressPhoto<T extends string>(
  page: PhotoFile<T>,
  settings: PhotoUploadSettings,
  tool: PhotoTool,
): Promise<PhotoFile<T | 'image/jpeg'> & { compressed: boolean }> {
  const same = { uri: page.uri, type: page.type, compressed: false };
  if (photoSkipReason(page.type, settings)) return same;
  const size = await tool.size(page.uri);
  if (!size) return same;
  const target = photoTargetSize(size.width, size.height, settings.maxEdgePx);
  let quality: number | null = settings.quality;
  let out: string | null = null;
  while (quality !== null) {
    if (out) tool.remove(out);
    out = await tool.encode(page.uri, target.width, target.height, quality / 100);
    quality = nextPhotoQuality(quality, tool.bytes(out), settings);
  }
  if (!out) return same;
  const pick = pickPhotoUpload({
    originalType: page.type,
    originalBytes: tool.bytes(page.uri),
    encodedBytes: tool.bytes(out),
    resized: target.resized,
  });
  if (pick === 'original') {
    tool.remove(out);
    return same;
  }
  return { uri: out, type: 'image/jpeg', compressed: true };
}

/** A file name for the compressed copy: the same name, saved as JPEG. */
export const jpegName = (name: string): string => `${name.replace(/\.[^./\\]*$/, '') || 'photo'}.jpg`;
