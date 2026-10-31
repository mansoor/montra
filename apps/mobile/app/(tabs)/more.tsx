/** More (08 §3): accounts and registers, import, sync activity, settings. */
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
      <Row title={t('mobile.more.accounts')} onPress={() => router.push('/accounts')} testID="more-accounts" />
      <Row title={t('mobile.more.import')} onPress={() => router.push('/import')} testID="more-import" />
      <Row
        title={t('mobile.more.activity')}
        subtitle={sync && sync.pending + sync.drafts > 0 ? t('mobile.activity.queue', { count: sync.pending + sync.drafts }) : undefined}
        onPress={() => router.push('/activity')}
        testID="more-activity"
      />
      <Row title={t('mobile.more.settings')} onPress={() => router.push('/settings')} testID="more-settings" />
      {state.status === 'signed_in' ? <Small>{t('mobile.more.signed_in_as', { email: state.me.email })}</Small> : null}
    </Screen>
  );
}
