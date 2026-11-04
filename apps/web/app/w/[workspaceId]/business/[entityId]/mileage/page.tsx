import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { MileageLog } from '@/components/business/mileage-log';
import { Money } from '@/components/money';
import { StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Mileage' };
export const dynamic = 'force-dynamic';

/** The mileage log for a tax year (BIZ-07). */
export default async function MileagePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const { year: rawYear } = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const thisYear = Number(today.slice(0, 4));
  const year = /^\d{4}$/.test(rawYear ?? '') ? Number(rawYear) : thisYear;
  const summary = await load((api) => api.getMileage(workspaceId, { entityId, year }));
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/business/${entityId}/mileage`;
  return (
    <div className="space-y-4">
      <nav aria-label={t('business.tax_year')} className="segmented segmented-md w-fit">
        {[thisYear - 1, thisYear].map((y) => (
          <Link key={y} href={`${base}?year=${y}`} aria-current={y === year ? 'page' : undefined}>
            {y}
          </Link>
        ))}
      </nav>
      <section className="grid gap-3 sm:grid-cols-2" aria-label={t('mileage.totals')}>
        <StatTile label={t('mileage.total_miles', { year })} value={summary.miles} />
        <StatTile
          label={t('mileage.total_deduction', { year })}
          value={<Money amount={summary.deduction} currency={summary.currency} />}
        />
      </section>
      <MileageLog workspaceId={workspaceId} entityId={entityId} summary={summary} today={today} />
    </div>
  );
}
