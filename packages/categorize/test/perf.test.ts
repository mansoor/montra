import { describe, expect, it } from 'vitest';
import { compileRules, runPipeline, type RuleRecord } from '../src/index.js';
import { deps, item } from './fixtures.js';

describe('performance', () => {
  it('runs 5,000 items against 100 rules in under 2 s', async () => {
    const ops = ['contains', 'starts_with', 'regex'] as const;
    const rules: RuleRecord[] = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      name: `Rule ${i}`,
      entityId: null,
      priority: i,
      conditions: {
        all: [
          {
            field: 'payee',
            op: ops[i % 3]!,
            value: ops[i % 3] === 'regex' ? `merchant ${i}\\b|store ${i}$` : `merchant ${i}`,
          },
          { field: 'amount', op: 'between', value: ['-500.00', '-1.00'] },
        ],
      },
      actions: { categoryId: `cat-${i}`, tags: ['auto'] },
      enabled: true,
      createdAt: '2026-01-01T00:00:00Z',
    }));
    const compiled = compileRules(rules).rules;
    const items = Array.from({ length: 5000 }, (_, i) =>
      item({
        id: `row-${i}`,
        payee: `Merchant ${i % 150} Downtown`,
        payeeKey: `MERCHANT ${i % 150}`,
        description: `MERCHANT ${i % 150} #${i} SEATTLE WA`,
        amountMinor: -BigInt(100 + (i % 40_000)),
      }),
    );
    const history = (k: string) => [{ amountBand: -9, categoryId: `hist-${k}`, memberId: null, count: 3 }];
    // Best of three: the budget is about the code, not about other test suites sharing the CPU.
    let ms = Infinity;
    let decisions: Awaited<ReturnType<typeof runPipeline>> = [];
    for (let run = 0; run < 3 && ms >= 2000; run++) {
      const started = performance.now();
      decisions = await runPipeline(items, deps({ rules: compiled, history }));
      ms = Math.min(ms, performance.now() - started);
    }
    console.log(`pipeline: ${items.length} items × ${compiled.length} rules in ${ms.toFixed(0)} ms`);
    expect(decisions).toHaveLength(5000);
    expect(decisions.filter((x) => x.step === 'rule').length).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(2000);
  }, 30_000);
});
