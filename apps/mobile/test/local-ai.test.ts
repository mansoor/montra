import { describe, expect, it } from 'vitest';
import type { AiTaskDto } from '@montra/schemas';
import { parseJsonContent, runLocalTask, runRound, runsLocally } from '../src/features/local-ai';

// Local AI mode on the phone (06 §2, backlog item 1): the phone answers parked AI work with the person's own model.
const task = (id: string): AiTaskDto => ({
  id,
  task: 'categorize',
  input: { model: 'llama3.1', messages: [{ role: 'user', content: '{}' }] },
  createdAt: '2026-11-21T00:00:00.000Z',
});

describe('the phone as a local AI runner', () => {
  it('sends the parked body as it is to the model and reads its JSON, fenced or not', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '```json\n{"results":[]}\n```' } }] }),
      );
    }) as unknown as typeof fetch;
    expect(await runLocalTask(task('a'), 'http://192.168.1.20:11434/v1/', fake)).toEqual({ results: [] });
    expect(calls[0]).toEqual({ url: 'http://192.168.1.20:11434/v1/chat/completions', body: task('a').input });
    const down = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    await expect(runLocalTask(task('a'), 'http://x', down)).rejects.toThrow('503');
    expect(parseJsonContent(' {"a":1} ')).toEqual({ a: 1 });
  });

  it('runs only in local mode with a model URL', () => {
    expect(runsLocally({ mode: 'local', endpoint: 'http://192.168.1.20:11434/v1' })).toBe(true);
    expect(runsLocally({ mode: 'local', endpoint: null })).toBe(false);
    expect(runsLocally({ mode: 'builtin', endpoint: 'http://x' })).toBe(false);
    expect(runsLocally(null)).toBe(false);
  });

  it('answers in order, stops the round when the model is down, and stops for good when refused', async () => {
    const posted: string[] = [];
    const deps = (failOn?: string) => ({
      tasks: async () => [task('a'), task('b'), task('c')],
      run: async (t: AiTaskDto) => {
        if (t.id === failOn) throw new Error('unreachable');
        return { id: t.id };
      },
      post: async (id: string) => {
        if (id === 'b') throw new Error('already answered');
        posted.push(id);
      },
    });
    expect(await runRound(deps())).toEqual({ answered: 2, stop: false });
    expect(posted).toEqual(['a', 'c']);
    posted.length = 0;
    expect(await runRound(deps('b'))).toEqual({ answered: 1, stop: false });
    expect(posted).toEqual(['a']);
    const refused = {
      ...deps(),
      tasks: async () => {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      },
    };
    expect(await runRound(refused)).toEqual({ answered: 0, stop: true });
    const offline = { ...deps(), tasks: async () => Promise.reject(new Error('network')) };
    expect(await runRound(offline)).toEqual({ answered: 0, stop: false });
  });
});
