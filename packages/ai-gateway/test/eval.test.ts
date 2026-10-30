import { describe, expect, it } from 'vitest';
import { generateBenchmark } from '../eval/generate.js';
import { loadBenchmark, runEval } from '../eval/harness.js';

describe('benchmark v1 (AIA-09)', () => {
  it('is committed, matches the generator and is stratified', () => {
    const committed = loadBenchmark();
    const fresh = generateBenchmark();
    expect(committed.rows.length).toBeGreaterThanOrEqual(5200);
    expect(committed.rows).toEqual(fresh.rows);
    expect(committed.categories).toEqual(fresh.categories);
    expect(committed.categories.length).toBeGreaterThanOrEqual(30);
    for (const c of committed.categories) {
      const rows = committed.rows.filter((r) => r.label === c.name);
      const test = rows.filter((r) => r.split === 'test').length;
      expect(test / rows.length).toBeCloseTo(0.2, 1);
    }
    expect(new Set(committed.categories.map((c) => c.entityType))).toEqual(
      new Set(['personal', 'business', 'rental']),
    );
  });

  it('runs end to end through the gateway with the fake provider', async () => {
    const report = await runEval({ provider: { id: 'fake' }, split: 'test', limit: 200 });
    expect(report.rows).toBe(200);
    for (const k of ['accuracy', 'coverage', 'macroF1', 'ece'] as const) {
      expect(report[k]).toBeGreaterThanOrEqual(0);
      expect(report[k]).toBeLessThanOrEqual(1);
    }
    expect(report.calls).toBeGreaterThan(0);
    expect(report.perCategory.length).toBeGreaterThanOrEqual(30);
    expect(report.costUsd).toBe(0);
    expect(report.suggestedCalibration[0]![0]).toBe(0);
  });
});
