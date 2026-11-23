/**
 * The phone's photo compression (BAK-08) on expo-image-manipulator: it loads the photo upright (EXIF orientation
 * applied), and what it saves has no EXIF, so no location. The decisions are in `features/photos.ts`.
 */
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { PhotoUploadSettings } from '@montra/schemas';
import { compressPhoto, type PhotoFile, type PhotoTool } from '../features/photos';

export const expoPhotoTool: PhotoTool = {
  async size(uri) {
    try {
      const ctx = ImageManipulator.manipulate(uri);
      const img = await ctx.renderAsync();
      const size = { width: img.width, height: img.height };
      img.release();
      ctx.release();
      return size;
    } catch {
      return null;
    }
  },
  async encode(uri, width, height, quality) {
    const ctx = ImageManipulator.manipulate(uri).resize({ width, height });
    const img = await ctx.renderAsync();
    try {
      return (await img.saveAsync({ compress: quality, format: SaveFormat.JPEG })).uri;
    } finally {
      img.release();
      ctx.release();
    }
  },
  bytes(uri) {
    const size: number | null = new File(uri).size;
    return size ?? 0;
  },
  remove(uri) {
    const f = new File(uri);
    if (f.exists) f.delete();
  },
};

/** `compressPhoto` with the device's manipulator; a page it can't read goes as it is. */
export async function compressForUpload<T extends string>(
  page: PhotoFile<T>,
  settings: PhotoUploadSettings,
): Promise<PhotoFile<T | 'image/jpeg'> & { compressed: boolean }> {
  try {
    return await compressPhoto(page, settings, expoPhotoTool);
  } catch {
    return { uri: page.uri, type: page.type, compressed: false };
  }
}
