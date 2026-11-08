/**
 * Accounts from the offline store with their last-synced balances, by kind, with the same totals as the web. Your share of
 * rental properties comes from net worth (read live, kept for offline) and counts in what you have, as on the web (ADR-0027).
 */
import { useRouter } from 'expo-router';
import { type CurrencyTotal } from '@montra/domain';
import { accountsWithProperties, countedProperties } from '../../src/features/accounts';
import { useCached } from '../../src/features/use-cached';
import { fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import { Body, Card, Row, Screen, Small, Title } from '../../src/ui/components';

const line = (totals: CurrencyTotal[]) =>
  totals.map((n) => fmtMoney(n.amount.toString(), n.currency)).join('\n') || '—';

export default function Accounts() {
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const worth = useCached(ws, 'net-worth-now', () => api.netWorth(ws, 1), Boolean(ws));
  const summary = accountsWithProperties(useLocal((s) => s.getReference('accounts')) ?? [], worth.data);
  const properties = countedProperties(worth.data);
  const ccy = worth.data?.currency;
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
      {properties.length > 0 ? (
        <Card testID="accounts-properties">
          <Title>{t('accounts.properties')}</Title>
          <Body>
            {fmtMoney(
              properties.reduce((sum, p) => sum + BigInt(p.value), 0n),
              ccy,
            )}
          </Body>
          {properties.map((p) => (
            <Row
              key={p.propertyId}
              title={p.name}
              right={<Body>{fmtMoney(p.value, ccy)}</Body>}
              onPress={() => router.push('/rentals')}
            />
          ))}
        </Card>
      ) : null}
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
