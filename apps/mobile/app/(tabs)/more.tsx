/** More (08 §3): review, planning, accounts and registers, import, sync activity, settings. */
import { useRouter } from 'expo-router';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useSync } from '../../src/sync/SyncProvider';
import { Row, Screen, Small, Title } from '../../src/ui/components';

export default function More() {
  const router = useRouter();
  const { state } = useSession();
  const { state: sync } = useSync();
  return (
    <Screen testID="more">
      <Title>{t('mobile.tab.more')}</Title>
      <Row
        title={t('mobile.tab.review')}
        subtitle={sync?.reviewCount ? t('mobile.more.review_count', { count: sync.reviewCount }) : undefined}
        onPress={() => router.push('/review')}
        testID="more-review"
      />
      <Row title={t('nav.goals')} onPress={() => router.push('/goals')} testID="more-goals" />
      <Row title={t('nav.cash_flow')} onPress={() => router.push('/cash-flow')} testID="more-cash-flow" />
      <Row title={t('nav.calendar')} onPress={() => router.push('/calendar')} testID="more-calendar" />
      <Row
        title={t('nav.suggestions')}
        onPress={() => router.push('/suggestions')}
        testID="more-suggestions"
      />
      <Row
        title={t('mobile.more.accounts')}
        onPress={() => router.push('/accounts')}
        testID="more-accounts"
      />
      <Row
        title={t('mobile.more.receipts')}
        onPress={() => router.push('/receipts')}
        testID="more-receipts"
      />
      <Row title={t('nav.business')} onPress={() => router.push('/business')} testID="more-business" />
      <Row title={t('nav.payslips')} onPress={() => router.push('/payslips')} testID="more-payslips" />
      <Row title={t('mobile.more.import')} onPress={() => router.push('/import')} testID="more-import" />
      <Row
        title={t('mobile.more.activity')}
        subtitle={
          sync && sync.pending + sync.drafts > 0
            ? t('mobile.activity.queue', { count: sync.pending + sync.drafts })
            : undefined
        }
        onPress={() => router.push('/activity')}
        testID="more-activity"
      />
      <Row
        title={t('mobile.more.settings')}
        onPress={() => router.push('/settings')}
        testID="more-settings"
      />
      {state.status === 'signed_in' ? (
        <Small>{t('mobile.more.signed_in_as', { email: state.me.email })}</Small>
      ) : null}
    </Screen>
  );
}
