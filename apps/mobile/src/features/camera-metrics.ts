/**
 * Frame quality for receipt and statement capture (TXN-08, Phase 4 camera spike): blur as the variance of the
 * Laplacian of a downscaled grayscale image (low variance = few edges = blurry) and glare as the share of
 * near-white pixels. Pure TypeScript over RGBA bytes so it runs on device and in tests.
 */

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** ITU-R BT.601 luma from RGBA, downscaled by box-averaging to at most `maxSide` pixels on the long side. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, maxSide = 256): Gray {
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const w = Math.max(1, Math.floor(width / scale));
  const h = Math.max(1, Math.floor(height / scale));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < scale; dy++) {
        const sy = y * scale + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < scale; dx++) {
          const sx = x * scale + dx;
          if (sx >= width) break;
          const i = (sy * width + sx) * 4;
          sum += 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
          n++;
        }
      }
      out[y * w + x] = n ? sum / n : 0;
    }
  }
  return { data: out, width: w, height: h };
}

/** Variance of the 4-neighbour Laplacian over interior pixels. */
export function laplacianVariance(g: Gray): number {
  const { data, width: w, height: h } = g;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = data[i - w]! + data[i + w]! + data[i - 1]! + data[i + 1]! - 4 * data[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Share of pixels at or above `threshold` luma (blown-out highlights). */
export function glareShare(g: Gray, threshold = 250): number {
  let hits = 0;
  for (const v of g.data) if (v >= threshold) hits++;
  return g.data.length ? hits / g.data.length : 0;
}

export interface FrameQuality {
  blur: number;
  glare: number;
  sharp: boolean;
  glareOk: boolean;
}

/** Defaults to tune in the spike: blur variance ≥ 100 on a 256-px frame, glare ≤ 5%. */
export const QUALITY_THRESHOLDS = { minBlurVariance: 100, maxGlare: 0.05 };

export function assessFrame(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  t = QUALITY_THRESHOLDS,
): FrameQuality {
  const g = toGray(rgba, width, height);
  const blur = laplacianVariance(g);
  const glare = glareShare(g);
  return { blur, glare, sharp: blur >= t.minBlurVariance, glareOk: glare <= t.maxGlare };
}

// ----- Spike log ------------------------------------------------------------------------------------------

export interface SpikeSample {
  at: string;
  device: string;
  kind: 'receipt' | 'statement';
  /** Shutter press → preview image shown (target < 1.5 s, open question §14.3). */
  latencyMs: number;
  blur: number;
  glare: number;
  /** Did the operator judge the capture usable? */
  usable: boolean | null;
}

export interface SpikeSummary {
  samples: number;
  p50: number;
  p95: number;
  underTarget: number;
  sharpShare: number;
  usableShare: number | null;
  pass: boolean;
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0;

/** Go/no-go criteria from docs/design/spikes/phase4-camera.md: p95 < 1.5 s and ≥ 90% sharp frames. */
export function summarize(samples: readonly SpikeSample[], targetMs = 1500): SpikeSummary {
  const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const judged = samples.filter((s) => s.usable !== null);
  const sharp = samples.filter((s) => s.blur >= QUALITY_THRESHOLDS.minBlurVariance).length;
  const s: SpikeSummary = {
    samples: samples.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    underTarget: samples.length ? lat.filter((l) => l < targetMs).length / samples.length : 0,
    sharpShare: samples.length ? sharp / samples.length : 0,
    usableShare: judged.length ? judged.filter((x) => x.usable).length / judged.length : null,
    pass: false,
  };
  s.pass = s.samples >= 30 && s.p95 < targetMs && s.sharpShare >= 0.9;
  return s;
}
