/** Home (08 §3): spent and income this month, review count, upcoming bills, sync status and attention banners. */
import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { monthSummary, todayLocal } from '../../src/features/home';
import { Banner, Body, Card, Row, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Home() {
  const th = useTheme();
  const router = useRouter();
  const { state: session } = useSession();
  const { state, refresh } = useSync();
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
