'use client';

import { useEffect, useRef, useState } from 'react';
import { idleState, recordActive, sharedLastActive, type IdleState } from '@/lib/idle';

const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

/**
 * Signs the browser out after the workspace's idle timeout (AUTH-07, ADR-0044), warning for the last minute. The API
 * also ends a browser session unused for 30 minutes, for a tab that stopped running.
 */
export function IdleSignOut({
  minutes,
  labels,
}: {
  minutes: number;
  labels: { title: string; body: string; stay: string; signOut: string };
}) {
  const last = useRef(Date.now());
  const form = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<IdleState>({ kind: 'active' });

  useEffect(() => {
    let lastWrite = 0;
    const touch = () => {
      const now = Date.now();
      last.current = now;
      // Other tabs only need to hear about it now and then.
      if (now - lastWrite > 15_000) {
        lastWrite = now;
        recordActive(now);
      }
    };
    for (const e of EVENTS) window.addEventListener(e, touch, { passive: true });
    recordActive(last.current);
    const timer = window.setInterval(() => {
      last.current = sharedLastActive(last.current);
      const next = idleState(last.current, Date.now(), minutes);
      setState(next);
      if (next.kind === 'expired') form.current?.requestSubmit();
    }, 1000);
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [minutes]);

  const stay = () => {
    last.current = Date.now();
    recordActive(last.current);
    setState({ kind: 'active' });
  };

  return (
    <>
      <form ref={form} method="post" action="/sign-out" hidden aria-hidden="true" />
      {state.kind === 'warning' && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="idle-title"
          aria-describedby="idle-body"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4"
          data-testid="idle-warning"
        >
          <div className="card max-w-sm space-y-3">
            <h2 id="idle-title" className="text-base font-semibold">
              {labels.title}
            </h2>
            <p id="idle-body" className="text-sm">
              {labels.body.replace('{seconds}', String(state.secondsLeft))}
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-primary" onClick={stay} autoFocus>
                {labels.stay}
              </button>
              <button type="button" className="btn-secondary" onClick={() => form.current?.requestSubmit()}>
                {labels.signOut}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
