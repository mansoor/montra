import { describe, expect, it } from 'vitest';
import {
  amountBand,
  applyCurve,
  calibrate,
  costMicroUsd,
  fitIsotonic,
  parsePriceOverrides,
  maskText,
  minimizeDate,
  minimizeText,
  modelFor,
  pseudonymize,
  roundedAmount,
  unpseudonymize,
} from '../src/index.js';
import * as categorizeV1 from '../src/tasks/categorize/v1.js';
import * as mapV1 from '../src/tasks/map-columns/v1.js';
import { jsonSchemaOf } from '../src/schema.js';
import { parseJsonLoose, stableJson } from '../src/util.js';

interface Schema {
  $schema?: string;
  additionalProperties: boolean;
  required: string[];
  properties: { results: { items: { additionalProperties: boolean; required: string[] } } };
}

describe('minimizer (AIA-03)', () => {
  it('masks card and account numbers but keeps dates and decimal amounts', () => {
    expect(maskText('SQ *BLUE BOTTLE 0423 SF CA')).toBe('SQ *BLUE BOTTLE •••• SF CA');
    expect(maskText('PAYMENT TO AMEX 371449635398431')).toBe('PAYMENT TO AMEX ••••');
    expect(maskText('Card 4111 1111 1111 1111')).toBe('Card •••• •••• •••• ••••');
    expect(maskText('ACH 2026-10-30 1,234.56')).toBe('ACH 2026-10-30 1,234.56');
    expect(maskText('posted 10/30/2026 amount 12.50')).toBe('posted 10/30/2026 amount 12.50');
    expect(maskText('Betrag 1.234,56 EUR')).toBe('Betrag 1.234,56 EUR');
    expect(maskText('store 123')).toBe('store 123');
  });

  it('masks emails, phone numbers and street numbers', () => {
    expect(maskText('ZELLE TO jane.doe@example.com')).toBe('ZELLE TO [email]');
    expect(maskText('Call (555) 123-4567 now')).toBe('Call [phone] now');
    expect(maskText('call 555-123-4567')).toBe('call [phone]');
    expect(maskText('+1 555 123 4567')).toBe('[phone]');
    expect(maskText('Rent for 123 Main St')).toBe('Rent for # Main St');
    expect(maskText('4521 N Oak Avenue repair')).toBe('# N Oak Avenue repair');
  });

  it('keeps digits for quick add when asked', () => {
    expect(maskText('rent 1200 checking', { keepDigits: true })).toBe('rent 1200 checking');
    expect(maskText('rent 1200 a@b.co', { keepDigits: true })).toBe('rent 1200 [email]');
  });

  it('pseudonymizes whole words case-insensitively and maps back', () => {
    const p = [
      { name: 'Sam', token: 'MEMBER_1' },
      { name: 'Sam Lee', token: 'MEMBER_2' },
      { name: 'Ann', token: 'TENANT_3' },
    ];
    const out = pseudonymize('Venmo to sam lee for SAM and Annabel; ann rent', p);
    expect(out).toBe('Venmo to MEMBER_2 for MEMBER_1 and Annabel; TENANT_3 rent');
    expect(unpseudonymize('MEMBER_2 paid TENANT_3', p)).toBe('Sam Lee paid Ann');
    expect(minimizeText('Zelle 1234567 to Sam', p)).toBe('Zelle •••• to MEMBER_1');
  });

  it('reduces dates to month and weekday', () => {
    expect(minimizeDate('2026-10-30')).toEqual({ month: '2026-10', weekday: 'Fri' });
    expect(minimizeDate('bad')).toEqual({ month: '', weekday: '' });
  });
});

describe('amount bands and rounding', () => {
  it('uses half-octave log buckets, signed', () => {
    expect(amountBand(0n, 2)).toBe(0);
    expect(amountBand(-50n, 2)).toBe(-1); // $0.50 → max(1, …) = 1 → 1
    expect(amountBand(-100n, 2)).toBe(-1); // $1
    expect(amountBand(-150n, 2)).toBe(-2); // $1.50: 2·log2(1.5)=1.17
    expect(amountBand(-480n, 2)).toBe(-5); // $4.80: 2·log2(4.8)=4.53
    expect(amountBand(120000n, 2)).toBe(21); // $1200: 2·log2(1200)=20.46
    expect(amountBand(1200n, 0)).toBe(21); // JPY
    expect(amountBand(-499n, 2)).toBe(amountBand(-480n, 2));
  });

  it('rounds to two significant figures', () => {
    expect(roundedAmount(-123456n, 2)).toBe('-1200');
    expect(roundedAmount(-483n, 2)).toBe('-4.8');
    expect(roundedAmount(-485n, 2)).toBe('-4.9');
    expect(roundedAmount(99n, 2)).toBe('0.99');
    expect(roundedAmount(5n, 2)).toBe('0.05');
    expect(roundedAmount(0n, 2)).toBe('0');
    expect(roundedAmount(1999n, 0)).toBe('2000');
  });
});

describe('calibration', () => {
  it('is identity by default and monotone for configured curves', () => {
    expect(calibrate('anthropic', 'claude-sonnet-5-5', 'categorize', 0.83)).toBeCloseTo(0.83);
    // Haiku's fitted curve (2026-11-21): it under-states, so 0.83 is raised; low scores stay low.
    expect(calibrate('anthropic', 'claude-haiku-5-5', 'categorize', 0.83)).toBeCloseTo(0.988);
    expect(calibrate('anthropic', 'claude-haiku-5-5', 'categorize', 0.3)).toBeCloseTo(0.091);
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = calibrate('openai_compatible', 'llama3.1', 'categorize', x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
    expect(calibrate('openai_compatible', 'llama3.1', 'categorize', 1)).toBeCloseTo(0.85);
    expect(
      applyCurve(
        [
          [0, 0],
          [1, 1],
        ],
        7,
      ),
    ).toBe(1);
  });

  it('fits a monotone isotonic curve', () => {
    const samples = [
      ...Array.from({ length: 50 }, (_, i) => ({ raw: 0.9, correct: i < 45 })),
      ...Array.from({ length: 50 }, (_, i) => ({ raw: 0.5, correct: i < 20 })),
      ...Array.from({ length: 20 }, (_, i) => ({ raw: 0.6, correct: i < 6 })),
    ];
    const curve = fitIsotonic(samples);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]![0]).toBeGreaterThan(curve[i - 1]![0]);
      expect(curve[i]![1]).toBeGreaterThanOrEqual(curve[i - 1]![1]);
    }
    expect(applyCurve(curve, 0.9)).toBeCloseTo(0.9, 1);
  });

  it('keeps a wide block of right answers flat, and never claims 0% or 100%', () => {
    // Under-confident: right 19 times in 20 from 0.5 up, wrong at 0.2.
    const samples = [
      ...Array.from({ length: 10 }, () => ({ raw: 0.2, correct: false })),
      ...Array.from({ length: 100 }, (_, i) => ({ raw: 0.5 + (i % 50) / 100, correct: i % 20 !== 0 })),
    ];
    const curve = fitIsotonic(samples);
    expect(applyCurve(curve, 0.2)).toBeGreaterThan(0);
    expect(applyCurve(curve, 0.2)).toBeLessThan(0.2);
    // The block's level holds across its whole range rather than sloping from its middle.
    expect(applyCurve(curve, 0.55)).toBeCloseTo(applyCurve(curve, 0.95), 1);
    expect(applyCurve(curve, 0.55)).toBeGreaterThan(0.9);
    expect(applyCurve(curve, 1)).toBeLessThan(1);
    expect(curve.length).toBeLessThanOrEqual(14);
  });
});

describe('prices and routing', () => {
  it('computes cost in micro-USD, rounding up', () => {
    expect(
      costMicroUsd('claude-haiku-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(100_000n);
    expect(
      costMicroUsd('claude-sonnet-5-5', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(12_000n);
    expect(
      costMicroUsd('claude-haiku-5-5', {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(1n);
    expect(
      costMicroUsd('llama3.1', {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0n);
  });

  it('routes groups to models with workspace and environment overrides', () => {
    expect(modelFor({ id: 'anthropic' }, 'small', {})).toBe('claude-haiku-5-5');
    expect(modelFor({ id: 'anthropic' }, 'vision', {})).toBe('claude-sonnet-5-5');
    expect(modelFor({ id: 'anthropic' }, 'large', {})).toBe('claude-opus-5-5');
    expect(modelFor({ id: 'anthropic' }, 'small', { AI_MODEL_SMALL: 'x' })).toBe('x');
    expect(modelFor({ id: 'anthropic', models: { small: 'y' } }, 'small', { AI_MODEL_SMALL: 'x' })).toBe('y');
    expect(modelFor({ id: 'openai_compatible', models: { small: 'qwen2.5' } }, 'large', {})).toBe('qwen2.5');
    expect(modelFor({ id: 'openai_compatible' }, 'small', {})).toBe('llama3.1');
    // Your own key (backlog item 3): defaults for OpenAI and Gemini; Azure has only the deployments it's given.
    expect(modelFor({ id: 'openai' }, 'small', {})).toBe('gpt-6-luna');
    expect(modelFor({ id: 'gemini' }, 'vision', {})).toBe('gemini-3.8-flash');
    expect(modelFor({ id: 'openai' }, 'small', { AI_MODEL_SMALL: 'x' })).toBe('gpt-6-luna');
    expect(modelFor({ id: 'azure_openai', models: { large: 'my-deploy' } }, 'small', {})).toBe('my-deploy');
    expect(modelFor({ id: 'azure_openai' }, 'small', {})).toBe('');
  });

  it('prices OpenAI and Gemini, by the day for announced changes, a snapshot as its model', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    // gpt-6-luna: 0.10 in, 0.01 cached, 0.50 out.
    expect(costMicroUsd('gpt-6-luna', usage)).toBe(610_000n);
    expect(costMicroUsd('gpt-6-luna-2026-09-30', usage)).toBe(610_000n);
    // gemini-4-argon doubles on 1 December 2026; gemini-3.8-flash on 1 January 2027.
    expect(costMicroUsd('gemini-4-argon', usage, { day: '2026-11-30' })).toBe(12_100_000n);
    expect(costMicroUsd('gemini-4-argon', usage, { day: '2026-12-01' })).toBe(24_200_000n);
    expect(costMicroUsd('gemini-3.8-flash', usage, { day: '2026-12-31' })).toBe(4_575_000n);
    expect(costMicroUsd('gemini-3.8-flash', usage, { day: '2027-01-01' })).toBe(9_150_000n);
    // A deployment name the table can't know costs nothing.
    expect(costMicroUsd('my-azure-deployment', usage)).toBe(0n);
  });

  it('takes rates from AI_MODEL_PRICES over the table, and refuses a bad setting', () => {
    const overrides = parsePriceOverrides(
      '{"gpt-6-luna":{"input":0.2,"output":1},"my-azure-deployment":{"input":1,"cachedInput":0.1,"output":4}}',
    );
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    expect(costMicroUsd('gpt-6-luna', usage, { overrides })).toBe(1_400_000n);
    expect(costMicroUsd('my-azure-deployment', usage, { overrides })).toBe(5_100_000n);
    expect(parsePriceOverrides(undefined)).toEqual({});
    expect(parsePriceOverrides('  ')).toEqual({});
    expect(() => parsePriceOverrides('{bad')).toThrow('not JSON');
    expect(() => parsePriceOverrides('[1]')).toThrow('must be an object');
    expect(() => parsePriceOverrides('{"m":{"input":"1","output":2}}')).toThrow('m.input');
    expect(() => parsePriceOverrides('{"m":{"input":1,"output":-2}}')).toThrow('m.output');
  });
});

describe('schemas and helpers', () => {
  it('produces strict JSON schemas (closed objects, all properties required)', () => {
    const s = jsonSchemaOf(categorizeV1.Output) as unknown as Schema;
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    const item = s.properties.results.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['id', 'category', 'member', 'tags', 'confidence', 'reason', 'merchant']);
    const m = jsonSchemaOf(mapV1.Output) as unknown as Schema;
    expect(m.required).toContain('payee');
    expect(JSON.stringify(m)).not.toContain('minimum');
  });

  it('parses JSON loosely and hashes stably', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here: {"a":2} done')).toEqual({ a: 2 });
    expect(() => parseJsonLoose('nope')).toThrow();
    expect(stableJson({ b: 1n, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":"1"}');
  });
});
