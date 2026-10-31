/** Transactions (08 §3): local list with search, account filter, keyset paging and swipe actions. Works offline. */
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { CategoryDto } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Field, Monogram, Small } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

const PAGE = 50;

export default function Transactions() {
  const th = useTheme();
  const router = useRouter();
  const { store, engine, version, state, refresh, touch } = useSync();
  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState<string | undefined>();
  const [rows, setRows] = useState<LocalTransaction[]>([]);
  const [done, setDone] = useState(false);
  const [picking, setPicking] = useState<LocalTransaction | null>(null);
  const accounts = useLocal((s) => s.getReference('accounts')) ?? [];
  const categories = useLocal((s) => s.getReference('categories')) ?? [];

  const load = useCallback(
    async (more: boolean) => {
      const last = more ? rows.at(-1) : undefined;
      const page = await store.listTransactions({
        search: search || undefined,
        accountId,
        limit: PAGE,
        ...(last ? { before: { date: last.date, id: last.id } } : {}),
      });
      setRows((r) => (more ? [...r, ...page] : page));
      setDone(page.length < PAGE);
    },
    [store, search, accountId, rows],
  );

  // Reload the first page when filters change or the store changes.
  useEffect(() => {
    void load(false);
    // `load` changes with `rows`; the first page only depends on the filters and the store version.
  }, [search, accountId, version]);

  const remove = (row: LocalTransaction) =>
    Alert.alert(t('mobile.txn.delete_confirm'), row.payee ?? row.description, [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      {
        text: t('mobile.txn.delete'),
        style: 'destructive',
        onPress: () => void engine.deleteTransaction(row.id).then(touch),
      },
    ]);

  const categorize = async (row: LocalTransaction, c: CategoryDto) => {
    setPicking(null);
    if (row.reviewState === 'needs_review') await engine.resolveReview(row.id, c.id);
    else await engine.updateTransaction(row.id, { categoryId: c.id });
    touch();
  };

  const renderItem = ({ item }: { item: LocalTransaction }) => {
    const name = item.merchantName ?? item.payee ?? item.description;
    const meta = [fmtDate(item.date), item.categoryName ?? (item.reviewState === 'needs_review' ? t('mobile.txn.needs_review') : null), item.pending ? t('mobile.txn.pending') : null]
      .filter(Boolean)
      .join(' · ');
    return (
      <Swipeable
        friction={2}
        renderRightActions={() => (
          <View style={{ flexDirection: 'row' }}>
            <Action label={t('mobile.txn.categorize')} color={th.primary} onPress={() => setPicking(item)} />
            <Action label={t('mobile.txn.delete')} color={th.danger} onPress={() => remove(item)} />
          </View>
        )}
      >
        <Pressable
          onPress={() => router.push(`/transaction/${item.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`${name}, ${fmtMoney(item.amount, item.currency)}, ${meta}`}
          accessibilityActions={[{ name: 'categorize', label: t('mobile.txn.categorize') }, { name: 'delete', label: t('mobile.txn.delete') }]}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'delete' ? remove(item) : setPicking(item))}
          testID="txn-row"
          style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(3), padding: th.space(3), backgroundColor: th.surface, borderBottomWidth: 0.5, borderColor: th.border }}
        >
          <Monogram name={name} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: th.text, fontSize: th.font.body }} numberOfLines={1}>
              {name}
            </Text>
            <Small>{meta}</Small>
          </View>
          <Text style={{ color: item.amount?.startsWith('-') ? th.text : th.success, fontSize: th.font.body, fontVariant: ['tabular-nums'] }}>
            {fmtMoney(item.amount, item.currency)}
          </Text>
        </Pressable>
      </Swipeable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: th.bg }} edges={['top']}>
      <View style={{ padding: th.space(4), gap: th.space(2) }}>
        <Field label={t('mobile.txn.search')} value={search} onChangeText={setSearch} returnKeyType="search" testID="txn-search" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: th.space(2) }}>
          <Chip label={t('mobile.txn.all_accounts')} active={!accountId} onPress={() => setAccountId(undefined)} />
          {accounts.filter((a) => !a.archived && !a.hidden).map((a) => (
            <Chip key={a.id} label={a.name} active={accountId === a.id} onPress={() => setAccountId(a.id)} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        onEndReached={() => !done && void load(true)}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={Boolean(state?.syncing)} onRefresh={() => void refresh()} />}
        ListEmptyComponent={<View style={{ padding: th.space(4) }}><Small>{t('mobile.txn.empty')}</Small></View>}
      />
      <CategoryPicker
        visible={picking !== null}
        categories={categories}
        kind={picking?.amount?.startsWith('-') ? 'expense' : 'income'}
        onClose={() => setPicking(null)}
        onPick={(c) => picking && void categorize(picking, c)}
      />
    </SafeAreaView>
  );
}

function Action({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={{ backgroundColor: color, justifyContent: 'center', paddingHorizontal: 16 }}>
      <Text style={{ color: '#fff', fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: active ? th.primary : th.surface, borderWidth: 0.5, borderColor: th.border }}
    >
      <Text style={{ color: active ? th.onPrimary : th.text }}>{label}</Text>
    </Pressable>
  );
}
