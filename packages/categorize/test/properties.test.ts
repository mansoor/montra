import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { amountBand, applyRules, compileRules, runPipeline, type RuleRecord } from '../src/index.js';
import { deps, item, subject } from './fixtures.js';

const minor = fc.bigInt({ min: 0n, max: 10n ** 15n });

describe('properties', () => {
  it('amountBand is monotone in |amount| and sign-symmetric', () => {
    fc.assert(
      fc.property(minor, minor, fc.integer({ min: 0, max: 4 }), (a, b, exp) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(amountBand(lo, exp)).toBeLessThanOrEqual(amountBand(hi, exp));
        expect(amountBand(-a, exp) + 0).toBe(-amountBand(a, exp) + 0); // +0 folds -0
      }),
    );
  });

  const words = ['shell', 'oil', 'bp', 'cafe', 'amazon', 'netflix'];
  const ruleArb = fc.record({
    word: fc.constantFrom(...words),
    priority: fc.integer({ min: 0, max: 5 }),
    category: fc.option(fc.constantFrom('c1', 'c2', 'c3'), { nil: undefined }),
    tag: fc.constantFrom('t1', 't2'),
    enabled: fc.boolean(),
  });

  it('applyRules is deterministic and the first matching rule in order sets the category', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 12 }), fc.constantFrom(...words), (specs, payeeWord) => {
        const records: RuleRecord[] = specs.map((s, i) => ({
          id: `r${String(i).padStart(2, '0')}`,
          name: `r${i}`,
          entityId: null,
          priority: s.priority,
          conditions: { all: [{ field: 'payee', op: 'contains', value: s.word }] },
          actions: s.category ? { categoryId: s.category, tags: [s.tag] } : { tags: [s.tag] },
          enabled: s.enabled,
          createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        }));
        const subj = subject({ payee: payeeWord, payeeKey: payeeWord.toUpperCase() });
        const { rules } = compileRules(records);
        const a = applyRules(rules, subj);
        expect(applyRules(compileRules([...records].reverse()).rules, subj)).toEqual(a);

        const ordered = records
          .filter((r) => r.enabled && r.conditions.all.some((c) => 'value' in c && c.value === payeeWord))
          .sort((x, y) => x.priority - y.priority || (x.createdAt < y.createdAt ? -1 : 1));
        const firstCat = ordered.find((r) => r.actions.categoryId);
        expect(a.actions.categoryId).toBe(firstCat?.actions.categoryId);
        expect(a.matchedRuleIds).toEqual(ordered.map((r) => r.id));
      }),
    );
  });

  it('never auto-applies below the threshold unless a rule says reviewed', async () => {
    const conf = fc.double({ min: 0, max: 1, noNaN: true });
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            history: fc.integer({ min: 0, max: 8 }),
            merchant: fc.boolean(),
            file: fc.boolean(),
            ai: fc.option(conf, { nil: undefined }),
            reviewed: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.double({ min: 0.5, max: 0.99, noNaN: true }),
        async (specs, threshold) => {
          const items = specs.map((s, i) =>
            item({
              id: `i${i}`,
              payee: s.reviewed ? 'Reviewed Payee' : `Payee ${i}`,
              payeeKey: `P${i}`,
              fileCategoryId: s.file ? 'cat-file' : null,
              fileCategoryName: 'File',
              merchant: s.merchant ? { id: 'm', name: 'M', categoryId: 'cat-m' } : null,
            }),
          );
          const reviewedRule: RuleRecord = {
            id: 'rv',
            name: 'reviewed',
            entityId: null,
            priority: 1,
            conditions: { all: [{ field: 'payee', op: 'equals', value: 'reviewed payee' }] },
            actions: { markReviewed: true },
            enabled: true,
            createdAt: '2026-01-01T00:00:00Z',
          };
          const decisions = await runPipeline(
            items,
            deps({
              threshold,
              rules: compileRules([reviewedRule]).rules,
              history: (k) => {
                const n = specs[Number(k.slice(1))]!.history;
                return n ? [{ amountBand: -11, categoryId: 'cat-h', memberId: null, count: n }] : [];
              },
              ai: async (open) =>
                new Map(
                  open
                    .filter((o) => specs[Number(o.id.slice(1))]!.ai !== undefined)
                    .map((o) => [
                      o.id,
                      {
                        categoryId: 'cat-ai',
                        memberId: null,
                        tags: [],
                        confidence: specs[Number(o.id.slice(1))]!.ai!,
                        explanation: 'AI',
                      },
                    ]),
                ),
            }),
          );
          decisions.forEach((dec, i) => {
            if (dec.autoApply && !specs[i]!.reviewed) {
              expect(dec.confidence).toBeGreaterThanOrEqual(threshold);
              expect(dec.categoryId).not.toBeNull();
            }
          });
        },
      ),
    );
  });
});
