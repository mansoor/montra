'use client';

import { Bell, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';

/** RPT-05: search from anywhere. A link on a phone, where there's no room for the box. */
export function GlobalSearchBox({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState('');
  const href = `/w/${workspaceId}/search`;
  return (
    <>
      <form
        role="search"
        className="hidden md:block"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) router.push(`${href}?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <input
          className="input h-9 w-56"
          type="search"
          maxLength={500}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
      <Link href={href} className="icon-btn md:hidden" aria-label={t('search.label')}>
        <Search aria-hidden size={18} strokeWidth={1.8} />
      </Link>
    </>
  );
}

/** Tells the bell something was marked read, since that doesn't change the page it's on. */
export const NOTIFICATIONS_CHANGED = 'montra:notifications-changed';

/** NOT-01: the inbox, with how much is unread. Checked as you move around rather than held open. */
export function NotificationBell({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void browserApi.notificationsUnread(workspaceId).then(
        (n) => alive && setUnread(n),
        () => undefined,
      );
    check();
    window.addEventListener(NOTIFICATIONS_CHANGED, check);
    return () => {
      alive = false;
      window.removeEventListener(NOTIFICATIONS_CHANGED, check);
    };
  }, [workspaceId, pathname]);
  return (
    <Link
      href={`/w/${workspaceId}/notifications`}
      className="icon-btn relative"
      aria-label={unread ? t('notifications.bell_unread', { count: unread }) : t('notifications.bell')}
    >
      <Bell aria-hidden size={18} strokeWidth={1.8} />
      {unread > 0 && (
        <span
          aria-hidden
          data-testid="notification-count"
          className="absolute -top-1 -right-1 min-w-4 rounded-full bg-bad px-1 text-center text-[10px] leading-4 font-semibold text-white"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
