import { z } from 'zod';

/**
 * BAK-08: photos are compressed before they upload, on the web and on the phone, to about 1 MB (07 §BAK-08): the long
 * edge fits `maxEdgePx` and the picture is saved as JPEG at `quality`, stepping down to `minQuality` while it is still
 * over `targetBytes`. Re-encoding applies the EXIF orientation and drops the rest of the metadata, location included.
 * PDFs and other files are never touched, and a person can keep their originals instead (`keepOriginal`).
 *
 * The limits are API settings (`PHOTO_*` in the API config), sent to the clients with `MeDto.photoLimits`. These are
 * their defaults, and what a client uses before it has heard from the API (the phone offline, an older cached profile).
 */
export const PHOTO_UPLOAD_DEFAULTS = {
  maxEdgePx: 2000,
  /** JPEG quality in percent (0–100); the canvas and the phone's image manipulator take it divided by 100. */
  quality: 80,
  minQuality: 60,
  targetBytes: 1_048_576,
} as const;

export const PhotoUploadLimits = z
  .object({
    maxEdgePx: z.number().int().min(320).max(10_000),
    quality: z.number().int().min(10).max(100),
    minQuality: z.number().int().min(10).max(100),
    targetBytes: z.number().int().min(65_536),
  })
  .refine((l) => l.minQuality <= l.quality, { message: 'minQuality must not be above quality' });
export type PhotoUploadLimits = z.infer<typeof PhotoUploadLimits>;

export interface PhotoUploadSettings extends PhotoUploadLimits {
  keepOriginal: boolean;
}

/** What a client compresses with: the API's limits and the person's choice, or the defaults where it hasn't heard. */
export function photoUploadSettings(
  me?: { photoLimits?: PhotoUploadLimits | null; keepOriginalPhotos?: boolean | null } | null,
): PhotoUploadSettings {
  return {
    ...PHOTO_UPLOAD_DEFAULTS,
    ...(me?.photoLimits ?? {}),
    keepOriginal: me?.keepOriginalPhotos ?? false,
  };
}

/** The photo types that are re-encoded. Anything else (PDF, HEIC the browser can't draw, CSV) goes as it is. */
export const COMPRESSIBLE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type PhotoSkipReason = 'not_photo' | 'keep_original';

/** Whether a file is re-encoded before upload, and why not when it isn't. */
export function photoSkipReason(
  type: string | null | undefined,
  settings: Pick<PhotoUploadSettings, 'keepOriginal'>,
): PhotoSkipReason | null {
  const t = (type ?? '').toLowerCase().split(';')[0]!.trim();
  if (!(COMPRESSIBLE_PHOTO_TYPES as readonly string[]).includes(t)) return 'not_photo';
  if (settings.keepOriginal) return 'keep_original';
  return null;
}

/** The size to draw at: the long edge fits `maxEdgePx`, the shape stays, and nothing is made bigger. */
export function photoTargetSize(
  width: number,
  height: number,
  maxEdgePx: number,
): { width: number; height: number; resized: boolean } {
  const long = Math.max(width, height);
  if (long <= maxEdgePx) return { width, height, resized: false };
  const fit = (side: number) => Math.max(1, Math.floor((side * maxEdgePx) / long));
  return { width: fit(width), height: fit(height), resized: true };
}

/**
 * The next quality to try after an encode of `bytes` at `quality`: 10 points lower while the picture is over
 * `targetBytes`, never under `minQuality`. Null when this one is kept.
 */
export function nextPhotoQuality(
  quality: number,
  bytes: number,
  limits: Pick<PhotoUploadLimits, 'minQuality' | 'targetBytes'>,
): number | null {
  if (bytes <= limits.targetBytes || quality <= limits.minQuality) return null;
  return Math.max(limits.minQuality, quality - 10);
}

/**
 * Which file to upload once the photo has been re-encoded. The compressed copy, unless it came out no smaller, wasn't
 * resized and the original isn't a JPEG: a PNG screenshot often is smaller as it is, while a JPEG photo is always sent
 * re-encoded, so its location and other EXIF data never leave the device.
 */
export function pickPhotoUpload(input: {
  originalType: string;
  originalBytes: number;
  encodedBytes: number;
  resized: boolean;
}): 'encoded' | 'original' {
  if (input.resized || input.originalType.toLowerCase() === 'image/jpeg') return 'encoded';
  return input.encodedBytes < input.originalBytes ? 'encoded' : 'original';
}
