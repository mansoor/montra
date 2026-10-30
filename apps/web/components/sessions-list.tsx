'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SessionInfoDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from './i18n';
import { ErrorWithAction } from './field';

/** Signed-in devices with remote sign-out (AUTH-07). */
export function SessionsList() {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<SessionInfoDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await browserApi.listSessions());
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorWithAction message={friendlyMessage(error, t)} error={error} />;
  if (!sessions) return <p className="text-sm text-muted">{t('common.loading')}</p>;
  if (sessions.length === 0) return <p className="text-sm text-muted">{t('security.no_sessions')}</p>;
  const others = sessions.filter((s) => !s.current);

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line" aria-label={t('security.devices')}>
        {sessions.map((s) => {
          const device = s.devices[0];
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {device?.userAgent ?? t('security.unknown_device')}
                </span>
                <span className="text-xs text-muted">
                  {[device?.location, device?.ipAddress].filter(Boolean).join(' · ')}
                  {' · '}
                  {t('security.signed_in_at', { when: new Date(s.authenticatedAt).toLocaleString() })}
                </span>
              </span>
              {s.current ? (
                <span className="rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-700">
                  {t('security.this_device')}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => act(() => browserApi.revokeSession(s.id))}
                >
                  {t('security.sign_out_device')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => act(() => browserApi.revokeOtherSessions())}
        >
          {t('security.sign_out_others')}
        </button>
      )}
    </div>
  );
}
