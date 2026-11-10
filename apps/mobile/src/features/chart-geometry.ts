/**
 * Geometry for the phone's line charts (FLOW-01): the value range, each series' points and which x labels to draw.
 * Amounts become numbers only for drawing; labels are formatted from the exact minor units.
 */

export interface Box {
  width: number;
  height: number;
  /** Room for the y labels (left) and x labels (bottom). */
  left: number;
  bottom: number;
  top: number;
  right: number;
}

/** The range to draw: from zero when asked (flows), else just around the values (a balance that moves in a band). */
export function valueRange(values: readonly number[], fromZero: boolean): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...values, ...(fromZero ? [0] : []));
  let max = Math.max(...values, ...(fromZero ? [0] : []));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return { min, max };
}

export function linePoints(
  values: readonly number[],
  box: Box,
  range: { min: number; max: number },
): Array<{ x: number; y: number }> {
  const n = Math.max(1, values.length - 1);
  const w = box.width - box.left - box.right;
  const h = box.height - box.top - box.bottom;
  return values.map((v, i) => ({
    x: box.left + (values.length === 1 ? w / 2 : (i / n) * w),
    y: box.top + (1 - (v - range.min) / (range.max - range.min)) * h,
  }));
}

/**
 * Which x labels to draw: every `step`-th from the first, and the last, at most about `max`; one too close to the
 * last gives way (the web chart's rule), so the gaps stay even.
 */
export function labelIndexes(count: number, max: number): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(count / max));
  const last = count - 1;
  return Array.from({ length: count }, (_, i) => i).filter(
    (i) => i === last || (i % step === 0 && last - i >= step),
  );
}
