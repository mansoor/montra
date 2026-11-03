import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { accountMap, groupAccountsByEntity, netPosition, toTransactionRow } from '@/lib/view-models';
import { Money } from '@/components/money';
import { TransactionList } from '@/components/transaction-list';
import { DateText } from '@/components/i18n';
import { PageHeader, StatTile } from '@/components/ui/page-header';
import { LineChart, ProgressBar } from '@/components/charts/line-chart';
import { RecommendationList } from '@/components/planning/recommendations';
import { drillHref, percentOf } from '@/lib/planning';

export const dynamic = 'force-dynamic';

export default async function HomePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [[workspace, accounts, transactions, dashboard, recs, categories], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        api.listTransactions(workspaceId, { limit: 10 }),
        api.getDashboard(workspaceId),
        api.listRecommendations(workspaceId, { status: 'open' }),
        api.listCategories(workspaceId),
      ]),
    ),
    getI18n(),
  ]);
  const d = dashboard;
  const ccy = d.currency;
  const lta = d.leftToAssign !== null ? BigInt(d.leftToAssign) : null;
  const groups = groupAccountsByEntity(workspace, accounts);
  const net = netPosition(accounts);
  const names = accountMap(accounts);
  const base = `/w/${workspace.id}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('nav.home')}
        subtitle={
          <>
            <DateText date={d.period.start} /> – <DateText date={d.period.end} />
          </>
        }
        actions={
          <Link href={`${base}/budget`} className="btn-secondary">
            {d.budgetId ? t('home.open_budget') : t('home.start_budget')}
          </Link>
        }
      />

      <section aria-label={t('home.this_period')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t('home.income')}
          value={<Money amount={d.income.amount} currency={ccy} />}
          href={drillHref(base, d.income.drill)}
        />
        <StatTile
          label={t('home.spent')}
          value={<Money amount={d.spent.amount} currency={ccy} />}
          href={drillHref(base, d.spent.drill)}
        />
        <StatTile
          label={t('home.left_to_spend')}
          value={d.leftToSpend !== null ? <Money amount={d.leftToSpend} currency={ccy} /> : '—'}
          hint={d.leftToSpend === null ? t('home.no_budget_hint') : undefined}
          tone={d.leftToSpend !== null && BigInt(d.leftToSpend) < 0n ? 'bad' : undefined}
          href={`${base}/budget`}
        />
        <StatTile
          label={t('budget.lta_label')}
          value={d.leftToAssign !== null ? <Money amount={d.leftToAssign} currency={ccy} /> : '—'}
          tone={lta !== null && lta < 0n ? 'bad' : undefined}
          hint={lta !== null && lta < 0n ? t('budget.over_assigned_hint') : undefined}
          href={`${base}/budget`}
        />
      </section>

      {d.lowBalance.length > 0 && (
        <section role="alert" className="card border-bad/40 bg-bad/5 text-sm">
          <h2 className="font-semibold text-bad">{t('home.low_balance')}</h2>
          <ul className="mt-1 space-y-0.5">
            {d.lowBalance.map((l) => (
              <li key={l.accountId}>
                {l.name}: <DateText date={l.date} /> (<Money amount={l.balance} currency={ccy} />){' '}
                <Link href={`${base}/cash-flow?tab=forecast`} className="underline">
                  {t('home.see_forecast')}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          {d.pace.length > 0 && (
            <section aria-labelledby="pace-heading" className="card space-y-3">
              <h2 id="pace-heading" className="font-semibold">
                {t('home.pace')}
              </h2>
              {d.pace.map((p) => (
                <div key={p.categoryId}>
                  <div className="flex justify-between text-sm">
                    <Link href={drillHref(base, p.drill)} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-muted">
                      <Money amount={p.activity} currency={ccy} /> /{' '}
                      <Money amount={p.assigned} currency={ccy} />
                    </span>
                  </div>
                  <ProgressBar
                    label={t('budget.pace_for', { name: p.name })}
                    percent={percentOf(BigInt(p.activity), BigInt(p.assigned))}
                    marker={percentOf(BigInt(p.pace.expectedByToday), BigInt(p.assigned))}
                    tone="bad"
                  />
                </div>
              ))}
            </section>
          )}
          <section aria-labelledby="upcoming-heading" className="card">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="upcoming-heading" className="font-semibold">
                {t('home.upcoming')}
              </h2>
              <Link href={`${base}/calendar`} className="text-sm font-medium text-brand-600 underline">
                {t('home.calendar')}
              </Link>
            </div>
            {d.upcoming.length === 0 ? (
              <p className="text-sm text-muted">{t('home.nothing_upcoming')}</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d.upcoming.map((u, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate">
                      <span className="text-muted">
                        <DateText date={u.date} />
                      </span>{' '}
                      · {u.name}
                      {u.status === 'overdue' && (
                        <span className="chip chip-bad ml-2">{t('calendar.status_overdue')}</span>
                      )}
                    </span>
                    <Money amount={u.amount} currency={u.currency} signed />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <div className="space-y-6">
          <section aria-labelledby="net-heading" className="card">
            <div className="flex items-baseline justify-between">
              <h2 id="net-heading" className="font-semibold">
                {t('home.net_position')}
              </h2>
              <Link
                href={`${base}/cash-flow?tab=net-worth`}
                className="text-sm font-medium text-brand-600 underline"
              >
                {t('home.details')}
              </Link>
            </div>
            {net.length <= 1 ? (
              <div className="mt-1 font-display text-2xl font-semibold">
                <Money amount={d.netWorth.current} currency={workspace.baseCurrency} />
              </div>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-x-6">
                {net.map((n) => (
                  <li key={n.currency} className="font-display text-2xl font-semibold">
                    <Money amount={n.amount} currency={n.currency} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-0.5 text-xs text-muted">{t('home.net_position_hint')}</p>
            {d.netWorth.trend.length > 1 && (
              <LineChart
                title={t('home.net_worth')}
                series={[{ label: t('home.net_worth'), values: d.netWorth.trend.map((p) => p.netWorth) }]}
                labels={d.netWorth.trend.map((p) => p.date)}
                currency={workspace.baseCurrency}
              />
            )}
          </section>
          {recs.length > 0 && (
            <section aria-labelledby="recs-heading" className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 id="recs-heading" className="font-semibold">
                  {t('nav.suggestions')}
                </h2>
                <Link href={`${base}/suggestions`} className="text-sm font-medium text-brand-600 underline">
                  {t('home.all_suggestions', { count: recs.length })}
                </Link>
              </div>
              <RecommendationList
                workspaceId={workspace.id}
                items={recs.slice(0, 2)}
                categoryNames={Object.fromEntries(categories.map((c) => [c.id, c.name]))}
                compact
              />
            </section>
          )}
        </div>
      </div>

      <section aria-labelledby="accounts-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="accounts-heading" className="text-lg font-semibold">
            {t('home.accounts')}
          </h2>
          <Link href={`${base}/accounts/new`} className="btn-secondary">
            {t('nav.add_account')}
          </Link>
        </div>
        {groups.length === 0 && (
          <div className="card text-sm">
            <p>{t('home.no_accounts')}</p>
            <Link
              href={`${base}/accounts/new`}
              className="mt-2 inline-block font-medium text-brand-600 underline"
            >
              {t('home.add_first_account')}
            </Link>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.entityId} className="card">
            <h3 className="mb-2 text-sm font-semibold">
              {g.entityName}{' '}
              <span className="font-normal text-muted">· {t(`entity.type.${g.entityType}`)}</span>
            </h3>
            <ul className="divide-y divide-line">
              {g.accounts.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`${base}/accounts/${a.id}`}
                    className="flex items-center justify-between gap-3 py-2 hover:bg-brand-50"
                  >
                    <span>
                      <span className="block font-medium">{a.name}</span>
                      <span className="text-xs text-muted">
                        {t(`account.kind.${a.kind}`)}
                        {a.last4 ? ` ••${a.last4}` : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money amount={a.balance.amount} currency={a.currency} />
                      {a.type === 'liability' && (
                        <span className="block text-xs text-muted">{t('home.owed')}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="recent-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="recent-heading" className="text-lg font-semibold">
            {t('home.recent')}
          </h2>
          <Link href={`${base}/transactions`} className="text-sm font-medium text-brand-600 underline">
            {t('home.all_transactions')}
          </Link>
        </div>
        <TransactionList
          rows={transactions.map((r) => toTransactionRow(r, names))}
          hrefBase={`${base}/transactions`}
        />
      </section>
    </div>
  );
}
