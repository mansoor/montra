import type { Metadata } from 'next';
import Link from 'next/link';
import { filesScheduleC, todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { drillHref } from '@/lib/planning';
import { TaxRateForm, UnmappedCategories } from '@/components/business/tax-tools';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { TaxPackageButton } from '@/components/settings/privacy-security';
import { StatTile } from '@/components/ui/page-header';
import { EntityTypeLine } from '@/components/business/entity-type-line';

export const metadata: Metadata = { title: 'Taxes' };
export const dynamic = 'force-dynamic';

/** Estimated tax and Schedule C (BIZ-09, BIZ-10, AI-10). Estimates for planning, not tax advice. */
export default async function TaxesPage({
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
  const chosen = /^\d{4}$/.test(rawYear ?? '');
  const year = chosen ? Number(rawYear) : thisYear;
  // Estimated tax is the owner's calendar year; the Schedule C summary is the business's fiscal year, which the API
  // picks when no year is chosen (ADR-0037 §2).
  const [business, estimate, schedule, lines] = await load((api) =>
    Promise.all([
      api.getBusiness(workspaceId, entityId),
      api.getTaxEstimate(workspaceId, { entityId, year }),
      api.getScheduleC(workspaceId, chosen ? { entityId, year } : { entityId }),
      api.listTaxLines(workspaceId, 'schedule_c'),
    ]),
  );
  const byPerson = await load((api) =>
    api.getExpensesByPerson(workspaceId, { entityId, from: schedule.from, to: schedule.to }),
  );
  const fiscal = business.fiscalYearStartMonth !== 1;
  const { t } = await getI18n();
  const ccy = estimate.currency;
  const base = `/w/${workspaceId}`;
  const here = `${base}/business/${entityId}/taxes`;
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
        <TaxPackageButton workspaceId={workspaceId} entityId={entityId} year={year} />
      </div>
      <EntityTypeLine workspaceId={workspaceId} profile={business} />

      <section className="space-y-3" aria-labelledby="estimate-title">
        <h2 id="estimate-title" className="text-lg font-semibold">
          {t('taxes.estimate_title')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label={t('taxes.profit')} value={<Money amount={estimate.ytdProfit} currency={ccy} />} />
          <StatTile label={t('taxes.target')} value={<Money amount={estimate.target} currency={ccy} />} />
          <StatTile label={t('taxes.saved')} value={<Money amount={estimate.saved} currency={ccy} />} />
          <StatTile
            label={t('taxes.to_set_aside')}
            value={<Money amount={estimate.toSetAside} currency={ccy} />}
            tone={BigInt(estimate.toSetAside) > 0n ? 'warn' : undefined}
          />
        </div>
        <div className="card space-y-2">
          <TaxRateForm workspaceId={workspaceId} profile={business} />
          <p className="text-xs text-muted">
            {estimate.rateBps === null ? t('taxes.rate_hint_none') : t('taxes.rate_hint')}
          </p>
        </div>
        <div className="card-flush">
          <table className="tbl" aria-label={t('taxes.due_dates')}>
            <thead>
              <tr>
                <th className="px-4 py-2">{t('taxes.payment')}</th>
                <th className="px-2 py-2">{t('taxes.due')}</th>
                <th className="px-2 py-2 text-right">{t('taxes.profit_through')}</th>
                <th className="px-4 py-2 text-right">{t('taxes.target')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {estimate.periods.map((p) => (
                <tr key={p.quarter} data-testid="tax-period">
                  <td className="px-4 py-2">
                    {t('taxes.quarter', { n: p.quarter })}
                    {p.status === 'next' && <span className="chip chip-warn ml-2">{t('taxes.next')}</span>}
                  </td>
                  <td className="px-2 py-2">
                    <DateText date={p.due} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={p.profit} currency={ccy} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={p.target} currency={ccy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="schedule-title">
        <h2 id="schedule-title" className="text-lg font-semibold">
          {fiscal
            ? t('taxes.schedule_title_fiscal', { year: schedule.year })
            : t('taxes.schedule_title', { year: schedule.year })}
        </h2>
        {fiscal && (
          <p className="text-sm text-muted" data-testid="schedule-c-range">
            <DateText date={schedule.from} /> – <DateText date={schedule.to} />
          </p>
        )}
        {!filesScheduleC(business.businessType) && business.returnForm && (
          <p role="note" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
            {t('setup.guide_only', { form: t(`setup.form.${business.returnForm}`) })}
          </p>
        )}
        {schedule.warnings.includes('mileage_and_actual_car') && (
          <p role="alert" className="card border-warn text-sm text-warn">
            {t('taxes.warning_mileage_and_actual_car')}
          </p>
        )}
        <div className="card-flush" data-testid="schedule-c">
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('taxes.line')}</th>
                <th className="px-2 py-2">{t('taxes.line_label')}</th>
                <th className="px-4 py-2 text-right">{t('taxes.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {schedule.lines.map((l) => (
                <tr key={l.code}>
                  <td className="num px-4 py-1.5">{l.line}</td>
                  <td className="px-2 py-1.5">
                    {l.label}
                    {l.mileage && (
                      <span className="block text-xs text-muted">
                        {t('taxes.includes_mileage')} <Money amount={l.mileage} currency={ccy} />
                      </span>
                    )}
                    {l.deductibleBps < 10000 && (
                      <span className="block text-xs text-warn">
                        {t('taxes.usually_deductible', { percent: l.deductibleBps / 100 })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {l.categoryIds.length > 0 ? (
                      <Link
                        className="underline"
                        href={drillHref(base, {
                          entityId,
                          categoryIds: l.categoryIds,
                          from: schedule.from,
                          to: schedule.to,
                        })}
                      >
                        <Money amount={l.amount} currency={ccy} />
                      </Link>
                    ) : (
                      <Money amount={l.amount} currency={ccy} />
                    )}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={2} className="px-4 py-2">
                  {t('taxes.gross')}
                </td>
                <td className="px-4 py-2 text-right">
                  <Money amount={schedule.grossReceipts} currency={ccy} />
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={2} className="px-4 py-2">
                  {t('taxes.total_expenses')}
                </td>
                <td className="px-4 py-2 text-right">
                  <Money amount={schedule.totalExpenses} currency={ccy} />
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={2} className="px-4 py-2">
                  {t('taxes.net')}
                </td>
                <td className="px-4 py-2 text-right" data-testid="schedule-net">
                  <Money amount={schedule.netProfit} currency={ccy} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {schedule.unmapped.length > 0 && (
          <UnmappedCategories
            workspaceId={workspaceId}
            entityId={entityId}
            currency={ccy}
            unmapped={schedule.unmapped}
            lines={lines}
          />
        )}
        {BigInt(schedule.assetSales) !== 0n && (
          <p className="text-sm" data-testid="asset-sales">
            {BigInt(schedule.assetSales) > 0n ? t('taxes.asset_gain') : t('taxes.asset_loss')}{' '}
            <Money amount={schedule.assetSales.replace('-', '')} currency={ccy} /> ·{' '}
            {t('taxes.asset_sales_note')}
          </p>
        )}
        <p className="text-xs text-muted">{t('taxes.disclaimer')}</p>
      </section>

      {byPerson.rows.length > 0 && (
        <section className="space-y-3" aria-labelledby="by-person-title">
          <h2 id="by-person-title" className="text-lg font-semibold">
            {t('expense.by_person_title', { year: schedule.year })}
          </h2>
          <div className="card-flush">
            <table className="tbl" data-testid="expenses-by-person">
              <thead>
                <tr>
                  <th className="px-4 py-2">{t('expense.spent_by')}</th>
                  <th className="px-2 py-2 text-right">{t('expense.count')}</th>
                  <th className="px-4 py-2 text-right">{t('taxes.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byPerson.rows.map((r) => (
                  <tr key={r.personId ?? r.spentBy ?? 'none'}>
                    <td className="px-4 py-1.5">
                      {r.spentBy === 'owner'
                        ? t('expense.spent_by_owner')
                        : r.spentBy === 'person'
                          ? (r.name ?? t('expense.spent_by_someone'))
                          : t('expense.spent_by_none')}
                    </td>
                    <td className="num px-2 py-1.5 text-right">{r.count}</td>
                    <td className="px-4 py-1.5 text-right">
                      <Link
                        className="underline"
                        href={`${base}/transactions?${new URLSearchParams({
                          entityId,
                          spentBy: r.spentBy === 'owner' ? 'owner' : (r.personId ?? 'none'),
                          from: schedule.from,
                          to: schedule.to,
                        }).toString()}`}
                      >
                        <Money amount={r.amount} currency={ccy} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
