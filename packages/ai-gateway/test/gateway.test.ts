import { describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  FakeAdapter,
  MemoryStore,
  type AiContext,
  type CategorizeItem,
  type CategoryOption,
  type CompletionRequest,
  type CompletionResponse,
  type ProviderAdapter,
  type ProviderConfig,
} from '../src/index.js';

const CATS: CategoryOption[] = [
  {
    id: 'cat-dining',
    name: 'Dining out',
    group: 'Daily',
    kind: 'expense',
    entityId: 'e1',
    entityType: 'personal',
  },
  { id: 'cat-fuel', name: 'Fuel', group: 'Daily', kind: 'expense', entityId: 'e1', entityType: 'personal' },
  {
    id: 'cat-groceries',
    name: 'Groceries',
    group: 'Daily',
    kind: 'expense',
    entityId: 'e1',
    entityType: 'personal',
  },
  {
    id: 'cat-salary',
    name: 'Salary',
    group: 'Income',
    kind: 'income',
    entityId: 'e1',
    entityType: 'personal',
  },
];

function item(id: string, payee: string, amountMinor = -480n): CategorizeItem {
  return {
    id,
    payee,
    description: payee,
    amountMinor,
    currency: 'USD',
    date: '2026-10-30',
    accountType: 'credit_card',
    entityType: 'personal',
  };
}

function ctxOf(store: MemoryStore, over: Partial<AiContext> = {}): AiContext {
  return {
    workspaceId: 'w1',
    mode: 'builtin',
    provider: { id: 'fake' },
    budget: { monthlyUsd: null, spentMicroUsd: 0n },
    store,
    ...over,
  };
}

/** Adapter that answers with a function of the request (records calls). */
class Scripted implements ProviderAdapter {
  readonly calls: CompletionRequest[] = [];
  constructor(
    readonly id: ProviderConfig['id'],
    private readonly fn: (
      req: CompletionRequest,
      n: number,
    ) => CompletionResponse | Promise<CompletionResponse>,
  ) {}
  async complete(req: CompletionRequest) {
    this.calls.push(req);
    return this.fn(req, this.calls.length);
  }
}

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('categorize', () => {
  it('categorizes through the fake provider, calibrates and explains', async () => {
    const store = new MemoryStore();
    const gw = createGateway();
    const res = await gw.categorize(
      [
        item('t1', 'SQ *BLUE BOTTLE COFFEE 0423 SF CA'),
        item('t2', 'SHELL OIL 57444'),
        item('t3', 'ZZZ unknown'),
      ],
      { categories: CATS, members: [] },
      ctxOf(store),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((v) => v.id)).toEqual(['t1', 't2', 't3']);
    expect(res.value[0]).toMatchObject({ categoryId: 'cat-dining', confidence: 0.9 });
    expect(res.value[0]!.explanation).toMatch(/^AI: .* → Dining out$/);
    expect(res.value[1]!.categoryId).toBe('cat-fuel');
    expect(res.value[2]!.categoryId).toBeNull();
    expect(res.value[2]!.confidence).toBe(0);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ task: 'categorize', outcome: 'ok', items: 3, provider: 'fake' });
    expect(JSON.stringify(store.events[0]!.output)).not.toContain('0423');
  });

  it('sends minimized rows with short ids, never raw numbers or real ids', async () => {
    const fake = new FakeAdapter();
    const gw = createGateway({ adapterFactory: () => fake });
    await gw.categorize(
      [{ ...item('t1', 'ZELLE TO Sam Lee 123456789'), amountMinor: -123456n }],
      { categories: CATS, members: [{ id: 'm-sam', name: 'Sam Lee', relationship: 'son' }] },
      ctxOf(new MemoryStore()),
    );
    const req = fake.calls[0]!;
    expect(req.task).toBe('categorize');
    expect(req.model).toBe('fake-small');
    expect(req.input).not.toContain('123456789');
    expect(req.input).not.toContain('Sam');
    expect(req.input).toContain('MEMBER_1');
    expect(req.input).toContain('"amount":"-1200"');
    expect(req.input).toContain('"month":"2026-10"');
    expect(req.input).not.toContain('2026-10-30');
    expect(req.context).not.toContain('cat-dining');
    expect(req.context).toContain('"id":"c1"');
    expect((req.schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it('serves repeats from the cache without calling the provider (AIA-07)', async () => {
    const store = new MemoryStore();
    const fake = new FakeAdapter();
    const gw = createGateway({ adapterFactory: () => fake });
    const opts = { categories: CATS, members: [] };
    // Same payee and band twice in one call → sent once.
    await gw.categorize([item('a', 'STARBUCKS 123'), item('b', 'STARBUCKS 999')], opts, ctxOf(store));
    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(fake.calls[0]!.input).items).toHaveLength(1);
    const second = await gw.categorize(
      [item('c', 'STARBUCKS #5'), item('d', 'KROGER 12')],
      opts,
      ctxOf(store),
    );
    expect(fake.calls).toHaveLength(2);
    expect(JSON.parse(fake.calls[1]!.input).items).toHaveLength(1); // only Kroger
    expect(second.ok && second.value.map((v) => v.categoryId)).toEqual(['cat-dining', 'cat-groceries']);
    expect(second.ok && second.meta.cachedItems).toBe(1);
    expect(store.events.map((e) => e.outcome)).toEqual(['ok', 'cached', 'ok']);
    // A different amount band or category list misses.
    await gw.categorize([item('e', 'STARBUCKS', -90000n)], opts, ctxOf(store));
    expect(fake.calls).toHaveLength(3);
    await gw.categorize(
      [item('f', 'STARBUCKS')],
      { categories: CATS.slice(0, 3), members: [] },
      ctxOf(store),
    );
    expect(fake.calls).toHaveLength(4);
  });

  it('batches by 100, at most 8 in flight, and keeps input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = new FakeAdapter();
    const slow = new Scripted('fake', async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return inner.complete(req);
    });
    const gw = createGateway({ adapterFactory: () => slow });
    const items = Array.from({ length: 1050 }, (_, i) =>
      item(`t${i}`, `MERCHANT NUMBER ${i} STARBUCKS`, -BigInt(100 + i * 37)),
    );
    // Distinct payee keys need distinct names; normalizeDescription strips numbers, so vary letters.
    const named = items.map((it, i) => ({
      ...it,
      payee: `SHOP ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))} COFFEE`,
    }));
    const res = await gw.categorize(named, { categories: CATS, members: [] }, ctxOf(new MemoryStore()));
    expect(res.ok).toBe(true);
    expect(slow.calls.length).toBe(11);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1);
    if (res.ok) {
      expect(res.value.map((v) => v.id)).toEqual(named.map((n) => n.id));
      expect(res.value.every((v) => v.categoryId === 'cat-dining')).toBe(true);
    }
  });

  it('drops unknown category ids and missing items; a broken batch fails only itself', async () => {
    const adapter = new Scripted('fake', (req) => {
      const items = JSON.parse(req.input).items as { id: string }[];
      if (items.length === 1) return { ok: true, json: { nope: 1 }, usage, model: 'm' }; // schema mismatch
      return {
        ok: true,
        model: 'm',
        usage,
        json: {
          results: [
            {
              id: 'i0',
              category: 'c99',
              member: null,
              tags: [],
              confidence: 0.9,
              reason: 'x',
              merchant: null,
            },
            // i1 missing
            {
              id: 'i2',
              category: 'c1',
              member: 'm9',
              tags: ['A', ' b '],
              confidence: 1.7,
              reason: 'y',
              merchant: { name: 'Y', mcc: '581' },
            },
          ],
        },
      };
    });
    const gw = createGateway({ adapterFactory: () => adapter });
    const store = new MemoryStore();
    const res = await gw.categorize(
      [item('a', 'AAA'), item('b', 'BBB'), item('c', 'CCC')],
      { categories: CATS, members: [] },
      ctxOf(store),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0]!.categoryId).toBeNull();
    expect(res.value[1]!.categoryId).toBeNull();
    expect(res.value[2]).toMatchObject({
      categoryId: 'cat-dining',
      memberId: null,
      tags: ['a', 'b'],
      rawConfidence: 1,
      merchant: { name: 'Y', mcc: null },
    });

    const one = await gw.categorize([item('z', 'ZED')], { categories: CATS, members: [] }, ctxOf(store));
    expect(one).toMatchObject({ ok: false, reason: 'invalid_output' });
    expect(store.events.at(-1)!.outcome).toBe('invalid_output');
  });

  it('returns off without calling anything when AI is off', async () => {
    const adapter = new Scripted('fake', () => {
      throw new Error('must not be called');
    });
    const gw = createGateway({ adapterFactory: () => adapter });
    const store = new MemoryStore();
    expect(
      await gw.categorize([item('a', 'X')], { categories: CATS, members: [] }, ctxOf(store, { mode: 'off' })),
    ).toEqual({ ok: false, reason: 'off' });
    expect(await gw.ping(ctxOf(store, { provider: { id: 'null' } }))).toEqual({ ok: false, reason: 'off' });
    expect(store.events).toHaveLength(0);
  });

  it('parks work for a local client instead of calling (hosted + local mode)', async () => {
    const adapter = new Scripted('openai_compatible', () => {
      throw new Error('must not be called');
    });
    const gw = createGateway({ adapterFactory: () => adapter });
    const store = new MemoryStore();
    const res = await gw.categorize(
      [item('a', 'SHELL 1234')],
      { categories: CATS, members: [] },
      ctxOf(store, { mode: 'local', provider: { id: 'openai_compatible' }, parkLocal: true }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'pending_local' });
    expect(store.parked).toHaveLength(1);
    expect(JSON.stringify(store.parked[0]!.input)).not.toContain('1234');
  });
});

describe('budget (AIA-08)', () => {
  it('blocks at 100% of the monthly budget and downgrades at 80%', async () => {
    const adapter = new Scripted('anthropic', (req) => ({
      ok: true,
      model: req.model,
      usage,
      json: { rows: [], opening: null, closing: null, periodStart: null, periodEnd: null },
    }));
    const gw = createGateway({ adapterFactory: () => adapter, env: {} });
    const store = new MemoryStore();
    const doc = { pages: ['page'], currency: 'USD' };
    const blocked = await gw.extractStatementTable(
      doc,
      ctxOf(store, { provider: { id: 'anthropic' }, budget: { monthlyUsd: 5, spentMicroUsd: 5_000_000n } }),
    );
    expect(blocked).toMatchObject({ ok: false, reason: 'budget' });
    expect(adapter.calls).toHaveLength(0);
    expect(store.events.at(-1)!.outcome).toBe('budget');

    await gw.extractStatementTable(
      doc,
      ctxOf(store, { provider: { id: 'anthropic' }, budget: { monthlyUsd: 5, spentMicroUsd: 1_000_000n } }),
    );
    expect(adapter.calls.at(-1)!.model).toBe('claude-sonnet-5-5');
    await gw.extractStatementTable(
      doc,
      ctxOf(store, { provider: { id: 'anthropic' }, budget: { monthlyUsd: 5, spentMicroUsd: 4_100_000n } }),
    );
    expect(adapter.calls.at(-1)!.model).toBe('claude-haiku-5-5');
  });

  it('accounts cost per call and stops mid-run once spend crosses the budget', async () => {
    const big = { inputTokens: 10_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }; // $1 on haiku
    const inner = new FakeAdapter();
    const adapter = new Scripted('anthropic', async (req) => {
      const r = await inner.complete(req);
      return r.ok ? { ...r, usage: big, model: req.model } : r;
    });
    const gw = createGateway({ adapterFactory: () => adapter, env: {}, concurrency: 1 });
    const store = new MemoryStore();
    const items = Array.from({ length: 300 }, (_, i) =>
      item(
        `t${i}`,
        `SHOP ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} STARBUCKS`,
      ),
    );
    const res = await gw.categorize(
      items,
      { categories: CATS, members: [] },
      ctxOf(store, { provider: { id: 'anthropic' }, budget: { monthlyUsd: 1.5, spentMicroUsd: 0n } }),
    );
    expect(adapter.calls).toHaveLength(2); // third batch sees $2 ≥ $1.50
    expect(store.spentMicroUsd).toBe(2_000_000n);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.filter((v) => v.categoryId).length).toBe(200);
      expect(res.meta.costMicroUsd).toBe(2_000_000n);
    }
    expect(store.events.map((e) => e.outcome)).toEqual(['ok', 'ok', 'budget']);
  });
});

describe('failover (OPS-07)', () => {
  it('retries once on the failover provider after a provider error', async () => {
    const primary = new Scripted('anthropic', () => ({
      ok: false,
      reason: 'provider_error',
      detail: '529 overloaded',
    }));
    const backup = new FakeAdapter();
    const onProviderFailure = vi.fn();
    const gw = createGateway({
      adapterFactory: (cfg) => (cfg.id === 'anthropic' ? primary : backup),
      onProviderFailure,
      env: {},
    });
    const store = new MemoryStore();
    const res = await gw.categorize(
      [item('a', 'SHELL')],
      { categories: CATS, members: [] },
      ctxOf(store, { provider: { id: 'anthropic' }, failover: { id: 'fake' } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.meta.failedOver).toBe(true);
      expect(res.meta.provider).toBe('fake');
      expect(res.value[0]!.categoryId).toBe('cat-fuel');
    }
    expect(onProviderFailure).toHaveBeenCalledWith({
      provider: 'anthropic',
      task: 'categorize',
      detail: '529 overloaded',
    });
    expect(store.events[0]).toMatchObject({ provider: 'fake', outcome: 'ok' });
    expect(store.calls).toBe(2);
  });

  it('does not fail over on refusals or invalid output', async () => {
    const primary = new Scripted('anthropic', () => ({ ok: false, reason: 'refused', detail: 'refusal' }));
    const backup = new Scripted('fake', () => {
      throw new Error('must not be called');
    });
    const gw = createGateway({
      adapterFactory: (cfg) => (cfg.id === 'anthropic' ? primary : backup),
      env: {},
    });
    const res = await gw.categorize(
      [item('a', 'X')],
      { categories: CATS, members: [] },
      ctxOf(new MemoryStore(), { provider: { id: 'anthropic' }, failover: { id: 'fake' } }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('reports provider_error when there is no failover', async () => {
    const primary = new Scripted('anthropic', () => ({
      ok: false,
      reason: 'provider_error',
      detail: 'connection error',
    }));
    const gw = createGateway({ adapterFactory: () => primary, env: {} });
    const store = new MemoryStore();
    const res = await gw.ping(ctxOf(store, { provider: { id: 'anthropic' } }));
    expect(res).toMatchObject({ ok: false, reason: 'provider_error', detail: 'connection error' });
    expect(store.events).toHaveLength(0); // pings are not audited
  });
});

describe('other tasks', () => {
  const gw = createGateway();
  const store = new MemoryStore();

  it('maps columns and validates indices', async () => {
    const rows = [
      ['Date', 'Description', 'Amount', 'Balance'],
      ['10/01/2026', 'STARBUCKS 1234', '-4.80', '100.00'],
      ['10/02/2026', 'PAYROLL', '2000.00', '2100.00'],
    ];
    const res = await gw.mapColumns(
      { fileType: 'csv', rows, locale: 'en-US', accountType: 'asset' },
      ctxOf(store),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.mapping).toMatchObject({
        headerRow: 0,
        dataStart: 1,
        date: 0,
        dateFormat: 'MM/DD/YYYY',
        description: [1],
        amount: 2,
        balance: 3,
        sign: 'normal',
      });
      expect(res.value.mapping.payee).toBeUndefined();
      expect(res.value.confidence).toBeCloseTo(0.85);
    }
    const bad = createGateway({
      adapterFactory: () =>
        new Scripted('fake', () => ({
          ok: true,
          usage,
          model: 'm',
          json: {
            headerRow: 0,
            dataStart: 1,
            date: 9,
            dateFormat: 'YYYY-MM-DD',
            description: [1],
            payee: null,
            amount: 2,
            debit: null,
            credit: null,
            direction: null,
            sign: 'normal',
            balance: null,
            category: null,
            reference: null,
            decimal: '.',
            confidence: 0.9,
          },
        })),
    });
    expect(
      await bad.mapColumns({ fileType: 'csv', rows, locale: 'en-US', accountType: 'asset' }, ctxOf(store)),
    ).toMatchObject({ ok: false, reason: 'invalid_output' });
  });

  it('parses quick add and maps short ids back', async () => {
    const res = await gw.parseQuickAdd(
      'lunch 18.50 amex yesterday with Sam',
      {
        today: '2026-10-30',
        currency: 'USD',
        accounts: [
          { id: 'acc-chk', label: 'Checking', kind: 'checking' },
          { id: 'acc-amex', label: 'Amex', kind: 'credit_card' },
        ],
        categories: CATS,
        members: [{ id: 'm-sam', name: 'Sam', relationship: 'son' }],
      },
      ctxOf(store),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        date: '2026-10-29',
        amount: '18.50',
        direction: 'out',
        accountId: 'acc-amex',
        memberId: 'm-sam',
      });
      expect(res.value.payee).toBe('Lunch');
    }
  });

  it('validates quick-add output: bad dates, negative or zero amounts, unknown ids', async () => {
    const g = createGateway({
      adapterFactory: () =>
        new Scripted('fake', () => ({
          ok: true,
          usage,
          model: 'm',
          json: {
            date: '2026-02-30',
            amount: '-12.00',
            direction: 'in',
            payee: 'MEMBER_1',
            account: 'a9',
            category: 'c1',
            member: 'm1',
            memo: null,
            tags: ['#Travel'],
            confidence: 0.8,
          },
        })),
    });
    const res = await g.parseQuickAdd(
      'x',
      {
        today: '2026-10-30',
        currency: 'USD',
        accounts: [],
        categories: CATS,
        members: [{ id: 'm-sam', name: 'Sam', relationship: null }],
      },
      ctxOf(store),
    );
    expect(res.ok && res.value).toMatchObject({
      date: null,
      amount: '12.00',
      direction: 'out',
      payee: 'Sam',
      accountId: null,
      memberId: 'm-sam',
      tags: ['travel'],
    });
  });

  it('extracts a statement table across page chunks and keeps opening/closing', async () => {
    const pages = [
      'Statement period 2026-10-01 to 2026-10-31\nOpening balance 1,000.00\n2026-10-02 STARBUCKS 4421 -4.80 995.20',
      '2026-10-05 PAYROLL ACME 2,000.00 2,995.20',
      'x',
      '10/30/2026 RENT -1,200.00 1,795.20\nClosing balance 1,795.20',
    ];
    const res = await gw.extractStatementTable({ pages, currency: 'USD' }, ctxOf(store));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows).toEqual([
        { date: '2026-10-02', description: 'STARBUCKS ••••', amount: '-4.80', balance: '995.20' },
        { date: '2026-10-05', description: 'PAYROLL ACME', amount: '2000.00', balance: '2995.20' },
        { date: '2026-10-30', description: 'RENT', amount: '-1200.00', balance: '1795.20' },
      ]);
      expect(res.value.opening).toBe('1000.00');
      expect(res.value.closing).toBe('1795.20');
    }
  });

  it('proposes categories, skipping existing names and unknown payees', async () => {
    const res = await gw.proposeCategories(
      {
        entityType: 'personal',
        existing: ['Groceries'],
        payees: [
          { payee: 'STARBUCKS', rows: 5, totalMinor: -2400n },
          { payee: 'KROGER', rows: 3, totalMinor: -12000n },
          { payee: 'MYSTERY LLC', rows: 1, totalMinor: -100n },
        ],
      },
      ctxOf(store),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.categories.map((c) => c.name)).toEqual(['Dining out']);
      expect(res.value.assignments).toEqual([
        { payee: 'STARBUCKS', category: 'Dining out' },
        { payee: 'KROGER', category: 'Groceries' },
      ]);
    }
  });

  it('normalizes payees with caching', async () => {
    const s = new MemoryStore();
    const res = await gw.normalizePayees(
      ['SQ *BLUE BOTTLE 0423 SF CA', 'SQ *BLUE BOTTLE 9999 SF CA'],
      ctxOf(s),
    );
    expect(res.ok && res.value.map((v) => v.name)).toEqual(['Blue Bottle', 'Blue Bottle']);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.items).toBe(1);
  });

  it('pings', async () => {
    expect(await gw.ping(ctxOf(store))).toMatchObject({ ok: true, value: { model: 'fake-small' } });
  });
});
