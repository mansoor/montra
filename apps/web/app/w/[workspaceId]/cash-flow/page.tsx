import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { shiftDays, shiftMonth } from '@/lib/planning';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { LinkTabs, PageHeader } from '@/components/ui/page-header';
import { Sankey } from '@/components/charts/sankey';
import { LineChart } from '@/components/charts/line-chart';

export const metadata: Metadata = { title: 'Cash flow' };
export const dynamic = 'force-dynamic';

const TABS = ['flow', 'forecast', 'net-worth'] as const;
type Tab = (typeof TABS)[number];

/** Money flow (FLOW-02, FLOW-06), the 30/60/90-day forecast (FLOW-03) and net worth (FLOW-07). */
export default async function CashFlowPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string; month?: string; days?: string; entityId?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as Tab) : 'flow';
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const { t } = await getI18n();
  const base = `/w/${workspaceId}`;
  const page = `${base}/cash-flow`;
  const href = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab: sp.tab, entityId: sp.entityId, ...extra })) if (v) q.set(k, v);
    return `${page}?${q.toString()}`;
  };
  const entityPicker = (
    <nav aria-label={t('flow.entities')} className="segmented segmented-md">
      <Link href={href({ entityId: undefined })} aria-current={!sp.entityId ? 'page' : undefined}>
        {t('flow.all_entities')}
      </Link>
      {workspace.entities.map((e) => (
        <Link
          key={e.id}
          href={href({ entityId: e.id })}
          aria-current={sp.entityId === e.id ? 'page' : undefined}
        >
          {e.name}
        </Link>
      ))}
    </nav>
  );

  let body: ReactNode = null;
  if (tab === 'flow') {
    const month = /^\d{4}-\d{2}-01$/.test(sp.month ?? '')
      ? sp.month!
      : `${todayIn(workspace.timeZone).slice(0, 7)}-01`;
    const to = shiftDays(shiftMonth(month, 1), -1);
    const data = await load((api) => api.getSankey(workspaceId, { from: month, to, entityId: sp.entityId }));
    body = (
      <section className="card space-y-3" aria-label={t('flow.sankey_label')}>
        <div className="flex items-center justify-between">
          <Link href={href({ month: shiftMonth(month, -1) })} className="btn-ghost">
            ← {t('budget.previous')}
          </Link>
          <h2 className="font-semibold">
            <DateText date={month} /> – <DateText date={to} />
          </h2>
          <Link href={href({ month: shiftMonth(month, 1) })} className="btn-ghost">
            {t('budget.next')} →
          </Link>
        </div>
        <Sankey data={data} base={base} />
        <p className="text-xs text-muted">{t('flow.sankey_hint')}</p>
      </section>
    );
  } else if (tab === 'forecast') {
    const days = [30, 60, 90].includes(Number(sp.days)) ? Number(sp.days) : 90;
    const f = await load((api) => api.getForecast(workspaceId, { days, entityId: sp.entityId }));
    const dates = Array.from({ length: f.days }, (_, i) => shiftDays(f.from, i));
    body = (
      <div className="space-y-4">
        <div className="segmented segmented-md">
          {[30, 60, 90].map((d) => (
            <Link key={d} href={href({ days: String(d) })} aria-current={days === d ? 'page' : undefined}>
              {t('flow.days', { count: d })}
            </Link>
          ))}
        </div>
        {f.accounts.length === 0 && <p className="card text-sm text-muted">{t('flow.no_accounts')}</p>}
        {f.accounts.map((a) => (
          <section key={a.accountId} className="card space-y-3" aria-labelledby={`fc-${a.accountId}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`fc-${a.accountId}`} className="font-semibold">
                {a.name}
              </h2>
              <span className="text-sm text-muted">
                {t('flow.today')} <Money amount={a.start} currency={a.currency} /> →{' '}
                {t('flow.in_days', { count: f.days })}{' '}
                <Money amount={a.balances[a.balances.length - 1] ?? a.start} currency={a.currency} />
              </span>
            </div>
            {a.lowBalance && (
              <p
                role="alert"
                className="rounded-[var(--radius-m)] border border-bad/40 bg-bad/10 p-3 text-sm text-bad"
              >
                {t('flow.low_balance', { name: a.name })} <DateText date={a.lowBalance.date} /> (
                <Money amount={a.lowBalance.balance} currency={a.currency} />)
                {a.lowBalance.drivers.length > 0 && (
                  <span className="mt-1 block text-xs">
                    {t('flow.drivers')} {a.lowBalance.drivers.map((d) => d.name).join(', ')}
                  </span>
                )}
              </p>
            )}
            <LineChart
              title={t('flow.forecast_for', { name: a.name })}
              series={[{ label: a.name, values: a.balances }]}
              labels={dates}
              currency={a.currency}
              threshold={a.kind === 'cash' ? a.threshold : null}
            />
            {a.items.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-semibold">
                  {t('flow.items', { count: a.items.length })}
                </summary>
                <ul className="mt-2 divide-y divide-line text-sm">
                  {a.items.map((i, n) => (
                    <li key={n} className="flex justify-between gap-2 py-1.5">
                      <span>
                        <DateText date={i.date} /> · {i.name}
                      </span>
                      <Money amount={i.amount} currency={a.currency} signed />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        ))}
      </div>
    );
  } else {
    const n = await load((api) => api.getNetWorth(workspaceId, { months: 12, entityId: sp.entityId }));
    body = (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card">
            <div className="text-xs font-semibold text-muted">{t('flow.net_worth')}</div>
            <div className="mt-1 font-display text-2xl font-semibold">
              <Money amount={n.netWorth} currency={n.currency} />
            </div>
          </div>
          <div className="card">
            <div className="text-xs font-semibold text-muted">{t('flow.assets')}</div>
            <div className="mt-1 font-display text-2xl font-semibold">
              <Money amount={n.assets} currency={n.currency} />
            </div>
          </div>
          <div className="card">
            <div className="text-xs font-semibold text-muted">{t('flow.liabilities')}</div>
            <div className="mt-1 font-display text-2xl font-semibold">
              <Money amount={n.liabilities} currency={n.currency} />
            </div>
          </div>
        </div>
        <section className="card" aria-label={t('flow.net_worth_trend')}>
          <LineChart
            title={t('flow.net_worth_trend')}
            series={[
              { label: t('flow.net_worth'), values: n.trend.map((p) => p.netWorth) },
              { label: t('flow.assets'), values: n.trend.map((p) => p.assets) },
              { label: t('flow.liabilities'), values: n.trend.map((p) => p.liabilities) },
            ]}
            labels={n.trend.map((p) => p.date)}
            currency={n.currency}
          />
        </section>
        <section className="card-flush" aria-label={t('flow.accounts')}>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('flow.account')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('flow.balance')}
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  {t('flow.value', { currency: n.currency })}
                </th>
              </tr>
            </thead>
            <tbody>
              {n.accounts.map((a) => (
                <tr key={a.accountId}>
                  <td className="px-4 py-2">
                    <Link href={`${base}/accounts/${a.accountId}`} className="hover:underline">
                      {a.name}
                    </Link>
                    <span className="ml-2 text-xs text-muted">{t(`flow.kind_${a.kind}`)}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={a.balance} currency={a.accountCurrency} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Money amount={a.value} currency={n.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav.cash_flow')}
        subtitle={t('flow.subtitle')}
        actions={workspace.entities.length > 1 ? entityPicker : null}
      />
      <LinkTabs
        label={t('flow.sections')}
        current={tab}
        tabs={TABS.map((k) => ({
          key: k,
          href: href({ tab: k === 'flow' ? undefined : k }),
          label: t(`flow.tab_${k}`),
        }))}
      />
      {body}
    </div>
  );
}
