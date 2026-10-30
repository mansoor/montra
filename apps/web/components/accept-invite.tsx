'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { FormError } from './field';

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function accept() {
    setBusy(true);
    setError(undefined);
    try {
      const { workspaceId } = await browserApi.acceptInvite(token);
      router.push(`/w/${workspaceId}`);
      router.refresh();
    } catch (err) {
      setError(friendlyMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <FormError message={error} />
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={accept}>
          {busy ? 'Joining…' : 'Accept invite'}
        </button>
        <form action="/sign-out" method="post">
          <button type="submit" className="btn-secondary">
            Use a different account
          </button>
        </form>
      </div>
    </div>
  );
}
