/**
 * Home (08 §3, FLOW-01): the same cards as the web dashboard. The month's numbers, money in and out with net worth
 * over a chosen period, the budget so far, where the money went and last month's changes; then what's coming up.
 * Charts come from the server (cached for offline); the local store covers the month when they haven't loaded yet.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { summarizeMonths } from '@montra/domain';
import { CHART_MONTHS } from '@montra/schemas';
import { currentLocale, fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { monthSummary, todayLocal } from '../../src/features/home';
import { useCached } from '../../src/features/use-cached';
import { BarList, DeviationBars, MiniLineChart } from '../../src/ui/charts';
import { ReceiptWaitingRow } from '../../src/ui/ReceiptWaiting';
import { Banner, Body, Button, Card, Row, Segmented, Small, Title } from '../../src/ui/components';
import { haptic } from '../../src/ui/haptics';
import { Icon } from '../../src/ui/icons';
import { useTheme } from '../../src/ui/theme';

type Months = (typeof CHART_MONTHS)[number];
const RANGE_LABELS: Record<Months, string> = {
  3: 'home.charts.range_3',
  6: 'home.charts.range_6',
  12: 'home.charts.range_12',
  24: 'home.charts.range_24',
};

export default function Home() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const { state, refresh } = useSync();
  const [months, setMonths] = useState<Months>(6);
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const now = useCached(ws, 'dashboard', () => api.dashboard(ws), Boolean(ws)).data;
  // The tiles can show another period. It's never remembered: leaving Home brings back the current one.
  const [at, setAt] = useState<string | null>(null);
  useFocusEffect(useCallback(() => () => setAt(null), []));
  const past = useCached(
    ws,
    `dashboard-at-${at ?? ''}`,
    () => api.dashboard(ws, at ?? undefined),
    Boolean(ws && at),
  );
  const dash = at ? past.data : now;
  const go = (next: string | null) => {
    haptic.select();
    setAt(next);
  };
  const monthName = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(currentLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch {
      return null;
    }
  }, []);
  /** A month reads as "September 2026"; another budget period (weekly, biweekly) as its dates. */
  const periodLabel = (p: { start: string; end: string }) =>
    p.start.endsWith('-01') && monthName && Number(p.end.slice(5, 7)) === Number(p.start.slice(5, 7))
      ? monthName.format(new Date(`${p.start}T00:00:00Z`))
      : `${fmtDate(p.start)} – ${fmtDate(p.end)}`;
  const charts = useCached(
    ws,
    `dashboard-charts-${months}`,
    () => api.dashboardCharts(ws, months),
    Boolean(ws),
  ).data;
  const notices = useCached(ws, 'status', () => api.status(), Boolean(ws)).data?.notices ?? [];
  const habitCache = useCached(ws, 'receipt-habit', () => api.receiptHabit(ws), Boolean(ws));
  const habit = habitCache.data;
  const notNeeded = (transactionId: string) =>
    void api
      .dismissReceiptRecommendation(ws, transactionId)
      .then(() => habitCache.reload())
      .catch(() => undefined);
  const currency = session.status === 'signed_in' ? session.workspace.baseCurrency : 'USD';
  const summary = useLocal(
    async (s) => monthSummary(await s.listTransactions({ limit: 2000 }), todayLocal(), currency),
    [currency],
  );
  const attention = useLocal(
    async (s) => (await s.conflicts()).length + (await s.outbox()).filter((o) => o.status === 'draft').length,
  );
  const ccy = dash?.currency ?? currency;
  const sum = charts ? summarizeMonths(charts.monthly) : null;

  const tile = (label: string, amount: string | bigint | null, bad = false) => (
    <Card style={{ flexBasis: '47%', flexGrow: 1, gap: 2 }}>
      <Small>{label}</Small>
      <Body style={{ fontSize: th.font.title, fontWeight: '700', color: bad ? th.danger : th.text }}>
        {amount === null ? '—' : fmtMoney(amount, ccy)}
      </Body>
    </Card>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: th.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: th.pad, gap: th.space(2) }}
        refreshControl={
          <RefreshControl refreshing={Boolean(state?.syncing)} onRefresh={() => void refresh()} />
        }
        testID="home"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(2) }}>
          <View style={{ flex: 1 }}>
            <Title>{session.status === 'signed_in' ? session.workspace.name : ''}</Title>
            {dash ? (
              <Small>
                {fmtDate(dash.period.start)} – {fmtDate(dash.period.end)}
              </Small>
            ) : null}
          </View>
          <Pressable
            onPress={() => {
              haptic.tap();
              router.push('/settings');
            }}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.settings.title')}
            hitSlop={6}
            testID="home-settings"
            style={({ pressed }) => ({
              width: th.tap,
              height: th.tap,
              borderRadius: th.tap / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: th.surfaceAlt,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="settings" size={20} />
          </Pressable>
        </View>

        {notices.map((n) => (
          <Banner key={n.id} tone="warning" text={n.body ? `${n.title}. ${n.body}` : n.title} />
        ))}
        {state && !state.online ? <Banner tone="warning" text={t('mobile.home.offline')} /> : null}
        {attention ? (
          <Banner
            tone="danger"
            text={t('mobile.home.attention', { count: attention })}
            onPress={() => router.push('/activity')}
          />
        ) : null}
        {state && state.pending > 0 ? (
          <Banner text={t('mobile.home.pending', { count: state.pending })} />
        ) : null}

        <View
          testID="home-period"
          style={
            at
              ? {
                  gap: th.space(2),
                  borderWidth: 2,
                  borderColor: th.warning,
                  backgroundColor: th.warningSoft,
                  borderRadius: th.radius,
                  padding: th.space(2),
                }
              : { gap: th.space(2) }
          }
        >
          {dash ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: th.space(2),
              }}
            >
              <Pressable
                onPress={() => go(dash.nav.previous)}
                accessibilityRole="button"
                accessibilityLabel={t('home.period_previous')}
                hitSlop={8}
                testID="home-period-previous"
                style={({ pressed }) => ({
                  width: th.tap,
                  height: th.tap,
                  borderRadius: th.tap / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: th.surfaceAlt,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: th.text, fontSize: 22, fontWeight: '700' }}>‹</Text>
              </Pressable>
              <Text
                style={{
                  minWidth: 150,
                  textAlign: 'center',
                  color: at ? th.warning : th.text,
                  fontWeight: '700',
                }}
                accessibilityLiveRegion="polite"
              >
                {periodLabel(dash.period)}
              </Text>
              <Pressable
                onPress={() => dash.nav.next && go(dash.nav.nextIsCurrent ? null : dash.nav.next)}
                disabled={!dash.nav.next}
                accessibilityRole="button"
                accessibilityLabel={t('home.period_next')}
                accessibilityState={{ disabled: !dash.nav.next }}
                hitSlop={8}
                testID="home-period-next"
                style={({ pressed }) => ({
                  width: th.tap,
                  height: th.tap,
                  borderRadius: th.tap / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: th.surfaceAlt,
                  opacity: !dash.nav.next ? 0.35 : pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: th.text, fontSize: 22, fontWeight: '700' }}>›</Text>
              </Pressable>
            </View>
          ) : null}
          {at ? (
            <>
              <Text
                style={{ color: th.warning, fontWeight: '700', textAlign: 'center' }}
                accessibilityRole="alert"
              >
                {t('home.past_period', { period: dash ? periodLabel(dash.period) : at.slice(0, 7) })}
              </Text>
              <Button label={t('home.back_to_today')} onPress={() => go(null)} testID="home-period-back" />
            </>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }} testID="home-tiles">
            {tile(t('home.income'), dash?.income.amount ?? (at ? null : (summary?.income ?? 0n)))}
            {tile(t('home.spent'), dash?.spent.amount ?? (at ? null : (summary?.spent ?? 0n)))}
            {tile(
              t('home.left_to_spend'),
              dash?.leftToSpend ?? null,
              dash?.leftToSpend != null && BigInt(dash.leftToSpend) < 0n,
            )}
            {tile(
              t('budget.lta_label'),
              dash?.leftToAssign ?? null,
              dash?.leftToAssign != null && BigInt(dash.leftToAssign) < 0n,
            )}
          </View>
          {at && dash ? (
            <Small>{t('home.past_period_note', { period: periodLabel(dash.period) })}</Small>
          ) : null}
        </View>

        {dash?.lowBalance.map((l) => (
          <Banner
            key={l.accountId}
            tone="danger"
            text={t('mobile.home.low_balance', { name: l.name, date: fmtDate(l.date) })}
            onPress={() => router.push('/cash-flow?tab=forecast')}
          />
        ))}
        {summary && summary.needsReview > 0 ? (
          <Banner
            text={t('mobile.home.review', { count: summary.needsReview })}
            onPress={() => router.push('/review')}
          />
        ) : null}

        <Card testID="home-over-time">
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Body style={{ fontWeight: '700' }}>{t('home.charts.title')}</Body>
            {dash ? <Small>{fmtMoney(dash.netWorth.current, currency)}</Small> : null}
          </View>
          <Segmented
            label={t('home.charts.range')}
            value={String(months)}
            onChange={(v) => setMonths(Number(v) as Months)}
            options={CHART_MONTHS.map((n) => ({ value: String(n), label: t(RANGE_LABELS[n]) }))}
          />
          {charts && sum ? (
            <>
              {sum.months > 0 ? (
                <Small>
                  {sum.keptPercent === null
                    ? t('home.charts.summary_no_income', {
                        months: sum.months,
                        spending: fmtMoney(sum.spending, charts.currency),
                      })
                    : t('home.charts.summary', {
                        months: sum.months,
                        income: fmtMoney(sum.income, charts.currency),
                        spending: fmtMoney(sum.spending, charts.currency),
                        kept: sum.keptPercent,
                      })}
                </Small>
              ) : null}
              <MiniLineChart
                title={t('home.charts.in_out')}
                summary={t('home.charts.current_month_note')}
                currency={charts.currency}
                months={charts.monthly.map((m) => m.start)}
                series={[
                  { label: t('home.charts.income'), values: charts.monthly.map((m) => m.income) },
                  { label: t('home.charts.spending'), values: charts.monthly.map((m) => m.spending) },
                  { label: t('home.charts.net'), values: charts.monthly.map((m) => m.net) },
                ]}
              />
              <MiniLineChart
                title={t('home.charts.net_worth')}
                summary={
                  sum.netWorthChange === 0n
                    ? t('home.charts.current_month_note')
                    : t(sum.netWorthChange > 0n ? 'home.charts.worth_up' : 'home.charts.worth_down', {
                        amount: fmtMoney(
                          sum.netWorthChange < 0n ? -sum.netWorthChange : sum.netWorthChange,
                          currency,
                        ),
                      })
                }
                currency={currency}
                fromZero={false}
                months={charts.monthly.map((m) => m.start)}
                series={[
                  { label: t('home.charts.net_worth'), values: charts.monthly.map((m) => m.netWorth) },
                ]}
              />
              <Small>{t('home.charts.current_month_note')}</Small>
            </>
          ) : (
            <Small>{t('mobile.common.loading')}</Small>
          )}
        </Card>

        {habit && habit.waiting > 0 ? (
          <Card testID="home-receipts">
            <Body style={{ fontWeight: '700' }}>{t('mobile.receipts.habit_title')}</Body>
            <Small>
              {t('mobile.receipts.habit_week', {
                kept: habit.captured,
                total: habit.captured + habit.missing,
              })}
              {habit.streakWeeks >= 2
                ? ` ${t('mobile.receipts.habit_streak', { count: habit.streakWeeks })}`
                : ''}
            </Small>
            {habit.latest.map((r, i) => (
              <ReceiptWaitingRow
                key={r.transactionId}
                item={r}
                onDismiss={notNeeded}
                last={i === habit.latest.length - 1 && habit.waiting <= habit.latest.length}
              />
            ))}
            {habit.waiting > habit.latest.length ? (
              <Row
                title={t('mobile.receipts.see_all', { count: habit.waiting })}
                onPress={() => router.push('/receipts')}
                last
              />
            ) : null}
          </Card>
        ) : habit && habit.captured > 0 ? (
          <Small>
            {t('mobile.receipts.habit_all_kept', { count: habit.captured })}
            {habit.streakWeeks >= 2
              ? ` ${t('mobile.receipts.habit_streak', { count: habit.streakWeeks })}`
              : ''}
          </Small>
        ) : null}

        {charts ? (
          <>
            <Card testID="home-budget-so-far">
              <Body style={{ fontWeight: '700' }}>{t('home.budget_so_far')}</Body>
              <Small>{t('home.budget_so_far_hint')}</Small>
              {!charts.budget ? (
                <Row title={t('home.start_budget')} onPress={() => router.push('/budget')} last />
              ) : charts.budget.rows.length === 0 ? (
                <Small>{t('home.budget_on_track')}</Small>
              ) : (
                <DeviationBars
                  currency={charts.currency}
                  overKey="home.ahead"
                  underKey="home.behind"
                  rows={charts.budget.rows.map((r) => ({
                    key: r.categoryId,
                    label: r.name,
                    amount: r.spent,
                    difference: r.difference,
                    detail: t('home.spent_of', {
                      spent: fmtMoney(r.spent, charts.currency),
                      assigned: fmtMoney(r.assigned, charts.currency),
                    }),
                    onPress: () => router.push('/budget'),
                  }))}
                />
              )}
            </Card>

            <Card testID="home-where">
              <Body style={{ fontWeight: '700' }}>{t('home.where_it_went')}</Body>
              <Small>
                {t('home.where_total', { amount: fmtMoney(charts.topSpending.total, charts.currency) })}
              </Small>
              {charts.topSpending.rows.length === 0 ? (
                <Small>{t('home.no_spending')}</Small>
              ) : (
                <BarList
                  currency={charts.currency}
                  total={charts.topSpending.total}
                  rows={charts.topSpending.rows.map((r) => ({
                    key: r.categoryId,
                    label: r.name,
                    amount: r.amount,
                  }))}
                />
              )}
            </Card>

            <Card testID="home-changes">
              <Body style={{ fontWeight: '700' }}>{t('home.changes')}</Body>
              <Small>{t('home.changes_hint')}</Small>
              {charts.changes.rows.length === 0 ? (
                <Small>{t('home.changes_none')}</Small>
              ) : (
                <DeviationBars
                  currency={charts.currency}
                  overKey="home.more"
                  underKey="home.less"
                  rows={charts.changes.rows.map((r) => ({
                    key: r.categoryId,
                    label: r.name,
                    amount: r.amount,
                    difference: r.difference,
                    detail: t('home.usual', {
                      amount: fmtMoney(r.amount, charts.currency),
                      usual: fmtMoney(r.usual, charts.currency),
                    }),
                  }))}
                />
              )}
            </Card>
          </>
        ) : null}

        <Card>
          <Body style={{ fontWeight: '700' }}>{t('mobile.home.upcoming')}</Body>
          {summary?.upcoming.length ? (
            summary.upcoming.map((u, i) => (
              <Row
                key={u.id}
                title={u.payee ?? u.description}
                subtitle={fmtDate(u.date)}
                right={<Body>{fmtMoney(u.amount, u.currency)}</Body>}
                onPress={() => router.push(`/transaction/${u.id}`)}
                last={i === summary.upcoming.length - 1}
              />
            ))
          ) : (
            <Small>{t('mobile.home.none_upcoming')}</Small>
          )}
        </Card>

        {dash && dash.openRecommendations > 0 ? (
          <Banner
            text={t('home.all_suggestions', { count: dash.openRecommendations })}
            onPress={() => router.push('/suggestions')}
          />
        ) : null}

        <Small>
          {state?.lastSyncedAt
            ? t('mobile.home.synced', { time: new Date(state.lastSyncedAt).toLocaleTimeString() })
            : t('mobile.home.never_synced')}
        </Small>
      </ScrollView>
    </SafeAreaView>
  );
}
