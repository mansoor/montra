/**
 * `pnpm --filter @montra/ai-gateway eval -- --task categorize --provider fake --split test [--limit N]`
 *
 * Providers: fake (offline), anthropic (ANTHROPIC_API_KEY; optional --model), openai_compatible
 * (--base-url http://localhost:11434/v1, --model llama3.1, optional OPENAI_API_KEY). Writes the report to
 * eval/reports/ and prints the headline numbers. Exits non-zero when --min-accuracy is given and missed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ProviderConfig } from '../src/types.js';
import { runEval } from './harness.js';

const { values } = parseArgs({
  options: {
    task: { type: 'string', default: 'categorize' },
    provider: { type: 'string', default: 'fake' },
    split: { type: 'string', default: 'test' },
    limit: { type: 'string' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    threshold: { type: 'string' },
    'min-accuracy': { type: 'string' },
  },
  allowPositionals: true,
});

if (values.task !== 'categorize') {
  console.error(`Only --task categorize has a benchmark in v1 (got ${values.task}).`);
  process.exit(2);
}
const id = values.provider as ProviderConfig['id'];
if (!['fake', 'anthropic', 'openai_compatible'].includes(id)) {
  console.error(`Unknown --provider ${id}`);
  process.exit(2);
}
const provider: ProviderConfig = {
  id,
  ...(id === 'anthropic' && process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  ...(id === 'openai_compatible' && process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
  ...(values.model ? { models: { small: values.model } } : {}),
};

const report = await runEval({
  provider,
  split: values.split as 'train' | 'test' | 'all',
  ...(values.limit ? { limit: Number(values.limit) } : {}),
  ...(values.threshold ? { threshold: Number(values.threshold) } : {}),
});

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'reports'), { recursive: true });
const file = join(
  here,
  'reports',
  `${report.task}-${report.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  [
    `${report.task} · ${report.provider}/${report.model} · ${report.promptVersion} · ${report.split} (${report.rows} rows)`,
    `accuracy ${(report.accuracy * 100).toFixed(1)}%  coverage ${(report.coverage * 100).toFixed(1)}%  macro-F1 ${report.macroF1.toFixed(3)}  ECE ${report.ece.toFixed(3)}`,
    `auto-apply ≥ ${report.autoApply.threshold}: ${(report.autoApply.share * 100).toFixed(1)}% of rows at ${(report.autoApply.precision * 100).toFixed(1)}% precision`,
    `latency p50 ${report.latencyMs.p50} ms  p95 ${report.latencyMs.p95} ms  total ${report.latencyMs.total} ms  ·  ${report.calls} calls  ·  $${report.costUsd.toFixed(4)}`,
    `report: ${file}`,
  ].join('\n'),
);

if (values['min-accuracy'] && report.accuracy < Number(values['min-accuracy'])) {
  console.error(`accuracy ${report.accuracy} is below --min-accuracy ${values['min-accuracy']}`);
  process.exit(1);
}
