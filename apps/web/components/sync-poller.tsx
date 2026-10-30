'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { browserApi } from '@/lib/browser-api';
import { maxSeq, needsRefresh, POLL_INTERVAL_MS } from '@/lib/sync';

/**
 * Polls /sync/changes every 15 s while the tab is visible and re-renders server data when something visible
 * changed (another device, a household member). WebSocket push replaces this later (ADR-0008).
 */
export function SyncPoller({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const seq = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function catchUp(refresh: boolean) {
      let since = seq.current ?? '0';
      let changed = false;
      // Page through; the first run only establishes the baseline.
      for (let page = 0; page < 20; page++) {
        const res = await browserApi.syncChanges(workspaceId, since, 1000);
        changed ||= needsRefresh(res.changes);
        since = maxSeq(since, res.latestSeq);
        if (!res.hasMore) break;
      }
      if (cancelled) return;
      const first = seq.current === null;
      seq.current = since;
      if (refresh && changed && !first) router.refresh();
    }

    async function tick() {
      if (document.visibilityState === 'visible') {
        try {
          await catchUp(true);
        } catch {
          // Offline or signed out; try again next tick.
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible' && seq.current !== null) void catchUp(true).catch(() => {});
    };

    void catchUp(false)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspaceId, router]);

  return null;
}
