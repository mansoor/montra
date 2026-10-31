/**
 * Confidence calibration (06 §6). Model-reported confidence is mapped through a monotone piecewise-linear
 * curve fitted (isotonic regression) on the benchmark per provider, model and task. The review threshold
 * applies to the calibrated score, so "accept all above 90%" means the same whichever provider answered.
 *
 * Points are [raw, calibrated] pairs, sorted by raw and non-decreasing in calibrated. Until a curve has been
 * fitted for a model, the identity is used. `pnpm eval` prints a fitted curve to paste here.
 */
import { clamp01 } from '../util.js';

export type CalibrationCurve = ReadonlyArray<readonly [number, number]>;

const IDENTITY: CalibrationCurve = [
  [0, 0],
  [1, 1],
];

/** Key: `${provider}/${model}/${task}`; `${provider}/*\/${task}` applies to every model of a provider. */
export const CALIBRATION: Readonly<Record<string, CalibrationCurve>> = {
  // Local models tend to be over-confident; shrink until a fitted curve exists.
  'openai_compatible/*/categorize': [
    [0, 0],
    [0.5, 0.4],
    [0.9, 0.75],
    [1, 0.85],
  ],
};

export function curveFor(provider: string, model: string, task: string): CalibrationCurve {
  return CALIBRATION[`${provider}/${model}/${task}`] ?? CALIBRATION[`${provider}/*/${task}`] ?? IDENTITY;
}

export function applyCurve(curve: CalibrationCurve, raw: number): number {
  const x = clamp01(raw);
  if (curve.length === 0) return x;
  if (x <= curve[0]![0]) return clamp01(curve[0]![1]);
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]!;
    const [x0, y0] = curve[i - 1]!;
    if (x <= x1) return clamp01(x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0));
  }
  return clamp01(curve[curve.length - 1]![1]);
}

export function calibrate(provider: string, model: string, task: string, raw: number): number {
  return applyCurve(curveFor(provider, model, task), raw);
}

/**
 * Fits an isotonic (pool-adjacent-violators) curve from (raw confidence, correct?) pairs, reduced to at most
 * `maxPoints` knots. Used by the evaluation harness.
 */
export function fitIsotonic(
  samples: ReadonlyArray<{ raw: number; correct: boolean }>,
  maxPoints = 8,
): CalibrationCurve {
  if (samples.length === 0) return IDENTITY;
  const sorted = [...samples].sort((a, b) => a.raw - b.raw);
  const blocks: { sum: number; n: number; lo: number; hi: number }[] = [];
  for (const s of sorted) {
    blocks.push({ sum: s.correct ? 1 : 0, n: 1, lo: s.raw, hi: s.raw });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n, lo: a.lo, hi: b.hi });
    }
  }
  const pts = blocks.map((b) => [(b.lo + b.hi) / 2, b.sum / b.n] as const);
  const step = Math.max(1, Math.ceil(pts.length / maxPoints));
  const reduced = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const curve: [number, number][] = [[0, Math.min(reduced[0]![1], 1)]];
  for (const [x, y] of reduced)
    if (x > curve[curve.length - 1]![0]) curve.push([x, Math.max(y, curve[curve.length - 1]![1])]);
  if (curve[curve.length - 1]![0] < 1) curve.push([1, curve[curve.length - 1]![1]]);
  return curve;
}
