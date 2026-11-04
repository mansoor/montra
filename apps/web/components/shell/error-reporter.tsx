'use client';

import { useEffect } from 'react';
import { browserApi } from '@/lib/browser-api';
import { recordClientLog, scrubClientText } from '@/lib/client-log';

/** Sent at most this often, so one broken page can't flood anything. */
const MIN_GAP_MS = 10_000;

/** NFR-13: browser errors reach error tracking through the API, without the query string or anything on the page. */
export function ClientErrorReporter() {
  useEffect(() => {
    let last = 0;
    const report = (message: string, stack?: string) => {
      recordClientLog(message);
      const now = Date.now();
      if (now - last < MIN_GAP_MS) return;
      last = now;
      void browserApi
        .reportClientError({
          message: scrubClientText(message),
          source: 'web',
          path: window.location.pathname,
          ...(stack ? { stack: stack.slice(0, 4000) } : {}),
        })
        .catch(() => undefined);
    };
    const onError = (e: ErrorEvent) => report(e.message, (e.error as Error | undefined)?.stack);
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as Error | undefined;
      report(reason?.message ?? 'Unhandled rejection', reason?.stack);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
