import { parentPort } from 'node:worker_threads';
import { strengthOf } from '@montra/password';

/** Scores passwords off the gateway's main thread (ADR-0043): a long repetitive one takes about half a second. */
parentPort?.on('message', (m: { id: number; password: string; words: string[] }) => {
  try {
    parentPort!.postMessage({ id: m.id, strength: strengthOf(m.password, m.words) });
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: (err as Error).message });
  }
});
