/** Account register (simple view) from local data, newest first with a running balance from the synced balance. */
import { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useLocal } from '../../src/sync/SyncProvider';
import { Body, Row, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Register() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const th = useTheme();
  const router = useRouter();
  const account = (useLocal((s) => s.getReference('accounts')) ?? []).find((a) => a.id === id);
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
        {account ? <Body>{fmtMoney(account.balance.amount, account.balance.currency)}</Body> : null}
      </View>
      <FlatList
        data={lines}
        keyExtractor={(l) => l.row.id}
        contentContainerStyle={{ paddingHorizontal: th.space(4) }}
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
