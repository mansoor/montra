/**
 * OpenAI-compatible adapter for local endpoints (Ollama, LM Studio, vLLM) — UP-13. Speaks
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id = 'openai_compatible' as const;
  private readonly baseUrl: string;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 120_000,
  ) {
    this.baseUrl = (cfg.baseUrl ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
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
    const system =
      (req.context ? `${req.system}\n\n${req.context}` : req.system) +
      (mode === 'json_object'
        ? `\n\nReply with one JSON object matching this JSON schema:\n${JSON.stringify(req.schema)}`
        : '');
    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.input },
      ],
      response_format:
        mode === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: req.task, schema: req.schema, strict: true } }
          : { type: 'json_object' },
      stream: false,
    };
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(req.signal ? [req.signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
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
    const usage: Usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
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
