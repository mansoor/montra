/**
 * Price table (06 §5) in micro-USD per million tokens. Local and fake models cost nothing, and so does a model the
 * table doesn't know (a customer's own deployment), so a budget can't hold it back.
 * Claude Haiku 5.5 has a higher rate above 100K prompt tokens; our batches stay far below that.
 * OpenAI and Gemini rates are their standard (not batch) rates read from their pricing pages on 2026-11-20. Rates
 * change: dated steps are in PRICE_SCHEDULES, and an operator can set any model's rate with AI_MODEL_PRICES
 * (`parsePriceOverrides`) without a release.
 */
import type { Usage } from '../types.js';

export interface ModelPrice {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}

const usd = (dollars: number): bigint => BigInt(Math.trunc(dollars * 1_000_000));

/** Anthropic: writing the prompt cache costs 1.25 × input. */
function price(input: number, output: number, cacheRead: number): ModelPrice {
  return { input: usd(input), output: usd(output), cacheRead: usd(cacheRead), cacheWrite: usd(input * 1.25) };
}

/** OpenAI and Gemini: caching is implicit, with no charge to write; cached input is billed at its own rate. */
function flat(input: number, cachedInput: number, output: number): ModelPrice {
  return { input: usd(input), output: usd(output), cacheRead: usd(cachedInput), cacheWrite: usd(input) };
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-fable-5-1': price(10, 50, 0.25),
  // OpenAI (standard tier, prompts up to 272K tokens).
  'gpt-6-luna': flat(0.1, 0.01, 0.5),
  'gpt-6.1-terra': flat(1, 0.05, 5),
  'gpt-6.1-sol': flat(2, 0.1, 10),
  'gpt-6.2-sol': flat(2, 0.1, 10),
  'gpt-6.2-astra': flat(8, 0.4, 40),
  'gpt-5-mini': flat(0.25, 0.025, 2),
  'gpt-5': flat(1.25, 0.125, 10),
  // Google Gemini.
  'gemini-3.5-flash-lite': flat(0.3, 0.03, 2.5),
  'gemini-4-hydrogen': flat(1.5, 0.075, 7.5),
  'gemini-4-neon': flat(3, 0.15, 15),
};

/** A rate that applies from a day (UTC, inclusive) until the next step. */
export interface PriceStep {
  from: string;
  price: ModelPrice;
}

/** Rates announced to change on a date (oldest first). */
export const PRICE_SCHEDULES: Readonly<Record<string, readonly PriceStep[]>> = {
  'gemini-3.8-flash': [
    { from: '2000-01-01', price: flat(0.75, 0.075, 3.75) },
    { from: '2027-01-01', price: flat(1.5, 0.15, 7.5) },
  ],
  'gemini-4-argon': [
    { from: '2000-01-01', price: flat(2, 0.1, 10) },
    { from: '2026-12-01', price: flat(4, 0.2, 20) },
  ],
  'gemini-4-carbon': [
    { from: '2000-01-01', price: flat(2, 0.1, 10) },
    { from: '2026-12-01', price: flat(4, 0.2, 20) },
  ],
};

/**
 * Reads AI_MODEL_PRICES: a JSON object of model id → `{ "input", "cachedInput", "output" }` in USD per million tokens
 * (cachedInput defaults to input). These win over the table for every day. Throws on anything else, so a bad
 * setting stops the server at start rather than pricing calls at nothing.
 */
export function parsePriceOverrides(json: string | undefined): Record<string, ModelPrice> {
  if (!json?.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('AI_MODEL_PRICES is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('AI_MODEL_PRICES must be an object');
  const rate = (v: unknown, model: string, field: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000)
      throw new Error(`AI_MODEL_PRICES: ${model}.${field} must be a number of USD per million tokens`);
    return v;
  };
  const out: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') throw new Error(`AI_MODEL_PRICES: ${model} must be an object`);
    const r = p as Record<string, unknown>;
    const input = rate(r.input, model, 'input');
    const cachedInput = r.cachedInput === undefined ? input : rate(r.cachedInput, model, 'cachedInput');
    out[model] = flat(input, cachedInput, rate(r.output, model, 'output'));
  }
  return out;
}

/** The rate for a model on a day: an operator's override, a dated step, then the table; a dated snapshot name
 * ("gpt-6-luna-2026-09-30") is priced as its model. */
export function priceOf(
  model: string,
  day: string,
  overrides: Readonly<Record<string, ModelPrice>> = {},
): ModelPrice | null {
  for (const name of [model, model.replace(/-\d{4}-\d{2}-\d{2}$/, '')]) {
    const o = overrides[name];
    if (o) return o;
    const steps = PRICE_SCHEDULES[name];
    if (steps) {
      const step = [...steps].reverse().find((s) => s.from <= day);
      if (step) return step.price;
    }
    const p = PRICES[name];
    if (p) return p;
  }
  return null;
}

const MILLION = 1_000_000n;

/** Cost of one call, rounded up to a whole micro-dollar. Unknown models (local) cost 0. */
export function costMicroUsd(
  model: string,
  usage: Usage,
  opts: { day?: string; overrides?: Readonly<Record<string, ModelPrice>> } = {},
): bigint {
  const p = priceOf(model, opts.day ?? new Date().toISOString().slice(0, 10), opts.overrides);
  if (!p) return 0n;
  const total =
    BigInt(usage.inputTokens) * p.input +
    BigInt(usage.outputTokens) * p.output +
    BigInt(usage.cacheReadTokens) * p.cacheRead +
    BigInt(usage.cacheWriteTokens) * p.cacheWrite;
  return (total + MILLION - 1n) / MILLION;
}
