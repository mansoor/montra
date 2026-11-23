import { describe, expect, it } from 'vitest';
import {
  createGateway,
  FakeAdapter,
  MemoryStore,
  type AiContext,
  type CompletionRequest,
  type CompletionResponse,
  type PropertyChoice,
  type PropertyItem,
  type ProviderAdapter,
} from '../src/index.js';

const PROPS: PropertyChoice[] = [
  {
    id: 'prop-elm',
    name: '12 Elm St',
    units: [
      { id: 'unit-2b', label: 'Unit 2B' },
      { id: 'unit-3', label: '3' },
    ],
  },
  { id: 'prop-lake', name: 'Lakeside cabin', units: [] },
];

const line = (id: string, description: string, payee: string | null = 'Ace Plumbing'): PropertyItem => ({
  id,
  payee,
  description,
  amountMinor: -18500n,
  currency: 'USD',
  category: 'Repairs',
});

const ctxOf = (store: MemoryStore, over: Partial<AiContext> = {}): AiContext => ({
  workspaceId: 'w1',
  mode: 'builtin',
  provider: { id: 'fake' },
  budget: { monthlyUsd: null, spentMicroUsd: 0n },
  store,
  ...over,
});

describe('suggest_property (AI-02)', () => {
  it('answers with the fake provider, deterministically, under the real ids', async () => {
    const fake = new FakeAdapter();
    const gw = createGateway({ adapterFactory: () => fake });
    const items = [
      line('a', 'ACE PLUMBING 12 ELM ST APT 2B'),
      line('b', 'Snow removal, Lakeside', 'Plow Co'),
      line('c', 'BANK SERVICE FEE', null),
    ];
    const res = await gw.suggestProperty(items, PROPS, ctxOf(new MemoryStore()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([
      {
        id: 'a',
        propertyId: 'prop-elm',
        unitId: 'unit-2b',
        confidence: 0.97,
        explanation: 'AI: the text names # Elm St → 12 Elm St, Unit 2B',
      },
      {
        id: 'b',
        propertyId: 'prop-lake',
        unitId: null,
        confidence: 0.97,
        explanation: 'AI: the text names Lakeside cabin → Lakeside cabin',
      },
      { id: 'c', propertyId: null, unitId: null, confidence: 0, explanation: '' },
    ]);
    const again = await createGateway({ adapterFactory: () => new FakeAdapter() }).suggestProperty(
      items,
      PROPS,
      ctxOf(new MemoryStore()),
    );
    expect(again.ok && again.value).toEqual(res.value);
  });

  it('sends short ids, names masked like any text and unit labels; never the real ids or a street number', async () => {
    const fake = new FakeAdapter();
    await createGateway({ adapterFactory: () => fake }).suggestProperty(
      [line('a', 'ACE PLUMBING 12 ELM ST, card 4111111111111111')],
      PROPS,
      ctxOf(new MemoryStore()),
    );
    const req = fake.calls[0]!;
    expect(req.task).toBe('suggest_property');
    const sent = `${req.context ?? ''}${req.input}`;
    expect(sent).not.toContain('prop-elm');
    expect(sent).not.toContain('unit-2b');
    expect(sent).not.toContain('12 Elm');
    expect(sent).not.toContain('12 ELM');
    expect(sent).not.toContain('4111');
    expect(JSON.parse(req.context!)).toEqual({
      properties: [
        {
          id: 'p1',
          name: '# Elm St',
          units: [
            { id: 'u1', label: 'Unit 2B' },
            { id: 'u2', label: '3' },
          ],
        },
        { id: 'p2', name: 'Lakeside cabin', units: [] },
      ],
    });
  });

  it('keeps a unit only with its own property, and drops ids it was not given', async () => {
    const scripted: ProviderAdapter = {
      id: 'fake',
      complete: async (): Promise<CompletionResponse> => ({
        ok: true,
        json: {
          results: [
            { id: 'i0', property: 'p2', unit: 'u1', confidence: 0.8, reason: 'cabin' },
            { id: 'i1', property: 'p9', unit: null, confidence: 0.99, reason: 'made up' },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'fake',
      }),
    };
    const res = await createGateway({ adapterFactory: () => scripted }).suggestProperty(
      [line('a', 'one'), line('b', 'two')],
      PROPS,
      ctxOf(new MemoryStore()),
    );
    expect(res.ok && res.value.map((v) => [v.id, v.propertyId, v.unitId, v.confidence])).toEqual([
      ['a', 'prop-lake', null, 0.8],
      ['b', null, null, 0],
    ]);
  });

  it('fails softly: off, and a provider error, return ok: false', async () => {
    const off = await createGateway().suggestProperty(
      [line('a', 'x')],
      PROPS,
      ctxOf(new MemoryStore(), { mode: 'off' }),
    );
    expect(off).toMatchObject({ ok: false, reason: 'off' });
    const broken: ProviderAdapter = {
      id: 'fake',
      complete: async (_r: CompletionRequest): Promise<CompletionResponse> => ({
        ok: false,
        reason: 'provider_error',
        detail: 'down',
      }),
    };
    const res = await createGateway({ adapterFactory: () => broken }).suggestProperty(
      [line('a', 'x')],
      PROPS,
      ctxOf(new MemoryStore()),
    );
    expect(res.ok).toBe(false);
  });

  it('caches per line, so the same line asks once', async () => {
    const fake = new FakeAdapter();
    const gw = createGateway({ adapterFactory: () => fake });
    const store = new MemoryStore();
    await gw.suggestProperty([line('a', 'ACE 12 ELM ST')], PROPS, ctxOf(store));
    const res = await gw.suggestProperty([line('z', 'ACE 12 ELM ST')], PROPS, ctxOf(store));
    expect(fake.calls).toHaveLength(1);
    expect(res.ok && res.value[0]).toMatchObject({ id: 'z', propertyId: 'prop-elm' });
  });
});
