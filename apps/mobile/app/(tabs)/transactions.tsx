/**
 * Transactions (08 §3): local list with search, filters (accounts, family members, dates: FAM-09) in a side panel,
 * keyset paging and swipe actions. Works offline.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { CategoryDto } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import { todayLocal } from '../../src/features/home';
import {
  activeCount,
  dateRange,
  HOUSEHOLD,
  memberChoices,
  NO_FILTERS,
  queryFor,
  type TxnFilters,
} from '../../src/features/txn-filters';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { canChangeOn } from '../../src/features/roles';
import { useAbilities } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Field, FilterChip, Monogram, Small } from '../../src/ui/components';
import { haptic } from '../../src/ui/haptics';
import { Icon } from '../../src/ui/icons';
import { dateSummary, memberName, TransactionFilters } from '../../src/ui/TransactionFilters';
import { useTheme } from '../../src/ui/theme';

const PAGE = 50;

export default function Transactions() {
  const th = useTheme();
  const router = useRouter();
  const { store, engine, version, state, refresh, touch } = useSync();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<TxnFilters>(NO_FILTERS);
  const [filtering, setFiltering] = useState(false);
  const [rows, setRows] = useState<LocalTransaction[]>([]);
  const [done, setDone] = useState(false);
  const [picking, setPicking] = useState<LocalTransaction | null>(null);
  const accounts = useLocal((s) => s.getReference('accounts')) ?? [];
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const members = useLocal((s) => s.getReference('members')) ?? [];
  const count = activeCount(filters);

  const load = useCallback(
    async (more: boolean) => {
      const last = more ? rows.at(-1) : undefined;
      const page = await store.listTransactions({
        ...queryFor(filters, search, todayLocal()),
        limit: PAGE,
        ...(last ? { before: { date: last.date, id: last.id } } : {}),
      });
      setRows((r) => (more ? [...r, ...page] : page));
      setDone(page.length < PAGE);
    },
    [store, search, filters, rows],
  );

  // Reload the first page when filters change or the store changes.
  useEffect(() => {
    void load(false);
    // `load` changes with `rows`; the first page only depends on the filters and the store version.
  }, [search, filters, version]);

  // One chip per active choice under the search box; tapping one removes it.
  const chips = [
    ...(dateRange(filters, todayLocal()).from || dateRange(filters, todayLocal()).to
      ? [
          {
            key: 'date',
            label: dateSummary(filters),
            remove: () => setFilters({ ...filters, date: 'any', from: null, to: null }),
          },
        ]
      : []),
    ...accounts
      .filter((a) => filters.accountIds.includes(a.id))
      .map((a) => ({
        key: a.id,
        label: a.name,
        remove: () => setFilters({ ...filters, accountIds: filters.accountIds.filter((x) => x !== a.id) }),
      })),
    ...memberChoices(members)
      .filter((m) => filters.memberKeys.includes(m.key))
      .map((m) => ({
        key: m.key === HOUSEHOLD ? HOUSEHOLD : `m-${m.key}`,
        label: memberName(m.name),
        remove: () => setFilters({ ...filters, memberKeys: filters.memberKeys.filter((x) => x !== m.key) }),
      })),
  ];

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

  const can = useAbilities();

  const renderItem = ({ item }: { item: LocalTransaction }) => {
    // Swipe actions only where this login may change the row (AUTH-18).
    const editable = canChangeOn(can, accounts, item.accountId);
    const name = item.merchantName ?? item.payee ?? item.description;
    const meta = [
      fmtDate(item.date),
      item.categoryName ?? (item.reviewState === 'needs_review' ? t('mobile.txn.needs_review') : null),
      item.pending ? t('mobile.txn.pending') : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <Swipeable
        friction={2}
        onSwipeableWillOpen={() => haptic.select()}
        enabled={editable}
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
          accessibilityActions={
            editable
              ? [
                  { name: 'categorize', label: t('mobile.txn.categorize') },
                  { name: 'delete', label: t('mobile.txn.delete') },
                ]
              : []
          }
          onAccessibilityAction={(e) =>
            e.nativeEvent.actionName === 'delete' ? remove(item) : setPicking(item)
          }
          testID="txn-row"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space(3),
            padding: th.space(3),
            backgroundColor: th.surface,
            borderBottomWidth: 0.5,
            borderColor: th.border,
          }}
        >
          <Monogram name={name} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: th.text, fontSize: th.font.body }} numberOfLines={1}>
              {name}
            </Text>
            <Small>{meta}</Small>
          </View>
          <Text
            style={{
              color: item.amount?.startsWith('-') ? th.text : th.success,
              fontSize: th.font.body,
              fontVariant: ['tabular-nums'],
            }}
          >
            {fmtMoney(item.amount, item.currency)}
          </Text>
        </Pressable>
      </Swipeable>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: th.bg }} edges={['top']}>
      <View style={{ padding: th.pad, gap: th.space(2) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(2) }}>
          <View style={{ flex: 1 }}>
            <Field
              label={t('mobile.txn.search')}
              icon="search"
              hideLabel
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
              testID="txn-search"
            />
          </View>
          <Pressable
            onPress={() => {
              haptic.tap();
              setFiltering(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.filters.button', { count })}
            testID="txn-filter"
            style={({ pressed }) => ({
              width: th.tap,
              height: th.tap,
              borderRadius: th.radius,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: count ? th.primary : th.surfaceAlt,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="filter" size={20} color={count ? th.onPrimary : th.text} />
            {count ? (
              <View
                importantForAccessibility="no"
                accessibilityElementsHidden
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  minWidth: 18,
                  height: 18,
                  borderRadius: 9,
                  paddingHorizontal: 4,
                  backgroundColor: th.text,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: th.bg, fontSize: 11, fontWeight: '700' }}>{count}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
        {chips.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: th.space(2) }}
          >
            {chips.map((c) => (
              <FilterChip
                key={c.key}
                label={c.label}
                onRemove={c.remove}
                removeLabel={t('mobile.filters.remove', { name: c.label })}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        onEndReached={() => !done && void load(true)}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={Boolean(state?.syncing)} onRefresh={() => void refresh()} />
        }
        ListEmptyComponent={
          <View style={{ padding: th.pad }}>
            <Small>{t('mobile.txn.empty')}</Small>
          </View>
        }
      />
      <TransactionFilters
        visible={filtering}
        filters={filters}
        onChange={setFilters}
        onClose={() => setFiltering(false)}
        accounts={accounts}
        members={members}
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ backgroundColor: color, justifyContent: 'center', paddingHorizontal: 16 }}
    >
      <Text style={{ color: '#fff', fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
