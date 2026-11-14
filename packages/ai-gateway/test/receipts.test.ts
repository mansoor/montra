import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { groupReceipt, parseMoney, validateReceipt, type CurrencyCode } from '@montra/domain';
import {
  AnthropicAdapter,
  createGateway,
  decodeFakeReceiptImage,
  encodeFakeReceiptImage,
  FakeAdapter,
  MemoryStore,
  parseReceiptText,
  type AiContext,
  type CompletionRequest,
  type ReceiptDocument,
  type ReceiptExtraction,
} from '../src/index.js';

// extract_receipt (RCP-01, RCP-02; 04 §7 step 2). The corpus in test/receipts holds receipt texts and the
// extraction the fake provider must produce; each must also validate under the domain arithmetic (RCP-05).
const DIR = join(__dirname, 'receipts');
const corpus = readdirSync(DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({
    name: f.replace(/\.txt$/, ''),
    text: readFileSync(join(DIR, f), 'utf8'),
    expected: JSON.parse(readFileSync(join(DIR, f.replace(/\.txt$/, '.json')), 'utf8')) as ReceiptExtraction,
  }));

const minor = (s: string | null, currency: string) =>
  s === null ? 0n : parseMoney(s, currency as CurrencyCode).amount;

function totalsOf(r: ReceiptExtraction, currency: string) {
  return {
    tax: minor(r.tax, currency),
    taxIncluded: r.taxIncluded === true,
    discount: minor(r.discount, currency),
    fees: minor(r.fees, currency),
    tip: minor(r.tip, currency),
    total: r.total === null ? null : minor(r.total, currency),
  };
}

const ctxOf = (store: MemoryStore, over: Partial<AiContext> = {}): AiContext => ({
  workspaceId: 'w1',
  mode: 'builtin',
  provider: { id: 'fake' },
  budget: { monthlyUsd: null, spentMicroUsd: 0n },
  store,
  ...over,
});
const png = (text: string) => ({
  mediaType: 'image/png' as const,
  data: Buffer.from(encodeFakeReceiptImage(text)).toString('base64'),
});
const doc = (over: Partial<ReceiptDocument> = {}): ReceiptDocument => ({
  images: [],
  ocrText: null,
  currencyHint: 'USD',
  locale: 'en-US',
  ...over,
});

describe('receipt corpus', () => {
  it.each(corpus.map((c) => [c.name, c] as const))('%s extracts as recorded and adds up', (_, c) => {
    const out = parseReceiptText(c.text);
    expect(out).toEqual(c.expected);
    const currency = out.currency ?? 'USD';
    const lines = out.lines.map((l) => ({
      key: l.rawText,
      lineTotal: minor(l.lineTotal, currency),
      discount: minor(l.discount, currency),
      taxable: l.taxable ?? true,
    }));
    expect(validateReceipt(lines, totalsOf(out, currency))).toMatchObject({ gap: 0n, ok: true });
  });

  it('turns the Walmart receipt into the documented splits (requirements §3.5)', () => {
    const w = corpus.find((c) => c.name === 'walmart')!.expected;
    const category = ['Groceries', 'Groceries', 'Electronics', 'Clothing'];
    const groups = groupReceipt(
      w.lines.map((l, i) => ({
        key: category[i]!,
        lineTotal: minor(l.lineTotal, 'USD'),
        discount: 0n,
        taxable: l.taxable!,
      })),
      totalsOf(w, 'USD'),
    );
    expect(groups.map((g) => [g.key, g.total])).toEqual([
      ['Groceries', 510n],
      ['Electronics', 1391n],
      ['Clothing', 970n],
    ]);
    expect(w.lines.map((l) => l.expandedName)).toEqual([
      'Great Value 2% milk 1 gal',
      null,
      'onn. USB-C charger',
      "Men's T-shirt",
    ]);
  });
});

describe('fake receipt images', () => {
  it('round-trips text through a valid PNG and ignores other images', () => {
    const bytes = encodeFakeReceiptImage('CAFÉ €3,20');
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(decodeFakeReceiptImage(Buffer.from(bytes).toString('base64'))).toBe('CAFÉ €3,20');
    expect(decodeFakeReceiptImage(Buffer.from('not a png').toString('base64'))).toBeNull();
  });
});

describe('gateway.extractReceipt', () => {
  const walmart = corpus.find((c) => c.name === 'walmart')!;

  it('reads photos in builtin mode and records the event', async () => {
    const fake = new FakeAdapter();
    const gw = createGateway({ adapterFactory: () => fake, env: {} });
    const store = new MemoryStore();
    const pages = walmart.text.split('SUBTOTAL');
    const res = await gw.extractReceipt(
      doc({ images: [png(pages[0]!), png(`SUBTOTAL${pages[1]!}`)] }),
      ctxOf(store, { subject: { type: 'receipt', id: 'r1' } }),
    );
    expect(res).toMatchObject({ ok: true, value: walmart.expected });
    expect(fake.calls[0]!.images).toHaveLength(2);
    expect(fake.calls[0]!.model).toBe('fake-vision');
    expect(store.events.at(-1)).toMatchObject({
      task: 'extract_receipt',
      outcome: 'ok',
      confidence: 0.9,
      output: { merchant: 'WALMART SUPERCENTER', lines: 4, total: '28.71' },
      subject: { type: 'receipt', id: 'r1' },
    });
  });

  it('never sends images in local mode: it reads the masked OCR text', async () => {
    const fake = new FakeAdapter();
    const gw = createGateway({ adapterFactory: () => fake, env: {} });
    const ocr = `${walmart.text}\nACCOUNT 4111111111111111`;
    const res = await gw.extractReceipt(
      doc({ images: [png(walmart.text)], ocrText: ocr }),
      ctxOf(new MemoryStore(), { mode: 'local', provider: { id: 'fake' } }),
    );
    expect(res.ok).toBe(true);
    const sent = fake.calls[0]!;
    expect(sent.images).toBeUndefined();
    expect(sent.input).not.toContain('4111111111111111');
    expect(JSON.parse(sent.input)).toMatchObject({ pages: 0, imageHashes: [], currencyHint: 'USD' });
  });

  it('fails cleanly without anything to read, and when AI is off', async () => {
    const gw = createGateway({ adapterFactory: () => new FakeAdapter(), env: {} });
    const store = new MemoryStore();
    expect(
      await gw.extractReceipt(doc({ images: [png('x')] }), ctxOf(store, { mode: 'local' })),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_output',
      detail: 'local mode reads receipts from OCR text; none yet',
    });
    expect(await gw.extractReceipt(doc({ ocrText: 'x' }), ctxOf(store, { mode: 'off' }))).toEqual({
      ok: false,
      reason: 'off',
    });
  });

  it('cleans what the model returns and rejects answers that lose most lines', async () => {
    const answer = (o: Record<string, unknown>) => ({
      merchant: '  Walmart ',
      storeAddress: ' 1155 Hollister St,\n San Diego, CA 92154 ',
      storePhone: '(619) 575-1111',
      storeWebsite: 'https://www.Walmart.com/',
      date: '2026-10-05',
      localTime: '25:99',
      currency: 'usd',
      lines: [],
      subtotal: '26.96',
      tax: '1.75',
      taxIncluded: 'no',
      discount: '-1.00',
      fees: null,
      tip: null,
      total: '28.71',
      cardLast4: '12345',
      confidence: 1.7,
      ...o,
    });
    let next: unknown;
    const scripted = {
      id: 'anthropic' as const,
      complete: async (req: CompletionRequest) => ({
        ok: true as const,
        json: next,
        model: req.model,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    };
    const gw = createGateway({ adapterFactory: () => scripted, env: {} });
    const ctx = ctxOf(new MemoryStore(), { provider: { id: 'anthropic' } });
    const line = (rawText: string, lineTotal: string, taxable = 'unmarked') => ({
      rawText,
      expandedName: null,
      qty: null,
      unitPrice: null,
      lineTotal,
      discount: null,
      taxable,
    });
    next = answer({ lines: [line('MILK', '3.48', 'no'), line('BREAD', '2,10', 'yes'), line('', '1.00')] });
    const ok = await gw.extractReceipt(doc({ images: [png('x')] }), ctx);
    expect(ok).toMatchObject({
      ok: true,
      value: {
        merchant: 'Walmart',
        storeAddress: '1155 Hollister St, San Diego, CA 92154',
        storePhone: '(619) 575-1111',
        storeWebsite: 'www.walmart.com',
        localTime: null,
        currency: 'USD',
        discount: '1.00',
        cardLast4: null,
        confidence: 1,
        // v2 answers yes/no/unmarked in words; the receipt keeps true/false/null.
        taxIncluded: false,
        lines: [
          { rawText: 'MILK', lineTotal: '3.48', taxable: false },
          { rawText: 'BREAD', taxable: true },
        ],
      },
    });
    // Nothing printed, or something that isn't a phone number or a website: null.
    next = answer({
      storeAddress: '',
      storePhone: 'call us',
      storeWebsite: 'Thank you!',
      lines: [line('EGGS', '2.00')],
    });
    expect(await gw.extractReceipt(doc({ images: [png('x')] }), ctx)).toMatchObject({
      ok: true,
      value: { storeAddress: null, storePhone: null, storeWebsite: null },
    });
    next = answer({ taxIncluded: 'unclear', lines: [line('EGGS', '2.00')] });
    expect(await gw.extractReceipt(doc({ images: [png('x')] }), ctx)).toMatchObject({
      ok: true,
      value: { taxIncluded: null, lines: [{ rawText: 'EGGS', taxable: null }] },
    });
    next = answer({ lines: [line('A', 'x'), line('B', 'y'), line('C', '1.00')] });
    expect(await gw.extractReceipt(doc({ images: [png('x')] }), ctx)).toMatchObject({
      ok: false,
      reason: 'invalid_output',
    });
  });
});

describe('AnthropicAdapter with documents', () => {
  it('sends images and PDF pages as content blocks before the text', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          return {
            model: 'claude-sonnet-5-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
      beta: { messages: { create: async () => ({}) } },
    } as unknown as Pick<Anthropic, 'messages' | 'beta'>;
    const adapter = new AnthropicAdapter(
      { id: 'anthropic', apiKey: 'k', baseUrl: 'https://proxy.test' },
      client,
    );
    await adapter.complete({
      task: 'extract_receipt',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      system: 'S',
      input: '{"pages":2}',
      images: [
        { mediaType: 'image/jpeg', data: 'AAA' },
        { mediaType: 'application/pdf', data: 'BBB' },
      ],
      schema: { type: 'object' },
      maxTokens: 100,
    });
    expect(seen[0]!.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } },
          { type: 'text', text: '{"pages":2}' },
        ],
      },
    ]);
  });
});
