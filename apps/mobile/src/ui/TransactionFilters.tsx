/**
 * The transaction filter panel: accounts (by kind, a whole kind at once), family members and a date range. Changes apply
 * as they're made, so the list behind updates live; an empty choice means all.
 */
import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { parts, type CalendarDate } from '@montra/domain';
import type { AccountDto, FamilyMemberDto } from '@montra/schemas';
import {
  accountGroups,
  activeCount,
  DATE_PRESETS,
  groupState,
  memberChoices,
  NO_FILTERS,
  setAll,
  toggle,
  type DatePreset,
  type TxnFilters,
} from '../features/txn-filters';
import { todayLocal } from '../features/home';
import { fmtDate, t } from '../i18n';
import { Button, CheckRow, Disclosure, Small } from './components';
import { SidePanel } from './SidePanel';
import { useTheme } from './theme';

type Section = 'accounts' | 'members' | 'date';

/** The one-line summary of a selection: all, the single choice, or how many. */
const chosen = (names: string[]) =>
  names.length === 0
    ? t('mobile.filters.all')
    : names.length === 1
      ? names[0]!
      : t('mobile.filters.selected', { count: names.length });

export const memberName = (name: string | null) => name ?? t('members.household');

export function dateSummary(f: TxnFilters): string {
  if (f.date !== 'custom') return t(`mobile.filters.date.${f.date}`);
  if (!f.from && !f.to) return t('mobile.filters.date.custom');
  const end = (d: CalendarDate | null) => (d ? fmtDate(d) : t('mobile.filters.open_end'));
  return `${end(f.from)} – ${end(f.to)}`;
}

const toJs = (d: CalendarDate) => {
  const p = parts(d);
  return new Date(p.year, p.month - 1, p.day);
};

export function TransactionFilters({
  visible,
  filters,
  onChange,
  onClose,
  accounts,
  members,
}: {
  visible: boolean;
  filters: TxnFilters;
  onChange: (f: TxnFilters) => void;
  onClose: () => void;
  accounts: readonly AccountDto[];
  members: readonly FamilyMemberDto[];
}) {
  const th = useTheme();
  const [open, setOpen] = useState<Section | null>(null);
  const [iosPicking, setIosPicking] = useState<'from' | 'to' | null>(null);
  const groups = accountGroups(accounts);
  const people = memberChoices(members);
  const flip = (s: Section) => setOpen((o) => (o === s ? null : s));

  const setDate = (end: 'from' | 'to', d: CalendarDate | null) =>
    onChange({ ...filters, date: 'custom', [end]: d });
  const pickDate = (end: 'from' | 'to') => {
    const value = toJs(filters[end] ?? todayLocal());
    if (Platform.OS === 'android')
      DateTimePickerAndroid.open({
        value,
        mode: 'date',
        onChange: (e, d) => {
          if (e.type === 'set' && d) setDate(end, todayLocal(d));
        },
      });
    else setIosPicking((p) => (p === end ? null : end));
  };

  const accountNames = groups.flatMap((g) => g.accounts).filter((a) => filters.accountIds.includes(a.id));
  const memberNames = people.filter((p) => filters.memberKeys.includes(p.key)).map((p) => memberName(p.name));

  return (
    <SidePanel
      visible={visible}
      title={t('mobile.filters.title')}
      closeLabel={t('mobile.filters.close')}
      onClose={onClose}
      testID="txn-filters"
      headerAction={
        activeCount(filters) > 0 ? (
          <Pressable
            onPress={() => onChange(NO_FILTERS)}
            accessibilityRole="button"
            hitSlop={8}
            style={{ minHeight: th.tap, justifyContent: 'center' }}
            testID="filters-clear"
          >
            <Text style={{ color: th.primary, fontWeight: '600' }}>{t('mobile.filters.clear')}</Text>
          </Pressable>
        ) : null
      }
      footer={<Button label={t('mobile.filters.done')} onPress={onClose} testID="filters-done" />}
    >
      <Disclosure
        title={t('mobile.filters.date')}
        summary={dateSummary(filters)}
        open={open === 'date'}
        onToggle={() => flip('date')}
        testID="filters-date"
      >
        {DATE_PRESETS.map((p: DatePreset) => (
          <Radio
            key={p}
            label={t(`mobile.filters.date.${p}`)}
            on={filters.date === p}
            onPress={() => onChange({ ...filters, date: p })}
          />
        ))}
        {filters.date === 'custom' ? (
          <View style={{ flexDirection: 'row', gap: th.space(2), paddingTop: th.space(1) }}>
            {(['from', 'to'] as const).map((end) => (
              <DateBox
                key={end}
                label={t(`mobile.filters.${end}`)}
                value={filters[end]}
                onPress={() => pickDate(end)}
                onClear={() => setDate(end, null)}
              />
            ))}
          </View>
        ) : null}
        {Platform.OS === 'ios' && iosPicking && filters.date === 'custom' ? (
          <DateTimePicker
            value={toJs(filters[iosPicking] ?? todayLocal())}
            mode="date"
            display="inline"
            onChange={(_e, d) => d && setDate(iosPicking, todayLocal(d))}
          />
        ) : null}
      </Disclosure>

      <Disclosure
        title={t('mobile.filters.accounts')}
        summary={chosen(accountNames.map((a) => a.name))}
        open={open === 'accounts'}
        onToggle={() => flip('accounts')}
        testID="filters-accounts"
      >
        {groups.map((g) => {
          const ids = g.accounts.map((a) => a.id);
          const state = groupState(filters.accountIds, ids);
          return (
            <View key={g.kind}>
              <CheckRow
                title={t(`account.kind.${g.kind}`)}
                strong
                checked={state === 'all'}
                mixed={state === 'some'}
                onPress={() =>
                  onChange({ ...filters, accountIds: setAll(filters.accountIds, ids, state !== 'all') })
                }
              />
              <View style={{ paddingLeft: th.space(6) }}>
                {g.accounts.map((a) => (
                  <CheckRow
                    key={a.id}
                    title={a.name}
                    subtitle={
                      [a.institution, a.last4 ? `••${a.last4}` : null].filter(Boolean).join(' · ') ||
                      undefined
                    }
                    checked={filters.accountIds.includes(a.id)}
                    onPress={() => onChange({ ...filters, accountIds: toggle(filters.accountIds, a.id) })}
                    testID={`filter-account-${a.name}`}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </Disclosure>

      <Disclosure
        title={t('mobile.filters.members')}
        summary={chosen(memberNames)}
        open={open === 'members'}
        onToggle={() => flip('members')}
        testID="filters-members"
      >
        {people.map((p) => (
          <CheckRow
            key={p.key}
            title={memberName(p.name)}
            checked={filters.memberKeys.includes(p.key)}
            onPress={() => onChange({ ...filters, memberKeys: toggle(filters.memberKeys, p.key) })}
            testID={`filter-member-${p.key}`}
          />
        ))}
      </Disclosure>
    </SidePanel>
  );
}

function Radio({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space(3),
        minHeight: th.tap,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: on ? th.primary : th.muted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: th.primary }} /> : null}
      </View>
      <Text style={{ color: th.text, fontSize: th.font.body }}>{label}</Text>
    </Pressable>
  );
}

function DateBox({
  label,
  value,
  onPress,
  onClear,
}: {
  label: string;
  value: CalendarDate | null;
  onPress: () => void;
  onClear: () => void;
}) {
  const th = useTheme();
  return (
    <View
      style={{
        flex: 1,
        borderWidth: 1,
        borderColor: value ? th.primary : th.border,
        borderRadius: th.radius,
        backgroundColor: th.surface,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value ? fmtDate(value) : t('mobile.filters.open_end')}`}
        style={{ flex: 1, minHeight: th.tap + 8, justifyContent: 'center', paddingHorizontal: th.space(3) }}
      >
        <Small>{label}</Small>
        <Text style={{ color: value ? th.text : th.muted, fontSize: th.font.body }}>
          {value ? fmtDate(value) : t('mobile.filters.open_end')}
        </Text>
      </Pressable>
      {value ? (
        <Pressable
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel={`${t('mobile.filters.clear_date')}: ${label}`}
          hitSlop={6}
          style={{ minWidth: th.tap, minHeight: th.tap, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: th.muted, fontSize: th.font.body }}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
