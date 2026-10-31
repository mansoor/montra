/**
 * Anthropic adapter (06 §3) on the official SDK: structured outputs through `output_config.format`, depth
 * through `output_config.effort`, no sampling parameters, and a cache breakpoint after the stable system
 * prompt + workspace context. `stop_reason` is checked before content is read. On models that support it
 * (Claude Sonnet 5.5, Claude Opus 5.5) the server-side refusal fallback is enabled on the Claude API.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderAdapter,
  ProviderConfig,
  Usage,
} from '../types.js';
import { parseJsonLoose } from '../util.js';

/** Models that accept `fallbacks: "default"` (beta server-side-fallback-2026-07-01) on the Claude API. */
const SERVER_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

type MessagesClient = Pick<Anthropic, 'messages' | 'beta'>;

interface ResponseLike {
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  private readonly client: MessagesClient;
  private readonly serverFallback: boolean;

  constructor(cfg: ProviderConfig, client?: MessagesClient) {
    this.client =
      client ??
      new Anthropic({
        apiKey: cfg.apiKey,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
        maxRetries: 2,
        timeout: 60_000,
      });
    // Gateways and proxies in front of the API may not know the beta; only use it on the Claude API itself.
    this.serverFallback = !cfg.baseUrl;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.system }];
    if (req.context) system.push({ type: 'text', text: req.context });
    system[system.length - 1]!.cache_control = { type: 'ephemeral' };
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      messages: [{ role: 'user' as const, content: req.input }],
      output_config: { format: { type: 'json_schema' as const, schema: req.schema }, effort: req.effort },
    };
    let res: ResponseLike;
    try {
      if (this.serverFallback && SERVER_FALLBACK_MODELS.has(req.model)) {
        res = (await this.client.beta.messages.create(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal: req.signal },
        )) as unknown as ResponseLike;
      } else {
        res = (await this.client.messages.create(params, { signal: req.signal })) as unknown as ResponseLike;
      }
    } catch (err) {
      return { ok: false, reason: 'provider_error', detail: describeError(err) };
    }
    const usage: Usage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    if (res.stop_reason === 'refusal') return { ok: false, reason: 'refused', detail: 'refusal', usage };
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'model_context_window_exceeded') {
      return { ok: false, reason: 'invalid_output', detail: res.stop_reason, usage };
    }
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    try {
      return { ok: true, json: parseJsonLoose(text), usage, model: res.model };
    } catch {
      return { ok: false, reason: 'invalid_output', detail: 'unparseable JSON', usage };
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionError) return 'connection error';
  if (err instanceof Anthropic.AuthenticationError) return '401 authentication failed';
  if (err instanceof Anthropic.PermissionDeniedError) return '403 permission denied';
  if (err instanceof Anthropic.RateLimitError) return '429 rate limited';
  if (err instanceof Anthropic.BadRequestError) return `400 ${err.message}`.slice(0, 300);
  if (err instanceof Anthropic.APIError) return `${err.status ?? 'error'} ${err.name}`;
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
}
