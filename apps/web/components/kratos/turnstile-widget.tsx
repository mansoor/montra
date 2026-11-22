'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Cloudflare Turnstile's widget (AUTH-08, ADR-0056), shown inside a sign-in or sign-up form only after the auth gateway
 * asked for it. It adds a hidden `cf-turnstile-response` input to the form, which the gateway checks and strips before
 * the submission reaches Kratos. The script is loaded here, so no other page ever loads it.
 */
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start'));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function TurnstileWidget({ siteKey, failedText }: { siteKey: string; failedText: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    let widgetId: string | undefined;
    loadTurnstile()
      .then((turnstile) => {
        if (gone || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          // Turnstile shows and retries its own errors in the widget; only a script that never loads is ours to say.
          'response-field-name': 'cf-turnstile-response',
        });
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  return (
    <div className="space-y-1" data-testid="captcha">
      <div ref={container} className="min-h-[65px]" />
      {failed && (
        <p role="alert" className="text-sm text-bad">
          {failedText}
        </p>
      )}
    </div>
  );
}
