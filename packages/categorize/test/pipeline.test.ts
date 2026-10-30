import { describe, expect, it, vi } from 'vitest';
import { compileRules, runPipeline, type AiSuggestion, type PipelineItem } from '../src/index.js';
import { d, deps, item, rule } from './fixtures.js';

const ai = (map: Record<string, AiSuggestion>) =>
  vi.fn(
    async (open: readonly PipelineItem[]) =>
      new Map(open.filter((o) => map[o.id]).map((o) => [o.id, map[o.id]!])),
  );

describe('runPipeline', () => {
  it('a rule closes the item at confidence 1', async () => {
    const r = rule({ name: 'Shell → Fuel', actions: { categoryId: 'cat-fuel', tags: ['car'] } });
    const aiFn = ai({});
    const [dec] = await runPipeline([item()], deps({ rules: compileRules([r]).rules, ai: aiFn }));
    expect(dec).toMatchObject({
      step: 'rule',
      categoryId: 'cat-fuel',
      entityId: 'ent-personal',
      confidence: 1,
      explanation: "Matched rule 'Shell → Fuel'",
      ruleId: r.id,
      matchedRuleIds: [r.id],
      tags: ['car'],
      autoApply: true,
    });
    expect(aiFn).not.toHaveBeenCalled();
  });

  it('a transfer closes the item; only ≥ 0.95 auto-applies', async () => {
    const candidate = {
      transactionId: 't2',
      accountId: 'acct-sav',
      accountName: 'Savings',
      accountLast4: null,
      amountMinor: 4200n,
      date: d('2026-10-14'),
    };
    const sure = item({ id: 'a', payee: null, payeeKey: null, description: 'ONLINE TRANSFER TO SAV' });
    const unsure = item({ id: 'b', payee: 'Bob', payeeKey: 'BOB', description: 'Bob' });
    const aiFn = ai({
      b: { categoryId: 'cat-x', memberId: null, tags: [], confidence: 0.99, explanation: 'AI' },
    });
    const [a, b] = await runPipeline(
      [sure, unsure],
      deps({ transferCandidates: () => [candidate], ai: aiFn }),
    );
    expect(a).toMatchObject({ step: 'transfer', transfer: candidate, confidence: 0.95, autoApply: true });
    expect(b).toMatchObject({ step: 'transfer', confidence: 0.6, autoApply: false, categoryId: null });
    expect(aiFn).not.toHaveBeenCalled();
  });

  it('history closes at the threshold, otherwise the AI gets a chance', async () => {
    const strong = item({ id: 'strong', payeeKey: 'SHELL OIL' });
    const weak = item({ id: 'weak', payeeKey: 'WEAK' });
    const history = (k: string) =>
      k === 'SHELL OIL'
        ? [{ amountBand: -11, categoryId: 'cat-fuel', memberId: 'mem-1', count: 8 }]
        : [{ amountBand: -11, categoryId: 'cat-food', memberId: null, count: 2 }];
    const aiFn = ai({
      weak: {
        categoryId: 'cat-coffee',
        memberId: 'mem-ai',
        tags: ['ai'],
        confidence: 0.85,
        explanation: 'AI: coffee',
      },
    });
    const [s, w] = await runPipeline([strong, weak], deps({ history, ai: aiFn }));
    expect(s).toMatchObject({ step: 'history', categoryId: 'cat-fuel', memberId: 'mem-1', autoApply: true });
    expect(aiFn).toHaveBeenCalledTimes(1);
    expect(aiFn.mock.calls[0]![0].map((x) => x.id)).toEqual(['weak']);
    expect(w).toMatchObject({
      step: 'ai',
      categoryId: 'cat-coffee',
      memberId: 'mem-ai',
      tags: ['ai'],
      confidence: 0.85,
      explanation: 'AI: coffee',
      autoApply: true,
    });
  });

  it('keeps a more confident fallback over a weaker AI answer', async () => {
    const history = () => [{ amountBand: -11, categoryId: 'cat-food', memberId: null, count: 3 }];
    const aiFn = ai({
      'row-1': { categoryId: 'cat-x', memberId: null, tags: [], confidence: 0.3, explanation: 'AI' },
    });
    const [dec] = await runPipeline([item()], deps({ history, ai: aiFn }));
    expect(aiFn).toHaveBeenCalledTimes(1);
    expect(dec).toMatchObject({ step: 'history', categoryId: 'cat-food', autoApply: false });
    expect(dec!.confidence).toBeCloseTo(0.6); // share 1 × 3/5
  });

  it('uses the file category and merchant hints', async () => {
    const [f, m] = await runPipeline(
      [
        item({ id: 'f', fileCategoryId: 'cat-groc', fileCategoryName: 'Groceries' }),
        item({ id: 'm', merchant: { id: 'shell', name: 'Shell', categoryId: 'cat-fuel' } }),
      ],
      deps(),
    );
    expect(f).toMatchObject({
      step: 'file',
      confidence: 0.9,
      explanation: 'From the file\'s category "Groceries"',
      autoApply: true,
    });
    expect(m).toMatchObject({
      step: 'merchant',
      confidence: 0.8,
      explanation: 'Known merchant: Shell',
      autoApply: true,
    });
  });

  it('falls through to the review queue', async () => {
    const [dec] = await runPipeline([item({ defaultMemberId: 'mem-default' })], deps());
    expect(dec).toMatchObject({
      step: 'none',
      categoryId: null,
      confidence: 0,
      explanation: 'Needs review',
      memberId: 'mem-default',
      entityId: 'ent-personal',
      autoApply: false,
    });
  });

  it('degrades when the AI throws', async () => {
    const [dec] = await runPipeline(
      [item()],
      deps({
        ai: async () => {
          throw new Error('provider down');
        },
      }),
    );
    expect(dec!.step).toBe('none');
  });

  it('merges member/tag/rename rules with later category steps', async () => {
    const r = rule({ actions: { memberId: 'mem-rule', tags: ['t'], renamePayee: 'Shell' } });
    const aiFn = ai({
      'row-1': {
        categoryId: 'biz-fuel',
        memberId: 'mem-ai',
        tags: ['x'],
        confidence: 0.9,
        explanation: 'AI',
      },
    });
    const [dec] = await runPipeline([item()], deps({ rules: compileRules([r]).rules, ai: aiFn }));
    expect(dec).toMatchObject({
      step: 'ai',
      categoryId: 'biz-fuel',
      entityId: 'ent-business',
      memberId: 'mem-rule',
      tags: ['t', 'x'],
      renamePayee: 'Shell',
      ruleId: null,
      matchedRuleIds: [r.id],
    });
  });

  it('markReviewed auto-applies regardless of confidence', async () => {
    const r = rule({ actions: { markReviewed: true, tags: ['ok'] } });
    const [dec] = await runPipeline([item()], deps({ rules: compileRules([r]).rules }));
    expect(dec).toMatchObject({ step: 'none', autoApply: true });
  });

  it('entity: the category’s entity, then the rule’s, then the item’s', async () => {
    const r = rule({ actions: { entityId: 'ent-rental', tags: ['x'] } });
    const [dec] = await runPipeline([item()], deps({ rules: compileRules([r]).rules }));
    expect(dec!.entityId).toBe('ent-rental');
  });

  it('respects a higher threshold', async () => {
    const [dec] = await runPipeline(
      [item({ merchant: { id: 'shell', name: 'Shell', categoryId: 'cat-fuel' } })],
      deps({ threshold: 0.9 }),
    );
    expect(dec).toMatchObject({ step: 'merchant', autoApply: false });
  });

  it('returns decisions in input order', async () => {
    const items = ['c', 'a', 'b'].map((id) => item({ id }));
    expect((await runPipeline(items, deps())).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});
