import { describe, expect, it, vi } from 'vitest';
import {
  addressKey,
  compileRules,
  propertyFromText,
  propertyHistorySuggestion,
  runPipeline,
  unitFromText,
  validateRule,
  type AiPropertySuggestion,
  type PropertyOption,
  type PropertyQuestion,
} from '../src/index.js';
import { deps, item, rule } from './fixtures.js';

const elm: PropertyOption = {
  id: 'p-elm',
  entityId: 'ent-rental',
  name: 'Elm duplex',
  address: '12 N Elm Street, Springfield, IL 62701',
  units: [
    { id: 'u-1', label: 'Unit 1' },
    { id: 'u-2b', label: '2B' },
  ],
};
const oak: PropertyOption = {
  id: 'p-oak',
  entityId: 'ent-rental',
  name: '40 Oak Ave',
  address: null,
  units: [
    { id: 'u-up', label: 'Upstairs' },
    { id: 'u-10', label: 'Unit 10' },
  ],
};
const properties = [elm, oak];

describe('addresses and units in the text (AI-02)', () => {
  it('reads the house number and the street, abbreviations folded', () => {
    expect(addressKey('12 N Elm Street, Springfield')).toEqual({ number: '12', street: 'elm' });
    expect(addressKey('40 Oak Ave')).toEqual({ number: '40', street: 'oak' });
    expect(addressKey('Elm duplex')).toBeNull();
    expect(addressKey(null)).toBeNull();
  });

  it('finds a property by its address, however the bank writes it', () => {
    expect(propertyFromText('ACE PLUMBING 12 ELM ST SPRINGFIELD', properties)).toMatchObject({
      propertyId: 'p-elm',
      unitId: null,
      confidence: 0.9,
    });
    expect(propertyFromText('Gutter cleaning, 12 North Elm Street', properties)?.propertyId).toBe('p-elm');
    // A name that is an address counts as one.
    expect(propertyFromText('PAINT 40 OAK AVENUE', properties)?.propertyId).toBe('p-oak');
    // Another house number on the same street is not this property.
    expect(propertyFromText('ACE PLUMBING 14 ELM ST', properties)).toBeNull();
  });

  it('finds a property by its name as a phrase, less surely than by address', () => {
    expect(propertyFromText('Invoice: Elm duplex roof', properties)).toMatchObject({
      propertyId: 'p-elm',
      confidence: 0.85,
    });
    expect(propertyFromText('elm tree service', properties)).toBeNull();
  });

  it('names nothing when two properties are named', () => {
    expect(propertyFromText('12 Elm St and 40 Oak Ave', properties)).toBeNull();
  });

  it('picks the unit the text names, with or without a prefix', () => {
    expect(propertyFromText('12 ELM ST APT 2B', properties)).toMatchObject({
      propertyId: 'p-elm',
      unitId: 'u-2b',
    });
    expect(unitFromText('LOCKSMITH #2B', elm.units)?.id).toBe('u-2b');
    expect(unitFromText('LOCKSMITH UNIT 1', elm.units)?.id).toBe('u-1');
    expect(unitFromText('LOCKSMITH UNIT NO 1', elm.units)?.id).toBe('u-1');
    // A bare number names nothing; nor does "Unit 10" name "Unit 1".
    expect(unitFromText('LOCKSMITH 2B', elm.units)).toBeNull();
    expect(unitFromText('UNIT 10', elm.units)).toBeNull();
    // A word label stands on its own.
    expect(unitFromText('carpet upstairs', oak.units)?.id).toBe('u-up');
  });

  it('a unit alone names its property only when no other property has it', () => {
    expect(propertyFromText('HANDYMAN UNIT 10', properties)).toMatchObject({
      propertyId: 'p-oak',
      unitId: 'u-10',
      confidence: 0.8,
    });
    const twin: PropertyOption = {
      ...oak,
      id: 'p-twin',
      name: 'Twin',
      units: [{ id: 'u-t10', label: '10' }],
    };
    expect(propertyFromText('HANDYMAN UNIT 10', [elm, oak, twin])).toBeNull();
  });
});

describe('payee history for properties (AI-02)', () => {
  it('suggests the property most of the payee’s lines went to, and the unit when most share it', () => {
    const h = propertyHistorySuggestion(
      [
        { propertyId: 'p-elm', unitId: 'u-2b', count: 4 },
        { propertyId: 'p-oak', unitId: null, count: 1 },
      ],
      properties,
    );
    expect(h).toMatchObject({ propertyId: 'p-elm', unitId: 'u-2b' });
    expect(h!.confidence).toBeCloseTo(0.8 * 0.8);
    expect(h!.explanation).toBe('Like 4 past transactions at Elm duplex, 2B');
  });

  it('needs a clear majority, two lines, and a property still on offer', () => {
    expect(
      propertyHistorySuggestion(
        [
          { propertyId: 'p-elm', unitId: null, count: 3 },
          { propertyId: 'p-oak', unitId: null, count: 2 },
        ],
        properties,
      ),
    ).toBeNull();
    expect(
      propertyHistorySuggestion([{ propertyId: 'p-elm', unitId: null, count: 1 }], properties),
    ).toBeNull();
    expect(
      propertyHistorySuggestion([{ propertyId: 'p-gone', unitId: null, count: 9 }], properties),
    ).toBeNull();
  });
});

describe('runPipeline: property and unit (AI-02)', () => {
  const rental = (over = {}) =>
    item({
      entityId: 'ent-rental',
      entityType: 'rental',
      payee: 'Ace Plumbing',
      payeeKey: 'ACE PLUMBING',
      description: 'ACE PLUMBING',
      rawDescription: null,
      ...over,
    });
  const base = (over: Parameters<typeof deps>[0] = {}) =>
    deps({
      entityOfCategory: () => 'ent-rental',
      properties: (e) => (e === 'ent-rental' ? properties : []),
      ...over,
    });
  const aiFn = (map: Record<string, AiPropertySuggestion>) =>
    vi.fn(
      async (open: readonly PropertyQuestion[]) =>
        new Map(open.filter((o) => map[o.item.id]).map((o) => [o.item.id, map[o.item.id]!])),
    );
  const history = () => [{ propertyId: 'p-oak', unitId: null, count: 5 }];

  it('a rule wins over history and the text, and the text adds the unit', async () => {
    const r = rule({
      name: 'Ace → Elm',
      conditions: { all: [{ field: 'payee', op: 'contains', value: 'ace' }] },
      actions: { propertyId: 'p-elm' },
    });
    const ai = aiFn({});
    const [d] = await runPipeline(
      [rental({ description: 'ACE PLUMBING 40 OAK AVE APT 2B' })],
      base({ rules: compileRules([r]).rules, propertyHistory: history, aiProperty: ai }),
    );
    expect(d!.property).toMatchObject({
      propertyId: 'p-elm',
      unitId: 'u-2b',
      step: 'rule',
      confidence: 1,
      autoApply: true,
    });
    expect(d!.property!.explanation).toBe("Matched rule 'Ace → Elm'; the text names 2B");
    expect(ai).not.toHaveBeenCalled();
  });

  it('history comes before the text, and the text comes before AI', async () => {
    const ai = aiFn({ x: { propertyId: 'p-oak', unitId: null, confidence: 0.99, explanation: 'AI: Oak' } });
    const [h] = await runPipeline(
      [rental({ description: 'ACE 12 ELM ST' })],
      base({ propertyHistory: history, aiProperty: ai }),
    );
    expect(h!.property).toMatchObject({ propertyId: 'p-oak', step: 'history', autoApply: true });
    const [t] = await runPipeline(
      [rental({ id: 'x', description: 'ACE 12 ELM ST #2B' })],
      base({ aiProperty: ai }),
    );
    expect(t!.property).toMatchObject({ propertyId: 'p-elm', unitId: 'u-2b', step: 'text', confidence: 0.9 });
    expect(ai).not.toHaveBeenCalled();
  });

  it('asks AI about the lines still open; an AI answer applies only at the AI threshold', async () => {
    const ai = aiFn({
      a: { propertyId: 'p-oak', unitId: 'u-up', confidence: 0.97, explanation: 'AI: sure' },
      b: { propertyId: 'p-elm', unitId: null, confidence: 0.9, explanation: 'AI: likely' },
      c: { propertyId: 'p-unknown', unitId: null, confidence: 0.99, explanation: 'AI: made up' },
    });
    const [a, b, c] = await runPipeline(
      [rental({ id: 'a' }), rental({ id: 'b' }), rental({ id: 'c' })],
      base({ aiProperty: ai, aiThreshold: 0.95 }),
    );
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![0].map((q) => [q.item.id, q.entityId])).toEqual([
      ['a', 'ent-rental'],
      ['b', 'ent-rental'],
      ['c', 'ent-rental'],
    ]);
    expect(a!.property).toMatchObject({ propertyId: 'p-oak', unitId: 'u-up', step: 'ai', autoApply: true });
    expect(b!.property).toMatchObject({ propertyId: 'p-elm', step: 'ai', autoApply: false });
    expect(c!.property).toBeNull();
  });

  it('below the property threshold it only suggests; a weak hint stays as the fallback against AI', async () => {
    const weak = () => [{ propertyId: 'p-oak', unitId: null, count: 2 }];
    const [d] = await runPipeline(
      [rental()],
      base({ propertyHistory: weak, propertyThreshold: 0.9, aiProperty: async () => new Map() }),
    );
    expect(d!.property).toMatchObject({ propertyId: 'p-oak', step: 'history', autoApply: false });
    expect(d!.property!.confidence).toBeCloseTo(0.4);
  });

  it('degrades when AI fails', async () => {
    const [d] = await runPipeline(
      [rental()],
      base({
        aiProperty: async () => {
          throw new Error('down');
        },
      }),
    );
    expect(d!.property).toBeNull();
  });

  it('leaves alone a property someone set, transfers and books without properties', async () => {
    const [kept] = await runPipeline(
      [rental({ keepProperty: true, description: 'ACE 12 ELM ST' })],
      base({ propertyHistory: history }),
    );
    expect(kept!.property).toBeNull();
    const [personal] = await runPipeline(
      [item({ description: 'ACE 12 ELM ST' })],
      base({ entityOfCategory: () => 'ent-personal' }),
    );
    expect(personal!.property).toBeNull();
    const candidate = {
      transactionId: 't2',
      accountId: 'acct-sav',
      accountName: 'Savings',
      accountLast4: null,
      amountMinor: 4200n,
      date: item().date,
    };
    const [transfer] = await runPipeline(
      [rental({ payee: null, payeeKey: null, description: 'ONLINE TRANSFER 12 ELM ST' })],
      base({ transferCandidates: () => [candidate] }),
    );
    expect(transfer!.step).toBe('transfer');
    expect(transfer!.property).toBeNull();
  });

  it('a personal card’s line goes to the rental books only with its category applied', async () => {
    const card = (over = {}) => rental({ entityId: 'ent-personal', entityType: 'personal', ...over });
    const r = rule({
      conditions: { all: [{ field: 'payee', op: 'contains', value: 'ace' }] },
      actions: { categoryId: 'cat-repairs' },
    });
    const [applied] = await runPipeline(
      [card({ description: 'ACE 12 ELM ST' })],
      base({ rules: compileRules([r]).rules }),
    );
    expect(applied!.property).toMatchObject({ propertyId: 'p-elm', autoApply: true });
    // Only suggested: the line is still uncategorized in the personal books, where the property can't go.
    const [suggested] = await runPipeline(
      [card({ description: 'ACE 12 ELM ST' })],
      base({
        propertyHistory: () => [],
        history: () => [{ amountBand: -7, categoryId: 'cat-repairs', memberId: null, count: 1 }],
        ai: async () =>
          new Map([
            [
              'row-1',
              { categoryId: 'cat-repairs', memberId: null, tags: [], confidence: 0.5, explanation: 'AI' },
            ],
          ]),
      }),
    );
    expect(suggested!.autoApply).toBe(false);
    expect(suggested!.property).toMatchObject({ propertyId: 'p-elm', autoApply: false });
  });

  it('a rule may set a property; a unit needs its property', () => {
    expect(
      validateRule({ all: [{ field: 'payee', op: 'contains', value: 'x' }] }, { propertyId: 'p' }),
    ).toEqual([]);
    expect(
      validateRule({ all: [{ field: 'payee', op: 'contains', value: 'x' }] }, { unitId: 'u' }),
    ).toContain('actions.unitId: A unit needs its property');
  });
});
