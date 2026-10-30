import { describe, expect, it } from 'vitest';
import { catalogs, createTranslator } from '@montra/i18n';
import type { AiTaskDto, InsightDto, QuickAddDraftDto, ReviewItemDto, RuleDto } from '@montra/schemas';
import {
  budgetPercent,
  draftToTransaction,
  formatUsd,
  groupInsights,
  highlightSpans,
  parseBudget,
  parseJsonContent,
  runLocalTask,
  thresholdFromPercent,
} from './ai';
import {
  clampCursor,
  confidenceTone,
  countAtOrAbove,
  goSequence,
  percent,
  removeItems,
  reviewCommand,
  suggestedCategoryId,
} from './review';
import {
  describeConditions,
  draftConditions,
  draftToRequest,
  emptyCondition,
  emptyDraft,
  ruleToDraft,
  sortRules,
  withField,
  type RuleDraft,
} from './rules';

const { t } = createTranslator('en-US', catalogs);

// ----- Rules editor ---------------------------------------------------------------------------------------

describe('rule drafts (UP-02)', () => {
  const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({
    ...emptyDraft(),
    name: 'Shell → Fuel',
    items: [{ kind: 'cond', cond: { ...emptyCondition('payee'), value: ' shell ' } }],
    actions: {
      categoryId: 'cat-fuel',
      memberId: '',
      tags: '#car, fuel, car',
      renamePayee: '',
      markReviewed: false,
    },
    ...patch,
  });

  it('builds the create body with trimmed text, deduped tags and no empty actions', () => {
    const r = draftToRequest(draft());
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Shell → Fuel',
        entityId: null,
        priority: 100,
        enabled: true,
        conditions: { all: [{ field: 'payee', op: 'contains', value: 'shell' }] },
        actions: { categoryId: 'cat-fuel', tags: ['car', 'fuel'] },
      },
    });
  });

  it('reports the first problem with the offending condition', () => {
    const bad = { ...emptyCondition('amount'), op: 'between' as const, value: '-5', value2: '-200' };
    expect(draftToRequest(draft({ items: [{ kind: 'cond', cond: bad }] }))).toEqual({
      key: bad.key,
      error: 'rules.error.range',
    });
    expect(draftToRequest(draft({ name: '  ' }))).toMatchObject({ error: 'rules.error.name' });
    expect(
      draftToRequest(
        draft({ actions: { categoryId: '', memberId: '', tags: '', renamePayee: '', markReviewed: false } }),
      ),
    ).toMatchObject({ error: 'rules.error.no_actions' });
    const regex = { ...emptyCondition('description'), op: 'regex' as const, value: '(' };
    expect(draftConditions([{ kind: 'cond', cond: regex }])).toMatchObject({ error: 'rules.error.regex' });
    expect(draftConditions([])).toMatchObject({ error: 'rules.error.no_conditions' });
  });

  it('supports amounts, lists, case sensitivity and "any of" groups', () => {
    const amount = { ...emptyCondition('amount'), op: 'between' as const, value: '-1,200.00', value2: '-5' };
    const accounts = { ...emptyCondition('account'), values: ['a1', 'a2'] };
    const text = { ...emptyCondition('payee'), op: 'equals' as const, value: 'Shell', ci: false };
    const r = draftConditions([
      { kind: 'cond', cond: amount },
      { kind: 'any', key: 'g', conds: [accounts, text] },
    ]);
    expect(r).toEqual({
      ok: true,
      value: {
        all: [
          { field: 'amount', op: 'between', value: ['-1200.00', '-5'] },
          {
            any: [
              { field: 'account', op: 'in', value: ['a1', 'a2'] },
              { field: 'payee', op: 'equals', value: 'Shell', ci: false },
            ],
          },
        ],
      },
    });
  });

  it('changing a field resets operator and value but keeps the row', () => {
    const c = { ...emptyCondition('payee'), value: 'x' };
    const next = withField(c, 'amount');
    expect(next).toMatchObject({ key: c.key, field: 'amount', op: 'between', value: '' });
  });

  it('round-trips a saved rule through the editor', () => {
    const rule: RuleDto = {
      id: 'r1',
      name: 'Weekend dining',
      entityId: 'e1',
      scope: 'transaction',
      priority: 10,
      conditions: {
        all: [
          { field: 'date_dow', op: 'in', value: ['0', '6'] },
          { field: 'amount', op: 'lt', value: '-20' },
        ],
      },
      actions: { categoryId: 'c1', tags: ['weekend'], markReviewed: true },
      origin: 'user',
      enabled: true,
      hitCount: 3,
      lastHitAt: null,
      version: '1',
      createdAt: '2026-10-01T00:00:00Z',
    };
    const back = draftToRequest(ruleToDraft(rule));
    expect(back).toMatchObject({
      ok: true,
      value: {
        name: 'Weekend dining',
        entityId: 'e1',
        priority: 10,
        conditions: rule.conditions,
        actions: rule.actions,
      },
    });
  });

  it('describes conditions in plain language and sorts by priority then age', () => {
    const text = describeConditions(
      {
        all: [
          { field: 'payee', op: 'contains', value: 'shell' },
          {
            any: [
              { field: 'account', op: 'in', value: ['a1'] },
              { field: 'date_dow', op: 'in', value: ['6'] },
            ],
          },
        ],
      },
      t,
      (_f, id) => (id === 'a1' ? 'Amex' : id),
    );
    expect(text).toBe('Payee contains “shell” and (Account is Amex or Day of week is Saturday)');
    const r = (id: string, priority: number, createdAt: string) => ({ id, priority, createdAt }) as RuleDto;
    expect(
      sortRules([r('b', 5, '2026-02'), r('a', 5, '2026-01'), r('c', 1, '2026-03')]).map((x) => x.id),
    ).toEqual(['c', 'a', 'b']);
  });
});

// ----- Review queue ---------------------------------------------------------------------------------------

const item = (id: string, confidence: number | null, categoryId: string | null = 'c1'): ReviewItemDto => ({
  transactionId: id,
  date: '2026-10-05',
  payee: 'Starbucks',
  description: '',
  amount: { amount: '-450', currency: 'USD' },
  accountId: 'a1',
  entityId: 'e1',
  categoryId: 'uncat',
  memberId: null,
  categorization:
    confidence === null
      ? null
      : {
          step: 'ai',
          confidence,
          explanation: 'AI: coffee shop',
          ruleId: null,
          suggested: { categoryId, entityId: 'e1', memberId: null },
        },
  merchant: null,
  version: '1',
});

describe('review queue (AI-03/04, PLT-10)', () => {
  it('maps keys to commands and leaves typing and chords alone', () => {
    expect(reviewCommand({ key: 'j' })).toBe('next');
    expect(reviewCommand({ key: 'ArrowUp' })).toBe('prev');
    expect(reviewCommand({ key: 'Enter' })).toBe('accept');
    expect(reviewCommand({ key: 'a' })).toBe('accept');
    expect(reviewCommand({ key: 'A', shiftKey: true })).toBe('acceptAbove');
    expect(reviewCommand({ key: 'c' })).toBe('category');
    expect(reviewCommand({ key: '?' })).toBe('help');
    expect(reviewCommand({ key: 'a', editable: true })).toBeNull();
    expect(reviewCommand({ key: 'a', metaKey: true })).toBeNull();
    expect(reviewCommand({ key: 'Escape', editable: true })).toBe('close');
  });

  it('keeps the cursor on the row that takes the handled one’s place', () => {
    const list = [item('1', 0.5), item('2', 0.6), item('3', 0.7), item('4', 0.9)];
    expect(removeItems(list, new Set(['2']), 1)).toMatchObject({ cursor: 1 });
    expect(removeItems(list, new Set(['1', '2']), 2).cursor).toBe(0);
    const last = removeItems(list, new Set(['4']), 3);
    expect(last.items.map((i) => i.transactionId)).toEqual(['1', '2', '3']);
    expect(last.cursor).toBe(2);
    expect(clampCursor(5, 0)).toBe(0);
  });

  it('counts suggestions at or above a confidence, ignoring rows without a suggestion', () => {
    const list = [item('1', 0.95), item('2', 0.9), item('3', 0.92, null), item('4', 0.4), item('5', null)];
    expect(countAtOrAbove(list, 0.9)).toBe(2);
    expect(suggestedCategoryId(item('5', null))).toBe('uncat');
  });

  it('colors confidence against the threshold and rounds to whole percent', () => {
    expect(confidenceTone(0.8, 0.8)).toBe('good');
    expect(confidenceTone(0.6, 0.8)).toBe('warn');
    expect(confidenceTone(0.3, 0.8)).toBe('bad');
    expect(percent(0.876)).toBe(88);
    expect(percent(1.2)).toBe(100);
  });

  it('recognizes "g r" within the time window only', () => {
    let s = goSequence(null, 'g', 1000);
    expect(s.target).toBeNull();
    expect(goSequence(s.state, 'r', 1500).target).toBe('review');
    s = goSequence(null, 'g', 1000);
    expect(goSequence(s.state, 'r', 3000).target).toBeNull();
    expect(goSequence(null, 'r', 0).target).toBeNull();
  });

  it('has messages for counts and rule offers', () => {
    expect(t('review.count', { count: 0 })).toBe('Nothing to review');
    expect(t('review.count', { count: 3 })).toBe('3 transactions to review');
    expect(t('rules.suggestion.text', { payee: 'Starbucks', category: 'Coffee', count: 2 })).toBe(
      "You've changed Starbucks to Coffee twice — create a rule?",
    );
    expect(t('rules.preview.counts', { matches: 14, changes: 9 })).toBe(
      'Matches 14 existing transactions, would change 9.',
    );
  });
});

// ----- AI settings, quick add, insights, local runner -----------------------------------------------------

describe('AI settings helpers (UP-13, AIA-08)', () => {
  it('computes budget use and parses the budget field', () => {
    const usage = { month: '2026-10', calls: 10, spentUsd: 4, state: 'ok' as const };
    expect(budgetPercent({ monthlyBudgetUsd: 5, usage })).toBe(80);
    expect(budgetPercent({ monthlyBudgetUsd: null, usage })).toBeNull();
    expect(budgetPercent({ monthlyBudgetUsd: 1, usage })).toBe(100);
    expect(parseBudget('')).toEqual({ ok: true, value: null });
    expect(parseBudget('$12.50')).toEqual({ ok: true, value: 12.5 });
    expect(parseBudget('abc')).toEqual({ ok: false });
    expect(parseBudget('20000')).toEqual({ ok: false });
    expect(thresholdFromPercent(40)).toBe(0.5);
    expect(thresholdFromPercent(85)).toBe(0.85);
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});

const qa = (patch: Partial<QuickAddDraftDto> = {}): QuickAddDraftDto => ({
  date: '2026-10-05',
  amount: { amount: '1850', currency: 'USD' },
  direction: 'out',
  payee: 'Lunch',
  accountId: 'amex',
  categoryId: 'dining',
  memberId: null,
  memo: 'client meeting',
  tags: [],
  confidence: 0.8,
  source: 'heuristic',
  spans: [
    { field: 'payee', text: 'lunch' },
    { field: 'amount', text: '18.50' },
    { field: 'account', text: 'amex' },
    { field: 'memo', text: 'client meeting' },
  ],
  ...patch,
});

describe('natural-language quick add (TXN-06)', () => {
  it('highlights the parsed parts in order, case-insensitively', () => {
    const segs = highlightSpans('Lunch 18.50 amex client meeting', qa().spans);
    expect(segs).toEqual([
      { text: 'Lunch', field: 'payee' },
      { text: ' ', field: null },
      { text: '18.50', field: 'amount' },
      { text: ' ', field: null },
      { text: 'amex', field: 'account' },
      { text: ' ', field: null },
      { text: 'client meeting', field: 'memo' },
    ]);
    // Repeated words map to separate occurrences.
    expect(
      highlightSpans('5 5', [
        { field: 'amount', text: '5' },
        { field: 'memo', text: '5' },
      ]).filter((s) => s.field),
    ).toEqual([
      { text: '5', field: 'amount' },
      { text: '5', field: 'memo' },
    ]);
  });

  it('turns a draft into a signed create body in the account currency', () => {
    expect(draftToTransaction(qa(), null, () => 'USD')).toEqual({
      ok: true,
      value: {
        date: '2026-10-05',
        accountId: 'amex',
        amount: { amount: '-1850', currency: 'USD' },
        payee: 'Lunch',
        categoryId: 'dining',
        memo: 'client meeting',
      },
    });
    expect(draftToTransaction(qa({ direction: 'in', accountId: null }), 'chk', () => 'EUR')).toMatchObject({
      ok: true,
      value: { accountId: 'chk', amount: { amount: '1850', currency: 'EUR' } },
    });
    expect(draftToTransaction(qa({ amount: null }), null, () => 'USD')).toEqual({
      ok: false,
      error: 'quick_add.nl.need_amount',
    });
    expect(draftToTransaction(qa({ accountId: null }), null, () => 'USD')).toEqual({
      ok: false,
      error: 'quick_add.nl.need_account',
    });
  });
});

describe('insights and local mode (AI-08/09, 06 §2)', () => {
  it('groups insights by kind in a fixed order', () => {
    const ins = (id: string, kind: InsightDto['kind']) =>
      ({
        id,
        kind,
        entityId: 'e',
        transactionId: null,
        payee: null,
        message: '',
        data: {},
        status: 'open',
        createdAt: '',
      }) as InsightDto;
    expect(
      groupInsights([ins('1', 'duplicate_charge'), ins('2', 'recurring'), ins('3', 'recurring')]),
    ).toEqual([
      { kind: 'recurring', items: [ins('2', 'recurring'), ins('3', 'recurring')] },
      { kind: 'duplicate_charge', items: [ins('1', 'duplicate_charge')] },
    ]);
  });

  it('runs a parked task against the local endpoint and parses its JSON', async () => {
    const task: AiTaskDto = {
      id: 't1',
      task: 'categorize',
      input: { model: 'llama3.1', messages: [] },
      createdAt: '',
    };
    const calls: { url: string; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '```json\n{"items":[]}\n```' } }] }),
      );
    }) as unknown as typeof fetch;
    await expect(runLocalTask(task, 'http://localhost:11434/v1/', fake)).resolves.toEqual({ items: [] });
    expect(calls[0]).toEqual({ url: 'http://localhost:11434/v1/chat/completions', body: task.input });
    const failing = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(runLocalTask(task, 'http://x', failing)).rejects.toThrow('500');
    expect(parseJsonContent('{"a":1}')).toEqual({ a: 1 });
  });
});
