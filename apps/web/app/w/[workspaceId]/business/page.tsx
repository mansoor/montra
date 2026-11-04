import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { EmptyState, PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Business' };
export const dynamic = 'force-dynamic';

/** Opens the first business, or says how to add one (BIZ-01). */
export default async function BusinessIndexPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const businesses = await load((api) => api.listBusinesses(workspaceId));
  if (businesses[0]) redirect(`/w/${workspaceId}/business/${businesses[0].entityId}`);
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <PageHeader title={t('nav.business')} />
      <EmptyState title={t('business.none_yet')}>
        <p className="mt-1 text-sm text-muted">{t('business.none_yet_hint')}</p>
        <Link href={`/w/${workspaceId}/settings?tab=entities`} className="btn-primary mt-3 inline-block">
          {t('business.add_in_settings')}
        </Link>
      </EmptyState>
    </div>
  );
}
