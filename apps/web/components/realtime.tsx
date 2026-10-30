'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import {
  isFatalSocketError,
  maxSeq,
  needsRefresh,
  parseServerMessage,
  POLL_INTERVAL_MS,
  reconnectDelay,
} from '@/lib/sync';
import { useI18n } from './i18n';

type Status = 'connecting' | 'live' | 'polling';

const REFRESH_DEBOUNCE_MS = 250;
const REFRESH_RACE_WINDOW_MS = 3000;

/**
 * Keeps the page current across devices and household members (PLT-06). Subscribes to `/v1/ws`; on each
 * `changes` push it pulls `/sync/changes` (which applies RLS) and re-renders when something visible changed.
 * While the socket is down it falls back to polling every 15 s, and only while the tab is visible.
 */
export function Realtime({ workspaceId, wsUrl }: { workspaceId: string; wsUrl: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>('connecting');
  const seq = useRef<string | null>(null);
  const lastRefresh = useRef(0);
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';

  // A realtime refresh still in flight when the user navigates can land after the navigation and show the
  // previous page's data; refreshing once more after such a navigation makes the new page authoritative.
  useEffect(() => {
    if (Date.now() - lastRefresh.current < REFRESH_RACE_WINDOW_MS) router.refresh();
  }, [pathname, search, router]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let pulling = false;
    let again = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    // Bursts of pushes (one per committed transaction) collapse into one re-render; a refresh is skipped
    // when the user has navigated meanwhile, since the new page was just rendered with fresh data.
    const scheduleRefresh = () => {
      const href = window.location.href;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (disposed || window.location.href !== href) return;
        lastRefresh.current = Date.now();
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    async function pull() {
      if (seq.current === null) return;
      if (pulling) {
        again = true; // a push arrived mid-pull; pull once more when this one finishes
        return;
      }
      pulling = true;
      try {
        do {
          again = false;
          let since: string = seq.current ?? '0';
          let changed = false;
          for (let page = 0; page < 20; page++) {
            const res = await browserApi.syncChanges(workspaceId, since, 1000);
            changed ||= needsRefresh(res.changes);
            since = maxSeq(since, res.latestSeq);
            if (!res.hasMore) break;
          }
          seq.current = since;
          if (changed && !disposed) scheduleRefresh();
        } while (again && !disposed);
      } catch {
        // Offline or signed out; the next push or poll retries.
      } finally {
        pulling = false;
      }
    }

    const startPolling = () => {
      if (pollTimer || disposed) return;
      setStatus('polling');
      pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void pull();
      }, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    async function connect() {
      if (disposed) return;
      let token: string | null = null;
      try {
        const res = await fetch('/api/session/ws-token', { cache: 'no-store' });
        if (res.ok) token = ((await res.json()) as { token: string | null }).token;
      } catch {
        // fall through: the socket may still authenticate with the cookie
      }
      if (disposed) return;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        startPolling();
        return;
      }
      let fatal = false;
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'subscribe', workspaceId, ...(token ? { token } : {}) }));
      };
      socket.onmessage = (e) => {
        const msg = parseServerMessage(e.data);
        if (!msg) return;
        if (msg.type === 'subscribed' && msg.workspaceId === workspaceId) {
          attempt = 0;
          stopPolling();
          setStatus('live');
          void pull(); // catch up on anything missed while disconnected
        } else if (msg.type === 'changes' && msg.workspaceId === workspaceId) {
          void pull();
        } else if (msg.type === 'error' && isFatalSocketError(msg.code)) {
          fatal = true;
          socket?.close();
        }
      };
      socket.onclose = () => {
        socket = null;
        if (disposed) return;
        startPolling();
        if (!fatal) reconnectTimer = setTimeout(connect, reconnectDelay(attempt++));
      };
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull();
    };

    void browserApi
      .syncHead(workspaceId)
      .then((head) => {
        seq.current = head;
      })
      .catch(() => {
        seq.current = '0';
      })
      .finally(() => void connect());
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      stopPolling();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [workspaceId, wsUrl, router]);

  return (
    <span
      className="text-xs text-muted"
      data-testid="realtime-status"
      data-status={status}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`mr-1 inline-block size-2 rounded-full ${status === 'live' ? 'bg-good' : 'bg-line'}`}
      />
      {t(`realtime.${status}`)}
    </span>
  );
}
