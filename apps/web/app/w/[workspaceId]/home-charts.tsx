import Link from 'next/link';
import { summarizeMonths } from '@montra/domain';
import { CHART_MONTHS, type DashboardChartsDto } from '@montra/schemas';
import { getI18n } from '@/lib/i18n-server';
import { drillHref } from '@/lib/planning';
import { LineChart } from '@/components/charts/line-chart';
import { BarList, DeviationBars } from '@/components/charts/bars';

const RANGES: Record<(typeof CHART_MONTHS)[number], { label: string }> = {
  3: { label: 'home.charts.range_3' },
  6: { label: 'home.charts.range_6' },
  12: { label: 'home.charts.range_12' },
  24: { label: 'home.charts.range_24' },
};

/**
 * The Home charts (FLOW-01): money in and out with net worth over a chosen period, the budget so far, where the
 * money went this month and last month's biggest changes. Each one answers a question in a sentence or a few bars,
 * and every row drills down to its transactions.
 */
export async function HomeCharts({
  charts: c,
  base,
  memberId,
  baseCurrency,
}: {
  charts: DashboardChartsDto;
  base: string;
  memberId?: string;
  baseCurrency: string;
}) {
  const { t, money } = await getI18n();
  const ccy = c.currency;
  const sum = summarizeMonths(c.monthly);
  const labels = c.monthly.map((m) => m.start);
  const rangeHref = (months: number) => {
    const q = new URLSearchParams({ ...(memberId ? { memberId } : {}), months: String(months) });
    return `${base}?${q}`;
  };

  return (
    <>
      <section aria-labelledby="over-time-heading" className="card space-y-3" data-testid="home-over-time">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="over-time-heading" className="font-semibold">
            {t('home.charts.title')}
          </h2>
          <nav aria-label={t('home.charts.range')} className="segmented">
            {CHART_MONTHS.map((n) => (
              <Link key={n} href={rangeHref(n)} aria-current={n === c.months ? 'page' : undefined}>
                {t(RANGES[n].label)}
              </Link>
            ))}
          </nav>
        </div>
        {sum.months > 0 && (
          <p className="text-sm text-muted">
            {sum.keptPercent === null
              ? t('home.charts.summary_no_income', {
                  months: sum.months,
                  spending: money(sum.spending, ccy),
                })
              : t('home.charts.summary', {
                  months: sum.months,
                  income: money(sum.income, ccy),
                  spending: money(sum.spending, ccy),
                  kept: sum.keptPercent,
                })}{' '}
            {sum.netWorthChange !== 0n &&
              t(sum.netWorthChange > 0n ? 'home.charts.worth_up' : 'home.charts.worth_down', {
                amount: money(
                  sum.netWorthChange < 0n ? -sum.netWorthChange : sum.netWorthChange,
                  baseCurrency,
                ),
              })}
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('home.charts.in_out')}</h3>
            <LineChart
              compact
              months
              title={t('home.charts.in_out')}
              series={[
                { label: t('home.charts.income'), values: c.monthly.map((m) => m.income) },
                { label: t('home.charts.spending'), values: c.monthly.map((m) => m.spending) },
                { label: t('home.charts.net'), values: c.monthly.map((m) => m.net) },
              ]}
              labels={labels}
              currency={ccy}
            />
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('home.charts.net_worth')}</h3>
            <LineChart
              compact
              months
              fromZero={false}
              title={t('home.charts.net_worth')}
              series={[{ label: t('home.charts.net_worth'), values: c.monthly.map((m) => m.netWorth) }]}
              labels={labels}
              currency={baseCurrency}
            />
          </div>
        </div>
        <p className="text-xs text-muted">{t('home.charts.current_month_note')}</p>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section
          aria-labelledby="budget-so-far-heading"
          className="card space-y-3"
          data-testid="home-budget-so-far"
        >
          <div>
            <h2 id="budget-so-far-heading" className="font-semibold">
              {t('home.budget_so_far')}
            </h2>
            <p className="text-xs text-muted">{t('home.budget_so_far_hint')}</p>
          </div>
          {!c.budget ? (
            <p className="text-sm">
              <Link href={`${base}/budget`} className="font-medium text-brand-600 underline">
                {t('home.start_budget')}
              </Link>{' '}
              <span className="text-muted">{t('home.budget_so_far_none')}</span>
            </p>
          ) : c.budget.rows.length === 0 ? (
            <p className="text-sm text-muted">{t('home.budget_on_track')}</p>
          ) : (
            <DeviationBars
              title={t('home.budget_so_far')}
              currency={ccy}
              overKey="home.ahead"
              underKey="home.behind"
              rows={c.budget.rows.map((r) => ({
                key: r.categoryId,
                label: r.name,
                amount: r.spent,
                difference: r.difference,
                detail: t('home.spent_of', {
                  spent: money(BigInt(r.spent), ccy),
                  assigned: money(BigInt(r.assigned), ccy),
                }),
                href: drillHref(base, r.drill),
              }))}
            />
          )}
        </section>

        <section aria-labelledby="where-heading" className="card space-y-3" data-testid="home-where">
          <div>
            <h2 id="where-heading" className="font-semibold">
              {t('home.where_it_went')}
            </h2>
            <p className="text-xs text-muted">
              {t('home.where_total', { amount: money(BigInt(c.topSpending.total), ccy) })}
            </p>
          </div>
          {c.topSpending.rows.length === 0 ? (
            <p className="text-sm text-muted">{t('home.no_spending')}</p>
          ) : (
            <BarList
              title={t('home.where_it_went')}
              currency={ccy}
              total={c.topSpending.total}
              rows={c.topSpending.rows.map((r) => ({
                key: r.categoryId,
                label: r.name,
                amount: r.amount,
                href: drillHref(base, r.drill),
              }))}
            />
          )}
        </section>

        <section aria-labelledby="changes-heading" className="card space-y-3" data-testid="home-changes">
          <div>
            <h2 id="changes-heading" className="font-semibold">
              {t('home.changes')}
            </h2>
            <p className="text-xs text-muted">{t('home.changes_hint')}</p>
          </div>
          {c.changes.rows.length === 0 ? (
            <p className="text-sm text-muted">{t('home.changes_none')}</p>
          ) : (
            <DeviationBars
              title={t('home.changes')}
              currency={ccy}
              overKey="home.more"
              underKey="home.less"
              rows={c.changes.rows.map((r) => ({
                key: r.categoryId,
                label: r.name,
                amount: r.amount,
                difference: r.difference,
                detail: t('home.usual', {
                  amount: money(BigInt(r.amount), ccy),
                  usual: money(BigInt(r.usual), ccy),
                }),
                href: drillHref(base, r.drill),
              }))}
            />
          )}
        </section>
      </div>
    </>
  );
}
