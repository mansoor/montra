import { describe, expect, it } from 'vitest';
import {
  applyRules,
  compileRule,
  compileRules,
  RuleError,
  validateRule,
  type RuleConditions,
} from '../src/index.js';
import { d, rule, subject } from './fixtures.js';

describe('validateRule', () => {
  it('accepts a valid rule', () => {
    expect(
      validateRule(
        {
          all: [
            { field: 'payee', op: 'contains', value: 'shell' },
            { field: 'amount', op: 'between', value: ['-200.00', '-5.00'] },
            { field: 'account', op: 'in', value: ['acct-1'] },
            {
              any: [
                { field: 'date_dow', op: 'in', value: ['0', '6'] },
                { field: 'description', op: 'regex', value: 'fuel|gas' },
              ],
            },
          ],
        },
        { categoryId: 'cat-fuel' },
      ),
    ).toEqual([]);
  });

  it('reports each kind of problem with its path', () => {
    const errors = validateRule(
      {
        all: [
          { field: 'payee', op: 'regex', value: 'x'.repeat(101) },
          { field: 'payee', op: 'regex', value: '(?=look)ahead' },
          { field: 'amount', op: 'between', value: ['-5.00', '-200.00'] },
          { field: 'amount', op: 'between', value: ['abc', '1'] },
          { field: 'amount', op: 'gt', value: '1,000' },
          { field: 'account', op: 'contains', value: 'acct' },
          { field: 'payee', op: 'in', value: 'shell' },
          { field: 'date_dow', op: 'in', value: ['7'] },
          { field: 'payee', op: 'contains', value: ['a'] },
          { any: [] },
        ],
      },
      {},
    );
    expect(errors).toEqual([
      'conditions.all[0]: The pattern is longer than 100 characters',
      expect.stringMatching(/^conditions\.all\[1\]: Invalid pattern/),
      'conditions.all[2]: The first amount must not be greater than the second',
      expect.stringMatching(/^conditions\.all\[3\]: "between" needs two decimal amounts/),
      expect.stringMatching(/^conditions\.all\[4\]: "gt" needs one decimal amount/),
      'conditions.all[5]: "contains" can\'t be used with account',
      'conditions.all[6]: "in" needs a list of values',
      'conditions.all[7]: Days of the week are 0 (Sunday) to 6 (Saturday)',
      'conditions.all[8]: "contains" needs a single text value',
      'conditions.all[9].any: An "any" group needs at least one condition',
      'actions: A rule needs at least one action',
    ]);
  });

  it('needs at least one condition', () => {
    expect(validateRule({ all: [] }, { categoryId: 'c' })).toEqual([
      'conditions.all: A rule needs at least one condition',
    ]);
  });

  it('rejects empty tags and payee names', () => {
    const c: RuleConditions = { all: [{ field: 'payee', op: 'contains', value: 'x' }] };
    expect(validateRule(c, { tags: [''] })[0]).toMatch(/^actions\.tags/);
    expect(validateRule(c, { renamePayee: ' ', categoryId: 'c' })[0]).toMatch(/^actions\.renamePayee/);
  });
});

describe('compileRule', () => {
  it('throws RuleError with the path', () => {
    try {
      compileRule(rule({ conditions: { all: [{ field: 'payee', op: 'regex', value: '(' }] } }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RuleError);
      expect((err as RuleError).path).toBe('conditions.all[0]');
    }
  });

  const matches = (conditions: RuleConditions, over = {}) =>
    compileRule(rule({ conditions })).matches(subject(over));

  it('payee matches the payee text or the payee key', () => {
    expect(matches({ all: [{ field: 'payee', op: 'equals', value: 'shell  oil' }] })).toBe(true);
    expect(matches({ all: [{ field: 'payee', op: 'equals', value: 'SHELL OIL' }] }, { payee: null })).toBe(
      true,
    );
    expect(matches({ all: [{ field: 'payee', op: 'starts_with', value: 'oil' }] })).toBe(false);
    expect(
      matches({ all: [{ field: 'payee', op: 'contains', value: 'shell' }] }, { payee: null, payeeKey: null }),
    ).toBe(false);
  });

  it('is case-insensitive unless ci is false', () => {
    expect(matches({ all: [{ field: 'payee', op: 'contains', value: 'shell', ci: false }] })).toBe(false);
    expect(matches({ all: [{ field: 'payee', op: 'contains', value: 'Shell', ci: false }] })).toBe(true);
    expect(matches({ all: [{ field: 'description', op: 'regex', value: 'shell\\s+oil \\d{5}' }] })).toBe(
      true,
    );
    expect(matches({ all: [{ field: 'description', op: 'regex', value: 'shell', ci: false }] })).toBe(false);
  });

  it('text "in" matches any listed value', () => {
    expect(matches({ all: [{ field: 'payee', op: 'in', value: ['bp', 'shell oil'] }] })).toBe(true);
  });

  it('raw_description and item_text never match when missing', () => {
    expect(
      matches(
        { all: [{ field: 'raw_description', op: 'contains', value: 'shell' }] },
        { rawDescription: null },
      ),
    ).toBe(false);
    expect(matches({ all: [{ field: 'item_text', op: 'contains', value: 'milk' }] })).toBe(false);
    expect(
      matches({ all: [{ field: 'item_text', op: 'contains', value: 'milk' }] }, { itemText: '2% MILK GAL' }),
    ).toBe(true);
  });

  it('compares signed amounts exactly', () => {
    const between: RuleConditions = {
      all: [{ field: 'amount', op: 'between', value: ['-200.00', '-5.00'] }],
    };
    expect(matches(between)).toBe(true);
    expect(matches(between, { amountMinor: -20000n })).toBe(true);
    expect(matches(between, { amountMinor: -500n })).toBe(true);
    expect(matches(between, { amountMinor: -499n })).toBe(false);
    expect(matches(between, { amountMinor: 4200n })).toBe(false);
    expect(matches({ all: [{ field: 'amount', op: 'equals', value: '-42' }] })).toBe(true);
    expect(matches({ all: [{ field: 'amount', op: 'lt', value: '-41.999' }] })).toBe(true);
    expect(matches({ all: [{ field: 'amount', op: 'gt', value: '0' }] })).toBe(false);
    expect(
      matches(
        { all: [{ field: 'amount', op: 'equals', value: '-42.000' }] },
        { amountMinor: -42000n, exponent: 3 },
      ),
    ).toBe(true);
  });

  it('matches accounts, entities and days of the week', () => {
    expect(matches({ all: [{ field: 'account', op: 'equals', value: 'ACCT-1' }] })).toBe(true);
    expect(matches({ all: [{ field: 'entity', op: 'in', value: ['ent-business'] }] })).toBe(false);
    // 2026-10-14 is a Wednesday → 3
    expect(matches({ all: [{ field: 'date_dow', op: 'equals', value: '3' }] })).toBe(true);
    expect(
      matches({ all: [{ field: 'date_dow', op: 'equals', value: '0' }] }, { date: d('2026-10-18') }),
    ).toBe(true);
  });

  it('ANDs top-level conditions and ORs any-groups', () => {
    const c: RuleConditions = {
      all: [
        { field: 'payee', op: 'contains', value: 'shell' },
        {
          any: [
            { field: 'account', op: 'equals', value: 'other' },
            { field: 'amount', op: 'lt', value: '0' },
          ],
        },
      ],
    };
    expect(matches(c)).toBe(true);
    expect(matches(c, { amountMinor: 100n })).toBe(false);
  });
});

describe('compileRules and applyRules', () => {
  it('orders by priority then age, skips disabled, reports bad rules', () => {
    const a = rule({ priority: 200, actions: { categoryId: 'cat-a' } });
    const b = rule({ priority: 50, actions: { categoryId: 'cat-b' } });
    const off = rule({ priority: 1, enabled: false, actions: { categoryId: 'cat-off' } });
    const bad = rule({ conditions: { all: [{ field: 'payee', op: 'regex', value: '[' }] } });
    const { rules, errors } = compileRules([a, b, off, bad]);
    expect(rules.map((r) => r.record.id)).toEqual([b.id, a.id]);
    expect(errors).toEqual([
      { ruleId: bad.id, message: expect.stringMatching(/^conditions\.all\[0\]: Invalid pattern/) },
    ]);
    expect(applyRules(rules, subject()).actions.categoryId).toBe('cat-b');
  });

  it('breaks priority ties by age', () => {
    const older = rule({ createdAt: '2025-01-01T00:00:00Z', actions: { categoryId: 'cat-old' } });
    const newer = rule({ createdAt: '2026-01-01T00:00:00Z', actions: { categoryId: 'cat-new' } });
    expect(applyRules(compileRules([newer, older]).rules, subject()).actions.categoryId).toBe('cat-old');
  });

  it('first match wins per field; tags are the union; ruleId is the category rule', () => {
    const tagger = rule({ priority: 1, name: 'Tag fuel', actions: { tags: ['fuel'], memberId: 'mem-1' } });
    const cat = rule({
      priority: 2,
      name: 'Shell → Fuel',
      actions: { categoryId: 'cat-fuel', tags: ['car'], memberId: 'mem-2' },
    });
    const later = rule({
      priority: 3,
      actions: { categoryId: 'cat-other', renamePayee: 'Shell', markReviewed: true },
    });
    const miss = rule({
      priority: 0,
      conditions: { all: [{ field: 'payee', op: 'contains', value: 'bp' }] },
    });
    const res = applyRules(compileRules([later, cat, tagger, miss]).rules, subject());
    expect(res).toEqual({
      actions: {
        tags: ['fuel', 'car'],
        memberId: 'mem-1',
        categoryId: 'cat-fuel',
        renamePayee: 'Shell',
        markReviewed: true,
      },
      ruleId: cat.id,
      ruleName: 'Shell → Fuel',
      matchedRuleIds: [tagger.id, cat.id, later.id],
    });
  });

  it('names the first matching rule when none sets a category', () => {
    const tagger = rule({ actions: { tags: ['x'] } });
    const res = applyRules(compileRules([tagger]).rules, subject());
    expect(res.ruleId).toBe(tagger.id);
    expect(res.actions.categoryId).toBeUndefined();
  });

  it('returns nothing when no rule matches', () => {
    expect(applyRules([], subject())).toEqual({
      actions: {},
      ruleId: null,
      ruleName: null,
      matchedRuleIds: [],
    });
  });
});
