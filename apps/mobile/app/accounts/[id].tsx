/**
 * An account: what its type needs (a loan's next payment, a card's statement, an investment's gain…; ADR-0024…0027), read
 * live and kept for offline viewing, then its register (simple view) from local data, newest first with a running balance
 * from the synced balance.
 */
import { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { accountProfile } from '@montra/domain';
import { accountSections } from '../../src/features/accounts';
import { todayLocal } from '../../src/features/home';
import { useCached } from '../../src/features/use-cached';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { AccountDetails, loadAccountDetails } from '../../src/ui/AccountDetails';
import { Banner, Body, Row, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Register() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const sync = useSync();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const accounts = useLocal((s) => s.getReference('accounts')) ?? [];
  const account = accounts.find((a) => a.id === id);
  const sections = account ? accountSections(account) : null;
  // Only types with something to read from the server ask for it; a checking account shows its register alone.
  const remote = Boolean(
    sections && (sections.loan || sections.statement || sections.performance || sections.interest),
  );
  const details = useCached(
    ws,
    `account:${id}`,
    () => loadAccountDetails(api, ws, account!, sections!),
    Boolean(ws && account && remote),
  );
  const rows = useLocal((s) => s.listTransactions({ accountId: id, limit: 500 }), [id]) ?? [];
  // Walk back from the current balance (natural sign: owed for cards) so each line shows the balance after it.
  const lines = useMemo(() => {
    if (!account) return [];
    const sign = account.type === 'liability' ? -1n : 1n;
    let bal = BigInt(account.balance.amount);
    return rows
      .filter((r) => r.status === 'posted' && r.amount !== null)
      .map((r) => {
        const line = { row: r, balance: bal };
        bal -= sign * BigInt(r.amount!);
        return line;
      });
  }, [rows, account]);

  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ padding: th.space(4), gap: th.space(1) }}>
        <Title>{account?.name ?? ''}</Title>
        {account ? <Small>{t(`account.kind.${account.kind}`)}</Small> : null}
        {account ? (
          <Body>
            {`${t(`register.${accountProfile(account.kind).balanceWord}`)}: ${fmtMoney(account.balance.amount, account.balance.currency)}`}
          </Body>
        ) : null}
      </View>
      <FlatList
        data={lines}
        keyExtractor={(l) => l.row.id}
        contentContainerStyle={{ paddingHorizontal: th.space(4) }}
        ListHeaderComponent={
          account && sections ? (
            <View style={{ gap: th.space(3), paddingBottom: th.space(2) }}>
              {details.stale ? (
                <Banner
                  tone="warning"
                  text={t(details.data ? 'mobile.plan.offline' : 'mobile.plan.offline_empty')}
                />
              ) : null}
              {details.error ? <Banner tone="danger" text={details.error} /> : null}
              <AccountDetails
                api={api}
                ws={ws}
                account={account}
                accounts={accounts}
                sections={sections}
                data={details.data}
                online={!details.stale}
                today={todayLocal()}
                onChanged={() => {
                  void details.reload();
                  void sync.refresh();
                }}
              />
              {lines.length > 0 ? <Title>{t('mobile.accounts.register')}</Title> : null}
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Row
            title={item.row.merchantName ?? item.row.payee ?? item.row.description}
            subtitle={`${fmtDate(item.row.date)} · ${fmtMoney(item.balance, account?.currency)}`}
            right={<Body>{fmtMoney(item.row.amount, item.row.currency)}</Body>}
            onPress={() => router.push(`/transaction/${item.row.id}`)}
          />
        )}
        ListEmptyComponent={<Small>{t('mobile.txn.empty')}</Small>}
      />
    </View>
  );
}
