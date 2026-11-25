import { describe, expect, it } from 'vitest';
import { catalogs, createTranslator } from '@montra/i18n';
import type {
  AccountDto,
  AiTaskDto,
  InsightDto,
  PropertyDto,
  QuickAddDraftDto,
  ReviewItemDto,
  RuleDto,
} from '@montra/schemas';
import {
  budgetPercent,
  draftToTransaction,
  formatUsd,
  groupInsights,
  BYOK_PROVIDERS,
  byokNeedsEndpoint,
  deploymentMissing,
  keyMissing,
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
  madeTransferMessage,
  parsePropertyPick,
  reviewBadgeTotal,
  percent,
  propertyLabel,
  propertyOptions,
  proposedProperty,
  removeItems,
  reviewCommand,
  suggestedCategoryId,
  transferOptions,
  transferTargets,
} from './review';
import {
  canApplyToExisting,
  describeConditions,
  describeFor,
  draftActions,
  draftConditions,
  draftToRequest,
  emptyCondition,
  emptyDraft,
  fieldsFor,
  HOUSEHOLD,
  ruleToDraft,
  sortRules,
  withField,
  withScope,
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
        scope: 'transaction',
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

  it('builds a receipt-item rule: "added by", category, and Household (owner, 2026-11-24)', () => {
    const base = emptyDraft('receipt_line');
    expect(base.items[0]).toMatchObject({ kind: 'cond', cond: { field: 'item_text' } });
    const addedBy = { ...emptyCondition('added_by'), values: ['m1'] };
    const category = { ...emptyCondition('category'), values: ['c-groceries'] };
    const d: RuleDraft = {
      ...base,
      name: 'Mansoor’s groceries',
      items: [
        { kind: 'cond', cond: addedBy },
        { kind: 'cond', cond: category },
      ],
      // Tags and the rest mean nothing on a receipt line and are left out.
      actions: { categoryId: '', memberId: HOUSEHOLD, tags: 'x', renamePayee: 'y', markReviewed: true },
    };
    expect(draftToRequest(d)).toEqual({
      ok: true,
      value: {
        name: 'Mansoor’s groceries',
        scope: 'receipt_line',
        entityId: null,
        priority: 100,
        enabled: true,
        conditions: {
          all: [
            { field: 'added_by', op: 'in', value: ['m1'] },
            { field: 'category', op: 'in', value: ['c-groceries'] },
          ],
        },
        actions: { household: true },
      },
    });
    // A rule that checks the category can't set it.
    expect(draftToRequest({ ...d, actions: { ...d.actions, categoryId: 'c-gifts' } })).toEqual({
      key: category.key,
      error: 'rules.error.category_loop',
    });
    // Round trip: Household comes back as the Household choice.
    const rule = {
      id: 'r2',
      name: 'x',
      entityId: null,
      scope: 'receipt_line',
      priority: 100,
      conditions: { all: [{ field: 'category', op: 'in', value: ['c1'] }] },
      actions: { household: true },
      origin: 'user',
      enabled: true,
      hitCount: 0,
      lastHitAt: null,
      version: '1',
      createdAt: '2026-11-24T00:00:00Z',
    } satisfies RuleDto;
    expect(ruleToDraft(rule)).toMatchObject({ scope: 'receipt_line', actions: { memberId: HOUSEHOLD } });
    expect(draftToRequest(ruleToDraft(rule))).toMatchObject({
      ok: true,
      value: { actions: { household: true } },
    });
  });

  it('switching a new rule to transactions drops what only receipt items have', () => {
    const d: RuleDraft = {
      ...emptyDraft('receipt_line'),
      items: [
        { kind: 'cond', cond: { ...emptyCondition('item_text'), value: 'milk' } },
        { kind: 'any', key: 'g', conds: [{ ...emptyCondition('added_by'), values: ['m1'] }] },
      ],
      actions: { categoryId: '', memberId: HOUSEHOLD, tags: '', renamePayee: '', markReviewed: false },
    };
    const next = withScope(d, 'transaction');
    expect(next.scope).toBe('transaction');
    expect(next.items[0]).toMatchObject({ kind: 'cond', cond: { field: 'payee', value: '' } });
    expect(next.items[1]).toMatchObject({ kind: 'any', conds: [{ field: 'payee', values: [] }] });
    expect(next.actions.memberId).toBe('');
    expect(fieldsFor('transaction')).not.toContain('added_by');
    expect(fieldsFor('receipt_line')).toEqual(expect.arrayContaining(['added_by', 'category', 'item_text']));
    // Household is never sent for a transaction rule.
    expect(draftActions({ ...d.actions, categoryId: 'c1' }, 'transaction')).toEqual({ categoryId: 'c1' });
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
    expect(
      describeConditions(
        {
          all: [
            { field: 'added_by', op: 'in', value: ['m1'] },
            { field: 'category', op: 'in', value: ['c1'] },
          ],
        },
        t,
        (f, id) => (f === 'added_by' ? 'Mansoor' : f === 'category' ? 'Groceries' : id),
      ),
    ).toBe('Added by is Mansoor and Category is Groceries');
    expect(describeFor({ household: true }, t)).toBe('for Household');
    expect(describeFor({ memberId: 'm1' }, t, () => 'Sam')).toBe('for Sam');
    expect(describeFor({ categoryId: 'c1' }, t)).toBe('');
    // "Apply to existing" changes transactions: receipt-item rules don't offer it.
    expect(canApplyToExisting({ scope: 'transaction' })).toBe(true);
    expect(canApplyToExisting({ scope: 'receipt_line' })).toBe(false);
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
  propertyId: null,
  unitId: null,
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

const account = (id: string, kind: AccountDto['kind'], over: Partial<AccountDto> = {}): AccountDto => ({
  id,
  entityId: 'e1',
  name: id,
  kind,
  type: ['credit_card', 'line_of_credit', 'loan', 'mortgage', 'liability'].includes(kind)
    ? 'liability'
    : 'asset',
  currency: 'USD',
  institution: null,
  last4: null,
  accountNumberMasked: null,
  fullNumberKept: false,
  holders: [],
  balance: { amount: '0', currency: 'USD' },
  archived: false,
  hidden: false,
  defaultMemberId: null,
  loanId: null,
  planType: null,
  employerId: null,
  employerContributions: false,
  reconciledThrough: null,
  purchasePrice: null,
  purchaseDate: null,
  loanAccountId: null,
  dueDate: null,
  cycle: { statementDay: null, dueDay: null, payFromAccountId: null, payRule: null, payFixed: null },
  planning: {
    creditLimit: null,
    interestRateBps: null,
    interestRatePpm: null,
    minPayment: null,
    lowBalance: '0',
  },
  ...over,
});

describe('make transfer… (TXN-04)', () => {
  const accounts = [
    account('a1', 'checking'),
    account('Savings', 'savings'),
    account('Sapphire', 'credit_card'),
    account('Mortgage', 'mortgage', { loanId: 'l1' }),
    account('Old card', 'credit_card', { archived: true }),
    account('Euro', 'checking', { currency: 'EUR' }),
    account('Brokerage', 'investment'),
  ];

  it('offers the other open accounts in the same currency, cards first, in words', () => {
    const out = transferTargets(accounts, item('x', null));
    expect(out.map((o) => [o.name, o.group, o.direction])).toEqual([
      ['Sapphire', 'cards', 'to'],
      ['Mortgage', 'loans', 'to'],
      ['Savings', 'bank', 'to'],
      ['Brokerage', 'other', 'to'],
    ]);
    expect(out.find((o) => o.name === 'Mortgage')?.trackedLoan).toBe(true);
    const money = { ...item('y', null), amount: { amount: '2000', currency: 'USD' as const } };
    expect(transferOptions(transferTargets(accounts, money), t)[0]).toEqual({
      id: 'Sapphire',
      label: 'Transfer from Sapphire',
      group: 'Cards',
    });
    expect(transferTargets(accounts, { accountId: null, amount: null })).toEqual([]);
  });

  it('says what it did: a transfer, a loan payment, or a transfer because no payment matched', () => {
    expect(madeTransferMessage({ absorbedId: null, loan: null }, 'Sapphire', t)).toContain(
      'Made a transfer with Sapphire.',
    );
    expect(madeTransferMessage({ absorbedId: 'x', loan: null }, 'Sapphire', t)).toContain('matched');
    expect(
      madeTransferMessage({ absorbedId: null, loan: { loanId: 'l1', name: 'Mortgage', number: 4 } }, '', t),
    ).toBe('Recorded as Mortgage payment 4, with its interest, principal and any escrow split out.');
    expect(
      madeTransferMessage(
        { absorbedId: null, loan: { loanId: 'l1', name: 'Mortgage', number: null } },
        '',
        t,
      ),
    ).toContain('plain transfer to the loan account');
  });
});

describe('review queue (AI-03/04, PLT-10)', () => {
  it('maps keys to commands and leaves typing and chords alone', () => {
    expect(reviewCommand({ key: 'j' })).toBe('next');
    expect(reviewCommand({ key: 'ArrowUp' })).toBe('prev');
    expect(reviewCommand({ key: 'Enter' })).toBe('accept');
    expect(reviewCommand({ key: 'a' })).toBe('accept');
    expect(reviewCommand({ key: 'A', shiftKey: true })).toBe('acceptAbove');
    expect(reviewCommand({ key: 'c' })).toBe('category');
    expect(reviewCommand({ key: 'p' })).toBe('property');
    expect(reviewCommand({ key: '?' })).toBe('help');
    expect(reviewCommand({ key: 'a', editable: true })).toBeNull();
    expect(reviewCommand({ key: 'a', metaKey: true })).toBeNull();
    expect(reviewCommand({ key: 'Escape', editable: true })).toBe('close');
  });

  it('offers a suggested property only while none is on the line (AI-02)', () => {
    const elm = {
      id: 'p-elm',
      entityId: 'e1',
      name: 'Elm duplex',
      archived: false,
      units: [
        { id: 'u-1a', label: '1A' },
        { id: 'u-2b', label: '2B' },
      ],
    } as unknown as PropertyDto;
    const oak = {
      id: 'p-oak',
      entityId: 'e1',
      name: 'Oak',
      archived: false,
      units: [{ id: 'u-m', label: 'Main' }],
    };
    const other = { ...oak, id: 'p-x', entityId: 'e2', name: 'Elsewhere' };
    const properties = [elm, oak, other] as unknown as PropertyDto[];
    const base = item('1', 0.9);
    const offered: ReviewItemDto = {
      ...base,
      categorization: {
        ...base.categorization!,
        property: {
          propertyId: 'p-elm',
          unitId: 'u-2b',
          label: 'Elm duplex, 2B',
          step: 'history',
          confidence: 0.6,
          explanation: 'Like 3 past transactions at Elm duplex, 2B',
          applied: false,
        },
      },
    };
    expect(proposedProperty(offered)?.propertyId).toBe('p-elm');
    expect(propertyLabel(offered, properties)).toBe('Elm duplex, 2B');
    // On the line already (by hand or a lease): that one shows, nothing is offered.
    const tagged = { ...offered, propertyId: 'p-oak', unitId: null };
    expect(proposedProperty(tagged)).toBeNull();
    expect(propertyLabel(tagged, properties)).toBe('Oak');
    expect(propertyLabel(base, properties)).toBeNull();

    expect(propertyOptions(properties, 'e1', 'No property').map((o) => [o.id, o.label])).toEqual([
      ['', 'No property'],
      ['p-elm', 'Elm duplex'],
      ['p-elm/u-1a', 'Elm duplex, 1A'],
      ['p-elm/u-2b', 'Elm duplex, 2B'],
      ['p-oak', 'Oak'],
    ]);
    expect(parsePropertyPick('p-elm/u-2b')).toEqual({ propertyId: 'p-elm', unitId: 'u-2b' });
    expect(parsePropertyPick('p-oak')).toEqual({ propertyId: 'p-oak', unitId: null });
    expect(parsePropertyPick('')).toEqual({ propertyId: null, unitId: null });
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

  it('adds tax forms to check to the Review badge, ignoring a count that failed to load', () => {
    expect(reviewBadgeTotal(6, 2)).toBe(8);
    expect(reviewBadgeTotal(0, 0)).toBe(0);
    expect(reviewBadgeTotal(6, null)).toBe(6);
    expect(reviewBadgeTotal(null, 2)).toBe(2);
    expect(reviewBadgeTotal(null, null)).toBeNull();
    // ADR-0054 §5a: files to provide again join the count.
    expect(reviewBadgeTotal(6, 2, 3)).toBe(11);
    expect(reviewBadgeTotal(null, null, 3)).toBe(3);
    expect(reviewBadgeTotal(6, 2, null)).toBe(8);
    expect(reviewBadgeTotal(null, null, null)).toBeNull();
    // ADR-0055 §5: bank feed imports waiting join it too, one each.
    expect(reviewBadgeTotal(6, 2, 3, 2)).toBe(13);
    expect(reviewBadgeTotal(null, null, null, 1)).toBe(1);
    expect(reviewBadgeTotal(null, null, null, null)).toBeNull();
    expect(t('review.badge', { count: 1 })).toBe('1 item to review');
    expect(t('review.badge', { count: 8 })).toBe('8 items to review');
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
    const usage = {
      month: '2026-10',
      calls: 10,
      spentUsd: 4,
      state: 'ok' as const,
      share: null,
      planAllowance: false,
    };
    expect(budgetPercent({ monthlyBudgetUsd: 5, usage })).toBe(80);
    expect(budgetPercent({ monthlyBudgetUsd: null, usage })).toBeNull();
    expect(budgetPercent({ monthlyBudgetUsd: 1, usage })).toBe(100);
    // With a plan's allowance, the server's share is what counts (ADR-0049 §2).
    const planned = { ...usage, share: 0.7, planAllowance: true };
    expect(budgetPercent({ monthlyBudgetUsd: null, usage: planned })).toBe(70);
    expect(parseBudget('')).toEqual({ ok: true, value: null });
    expect(parseBudget('$12.50')).toEqual({ ok: true, value: 12.5 });
    expect(parseBudget('abc')).toEqual({ ok: false });
    expect(parseBudget('20000')).toEqual({ ok: false });
    expect(thresholdFromPercent(40)).toBe(0.5);
    expect(thresholdFromPercent(85)).toBe(0.85);
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(1.5)).toBe('$1.50');
  });

  it('won’t save “your own key” without a key', () => {
    const none = { provider: 'anthropic' as const, hasKey: false };
    const saved = { provider: 'anthropic' as const, hasKey: true };
    expect(keyMissing('byok', 'anthropic', '', none)).toBe(true);
    expect(keyMissing('byok', 'anthropic', '   ', none)).toBe(true);
    expect(keyMissing('byok', 'anthropic', 'sk-ant-123456', none)).toBe(false);
    expect(keyMissing('byok', 'anthropic', '', saved)).toBe(false);
    // A key saved for the other provider doesn't count.
    expect(keyMissing('byok', 'anthropic', '', { provider: 'openai_compatible', hasKey: true })).toBe(true);
    // An OpenAI-compatible server may not need one; other modes never do.
    expect(keyMissing('byok', 'openai_compatible', '', none)).toBe(false);
    expect(keyMissing('builtin', 'anthropic', '', none)).toBe(false);
    expect(keyMissing('off', 'anthropic', '', none)).toBe(false);
    // OpenAI, Gemini and Azure OpenAI need a key like Anthropic (backlog item 3).
    for (const p of ['openai', 'gemini', 'azure_openai'] as const) {
      expect(keyMissing('byok', p, '', none)).toBe(true);
      expect(keyMissing('byok', p, '', { provider: p, hasKey: true })).toBe(false);
    }
  });

  it('asks Azure OpenAI for its resource URL and a deployment; OpenAI and Gemini for neither', () => {
    const blank = { small: '', vision: '', large: '' };
    expect(byokNeedsEndpoint('byok', 'azure_openai')).toBe(true);
    expect(byokNeedsEndpoint('byok', 'openai_compatible')).toBe(true);
    expect(byokNeedsEndpoint('byok', 'openai')).toBe(false);
    expect(byokNeedsEndpoint('byok', 'gemini')).toBe(false);
    expect(byokNeedsEndpoint('local', 'azure_openai')).toBe(false);
    expect(deploymentMissing('byok', 'azure_openai', blank)).toBe(true);
    expect(deploymentMissing('byok', 'azure_openai', { ...blank, large: 'montra-mini' })).toBe(false);
    expect(deploymentMissing('byok', 'openai', blank)).toBe(false);
    expect(BYOK_PROVIDERS).toEqual(['anthropic', 'openai', 'gemini', 'azure_openai', 'openai_compatible']);
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
