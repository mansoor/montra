import { describe, expect, it } from 'vitest';
import {
  MeDto,
  nextPhotoQuality,
  PHOTO_UPLOAD_DEFAULTS,
  photoSkipReason,
  photoTargetSize,
  photoUploadSettings,
  PhotoUploadLimits,
  pickPhotoUpload,
  UpdateMeRequest,
} from '../src/index.js';

const on = { keepOriginal: false };

describe('photo uploads (BAK-08)', () => {
  it('compresses JPEG, PNG and WebP photos, and nothing else', () => {
    expect(photoSkipReason('image/jpeg', on)).toBeNull();
    expect(photoSkipReason('image/png', on)).toBeNull();
    expect(photoSkipReason('IMAGE/WEBP', on)).toBeNull();
    expect(photoSkipReason('image/jpeg; charset=binary', on)).toBeNull();
    expect(photoSkipReason('application/pdf', on)).toBe('not_photo');
    expect(photoSkipReason('image/heic', on)).toBe('not_photo');
    expect(photoSkipReason('image/gif', on)).toBe('not_photo');
    expect(photoSkipReason('text/csv', on)).toBe('not_photo');
    expect(photoSkipReason('', on)).toBe('not_photo');
    expect(photoSkipReason(undefined, on)).toBe('not_photo');
  });

  it('leaves photos alone when the person keeps originals, and a PDF is still not a photo', () => {
    expect(photoSkipReason('image/jpeg', { keepOriginal: true })).toBe('keep_original');
    expect(photoSkipReason('application/pdf', { keepOriginal: true })).toBe('not_photo');
  });

  it('fits the long edge, keeps the shape and never makes a photo bigger', () => {
    expect(photoTargetSize(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500, resized: true });
    expect(photoTargetSize(3024, 4032, 2000)).toEqual({ width: 1500, height: 2000, resized: true });
    expect(photoTargetSize(1000, 9000, 2000)).toEqual({ width: 222, height: 2000, resized: true });
    expect(photoTargetSize(2000, 1000, 2000)).toEqual({ width: 2000, height: 1000, resized: false });
    expect(photoTargetSize(640, 480, 2000)).toEqual({ width: 640, height: 480, resized: false });
    // A very thin strip keeps at least a pixel.
    expect(photoTargetSize(100_000, 1, 2000)).toEqual({ width: 2000, height: 1, resized: true });
  });

  it('steps the quality down by 10 while over the target, never under the floor', () => {
    const limits = { minQuality: 60, targetBytes: 1_000_000 };
    expect(nextPhotoQuality(80, 900_000, limits)).toBeNull();
    expect(nextPhotoQuality(80, 1_000_000, limits)).toBeNull();
    expect(nextPhotoQuality(80, 1_500_000, limits)).toBe(70);
    expect(nextPhotoQuality(70, 1_500_000, limits)).toBe(60);
    expect(nextPhotoQuality(60, 1_500_000, limits)).toBeNull();
    expect(nextPhotoQuality(65, 1_500_000, limits)).toBe(60);
  });

  it('sends a JPEG re-encoded always, and a small PNG as it is when that is smaller', () => {
    const base = { originalBytes: 100_000, encodedBytes: 150_000, resized: false };
    expect(pickPhotoUpload({ ...base, originalType: 'image/jpeg' })).toBe('encoded');
    expect(pickPhotoUpload({ ...base, originalType: 'image/png' })).toBe('original');
    expect(pickPhotoUpload({ ...base, originalType: 'image/webp' })).toBe('original');
    expect(pickPhotoUpload({ ...base, originalType: 'image/png', encodedBytes: 100_000 })).toBe('original');
    expect(pickPhotoUpload({ ...base, originalType: 'image/png', encodedBytes: 40_000 })).toBe('encoded');
    expect(pickPhotoUpload({ ...base, originalType: 'image/png', resized: true })).toBe('encoded');
  });

  it("takes the API's limits and the person's choice, or the defaults when it hasn't heard", () => {
    expect(photoUploadSettings()).toEqual({ ...PHOTO_UPLOAD_DEFAULTS, keepOriginal: false });
    expect(photoUploadSettings({})).toEqual({ ...PHOTO_UPLOAD_DEFAULTS, keepOriginal: false });
    const limits = { maxEdgePx: 1600, quality: 75, minQuality: 50, targetBytes: 800_000 };
    expect(photoUploadSettings({ photoLimits: limits, keepOriginalPhotos: true })).toEqual({
      ...limits,
      keepOriginal: true,
    });
  });

  it('checks the limits and carries them on the profile', () => {
    expect(PhotoUploadLimits.safeParse(PHOTO_UPLOAD_DEFAULTS).success).toBe(true);
    expect(PhotoUploadLimits.safeParse({ ...PHOTO_UPLOAD_DEFAULTS, minQuality: 90 }).success).toBe(false);
    expect(PhotoUploadLimits.safeParse({ ...PHOTO_UPLOAD_DEFAULTS, quality: 0 }).success).toBe(false);
    expect(PhotoUploadLimits.safeParse({ ...PHOTO_UPLOAD_DEFAULTS, maxEdgePx: 100 }).success).toBe(false);
    expect(UpdateMeRequest.parse({ keepOriginalPhotos: true })).toEqual({ keepOriginalPhotos: true });
    expect(UpdateMeRequest.safeParse({ keepOriginalPhotos: 'yes' }).success).toBe(false);
    expect(MeDto.shape.photoLimits).toBe(PhotoUploadLimits);
  });
});
