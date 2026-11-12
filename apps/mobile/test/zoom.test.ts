import { describe, expect, it } from 'vitest';
import { clampOffset, clampZoom, MAX_ZOOM, maxOffset, MIN_ZOOM, offsetForZoom } from '../src/features/zoom';

describe('receipt zoom geometry (RCP-14)', () => {
  it('keeps the zoom between the whole page and five times', () => {
    expect(clampZoom(0.4)).toBe(MIN_ZOOM);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
  });

  it('lets a zoomed page move only until its edge reaches the view edge', () => {
    expect(maxOffset(300, 1)).toBe(0);
    expect(maxOffset(300, 2)).toBe(150);
    expect(clampOffset(400, 300, 2)).toBe(150);
    expect(clampOffset(-400, 300, 2)).toBe(-150);
    expect(clampOffset(40, 300, 1)).toBe(0);
  });

  it('keeps the point under the fingers in place while zooming', () => {
    // Fingers 100 pt right of centre on an unzoomed page; doubling the zoom moves the page 100 pt left.
    const offset = offsetForZoom(100, 0, 1, 2);
    expect(offset).toBe(-100);
    // The content point under the fingers is the same before and after: (focal - offset) / scale.
    expect((100 - offset) / 2).toBe((100 - 0) / 1);
    // Zooming back out from there returns to the start.
    expect(offsetForZoom(100, offset, 2, 1)).toBe(0);
  });
});
