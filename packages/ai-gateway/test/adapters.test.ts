import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, OpenAiCompatibleAdapter, type CompletionRequest } from '../src/index.js';

const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  task: 'categorize',
  model: 'claude-haiku-5-5',
  effort: 'low',
  system: 'SYSTEM',
  context: 'CONTEXT',
  input: '{"items":[]}',
  schema: {
    type: 'object',
    properties: { results: { type: 'array' } },
    required: ['results'],
    additionalProperties: false,
  },
  maxTokens: 16000,
  ...over,
});

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: '{"results":[]}' },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    },
    ...over,
  };
}

function fakeClient(respond: (params: Record<string, unknown>) => unknown) {
  const seen: { api: 'messages' | 'beta'; params: Record<string, unknown> }[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        seen.push({ api: 'messages', params });
        return respond(params);
      },
    },
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          seen.push({ api: 'beta', params });
          return respond(params);
        },
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, 'messages' | 'beta'>, seen };
}

describe('AnthropicAdapter', () => {
  it('sends structured-output requests with effort and a cache breakpoint after the stable prefix', async () => {
    const { client, seen } = fakeClient(() => message());
    const a = new AnthropicAdapter({ id: 'anthropic', apiKey: 'k' }, client);
    const res = await a.complete(req());
    expect(res).toEqual({
      ok: true,
      json: { results: [] },
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 0 },
    });
    const p = seen[0]!.params;
    expect(seen[0]!.api).toBe('messages');
    expect(p).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      system: [
        { type: 'text', text: 'SYSTEM' },
        { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: '{"items":[]}' }],
      output_config: { format: { type: 'json_schema' }, effort: 'low' },
    });
    expect((p.system as object[])[0]).not.toHaveProperty('cache_control');
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('thinking');
  });

  it('enables the server-side refusal fallback on Sonnet/Opus on the Claude API only', async () => {
    const { client, seen } = fakeClient(() => message({ model: 'claude-sonnet-5-5' }));
    await new AnthropicAdapter({ id: 'anthropic' }, client).complete(
      req({ model: 'claude-sonnet-5-5', context: undefined }),
    );
    expect(seen[0]!.api).toBe('beta');
    expect(seen[0]!.params).toMatchObject({
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect((seen[0]!.params.system as object[])[0]).toHaveProperty('cache_control');

    const proxied = fakeClient(() => message());
    await new AnthropicAdapter(
      { id: 'anthropic', baseUrl: 'https://proxy.example' },
      proxied.client,
    ).complete(req({ model: 'claude-sonnet-5-5' }));
    expect(proxied.seen[0]!.api).toBe('messages');
  });

  it('maps stop reasons and bad JSON before reading content', async () => {
    const refusal = fakeClient(() => message({ stop_reason: 'refusal', content: [] }));
    expect(await new AnthropicAdapter({ id: 'anthropic' }, refusal.client).complete(req())).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    const cut = fakeClient(() => message({ stop_reason: 'max_tokens' }));
    expect(await new AnthropicAdapter({ id: 'anthropic' }, cut.client).complete(req())).toMatchObject({
      ok: false,
      reason: 'invalid_output',
      detail: 'max_tokens',
    });
    const junk = fakeClient(() => message({ content: [{ type: 'text', text: 'sorry' }] }));
    expect(await new AnthropicAdapter({ id: 'anthropic' }, junk.client).complete(req())).toMatchObject({
      ok: false,
      reason: 'invalid_output',
    });
  });

  it('maps SDK errors to provider_error', async () => {
    const headers = new Headers();
    const cases: [unknown, RegExp][] = [
      [new Anthropic.RateLimitError(429, { type: 'error' }, 'rate', headers), /429/],
      [new Anthropic.APIConnectionError({ message: 'down' }), /connection/],
      [new Anthropic.BadRequestError(400, { type: 'error' }, 'bad schema', headers), /^400/],
      [new Anthropic.InternalServerError(529, { type: 'error' }, 'overloaded', headers), /529/],
    ];
    for (const [err, detail] of cases) {
      const { client } = fakeClient(() => {
        throw err;
      });
      const res = await new AnthropicAdapter({ id: 'anthropic' }, client).complete(req());
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('provider_error');
        expect(res.detail).toMatch(detail);
      }
    }
  });
});

describe('OpenAiCompatibleAdapter', () => {
  function stub(responses: Array<(body: Record<string, unknown>) => Response>) {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      return responses[calls.length - 1]!(body);
    };
    return { fetchImpl, calls };
  }
  const ok = (content: string, finish = 'stop') =>
    new Response(
      JSON.stringify({
        model: 'llama3.1',
        choices: [{ message: { content }, finish_reason: finish }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
      { status: 200 },
    );

  it('posts chat completions with a strict json_schema response format', async () => {
    const { fetchImpl, calls } = stub([() => ok('{"results":[]}')]);
    const a = new OpenAiCompatibleAdapter(
      { id: 'openai_compatible', baseUrl: 'http://localhost:11434/v1/', apiKey: 'sk' },
      fetchImpl,
    );
    const res = await a.complete(req({ model: 'llama3.1' }));
    expect(res).toMatchObject({
      ok: true,
      json: { results: [] },
      usage: { inputTokens: 50, outputTokens: 10 },
    });
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk');
    expect(calls[0]!.body).toMatchObject({
      model: 'llama3.1',
      response_format: { type: 'json_schema', json_schema: { name: 'categorize', strict: true } },
      messages: [{ role: 'system', content: 'SYSTEM\n\nCONTEXT' }, { role: 'user' }],
    });
  });

  it('falls back to JSON mode when the server rejects json_schema, and parses fenced JSON', async () => {
    const { fetchImpl, calls } = stub([
      () => new Response('response_format not supported', { status: 400 }),
      () => ok('```json\n{"results":[1]}\n```'),
    ]);
    const res = await new OpenAiCompatibleAdapter({ id: 'openai_compatible' }, fetchImpl).complete(req());
    expect(res).toMatchObject({ ok: true, json: { results: [1] } });
    expect(calls[1]!.body.response_format).toEqual({ type: 'json_object' });
    expect(String((calls[1]!.body.messages as { content: string }[])[0]!.content)).toContain('JSON schema');
  });

  it('maps failures', async () => {
    const down = new OpenAiCompatibleAdapter({ id: 'openai_compatible' }, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await down.complete(req())).toMatchObject({
      ok: false,
      reason: 'provider_error',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
    const s500 = stub([() => new Response('boom', { status: 500 })]);
    expect(
      await new OpenAiCompatibleAdapter({ id: 'openai_compatible' }, s500.fetchImpl).complete(req()),
    ).toMatchObject({ ok: false, reason: 'provider_error' });
    const cut = stub([() => ok('{"res', 'length')]);
    expect(
      await new OpenAiCompatibleAdapter({ id: 'openai_compatible' }, cut.fetchImpl).complete(req()),
    ).toMatchObject({ ok: false, reason: 'invalid_output' });
    const junk = stub([() => ok('no json here')]);
    expect(
      await new OpenAiCompatibleAdapter({ id: 'openai_compatible' }, junk.fetchImpl).complete(req()),
    ).toMatchObject({ ok: false, reason: 'invalid_output' });
  });
});
