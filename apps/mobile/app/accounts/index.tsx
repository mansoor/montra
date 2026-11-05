/** Accounts from the offline store with their last-synced balances, by kind, with the same totals as the web. */
import { useRouter } from 'expo-router';
import { summarizeAccounts, type CurrencyTotal } from '@montra/domain';
import { fmtMoney, t } from '../../src/i18n';
import { useLocal } from '../../src/sync/SyncProvider';
import { Body, Card, Row, Screen, Small, Title } from '../../src/ui/components';

const line = (totals: CurrencyTotal[]) =>
  totals.map((n) => fmtMoney(n.amount.toString(), n.currency)).join('\n') || '—';

export default function Accounts() {
  const router = useRouter();
  const summary = summarizeAccounts(useLocal((s) => s.getReference('accounts')) ?? []);
  return (
    <Screen testID="accounts">
      {summary.groups.length === 0 ? <Small>{t('mobile.accounts.empty')}</Small> : null}
      {summary.groups.map((g) => (
        <Card key={g.kind} testID="accounts-group">
          <Title>{t(`account.kind.${g.kind}`)}</Title>
          <Body>
            {line(g.totals)}
            {g.type === 'liability' ? ` ${t('home.owed')}` : ''}
          </Body>
          {g.accounts.map((a) => (
            <Row
              key={a.id}
              title={a.name}
              subtitle={
                [a.institution, a.last4 ? `••${a.last4}` : null].filter(Boolean).join(' · ') || undefined
              }
              right={<Body>{fmtMoney(a.balance.amount, a.balance.currency)}</Body>}
              onPress={() => router.push(`/accounts/${a.id}`)}
            />
          ))}
        </Card>
      ))}
      {summary.groups.length > 0 ? (
        <Card testID="accounts-summary">
          <Title>{t('accounts.all')}</Title>
          <Small>{t('accounts.total_assets')}</Small>
          <Body>{line(summary.assets)}</Body>
          <Small>{t('accounts.total_liabilities')}</Small>
          <Body>{line(summary.liabilities)}</Body>
          <Small>{t('accounts.net')}</Small>
          <Body>{line(summary.net)}</Body>
          <Small>{t('accounts.net_hint')}</Small>
        </Card>
      ) : null}
    </Screen>
  );
}
