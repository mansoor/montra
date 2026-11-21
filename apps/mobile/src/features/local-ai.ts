/**
 * Local AI mode on the hosted service (06 §2, backlog item 1): the server can't reach the person's own model (Ollama,
 * LM Studio), so it parks AI work; a client on their network answers it. The web does it while a page is open; the
 * phone does it while the app is open and in front. Each parked task already holds the `chat/completions` body to
 * send, so the phone only forwards it and posts the model's JSON back.
 *
 * Android: a plain-http model (http://192.168.x.x:11434) is reachable only in builds that allow cleartext traffic (the
 * LAN build, whose API is http too). A production build needs the model served over https.
 */
import type { AiTaskDto } from '@montra/schemas';

/** How often the phone looks for parked work while the app is in front. */
export const LOCAL_POLL_MS = 15_000;

/** Sends one parked task to the person's OpenAI-compatible endpoint and returns the model's JSON output. */
export async function runLocalTask(
  task: AiTaskDto,
  endpoint: string,
  fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => globalThis.fetch(...a),
): Promise<unknown> {
  const res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(task.input),
  });
  if (!res.ok) throw new Error(`Local model answered ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Local model returned no content');
  return parseJsonContent(content);
}

/** Model text → JSON, tolerating a ```json fence around it. */
export function parseJsonContent(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  return JSON.parse((fenced ? fenced[1]! : content).trim());
}

/** Whether this workspace's AI runs through a model on the person's network. */
export const runsLocally = (
  s: { mode: string; endpoint?: string | null } | null,
): s is { mode: 'local'; endpoint: string } => Boolean(s && s.mode === 'local' && s.endpoint);

export interface RunnerDeps {
  tasks(): Promise<AiTaskDto[]>;
  run(task: AiTaskDto): Promise<unknown>;
  post(id: string, output: unknown): Promise<unknown>;
}

/**
 * One round: claims what's parked and answers it in order. The model being unreachable ends the round (the next one
 * tries again); the server not letting this person list work (403) says to stop. Returns how many were answered.
 */
export async function runRound(deps: RunnerDeps): Promise<{ answered: number; stop: boolean }> {
  let list: AiTaskDto[];
  try {
    list = await deps.tasks();
  } catch (e) {
    return { answered: 0, stop: (e as { status?: number }).status === 403 };
  }
  let answered = 0;
  for (const task of list) {
    let output: unknown;
    try {
      output = await deps.run(task);
    } catch {
      break;
    }
    try {
      await deps.post(task.id, output);
      answered++;
    } catch {
      // Already answered elsewhere, or expired: the next task may still be wanted.
    }
  }
  return { answered, stop: false };
}
