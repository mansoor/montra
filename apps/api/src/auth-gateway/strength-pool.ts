import { Worker } from 'node:worker_threads';
import type { Strength } from '@montra/password';

/**
 * One worker thread that scores passwords in turn (ADR-0043). Password changes and sign-ups are rare, and the
 * gateway's address limits cap how many arrive, so one thread is plenty; it keeps the event loop free for everyone
 * else signing in. Under `tsx` (development) the worker runs from source with the parent's loader flags.
 */
export class StrengthPool {
  private worker: Worker | null = null;
  private next = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (s: Strength) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly timeoutMs = 5000) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL(`./strength-worker${ext}`, import.meta.url));
    worker.unref();
    worker.on('message', (m: { id: number; strength?: Strength; error?: string }) => {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.strength) w.resolve(m.strength);
      else w.reject(new Error(m.error ?? 'Scoring failed'));
    });
    const fail = (err: Error) => {
      this.worker = null;
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(err);
        this.waiting.delete(id);
      }
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`The scoring thread stopped (${code})`)));
    this.worker = worker;
    return worker;
  }

  score(password: string, words: string[]): Promise<Strength> {
    const worker = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('Scoring took too long'));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      worker.postMessage({ id, password, words });
    });
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
