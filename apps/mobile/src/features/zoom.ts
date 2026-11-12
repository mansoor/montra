/**
 * Pinch-to-zoom geometry for the receipt viewer (RCP-14). Pure, and marked as worklets so the gesture callbacks can
 * call them on the UI thread. Offsets are the view's translation in points from its centred position; focal points
 * are relative to the view's centre.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** Where a double tap zooms to. */
export const TAP_ZOOM = 2.5;

export function clampZoom(scale: number): number {
  'worklet';
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** How far the content may move each way before an edge of the zoomed content leaves the view's edge. */
export function maxOffset(size: number, scale: number): number {
  'worklet';
  return Math.max(0, (size * scale - size) / 2);
}

export function clampOffset(offset: number, size: number, scale: number): number {
  'worklet';
  const limit = maxOffset(size, scale);
  return Math.min(limit, Math.max(-limit, offset));
}

/**
 * The offset that keeps the point under the fingers in place while zooming from `fromScale` to `toScale`: the point
 * at focal `f` shows content point (f - offset) / scale, and stays under `f` at the new scale.
 */
export function offsetForZoom(focal: number, offset: number, fromScale: number, toScale: number): number {
  'worklet';
  return focal - ((focal - offset) * toScale) / fromScale;
}
