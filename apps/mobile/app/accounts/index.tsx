/** Accounts from the offline store with their last-synced balances. */
import { useRouter } from 'expo-router';
import { fmtMoney, t } from '../../src/i18n';
import { useLocal } from '../../src/sync/SyncProvider';
import { Body, Row, Screen, Small } from '../../src/ui/components';

export default function Accounts() {
  const router = useRouter();
  const accounts = (useLocal((s) => s.getReference('accounts')) ?? []).filter(
    (a) => !a.archived && !a.hidden,
  );
  return (
    <Screen testID="accounts">
      {accounts.length === 0 ? <Small>{t('mobile.accounts.empty')}</Small> : null}
      {accounts.map((a) => (
        <Row
          key={a.id}
          title={a.name}
          subtitle={[a.institution, a.last4 ? `••${a.last4}` : null].filter(Boolean).join(' · ') || undefined}
          right={<Body>{fmtMoney(a.balance.amount, a.balance.currency)}</Body>}
          onPress={() => router.push(`/accounts/${a.id}`)}
        />
      ))}
    </Screen>
  );
}
