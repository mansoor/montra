'use client';

import { useEffect } from 'react';
import { browserApi } from '@/lib/browser-api';
import { recordClientLog, scrubClientText } from '@/lib/client-log';
import { catalogs, createTranslator } from '@montra/i18n';

/** Anything a page throws while rendering. Plain words here, and the details go to error tracking. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // This can show when nothing else works, including the provider that knows someone's language.
  const { t } = createTranslator('en', catalogs);
  useEffect(() => {
    recordClientLog(error.message);
    void browserApi
      .reportClientError({
        message: scrubClientText(error.digest ? `digest ${error.digest}` : error.message),
        source: 'web',
        path: window.location.pathname,
      })
      .catch(() => undefined);
  }, [error]);
  return (
    <main id="main" className="mx-auto max-w-md space-y-4 px-4 py-16">
      <h1 className="page-title">{t('error.title')}</h1>
      <p className="text-sm text-muted">{t('error.hint')}</p>
      <button type="button" className="btn-primary" onClick={reset}>
        {t('error.retry')}
      </button>
    </main>
  );
}
