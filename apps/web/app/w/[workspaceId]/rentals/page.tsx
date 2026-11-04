import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { EmptyState, PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Rentals' };
export const dynamic = 'force-dynamic';

/** Opens the first portfolio, or says how to add one (RNT-01). */
export default async function RentalsIndexPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const first = workspace.entities.find((e) => e.type === 'rental');
  if (first) redirect(`/w/${workspaceId}/rentals/${first.id}`);
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <PageHeader title={t('nav.rentals')} />
      <EmptyState title={t('rentals.none_yet')}>
        <p className="mt-1 text-sm text-muted">{t('rentals.none_yet_hint')}</p>
        <Link href={`/w/${workspaceId}/settings?tab=entities`} className="btn-primary mt-3 inline-block">
          {t('rentals.add_in_settings')}
        </Link>
      </EmptyState>
    </div>
  );
}
