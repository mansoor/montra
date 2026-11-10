import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { accountMap, groupAccountsByEntity, netPosition, toTransactionRow } from '@/lib/view-models';
import { Money } from '@/components/money';
import { TransactionList } from '@/components/transaction-list';
import { DateText } from '@/components/i18n';
import { PageHeader, StatTile } from '@/components/ui/page-header';
import { RecommendationList } from '@/components/planning/recommendations';
import { drillHref } from '@/lib/planning';
import { endOfMonth, isCalendarDate, type CalendarDate } from '@montra/domain';
import { CHART_MONTHS } from '@montra/schemas';
import { HomeCharts } from './home-charts';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ memberId?: string; months?: string; period?: string }>;
}) {
  const { workspaceId } = await params;
  const { memberId, months: m, period: p } = await searchParams;
  const only = memberId ? { memberId } : {};
  const months = (CHART_MONTHS as readonly number[]).includes(Number(m)) ? Number(m) : 6;
  // The tiles' period lives only in the URL: leaving Home (or "Back to today") brings back the current one.
  const period = p && isCalendarDate(p) ? p : undefined;
  const [
    [workspace, accounts, transactions, dashboard, recs, categories, members, charts],
    { t, locale, date },
  ] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        api.listTransactions(workspaceId, { limit: 10, ...only }),
        api.getDashboard(workspaceId, { ...only, period }),
        api.listRecommendations(workspaceId, { status: 'open' }),
        api.listCategories(workspaceId),
        api.listFamilyMembers(workspaceId),
        api.getDashboardCharts(workspaceId, { months, ...only }),
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
  const active = members.filter((m) => m.status === 'active');
  const homeHref = (q: { memberId?: string; period?: string | null }) => {
    const s = new URLSearchParams();
    if (q.memberId) s.set('memberId', q.memberId);
    if (m && months !== 6) s.set('months', String(months));
    if (q.period) s.set('period', q.period);
    return s.size ? `${base}?${s}` : base;
  };
  // A month reads as "September 2026"; another budget period (weekly, biweekly) as its dates.
  const start = d.period.start as CalendarDate;
  const periodLabel =
    start.endsWith('-01') && d.period.end === endOfMonth(start)
      ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${start}T00:00:00Z`),
        )
      : `${date(d.period.start)} – ${date(d.period.end)}`;
  const shownPeriod = d.current ? null : d.period.start;

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
          <>
            {active.length > 0 && (
              <nav aria-label={t('home.filter_member')} className="segmented segmented-md">
                <Link href={homeHref({ period: shownPeriod })} aria-current={!memberId ? 'page' : undefined}>
                  {t('home.everyone')}
                </Link>
                {active.map((m) => (
                  <Link
                    key={m.id}
                    href={homeHref({ memberId: m.id, period: shownPeriod })}
                    aria-current={m.id === memberId ? 'page' : undefined}
                  >
                    {m.name}
                  </Link>
                ))}
              </nav>
            )}
            <Link href={`${base}/budget`} className="btn-secondary">
              {d.budgetId ? t('home.open_budget') : t('home.start_budget')}
            </Link>
          </>
        }
      />

      <section
        aria-label={t('home.this_period')}
        data-testid="home-period"
        className={
          d.current ? 'space-y-3' : 'space-y-3 rounded-xl border-2 border-warn bg-warn/10 p-3 sm:p-4'
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label={t('home.period_nav')} className="flex items-center gap-1">
            <Link
              href={homeHref({ memberId, period: d.nav.previous })}
              className="btn-secondary px-3"
              aria-label={t('home.period_previous')}
              title={t('home.period_previous')}
            >
              ←
            </Link>
            <span className="min-w-40 px-2 text-center font-semibold">{periodLabel}</span>
            {d.nav.next ? (
              <Link
                href={homeHref({ memberId, period: d.nav.nextIsCurrent ? null : d.nav.next })}
                className="btn-secondary px-3"
                aria-label={t('home.period_next')}
                title={t('home.period_next')}
              >
                →
              </Link>
            ) : (
              <span className="btn-secondary px-3 opacity-40" aria-hidden="true">
                →
              </span>
            )}
          </nav>
          {!d.current && (
            <>
              <p role="status" className="font-semibold text-warn">
                {t('home.past_period', { period: periodLabel })}
              </p>
              <Link href={homeHref({ memberId })} className="btn-primary sm:ml-auto">
                {t('home.back_to_today')}
              </Link>
            </>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        </div>
        {!d.current && (
          <p className="text-xs text-muted">{t('home.past_period_note', { period: periodLabel })}</p>
        )}
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

      <HomeCharts charts={charts} base={base} memberId={memberId} baseCurrency={workspace.baseCurrency} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
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
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`${base}/accounts`} className="text-sm font-medium text-brand-600 underline">
              {t('accounts.see_all')}
            </Link>
            <Link href={`${base}/accounts/new`} className="btn-secondary">
              {t('nav.add_account')}
            </Link>
          </div>
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
