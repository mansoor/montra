import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSession } from '../session/SessionProvider';
import { LOCAL_POLL_MS, runLocalTask, runRound, runsLocally } from '../features/local-ai';

/**
 * Local AI mode (06 §2, backlog item 1): while the app is open and in front, answers the AI work the server parked for
 * a model on the person's network, as the web does. Silent: a model that can't be reached is tried again on the next
 * round, and a person the server won't give work to stops it. Draws nothing.
 */
export function LocalAiRunner({ workspaceId }: { workspaceId: string }) {
  const { api } = useSession();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let endpoint: string | null = null;
    let running = false;

    async function tick() {
      if (stopped || running) return;
      if (AppState.currentState !== 'active') return schedule();
      running = true;
      try {
        if (endpoint === null) {
          const s = await api.aiSettings(workspaceId).catch(() => null);
          // Not local mode: nothing to do here until the app is opened again.
          if (!runsLocally(s)) return;
          endpoint = s.endpoint;
        }
        const at = endpoint;
        const { stop } = await runRound({
          tasks: () => api.aiTasks(workspaceId),
          run: (task) => runLocalTask(task, at),
          post: (id, output) => api.postAiTaskResult(workspaceId, id, output),
        });
        if (stop) return;
      } finally {
        running = false;
      }
      schedule();
    }
    function schedule() {
      if (stopped) return;
      timer = setTimeout(() => void tick(), LOCAL_POLL_MS);
    }

    void tick();
    // Coming back to the app looks at once rather than at the next round.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !running) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [api, workspaceId]);
  return null;
}
