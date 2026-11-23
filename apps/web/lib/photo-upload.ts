/**
 * BAK-08 on the web: a photo is resized and re-encoded in the browser before it uploads, with the same limits as the
 * phone (`MeDto.photoLimits`, the API's `PHOTO_*` settings), unless the person keeps their originals. PDFs and other
 * files go as they are. Drawing the photo applies its EXIF orientation, and the JPEG made from the canvas carries no
 * metadata, so a photo's location doesn't leave the browser.
 */
import {
  nextPhotoQuality,
  photoSkipReason,
  photoTargetSize,
  photoUploadSettings,
  pickPhotoUpload,
  type PhotoUploadSettings,
} from '@montra/schemas';
import { browserApi } from './browser-api';

/** What compressing needs from the browser; tests pass their own. */
export interface PhotoCodec {
  /** The picture upright (EXIF orientation applied), or null when the browser can't read it. */
  decode(
    file: Blob,
  ): Promise<{ width: number; height: number; source: CanvasImageSource; close?: () => void } | null>;
  /** The picture drawn at `width` × `height` on white, as JPEG at `quality` (0–1). */
  encode(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob | null>;
}

export const browserCodec: PhotoCodec = {
  async decode(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
    } catch {
      return null;
    }
  },
  async encode(source, width, height, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return null;
    // JPEG has no transparency: a PNG's clear parts become white, not black.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  },
};

const jpegName = (name: string) => `${name.replace(/\.[^./\\]*$/, '') || 'photo'}.jpg`;

/**
 * The file to upload for `file`: the photo compressed, or `file` itself when it isn't a photo, the person keeps
 * originals, the browser can't read it, or the compressed copy wouldn't help (`pickPhotoUpload`).
 */
export async function preparePhoto(
  file: File,
  settings: PhotoUploadSettings,
  codec: PhotoCodec = browserCodec,
): Promise<File> {
  if (photoSkipReason(file.type, settings)) return file;
  const img = await codec.decode(file);
  if (!img) return file;
  const size = photoTargetSize(img.width, img.height, settings.maxEdgePx);
  let quality: number | null = settings.quality;
  let blob: Blob | null = null;
  try {
    while (quality !== null) {
      blob = await codec.encode(img.source, size.width, size.height, quality / 100);
      if (!blob) return file;
      quality = nextPhotoQuality(quality, blob.size, settings);
    }
  } finally {
    img.close?.();
  }
  if (!blob) return file;
  const pick = pickPhotoUpload({
    originalType: file.type,
    originalBytes: file.size,
    encodedBytes: blob.size,
    resized: size.resized,
  });
  if (pick === 'original') return file;
  return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
}

let cached: Promise<PhotoUploadSettings> | null = null;

/** The signed-in person's choice and the API's limits, read once per page; the defaults if the API can't say. */
export function photoSettings(): Promise<PhotoUploadSettings> {
  cached ??= browserApi.getMe().then(
    (me) => photoUploadSettings(me),
    () => {
      cached = null;
      return photoUploadSettings();
    },
  );
  return cached;
}

/** After the profile changes the choice. */
export function forgetPhotoSettings(): void {
  cached = null;
}

/** `preparePhoto` with the person's settings; `keepOriginal` overrides their choice for this upload. */
export async function photoForUpload(file: File, keepOriginal?: boolean): Promise<File> {
  const s = await photoSettings();
  return preparePhoto(file, keepOriginal === undefined ? s : { ...s, keepOriginal });
}

/** Sends `file` through `send`, compressed first when it's a photo. */
export async function withPhoto<T>(file: File, send: (file: File) => Promise<T>): Promise<T> {
  return send(await photoForUpload(file));
}
