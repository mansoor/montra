import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { NotificationList } from '@/components/notification-list';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

/** The inbox (NOT-01). */
export default async function NotificationsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const list = await load((api) => api.listNotifications(workspaceId));
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('notifications.title')}
        actions={
          <Link className="btn-secondary" href={`/w/${workspaceId}/settings?tab=notifications`}>
            {t('notifications.settings')}
          </Link>
        }
      />
      <NotificationList workspaceId={workspaceId} items={list.data} />
    </div>
  );
}
