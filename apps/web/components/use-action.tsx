'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { friendlyMessage } from '@/lib/errors';

export interface ActionMessage {
  tone: 'good' | 'bad';
  text: string;
}

/** Runs a mutation, shows a status line, and re-renders server data on success. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  async function run<T>(
    fn: () => Promise<T>,
    success?: string | ((result: T) => string),
  ): Promise<T | undefined> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      if (success)
        setMessage({ tone: 'good', text: typeof success === 'function' ? success(result) : success });
      router.refresh();
      return result;
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyMessage(err) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, setMessage, run };
}

export function StatusLine({ message }: { message: ActionMessage | null }) {
  if (!message) return null;
  return (
    <p
      role={message.tone === 'bad' ? 'alert' : 'status'}
      className={`text-sm ${message.tone === 'good' ? 'text-good' : 'text-bad'}`}
    >
      {message.text}
    </p>
  );
}
