import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { TripsManager } from '@/components/trips/trips-manager';

export const metadata: Metadata = { title: 'Trips' };
export const dynamic = 'force-dynamic';

/** Travel mode (CUR-09). */
export default async function TripsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const trips = await load((api) => api.listTrips(workspaceId));
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('trips.title')}</h1>
        <p className="text-sm text-muted">{t('trips.intro')}</p>
      </div>
      <TripsManager workspaceId={workspaceId} trips={trips} />
    </div>
  );
}
