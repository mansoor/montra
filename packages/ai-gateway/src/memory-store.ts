import type { AiEventRecord, GatewayStore, TaskName } from './types.js';

/** In-memory GatewayStore for tests, the evaluation harness and scripts. */
export class MemoryStore implements GatewayStore {
  readonly cache = new Map<string, { output: unknown; model: string; expiresAt: number }>();
  readonly events: AiEventRecord[] = [];
  readonly parked: Array<{ task: TaskName; input: unknown }> = [];
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

  async parkLocal(task: TaskName, input: unknown): Promise<void> {
    this.parked.push({ task, input });
  }
}
