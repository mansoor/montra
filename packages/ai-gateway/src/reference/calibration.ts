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
  // Fitted on the benchmark's train split (4,224 rows, 2026-11-21; 97.3% right). Claude Haiku under-states its
  // confidence: identity had ECE 0.140 on the test split, this curve 0.011. At the 95% AI threshold, 89.6% of test rows
  // apply at 99.2% precision. Refit with `pnpm --filter @montra/ai-gateway eval -- --provider anthropic --split train`.
  'anthropic/claude-haiku-5-5/categorize': [
    [0, 0.091],
    [0.35, 0.091],
    [0.4, 0.924],
    [0.6, 0.924],
    [0.65, 0.988],
    [0.9, 0.988],
    [0.95, 0.998],
    [1, 0.998],
  ],
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
 * Fits an isotonic (pool-adjacent-violators) curve from (raw confidence, correct?) pairs. Used by the evaluation
 * harness. Each block keeps its range of raw scores as a flat level, so a wide block of right answers isn't drawn as a
 * slope from its middle. Adjacent blocks with the closest levels are merged until there are at most `maxPoints / 2`,
 * and each level is smoothed ((right + 1) / (n + 2)), so a small block never claims 0% or 100%.
 */
export function fitIsotonic(
  samples: ReadonlyArray<{ raw: number; correct: boolean }>,
  maxPoints = 12,
): CalibrationCurve {
  if (samples.length === 0) return IDENTITY;
  const sorted = [...samples].sort((a, b) => a.raw - b.raw);
  type Block = { sum: number; n: number; lo: number; hi: number };
  const merge = (a: Block, b: Block): Block => ({ sum: a.sum + b.sum, n: a.n + b.n, lo: a.lo, hi: b.hi });
  const blocks: Block[] = [];
  for (const s of sorted) {
    const raw = clamp01(s.raw);
    const last = blocks[blocks.length - 1];
    // Equal scores are one observation of that score.
    if (last && last.hi === raw) {
      last.sum += s.correct ? 1 : 0;
      last.n++;
    } else blocks.push({ sum: s.correct ? 1 : 0, n: 1, lo: raw, hi: raw });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n < b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, merge(a, b));
    }
  }
  const most = Math.max(1, Math.floor(maxPoints / 2));
  while (blocks.length > most) {
    let at = 0;
    let gap = Infinity;
    for (let i = 0; i + 1 < blocks.length; i++) {
      const g = blocks[i + 1]!.sum / blocks[i + 1]!.n - blocks[i]!.sum / blocks[i]!.n;
      if (g < gap) [at, gap] = [i, g];
    }
    blocks.splice(at, 2, merge(blocks[at]!, blocks[at + 1]!));
  }
  const r3 = (v: number) => Math.trunc(v * 1000 + 0.5) / 1000;
  const curve: [number, number][] = [];
  let level = 0;
  for (const b of blocks) {
    level = Math.max(level, r3((b.sum + 1) / (b.n + 2)));
    for (const x of b.hi > b.lo ? [b.lo, b.hi] : [b.lo]) {
      const prev = curve[curve.length - 1];
      if (prev && prev[0] === r3(x)) prev[1] = level;
      else curve.push([r3(x), level]);
    }
  }
  if (curve[0]![0] > 0) curve.unshift([0, curve[0]![1]]);
  if (curve[curve.length - 1]![0] < 1) curve.push([1, curve[curve.length - 1]![1]]);
  return curve;
}
