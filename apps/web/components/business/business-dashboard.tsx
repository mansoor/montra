import Link from 'next/link';
import { BUSINESS_CHART_MONTHS, type BusinessDashboardDto } from '@montra/schemas';
import { getI18n } from '@/lib/i18n-server';
import { LineChart } from '@/components/charts/line-chart';
import { Money } from '@/components/money';
import { PeriodSelect } from '@/components/planning/period-select';
import { StatTile } from '@/components/ui/page-header';

/**
 * A business at a glance (ADR-0032), like the personal Home: the chosen month's money in and out, revenue, expenses,
 * profit and cash, what's owed either way, then the period's charts and a table of its months. Revenue and expenses
 * are the P&L's, month by month. Every choice is a link, so the page is the URL.
 */
export async function BusinessDashboard({
  d,
  here,
  hrefFor,
  setAside,
}: {
  d: BusinessDashboardDto;
  here: string;
  /** This page with the dashboard's choices changed and the rest of the query kept. */
  hrefFor: (q: { months?: number; month?: string | null }) => string;
  /** The tax to set aside, shown under profit. */
  setAside: string | null;
}) {
  const { t, money, locale } = await getI18n();
  const ccy = d.currency;
  const monthName = (start: string) =>
    new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${start}T00:00:00Z`),
    );
  const m = d.monthly[d.monthly.length - 1]!;
  const profit = BigInt(m.profit);
  const labels = d.monthly.map((x) => x.start);
  const options = d.periods.map((p, i) => ({
    href: hrefFor({ month: i === 0 ? null : p.start }),
    label: monthName(p.start),
  }));
  const chosen = hrefFor({ month: d.current ? null : d.month.start });
  const margin = d.totals.marginBps === null ? null : `${(d.totals.marginBps / 100).toFixed(1)}%`;

  return (
    <section aria-labelledby="dashboard-title" className="space-y-4" data-testid="business-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="dashboard-title" className="text-base font-semibold">
            {t('business.dashboard.title')}
          </h2>
          <PeriodSelect
            label={t('business.dashboard.month')}
            options={options}
            value={chosen}
            testId="business-month-select"
          />
        </div>
        <nav aria-label={t('business.dashboard.range')} className="segmented segmented-md">
          {BUSINESS_CHART_MONTHS.map((n) => (
            <Link key={n} href={hrefFor({ months: n })} aria-current={n === d.months ? 'page' : undefined}>
              {t(`home.charts.range_${n}`)}
            </Link>
          ))}
        </nav>
      </div>
      {!d.current && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-xl border-2 border-warn bg-warn/10 p-3 font-semibold text-warn"
        >
          {t('business.dashboard.past_month', { month: monthName(d.month.start) })}
          <Link href={hrefFor({ month: null })} className="btn-primary sm:ml-auto">
            {t('home.back_to_today')}
          </Link>
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="business-tiles">
        <StatTile label={t('business.revenue')} value={<Money amount={m.revenue} currency={ccy} />} />
        <StatTile label={t('business.expenses')} value={<Money amount={m.expenses} currency={ccy} />} />
        <StatTile
          label={t('business.profit')}
          value={<Money amount={m.profit} currency={ccy} />}
          tone={profit < 0n ? 'bad' : undefined}
          hint={setAside ? t('business.dashboard.set_aside', { amount: setAside }) : undefined}
          href={`${here}/taxes`}
        />
        <StatTile
          label={t('business.dashboard.cash')}
          value={<Money amount={m.cashOnHand} currency={ccy} />}
          hint={d.current ? t('business.dashboard.cash_today') : t('business.dashboard.cash_month_end')}
        />
        <StatTile
          label={t('business.dashboard.money_in')}
          value={<Money amount={m.moneyIn} currency={ccy} />}
        />
        <StatTile
          label={t('business.dashboard.money_out')}
          value={<Money amount={m.moneyOut} currency={ccy} />}
        />
        <StatTile
          label={t('business.owed_to_you')}
          value={<Money amount={d.openInvoices.amount} currency={ccy} />}
          hint={
            d.openInvoices.overdueCount
              ? t('business.overdue_count', { count: d.openInvoices.overdueCount })
              : t('business.dashboard.open_count', { count: d.openInvoices.count })
          }
          tone={d.openInvoices.overdueCount ? 'warn' : undefined}
          href={`${here}/invoices`}
        />
        <StatTile
          label={t('business.you_owe')}
          value={<Money amount={d.openBills.amount} currency={ccy} />}
          hint={
            d.openBills.overdueCount
              ? t('business.dashboard.bills_overdue', { count: d.openBills.overdueCount })
              : t('business.dashboard.open_count', { count: d.openBills.count })
          }
          tone={d.openBills.overdueCount ? 'warn' : undefined}
          href={`${here}/bills`}
        />
      </div>

      <div className="card space-y-3">
        <p className="text-sm text-muted">
          {t('business.dashboard.summary', {
            months: d.months,
            revenue: money(BigInt(d.totals.revenue), ccy),
            expenses: money(BigInt(d.totals.expenses), ccy),
            profit: money(BigInt(d.totals.profit), ccy),
          })}{' '}
          {margin && t('business.margin', { rate: margin })}
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('business.dashboard.in_out')}</h3>
            <LineChart
              compact
              months
              title={t('business.dashboard.in_out')}
              series={[
                { label: t('business.dashboard.money_in'), values: d.monthly.map((x) => x.moneyIn) },
                { label: t('business.dashboard.money_out'), values: d.monthly.map((x) => x.moneyOut) },
              ]}
              labels={labels}
              currency={ccy}
            />
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('business.dashboard.profit_chart')}</h3>
            <LineChart
              compact
              months
              title={t('business.dashboard.profit_chart')}
              series={[
                { label: t('business.revenue'), values: d.monthly.map((x) => x.revenue) },
                { label: t('business.expenses'), values: d.monthly.map((x) => x.expenses) },
                { label: t('business.profit'), values: d.monthly.map((x) => x.profit) },
              ]}
              labels={labels}
              currency={ccy}
            />
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('business.dashboard.cash')}</h3>
            <LineChart
              compact
              months
              fromZero={false}
              title={t('business.dashboard.cash')}
              series={[{ label: t('business.dashboard.cash'), values: d.monthly.map((x) => x.cashOnHand) }]}
              labels={labels}
              currency={ccy}
            />
          </div>
        </div>
      </div>

      <div className="card-flush overflow-x-auto">
        <table className="tbl" data-testid="business-months">
          <caption className="sr-only">{t('business.dashboard.table')}</caption>
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">{t('business.dashboard.month_col')}</th>
              <th className="px-3 py-2 text-right">{t('business.dashboard.money_in')}</th>
              <th className="px-3 py-2 text-right">{t('business.dashboard.money_out')}</th>
              <th className="px-3 py-2 text-right">{t('business.revenue')}</th>
              <th className="px-3 py-2 text-right">{t('business.expenses')}</th>
              <th className="px-3 py-2 text-right">{t('business.profit')}</th>
              <th className="px-4 py-2 text-right">{t('business.dashboard.cash')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {[...d.monthly].reverse().map((x) => (
              <tr key={x.start}>
                <th scope="row" className="px-4 py-1.5 text-left font-normal">
                  <Link
                    href={hrefFor({ month: x.start === d.periods[0]?.start ? null : x.start })}
                    className="underline"
                  >
                    {monthName(x.start)}
                  </Link>
                </th>
                <td className="px-3 py-1.5 text-right">
                  <Money amount={x.moneyIn} currency={ccy} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Money amount={x.moneyOut} currency={ccy} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Money amount={x.revenue} currency={ccy} />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Money amount={x.expenses} currency={ccy} />
                </td>
                <td className={`px-3 py-1.5 text-right ${BigInt(x.profit) < 0n ? 'text-bad' : ''}`}>
                  <Money amount={x.profit} currency={ccy} />
                </td>
                <td className="px-4 py-1.5 text-right">
                  <Money amount={x.cashOnHand} currency={ccy} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <th scope="row" className="px-4 py-2 text-left">
                {t('business.dashboard.total')}
              </th>
              <td className="px-3 py-2 text-right">
                <Money amount={d.totals.moneyIn} currency={ccy} />
              </td>
              <td className="px-3 py-2 text-right">
                <Money amount={d.totals.moneyOut} currency={ccy} />
              </td>
              <td className="px-3 py-2 text-right">
                <Money amount={d.totals.revenue} currency={ccy} />
              </td>
              <td className="px-3 py-2 text-right">
                <Money amount={d.totals.expenses} currency={ccy} />
              </td>
              <td className="px-3 py-2 text-right">
                <Money amount={d.totals.profit} currency={ccy} />
              </td>
              <td className="px-4 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-muted">{t('business.dashboard.note')}</p>
    </section>
  );
}
