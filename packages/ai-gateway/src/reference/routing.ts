/**
 * Per-task routing (AIA-02, 06 §3). Configuration, not code paths: versioned here and overridable per
 * environment (AI_MODEL_SMALL / AI_MODEL_VISION / AI_MODEL_LARGE) and per workspace (ProviderConfig.models).
 */
import type { Effort, ModelGroup, ProviderConfig, TaskName } from '../types.js';

export interface TaskRoute {
  group: ModelGroup;
  effort: Effort;
  /** Items per provider call (batched tasks). */
  batchSize: number;
  maxTokens: number;
  /** Cache TTL for per-item results; 0 = not cached. */
  cacheTtlDays: number;
}

export const DEFAULT_ROUTING: Record<TaskName | 'ping', TaskRoute> = {
  categorize: { group: 'small', effort: 'low', batchSize: 100, maxTokens: 16000, cacheTtlDays: 90 },
  normalize_payees: { group: 'small', effort: 'low', batchSize: 100, maxTokens: 8000, cacheTtlDays: 90 },
  map_columns: { group: 'small', effort: 'low', batchSize: 1, maxTokens: 4000, cacheTtlDays: 0 },
  parse_quick_add: { group: 'small', effort: 'low', batchSize: 1, maxTokens: 2000, cacheTtlDays: 0 },
  propose_categories: { group: 'small', effort: 'medium', batchSize: 1, maxTokens: 8000, cacheTtlDays: 0 },
  extract_statement_table: {
    group: 'vision',
    effort: 'medium',
    batchSize: 3,
    maxTokens: 16000,
    cacheTtlDays: 0,
  },
  ping: { group: 'small', effort: 'low', batchSize: 1, maxTokens: 200, cacheTtlDays: 0 },
};

/** Default models per provider and group. */
const DEFAULT_MODELS: Record<
  'anthropic' | 'openai_compatible' | 'fake' | 'null',
  Record<ModelGroup, string>
> = {
  anthropic: { small: 'claude-haiku-5-5', vision: 'claude-sonnet-5-5', large: 'claude-opus-5-5' },
  openai_compatible: { small: 'llama3.1', vision: 'llama3.1', large: 'llama3.1' },
  fake: { small: 'fake-small', vision: 'fake-vision', large: 'fake-large' },
  null: { small: 'none', vision: 'none', large: 'none' },
};

const ENV_KEYS: Record<ModelGroup, string> = {
  small: 'AI_MODEL_SMALL',
  vision: 'AI_MODEL_VISION',
  large: 'AI_MODEL_LARGE',
};

/**
 * Model for a group: workspace override → environment override (Anthropic only, the hosted default) →
 * routing default.
 */
export function modelFor(
  cfg: ProviderConfig,
  group: ModelGroup,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = cfg.models?.[group];
  if (override) return override;
  if (cfg.id === 'anthropic') {
    const fromEnv = env[ENV_KEYS[group]];
    if (fromEnv) return fromEnv;
  }
  if (cfg.id === 'openai_compatible') {
    // Local servers usually run one model; fall back to whichever group is configured.
    const any = cfg.models?.small ?? cfg.models?.large ?? cfg.models?.vision;
    if (any) return any;
  }
  return DEFAULT_MODELS[cfg.id][group];
}

/** Share of the monthly budget at which vision and large tasks move to the small model (AIA-08). */
export const DOWNGRADE_AT = 0.8;
