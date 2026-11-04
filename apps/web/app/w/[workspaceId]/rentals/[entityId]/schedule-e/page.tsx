import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { Money } from '@/components/money';
import { UnmappedCategories } from '@/components/business/tax-tools';
import { ScheduleEExport } from '@/components/rentals/rental-ops';
import { StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Schedule E' };
export const dynamic = 'force-dynamic';

/** Each property on Schedule E's lines, depreciation included, ready to export (RNT-06, RNT-11, UP-10). */
export default async function ScheduleEPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const { year: rawYear } = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const thisYear = Number(todayIn(workspace.timeZone).slice(0, 4));
  const year = /^\d{4}$/.test(rawYear ?? '') ? Number(rawYear) : thisYear;
  const [schedule, lines] = await load((api) =>
    Promise.all([
      api.getScheduleE(workspaceId, { entityId, year }),
      api.listTaxLines(workspaceId, 'schedule_e'),
    ]),
  );
  const { t } = await getI18n();
  const ccy = schedule.currency;
  const here = `/w/${workspaceId}/rentals/${entityId}/schedule-e`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label={t('business.tax_year')} className="segmented segmented-md w-fit">
          {[thisYear - 1, thisYear].map((y) => (
            <Link key={y} href={`${here}?year=${y}`} aria-current={y === year ? 'page' : undefined}>
              {y}
            </Link>
          ))}
        </nav>
        <ScheduleEExport workspaceId={workspaceId} entityId={entityId} year={year} />
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('rentals.at_a_glance')}>
        <StatTile
          label={t('rentals.income')}
          value={<Money amount={schedule.totalIncome} currency={ccy} />}
        />
        <StatTile
          label={t('rentals.expenses')}
          value={<Money amount={schedule.totalExpenses} currency={ccy} />}
        />
        <StatTile label={t('rentals.net')} value={<Money amount={schedule.totalNet} currency={ccy} />} />
        <StatTile
          label={t('rentals.your_share')}
          value={<Money amount={schedule.totalYourShare} currency={ccy} />}
        />
      </section>
      {schedule.unmapped.length > 0 && (
        <UnmappedCategories
          workspaceId={workspaceId}
          entityId={entityId}
          currency={ccy}
          unmapped={schedule.unmapped}
          lines={lines}
        />
      )}
      {schedule.properties.map((p) => (
        <section
          key={p.propertyId ?? 'none'}
          className="card-flush overflow-x-auto"
          aria-label={p.name || t('rentals.not_assigned')}
          data-testid="schedule-e-property"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
            <h2 className="text-base font-semibold">{p.name || t('rentals.not_assigned')}</h2>
            {p.address && <span className="text-sm text-muted">{p.address}</span>}
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('rentals.line')}</th>
                <th className="px-2 py-2">{t('rentals.item')}</th>
                <th className="px-4 py-2 text-right">{t('rentals.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {p.lines.map((l) => (
                <tr key={l.code} data-testid="schedule-e-line">
                  <td className="num px-4 py-2">{l.line}</td>
                  <td className="px-2 py-2 text-sm">
                    {l.label}
                    {l.depreciation && (
                      <span className="block text-xs text-muted">{t('rentals.from_depreciation')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={l.amount} currency={ccy} />
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-2" />
                <td className="px-2 py-2 text-sm font-medium">{t('rentals.net')}</td>
                <td className="px-4 py-2 text-right font-medium">
                  <Money amount={p.net} currency={ccy} />
                </td>
              </tr>
              {p.ownershipBps !== 10000 && (
                <tr>
                  <td className="px-4 py-2" />
                  <td className="px-2 py-2 text-sm">
                    {t('rentals.your_share_of', { percent: p.ownershipBps / 100 })}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={p.yourShare} currency={ccy} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      ))}
      <p className="text-xs text-muted">{t('rentals.schedule_e_note')}</p>
    </div>
  );
}
