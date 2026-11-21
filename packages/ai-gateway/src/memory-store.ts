import type { AiEventRecord, GatewayStore, LocalAnswer, LocalRequest, TaskName } from './types.js';

/** In-memory GatewayStore for tests, the evaluation harness and scripts. */
export class MemoryStore implements GatewayStore {
  readonly cache = new Map<string, { output: unknown; model: string; expiresAt: number }>();
  readonly events: AiEventRecord[] = [];
  readonly parked: Array<{ task: TaskName; request: LocalRequest; answer?: LocalAnswer }> = [];
  spentMicroUsd = 0n;
  calls = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async cacheGet(task: TaskName, keyHash: string): Promise<unknown | null> {
    const hit = this.cache.get(`${task}:${keyHash}`);
    if (!hit || hit.expiresAt < this.now()) return null;
    return hit.output;
  }

  async cachePut(
    task: TaskName,
    keyHash: string,
    output: unknown,
    model: string,
    ttlDays: number,
  ): Promise<void> {
    this.cache.set(`${task}:${keyHash}`, { output, model, expiresAt: this.now() + ttlDays * 86_400_000 });
  }

  async recordEvent(e: AiEventRecord): Promise<void> {
    this.events.push(e);
  }

  async addUsage(costMicroUsd: bigint, calls: number): Promise<void> {
    this.spentMicroUsd += costMicroUsd;
    this.calls += calls;
  }

  async parkLocal(task: TaskName, request: LocalRequest): Promise<void> {
    if (this.parked.some((p) => p.task === task && p.request.inputHash === request.inputHash)) return;
    this.parked.push({ task, request });
  }

  /** Plays the local client: answers the parked request at `index`. */
  answer(index: number, output: unknown, model = 'local-model'): void {
    const p = this.parked[index]!;
    p.answer = { output, model, itemKeys: p.request.itemKeys ?? null };
  }

  async localAnswer(task: TaskName, inputHash: string): Promise<LocalAnswer | null> {
    return this.parked.find((p) => p.task === task && p.request.inputHash === inputHash)?.answer ?? null;
  }

  async localAnswersFor(task: TaskName, itemKeys: readonly string[]): Promise<LocalAnswer[]> {
    const wanted = new Set(itemKeys);
    return this.parked
      .filter((p) => p.task === task && p.answer && p.request.itemKeys?.some((k) => wanted.has(k)))
      .map((p) => p.answer!);
  }
}
