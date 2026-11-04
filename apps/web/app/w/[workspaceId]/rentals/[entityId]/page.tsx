import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn, type CalendarDate } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { rangeOf, REPORT_RANGES, type ReportRange } from '@/lib/business';
import { drillHref } from '@/lib/planning';
import { percentLabel } from '@/lib/rentals';
import { Money } from '@/components/money';
import { RecommendationList } from '@/components/planning/recommendations';
import { EmptyState, LinkTabs, StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Rentals' };
export const dynamic = 'force-dynamic';

/** The portfolio at a glance: income, NOI, cash flow and the ratios, per property and in total (RNT-11). */
export default async function RentalsOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const sp = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const range: ReportRange = (REPORT_RANGES as readonly string[]).includes(sp.range ?? '')
    ? (sp.range as ReportRange)
    : 'ytd';
  const { from, to } = rangeOf(range, today);
  const [report, arrears, reminders, recs] = await load((api) =>
    Promise.all([
      api.getRentalReport(workspaceId, { entityId, from: from as CalendarDate, to: to as CalendarDate }),
      api.getArrears(workspaceId, entityId),
      api.listReminders(workspaceId, entityId),
      api.listRecommendations(workspaceId, { status: 'open' }),
    ]),
  );
  const { t } = await getI18n();
  const ccy = report.currency;
  const base = `/w/${workspaceId}`;
  const here = `${base}/rentals/${entityId}`;
  const totals = report.portfolio;
  const soon = reminders.filter((r) => r.active);
  const notes = recs.filter((r) => r.entityId === entityId);

  if (report.properties.length === 0) {
    return (
      <EmptyState title={t('rentals.no_properties')}>
        <p className="mt-1 text-sm text-muted">{t('rentals.no_properties_hint')}</p>
        <Link href={`${here}/properties`} className="btn-primary mt-3 inline-block">
          {t('rentals.add_property')}
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5">
      <section aria-label={t('rentals.at_a_glance')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t('rentals.noi')} value={<Money amount={totals.noi} currency={ccy} />} />
        <StatTile
          label={t('rentals.cash_flow')}
          value={<Money amount={totals.cashFlow} currency={ccy} />}
          tone={BigInt(totals.cashFlow) < 0n ? 'bad' : undefined}
        />
        <StatTile
          label={t('rentals.arrears')}
          value={<Money amount={arrears.total} currency={ccy} />}
          hint={t('rentals.arrears_count', { count: arrears.rows.length })}
          tone={arrears.rows.length ? 'warn' : undefined}
          href={`${here}/arrears`}
        />
        <StatTile
          label={t('rentals.occupancy')}
          value={percentLabel(totals.occupancyBps)}
          hint={t('rentals.reminders_soon', { count: soon.length })}
          href={`${here}/reminders`}
        />
      </section>

      {notes.length > 0 && <RecommendationList workspaceId={workspaceId} items={notes} categoryNames={{}} />}

      <LinkTabs
        label={t('rentals.period')}
        current={range}
        tabs={REPORT_RANGES.map((r) => ({
          key: r,
          href: `${here}?range=${r}`,
          label: t(`business.range_${r}`),
        }))}
      />

      <section className="card-flush overflow-x-auto" aria-label={t('rentals.by_property')}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-4 py-2">{t('rentals.property')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.income')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.operating_expenses')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.noi')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.debt_service')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.capex')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.cash_flow')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.cap_rate')}</th>
              <th className="px-2 py-2 text-right">{t('rentals.cash_on_cash')}</th>
              <th className="px-4 py-2 text-right">{t('rentals.occupancy')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {[
              ...report.properties,
              ...(BigInt(report.untagged.income) || BigInt(report.untagged.operatingExpenses)
                ? [report.untagged]
                : []),
              totals,
            ].map((p, i, all) => {
              const isTotal = i === all.length - 1;
              return (
                <tr key={p.propertyId ?? (isTotal ? 'total' : 'untagged')} data-testid="property-report-row">
                  <td className="px-4 py-2 font-medium">
                    {isTotal ? (
                      t('rentals.portfolio_total')
                    ) : p.propertyId ? (
                      <Link
                        className="underline"
                        href={drillHref(base, { entityId, propertyId: p.propertyId, from, to })}
                      >
                        {p.name}
                      </Link>
                    ) : (
                      t('rentals.not_assigned')
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.income} currency={ccy} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.operatingExpenses} currency={ccy} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.noi} currency={ccy} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.debtService} currency={ccy} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.capex} currency={ccy} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.cashFlow} currency={ccy} />
                  </td>
                  <td className="num px-2 py-2 text-right">{percentLabel(p.capRateBps)}</td>
                  <td className="num px-2 py-2 text-right">{percentLabel(p.cashOnCashBps)}</td>
                  <td className="num px-4 py-2 text-right">{percentLabel(p.occupancyBps)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-muted">{t('rentals.metrics_note')}</p>
    </div>
  );
}
