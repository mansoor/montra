/**
 * Evaluation harness (AIA-09, 06 §7): runs the benchmark through the real gateway (minimizer, batching,
 * calibration) with an in-memory store, and reports accuracy, macro-F1, calibration error, latency and cost.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, type GatewayOptions } from '../src/gateway.js';
import { MemoryStore } from '../src/memory-store.js';
import { fitIsotonic, type CalibrationCurve } from '../src/reference/calibration.js';
import type { AiContext, CategorizeItem, CategoryOption, ProviderConfig } from '../src/types.js';
import type { BenchCategory, BenchRow } from './generate.js';

const here = dirname(fileURLToPath(import.meta.url));

export function loadBenchmark(): { categories: BenchCategory[]; rows: BenchRow[] } {
  const categories = JSON.parse(
    readFileSync(join(here, 'benchmark', 'categories.v1.json'), 'utf8'),
  ) as BenchCategory[];
  const rows = readFileSync(join(here, 'benchmark', 'categorize.v1.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BenchRow);
  return { categories, rows };
}

export interface EvalOptions {
  provider: ProviderConfig;
  split: 'train' | 'test' | 'all';
  limit?: number;
  /** Review threshold for the auto-apply metrics (default 0.80). */
  threshold?: number;
  gatewayOptions?: GatewayOptions;
}

export interface EvalReport {
  task: 'categorize';
  provider: string;
  model: string;
  promptVersion: string;
  split: string;
  rows: number;
  accuracy: number;
  coverage: number;
  macroF1: number;
  /** Expected calibration error over 10 equal-width bins of calibrated confidence. */
  ece: number;
  autoApply: { threshold: number; share: number; precision: number };
  latencyMs: { p50: number; p95: number; total: number };
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  perCategory: Array<{ label: string; support: number; precision: number; recall: number; f1: number }>;
  /** Isotonic curve fitted on raw confidence, to paste into reference/calibration.ts. */
  suggestedCalibration: CalibrationCurve;
}

const r4 = (n: number) => Number(n.toFixed(4));

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const bench = loadBenchmark();
  let rows = opts.split === 'all' ? bench.rows : bench.rows.filter((r) => r.split === opts.split);
  if (opts.limit) {
    // Keep the sample stratified: take every k-th row.
    const k = Math.max(1, Math.floor(rows.length / opts.limit));
    rows = rows.filter((_, i) => i % k === 0).slice(0, opts.limit);
  }
  const threshold = opts.threshold ?? 0.8;
  const categories: CategoryOption[] = bench.categories.map((c) => ({
    id: c.id,
    name: c.name,
    group: c.group,
    kind: c.kind,
    entityId: c.entityType,
    entityType: c.entityType,
  }));
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  const store = new MemoryStore();
  const ctx: AiContext = {
    workspaceId: 'eval',
    mode: 'builtin',
    provider: opts.provider,
    budget: { monthlyUsd: null, spentMicroUsd: 0n },
    store,
  };
  const items: CategorizeItem[] = rows.map((r) => ({
    id: r.id,
    payee: r.payee,
    description: r.description,
    amountMinor: BigInt(r.amountMinor),
    currency: r.currency,
    date: r.date,
    accountType: r.accountType,
    entityType: r.entityType,
  }));
  const gw = createGateway(opts.gatewayOptions);
  const started = Date.now();
  const res = await gw.categorize(items, { categories, members: [] }, ctx);
  const total = Date.now() - started;
  if (!res.ok) throw new Error(`categorize failed: ${res.reason} ${res.detail ?? ''}`);

  const labels = [...new Set(rows.map((r) => r.label))].sort();
  const tp = new Map<string, number>();
  const fp = new Map<string, number>();
  const fn = new Map<string, number>();
  let correct = 0;
  let answered = 0;
  let autoN = 0;
  let autoCorrect = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, correct: 0 }));
  const samples: { raw: number; correct: boolean }[] = [];
  res.value.forEach((out, i) => {
    const truth = rows[i]!.label;
    const pred = out.categoryId ? nameOf.get(out.categoryId)! : null;
    const ok = pred === truth;
    if (pred) {
      answered++;
      if (ok) tp.set(truth, (tp.get(truth) ?? 0) + 1);
      else fp.set(pred, (fp.get(pred) ?? 0) + 1);
    }
    if (!ok) fn.set(truth, (fn.get(truth) ?? 0) + 1);
    if (ok) correct++;
    if (out.confidence >= threshold) {
      autoN++;
      if (ok) autoCorrect++;
    }
    const b = bins[Math.min(9, Math.floor(out.confidence * 10))]!;
    b.n++;
    b.conf += out.confidence;
    b.correct += ok ? 1 : 0;
    samples.push({ raw: out.rawConfidence, correct: ok });
  });
  const perCategory = labels.map((label) => {
    const t = tp.get(label) ?? 0;
    const precision = t + (fp.get(label) ?? 0) ? t / (t + (fp.get(label) ?? 0)) : 0;
    const recall = t + (fn.get(label) ?? 0) ? t / (t + (fn.get(label) ?? 0)) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return {
      label,
      support: rows.filter((r) => r.label === label).length,
      precision: r4(precision),
      recall: r4(recall),
      f1: r4(f1),
    };
  });
  const n = rows.length || 1;
  const ece = bins.reduce((s, b) => (b.n ? s + (b.n / n) * Math.abs(b.correct / b.n - b.conf / b.n) : s), 0);
  const okEvents = store.events.filter((e) => e.outcome === 'ok');
  return {
    task: 'categorize',
    provider: opts.provider.id,
    model: res.meta.model,
    promptVersion: res.meta.promptVersion,
    split: opts.split,
    rows: rows.length,
    accuracy: r4(correct / n),
    coverage: r4(answered / n),
    macroF1: r4(perCategory.reduce((s, c) => s + c.f1, 0) / (perCategory.length || 1)),
    ece: r4(ece),
    autoApply: { threshold, share: r4(autoN / n), precision: r4(autoN ? autoCorrect / autoN : 0) },
    latencyMs: {
      p50: percentile(
        okEvents.map((e) => e.latencyMs ?? 0),
        50,
      ),
      p95: percentile(
        okEvents.map((e) => e.latencyMs ?? 0),
        95,
      ),
      total,
    },
    calls: store.calls,
    tokensIn: res.meta.tokensIn,
    tokensOut: res.meta.tokensOut,
    costUsd: Number(store.spentMicroUsd) / 1_000_000,
    perCategory,
    suggestedCalibration: fitIsotonic(samples),
  };
}
