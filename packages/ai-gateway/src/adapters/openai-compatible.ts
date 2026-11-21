/**
 * OpenAI-compatible adapter (UP-13): local endpoints (Ollama, LM Studio, vLLM) and, with a key of the customer's
 * own, OpenAI, Google Gemini and Azure OpenAI through their chat completions APIs. Speaks
 * `POST {baseUrl}/chat/completions` with `response_format: json_schema`; servers that reject json_schema
 * are retried once in JSON mode with the schema in the prompt.
 */
import type {
  CompletionRequest,
  CompletionResponse,
  ProviderAdapter,
  ProviderConfig,
  Usage,
} from '../types.js';
import { parseJsonLoose } from '../util.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI and Azure: the part of the prompt read from the provider's cache, included in prompt_tokens. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  model?: string;
}

/** How each provider is reached through its chat completions API. */
interface Dialect {
  baseUrl: (cfg: ProviderConfig) => string;
  auth: 'bearer' | 'api-key';
  /** OpenAI's reasoning models refuse `max_tokens`; they take `max_completion_tokens`. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

const DIALECTS: Record<'openai' | 'gemini' | 'azure_openai' | 'openai_compatible', Dialect> = {
  openai: {
    baseUrl: (cfg) => trimSlash(cfg.baseUrl ?? 'https://api.openai.com/v1'),
    auth: 'bearer',
    tokenParam: 'max_completion_tokens',
  },
  gemini: {
    baseUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: 'bearer',
    tokenParam: 'max_tokens',
  },
  // Azure's v1 API: the resource URL + /openai/v1, the key in `api-key`, the deployment name as the model.
  azure_openai: {
    baseUrl: (cfg) => {
      const base = trimSlash(cfg.baseUrl ?? '');
      return /\/openai\/v1$/.test(base) ? base : `${base.replace(/\/openai$/, '')}/openai/v1`;
    },
    auth: 'api-key',
    tokenParam: 'max_completion_tokens',
  },
  openai_compatible: {
    baseUrl: (cfg) => trimSlash(cfg.baseUrl ?? 'http://localhost:11434/v1'),
    auth: 'bearer',
    tokenParam: 'max_tokens',
  },
};

/** The chat completions URL a provider config is reached at. */
export function chatCompletionsUrl(cfg: ProviderConfig): string {
  return `${dialectOf(cfg).baseUrl(cfg)}/chat/completions`;
}

function dialectOf(cfg: ProviderConfig): Dialect {
  return cfg.id === 'openai' || cfg.id === 'gemini' || cfg.id === 'azure_openai'
    ? DIALECTS[cfg.id]
    : DIALECTS.openai_compatible;
}

/**
 * The `chat/completions` body for a request. Also what a request parked for a local client holds (06 §2), so the
 * client sends it to the user's endpoint as it is.
 */
export function chatCompletionBody(
  req: Omit<CompletionRequest, 'effort' | 'signal'>,
  mode: 'json_schema' | 'json_object',
  tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens',
): Record<string, unknown> {
  const system =
    (req.context ? `${req.system}\n\n${req.context}` : req.system) +
    (mode === 'json_object'
      ? `\n\nReply with one JSON object matching this JSON schema:\n${JSON.stringify(req.schema)}`
      : '');
  return {
    model: req.model,
    [tokenParam]: req.maxTokens,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        // Vision models on OpenAI-compatible servers take images as data URLs; PDFs aren't supported there.
        content: req.images?.length
          ? [
              ...req.images
                .filter((i) => i.mediaType !== 'application/pdf')
                .map((i) => ({
                  type: 'image_url',
                  image_url: { url: `data:${i.mediaType};base64,${i.data}` },
                })),
              { type: 'text', text: req.input },
            ]
          : req.input,
      },
    ],
    response_format:
      mode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: req.task, schema: req.schema, strict: true } }
        : { type: 'json_object' },
    stream: false,
  };
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderConfig['id'];
  private readonly url: string;
  private readonly dialect: Dialect;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 120_000,
  ) {
    this.id = cfg.id;
    this.dialect = dialectOf(cfg);
    this.url = chatCompletionsUrl(cfg);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const first = await this.call(req, 'json_schema');
    if (!first.ok && first.reason === 'provider_error' && /^4(00|22)\b/.test(first.detail)) {
      return this.call(req, 'json_object');
    }
    return first;
  }

  private async call(
    req: CompletionRequest,
    mode: 'json_schema' | 'json_object',
  ): Promise<CompletionResponse> {
    const body = chatCompletionBody(req, mode, this.dialect.tokenParam);
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(req.signal ? [req.signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey
            ? this.dialect.auth === 'api-key'
              ? { 'api-key': this.cfg.apiKey }
              : { authorization: `Bearer ${this.cfg.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      return {
        ok: false,
        reason: 'provider_error',
        detail: `connection error: ${(err as Error).message}`.slice(0, 300),
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: 'provider_error', detail: `${res.status} ${text}`.slice(0, 300) };
    }
    let data: ChatResponse;
    try {
      data = (await res.json()) as ChatResponse;
    } catch {
      return { ok: false, reason: 'invalid_output', detail: 'response is not JSON' };
    }
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: Usage = {
      inputTokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) return { ok: false, reason: 'refused', detail: 'refusal', usage };
    if (choice?.finish_reason === 'length')
      return { ok: false, reason: 'invalid_output', detail: 'max_tokens', usage };
    const content = choice?.message?.content;
    if (!content) return { ok: false, reason: 'invalid_output', detail: 'empty response', usage };
    try {
      return { ok: true, json: parseJsonLoose(content), usage, model: data.model ?? req.model };
    } catch {
      return { ok: false, reason: 'invalid_output', detail: 'unparseable JSON', usage };
    }
  }
}
