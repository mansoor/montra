/**
 * Price table (06 §5) in micro-USD per million tokens. Local and fake models cost nothing.
 * Claude Haiku 5.5 has a higher rate above 100K prompt tokens; our batches stay far below that.
 */
import type { Usage } from '../types.js';

export interface ModelPrice {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}

const usd = (dollars: number): bigint => BigInt(Math.trunc(dollars * 1_000_000));

function price(input: number, output: number, cacheRead: number): ModelPrice {
  return { input: usd(input), output: usd(output), cacheRead: usd(cacheRead), cacheWrite: usd(input * 1.25) };
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-fable-5-1': price(10, 50, 0.25),
};

const MILLION = 1_000_000n;

/** Cost of one call, rounded up to a whole micro-dollar. Unknown models (local) cost 0. */
export function costMicroUsd(model: string, usage: Usage): bigint {
  const p = PRICES[model];
  if (!p) return 0n;
  const total =
    BigInt(usage.inputTokens) * p.input +
    BigInt(usage.outputTokens) * p.output +
    BigInt(usage.cacheReadTokens) * p.cacheRead +
    BigInt(usage.cacheWriteTokens) * p.cacheWrite;
  return (total + MILLION - 1n) / MILLION;
}
