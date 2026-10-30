'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { errorAction, friendlyMessage, type ErrorAction } from '@/lib/errors';
import { useI18n } from './i18n';

export interface ActionMessage {
  tone: 'good' | 'bad';
  text: string;
  action?: ErrorAction;
}

/** Runs a mutation, shows a status line, and re-renders server data on success. */
export function useAction() {
  const router = useRouter();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  async function run<R>(
    fn: () => Promise<R>,
    success?: string | ((result: R) => string),
  ): Promise<R | undefined> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      if (success)
        setMessage({ tone: 'good', text: typeof success === 'function' ? success(result) : success });
      router.refresh();
      return result;
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyMessage(err, t), action: errorAction(err, t) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, setMessage, run, t };
}

export function StatusLine({ message }: { message: ActionMessage | null }) {
  if (!message) return null;
  return (
    <p
      role={message.tone === 'bad' ? 'alert' : 'status'}
      className={`text-sm ${message.tone === 'good' ? 'text-good' : 'text-bad'}`}
    >
      {message.text}
      {message.action && (
        <>
          {' '}
          <a href={message.action.href} className="font-medium underline">
            {message.action.label}
          </a>
        </>
      )}
    </p>
  );
}
