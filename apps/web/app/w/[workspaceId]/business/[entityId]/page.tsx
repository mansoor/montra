import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn, type CalendarDate } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { rangeOf, REPORT_RANGES, type ReportRange } from '@/lib/business';
import { drillHref } from '@/lib/planning';
import { LineChart } from '@/components/charts/line-chart';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { RecommendationList } from '@/components/planning/recommendations';
import { LinkTabs, StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Business' };
export const dynamic = 'force-dynamic';

const SHOW = ['pnl', 'customers', 'vendors'] as const;
type Show = (typeof SHOW)[number];

/** The business at a glance: profit and loss, what's owed either way, and income by customer (BIZ-10). */
export default async function BusinessOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ range?: string; show?: string; from?: string; to?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const sp = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const range: ReportRange = (REPORT_RANGES as readonly string[]).includes(sp.range ?? '')
    ? (sp.range as ReportRange)
    : 'ytd';
  const show: Show = (SHOW as readonly string[]).includes(sp.show ?? '') ? (sp.show as Show) : 'pnl';
  const { from, to } =
    sp.from && sp.to ? { from: sp.from as CalendarDate, to: sp.to as CalendarDate } : rangeOf(range, today);
  const [pnl, customers, vendors, invoices, bills, estimate, recs] = await load((api) =>
    Promise.all([
      api.getPnl(workspaceId, { entityId, from, to }),
      api.getPartyReport(workspaceId, { entityId, kind: 'customer', from, to }),
      api.getPartyReport(workspaceId, { entityId, kind: 'vendor', from, to }),
      api.listInvoices(workspaceId, { entityId }),
      api.listBills(workspaceId, { entityId }),
      api.getTaxEstimate(workspaceId, { entityId }),
      api.listRecommendations(workspaceId, { status: 'open' }),
    ]),
  );
  const { t } = await getI18n();
  const ccy = pnl.currency;
  const base = `/w/${workspaceId}`;
  const here = `${base}/business/${entityId}`;
  const owedToYou = invoices
    .filter((i) => ['sent', 'partial', 'overdue'].includes(i.status))
    .reduce((n, i) => n + BigInt(i.open), 0n);
  const overdue = invoices.filter((i) => i.status === 'overdue');
  const youOwe = bills
    .filter((b) => b.status === 'open' || b.status === 'overdue')
    .reduce((n, b) => n + BigInt(b.amount), 0n);
  const rate = pnl.marginBps === null ? null : `${(pnl.marginBps / 100).toFixed(1)}%`;
  const notes = recs.filter((r) => r.entityId === entityId);
  const qs = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ range, show, ...extra });
    return `${here}?${q.toString()}`;
  };
  const drill = (categoryIds: string[]) => drillHref(base, { entityId, categoryIds, from, to });

  return (
    <div className="space-y-5">
      <section aria-label={t('business.at_a_glance')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t('business.profit')}
          value={<Money amount={pnl.netProfit} currency={ccy} />}
          hint={rate ? t('business.margin', { rate }) : t('business.no_revenue')}
          tone={BigInt(pnl.netProfit) < 0n ? 'bad' : undefined}
        />
        <StatTile
          label={t('business.owed_to_you')}
          value={<Money amount={owedToYou} currency={ccy} />}
          hint={
            overdue.length
              ? t('business.overdue_count', { count: overdue.length })
              : t('business.none_overdue')
          }
          tone={overdue.length ? 'warn' : undefined}
          href={`${here}/invoices`}
        />
        <StatTile
          label={t('business.you_owe')}
          value={<Money amount={youOwe} currency={ccy} />}
          href={`${here}/bills`}
        />
        <StatTile
          label={t('business.to_set_aside')}
          value={<Money amount={estimate.toSetAside} currency={ccy} />}
          hint={estimate.rateBps === null ? t('business.enter_rate') : undefined}
          href={`${here}/taxes`}
        />
      </section>
      {notes.length > 0 && <RecommendationList workspaceId={workspaceId} items={notes} categoryNames={{}} />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <LinkTabs
          label={t('business.report')}
          current={show}
          tabs={SHOW.map((k) => ({ key: k, href: qs({ show: k }), label: t(`business.show_${k}`) }))}
        />
        <nav aria-label={t('business.period')} className="segmented segmented-md">
          {REPORT_RANGES.map((k) => (
            <Link
              key={k}
              href={`${here}?${new URLSearchParams({ range: k, show }).toString()}`}
              aria-current={!sp.from && k === range ? 'page' : undefined}
            >
              {t(`business.range_${k}`)}
            </Link>
          ))}
        </nav>
      </div>
      <form action={here} className="flex flex-wrap items-end gap-2" aria-label={t('business.custom_range')}>
        <input type="hidden" name="show" value={show} />
        <label>
          <span className="field-label">{t('business.export_from')}</span>
          <input className="input" type="date" name="from" defaultValue={from} required />
        </label>
        <label>
          <span className="field-label">{t('business.export_to')}</span>
          <input className="input" type="date" name="to" defaultValue={to} required />
        </label>
        <button type="submit" className="btn-secondary">
          {t('business.apply_range')}
        </button>
        <span className="pb-2 text-xs text-muted">
          <DateText date={from} /> – <DateText date={to} />
        </span>
      </form>

      {show === 'pnl' && (
        <>
          {pnl.months.length > 1 && (
            <section className="card" aria-label={t('business.by_month')}>
              <h2 className="mb-2 text-base font-semibold">{t('business.by_month')}</h2>
              <LineChart
                title={t('business.by_month')}
                series={[
                  { label: t('business.revenue'), values: pnl.months.map((m) => m.revenue) },
                  { label: t('business.expenses'), values: pnl.months.map((m) => m.expenses) },
                ]}
                labels={pnl.months.map((m) => m.month)}
                currency={ccy}
              />
            </section>
          )}
          <section className="card-flush" aria-label={t('business.show_pnl')} data-testid="pnl">
            <table className="tbl">
              <tbody className="divide-y divide-line">
                <tr>
                  <th colSpan={2} scope="colgroup" className="px-4 py-2 text-left font-semibold">
                    {t('business.revenue')}
                  </th>
                </tr>
                {pnl.income.map((l) => (
                  <tr key={l.categoryId}>
                    <td className="px-4 py-1.5">
                      <Link href={drill([l.categoryId])} className="underline">
                        {l.name}
                      </Link>
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <Money amount={l.amount} currency={ccy} />
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="px-4 py-2">{t('business.total_revenue')}</td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={pnl.revenue} currency={ccy} />
                  </td>
                </tr>
                <tr>
                  <th colSpan={2} scope="colgroup" className="px-4 py-2 text-left font-semibold">
                    {t('business.expenses')}
                  </th>
                </tr>
                {pnl.expense.map((l) => (
                  <tr key={l.categoryId}>
                    <td className="px-4 py-1.5">
                      <Link href={drill([l.categoryId])} className="underline">
                        {l.name}
                      </Link>
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <Money amount={l.amount} currency={ccy} />
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="px-4 py-2">{t('business.total_expenses')}</td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={pnl.expenses} currency={ccy} />
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="px-4 py-2">{t('business.net_profit')}</td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={pnl.netProfit} currency={ccy} />
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
          <p className="text-xs text-muted">{t('business.cash_basis')}</p>
        </>
      )}

      {show !== 'pnl' && (
        <section
          className="card-flush"
          aria-label={t(`business.show_${show}`)}
          data-testid={`report-${show}`}
        >
          {(show === 'customers' ? customers : vendors).rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">{t('business.report_empty')}</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th className="px-4 py-2">{t('business.party')}</th>
                  <th className="px-2 py-2 text-right">{t('business.count')}</th>
                  <th className="px-4 py-2 text-right">{t('business.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(show === 'customers' ? customers : vendors).rows.map((r) => (
                  <tr key={r.payeeKey ?? r.name}>
                    <td className="px-4 py-1.5">{r.name || t('business.no_name')}</td>
                    <td className="num px-2 py-1.5 text-right">{r.count}</td>
                    <td className="px-4 py-1.5 text-right">
                      <Money amount={r.amount} currency={ccy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
