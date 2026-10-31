'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { browserApi } from '@/lib/browser-api';
import { runLocalTask } from '@/lib/ai';

const POLL_MS = 15_000;

/** What the local-mode runner last did, for the AI settings page. */
export interface RunnerState {
  status: 'inactive' | 'waiting' | 'ok' | 'unreachable';
  done: number;
}

let state: RunnerState = { status: 'inactive', done: 0 };
const listeners = new Set<() => void>();
const setState = (next: Partial<RunnerState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useLocalRunnerStatus = () =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );

export const localRunnerStatus = (s: RunnerState) => s.status;

/**
 * Local AI mode on the hosted service (06 §2): the server can't reach the user's Ollama / LM Studio, so it
 * parks AI work; this browser, on the user's network, runs each task against the local endpoint and posts the
 * result back. Best effort and silent: a CORS or connection failure only shows on the AI settings page.
 */
export function LocalAiRunner({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let endpoint: string | null = null;

    async function tick() {
      if (stopped) return;
      try {
        if (endpoint === null) {
          const s = await browserApi.getAiSettings(workspaceId);
          if (s.mode !== 'local' || !s.endpoint) {
            setState({ status: 'inactive' });
            return; // not in local mode: don't poll
          }
          endpoint = s.endpoint;
          setState({ status: 'waiting' });
        }
        const tasks = await browserApi.listAiTasks(workspaceId);
        for (const task of tasks) {
          if (stopped) return;
          try {
            const output = await runLocalTask(task, endpoint);
            await browserApi.postAiTaskResult(workspaceId, task.id, output);
            setState({ status: 'ok', done: state.done + 1 });
          } catch {
            setState({ status: 'unreachable' });
            break; // try again on the next tick
          }
        }
      } catch {
        // API not reachable or no access: stay quiet.
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    }

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId]);
  return null;
}
