'use client';

import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from './i18n';

/** An account being deleted can only do this: change its mind (BAK-09). */
export function CancelDeletion() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await browserApi.cancelDeletion();
            window.location.assign('/');
          } catch (err) {
            setError(friendlyMessage(err, t));
            setBusy(false);
          }
        }}
      >
        {t('account_deleting.cancel')}
      </button>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </>
  );
}

/** OPS-10: the page behind the link in an email. A button, because mail scanners follow links. */
export function UnsubscribeButton({ token }: { token: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (done) {
    return (
      <p role="status" className="text-sm text-good">
        {t('unsubscribe.done')}
      </p>
    );
  }
  return (
    <button
      type="button"
      className="btn-primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/v1/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(
          () => undefined,
        );
        setDone(true);
      }}
    >
      {t('unsubscribe.confirm')}
    </button>
  );
}
