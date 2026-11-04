/** Home (08 §3): spent and income this month, review count, upcoming bills, sync status and attention banners. */
import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { monthSummary, todayLocal } from '../../src/features/home';
import { useCached } from '../../src/features/use-cached';
import { Banner, Body, Card, Row, Small, Sparkline, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Home() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const { state, refresh } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const dash = useCached(ws, 'dashboard', () => api.dashboard(ws), Boolean(ws)).data;
  const notices = useCached(ws, 'status', () => api.status(), Boolean(ws)).data?.notices ?? [];
  const currency = session.status === 'signed_in' ? session.workspace.baseCurrency : 'USD';
  const summary = useLocal(
    async (s) => monthSummary(await s.listTransactions({ limit: 2000 }), todayLocal(), currency),
    [currency],
  );
  const attention = useLocal(
    async (s) => (await s.conflicts()).length + (await s.outbox()).filter((o) => o.status === 'draft').length,
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: th.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: th.space(4), gap: th.space(3) }}
        refreshControl={
          <RefreshControl refreshing={Boolean(state?.syncing)} onRefresh={() => void refresh()} />
        }
        testID="home"
      >
        <Title>{session.status === 'signed_in' ? session.workspace.name : ''}</Title>
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
        <Card>
          <Small>{t('mobile.home.spent')}</Small>
          <Body style={{ fontSize: th.font.amount, fontWeight: '700' }}>
            {fmtMoney(summary?.spent ?? 0n, currency)}
          </Body>
          <Small>
            {t('mobile.home.income')}: {fmtMoney(summary?.income ?? 0n, currency)}
          </Small>
        </Card>
        {dash?.lowBalance.map((l) => (
          <Banner
            key={l.accountId}
            tone="danger"
            text={t('mobile.home.low_balance', { name: l.name, date: fmtDate(l.date) })}
            onPress={() => router.push('/cash-flow?tab=forecast')}
          />
        ))}
        {dash && dash.budgetId ? (
          <Card testID="home-budget">
            <Small>{t('home.left_to_spend')}</Small>
            <Body style={{ fontSize: th.font.amount, fontWeight: '700' }}>
              {fmtMoney(dash.leftToSpend, dash.currency)}
            </Body>
            {dash.leftToAssign !== null ? (
              <Small color={BigInt(dash.leftToAssign) < 0n ? th.danger : undefined}>
                {t('budget.lta_label')}: {fmtMoney(dash.leftToAssign, dash.currency)}
              </Small>
            ) : null}
          </Card>
        ) : null}
        {dash && dash.openRecommendations > 0 ? (
          <Banner
            text={t('home.all_suggestions', { count: dash.openRecommendations })}
            onPress={() => router.push('/suggestions')}
          />
        ) : null}
        {dash?.pace.map((p) => (
          <Banner
            key={p.categoryId}
            tone="warning"
            text={t('mobile.home.over_pace', { name: p.name })}
            onPress={() => router.push('/budget')}
          />
        ))}
        {summary && summary.needsReview > 0 ? (
          <Banner
            text={t('mobile.home.review', { count: summary.needsReview })}
            onPress={() => router.push('/review')}
          />
        ) : null}
        <Card>
          <Small>{t('mobile.home.upcoming')}</Small>
          {summary?.upcoming.length ? (
            summary.upcoming.map((u) => (
              <Row
                key={u.id}
                title={u.payee ?? u.description}
                subtitle={fmtDate(u.date)}
                right={<Body>{fmtMoney(u.amount, u.currency)}</Body>}
                onPress={() => router.push(`/transaction/${u.id}`)}
              />
            ))
          ) : (
            <Body muted>{t('mobile.home.none_upcoming')}</Body>
          )}
        </Card>
        {dash ? (
          <Card testID="home-net-worth">
            <Small>{t('home.net_position')}</Small>
            <Body style={{ fontWeight: '700' }}>
              {fmtMoney(dash.netWorth.current, session.status === 'signed_in' ? currency : dash.currency)}
            </Body>
            <Sparkline values={dash.netWorth.trend.map((p) => p.netWorth)} label={t('home.net_position')} />
          </Card>
        ) : null}
        <View>
          <Small>
            {state?.lastSyncedAt
              ? t('mobile.home.synced', { time: new Date(state.lastSyncedAt).toLocaleTimeString() })
              : t('mobile.home.never_synced')}
          </Small>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
