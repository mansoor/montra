'use client';

import Link from 'next/link';
import type { NotificationDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from './i18n';
import { NOTIFICATIONS_CHANGED } from './shell/header-tools';
import { useAction } from './use-action';

/** NOT-01: the inbox. Opening one marks it read. */
export function NotificationList({ workspaceId, items }: { workspaceId: string; items: NotificationDto[] }) {
  const { run, busy, t } = useAction();
  const { locale } = useI18n();
  if (items.length === 0) return <p className="card text-sm text-muted">{t('notifications.empty')}</p>;
  const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || items.every((n) => n.read)}
        onClick={() => run(() => browserApi.markAllNotificationsRead(workspaceId)).then(changed)}
      >
        {t('notifications.mark_all')}
      </button>
      <ul className="card divide-y divide-line p-0" aria-label={t('notifications.title')}>
        {items.map((n) => (
          <li key={n.id} className="flex items-start gap-3 px-4 py-3" data-testid="notification-row">
            {!n.read && (
              <span
                aria-label={t('notifications.unread')}
                className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600"
              />
            )}
            <div className="min-w-0 flex-1">
              {n.link ? (
                <Link
                  className={`text-sm underline ${n.read ? '' : 'font-semibold'}`}
                  href={n.link}
                  onClick={() => {
                    if (!n.read)
                      void browserApi.markNotificationRead(workspaceId, n.id).then(changed, () => undefined);
                  }}
                >
                  {n.title}
                </Link>
              ) : (
                <p className={`text-sm ${n.read ? '' : 'font-semibold'}`}>{n.title}</p>
              )}
              {n.body && <p className="whitespace-pre-line text-sm text-muted">{n.body}</p>}
              <p className="text-xs text-muted">{when.format(new Date(n.createdAt))}</p>
            </div>
            {!n.read && (
              <button
                type="button"
                className="text-sm underline"
                disabled={busy}
                onClick={() => run(() => browserApi.markNotificationRead(workspaceId, n.id)).then(changed)}
              >
                {t('notifications.mark_read')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
