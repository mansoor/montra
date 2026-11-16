/**
 * Bills and paydays as an agenda (FLOW-05, UP-14): a month grid doesn't fit a phone, so days are listed. With more
 * than one book, chips filter the agenda by book, as Google Calendar's calendars: each item carries its book's colour
 * and a word for its kind, and amounts are green coming in and red going out. Which books are hidden is the person's
 * own choice, kept on the server (the same as on the web) and cached here, so it still applies offline.
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { addMonths, calendarDate, endOfMonth, startOfMonth } from '@montra/domain';
import type { CalendarBooksDto, CalendarDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../src/i18n';
import { bookChips, calendarTotals, toggleBook, visibleCalendarItems } from '../src/features/calendar-books';
import { todayLocal } from '../src/features/home';
import { useCached } from '../src/features/use-cached';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Screen, Small } from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { Icon } from '../src/ui/icons';
import { useTheme } from '../src/ui/theme';

export default function Calendar() {
  const th = useTheme();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const entities = useMemo(
    () => (session.status === 'signed_in' ? session.workspace.entities : []),
    [session],
  );
  const filtered = entities.length > 1;
  const [month, setMonth] = useState(() => startOfMonth(todayLocal()));
  const [saveError, setSaveError] = useState<string | null>(null);
  const data = useCached(
    ws,
    `calendar.${month}`,
    () => api.calendar(ws, month, endOfMonth(month)),
    Boolean(ws),
  );
  const prefs = useCached<CalendarBooksDto>(
    ws,
    'calendar.books',
    () => api.calendarBooks(ws),
    Boolean(ws) && filtered,
  );
  const hidden = useMemo(() => (filtered ? (prefs.data?.hiddenEntityIds ?? []) : []), [filtered, prefs.data]);
  const books = useMemo(() => bookChips(entities, hidden), [entities, hidden]);
  const colorOf = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const shown = useMemo(() => visibleCalendarItems(data.data?.items ?? [], hidden), [data.data, hidden]);
  const totals = useMemo(() => calendarTotals(shown), [shown]);
  const days = useMemo(() => {
    const m = new Map<string, CalendarDto['items']>();
    for (const i of shown) m.set(i.date, [...(m.get(i.date) ?? []), i]);
    return [...m.entries()];
  }, [shown]);

  async function toggle(id: string) {
    const before = hidden;
    const next = toggleBook(books, hidden, id);
    haptic.select();
    setSaveError(null);
    prefs.set({ hiddenEntityIds: next });
    try {
      prefs.set(await api.setCalendarBooks(ws, next));
    } catch (err) {
      prefs.set({ hiddenEntityIds: before });
      const e = err as { offline?: boolean; message: string };
      setSaveError(e.offline ? t('mobile.plan.offline') : e.message);
    }
  }

  return (
    <Screen testID="calendar">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Button
          kind="secondary"
          label="‹"
          hint={t('budget.previous')}
          onPress={() => setMonth(addMonths(calendarDate(month), -1))}
        />
        <Body style={{ fontWeight: '600' }}>
          {fmtDate(month)} – {fmtDate(endOfMonth(month))}
        </Body>
        <Button
          kind="secondary"
          label="›"
          hint={t('budget.next')}
          onPress={() => setMonth(addMonths(calendarDate(month), 1))}
        />
      </View>
      {filtered ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: th.space(2) }}
          accessibilityLabel={t('calendar.books')}
        >
          {books.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => void toggle(b.id)}
              disabled={prefs.stale}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: b.shown, disabled: prefs.stale }}
              accessibilityLabel={b.name}
              testID={`calendar-book-${b.id}`}
              hitSlop={4}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: th.space(1.5),
                minHeight: 36,
                paddingHorizontal: th.space(3),
                borderRadius: 18,
                borderWidth: 1,
                borderColor: b.shown ? b.color : th.border,
                backgroundColor: b.shown ? th.surface : th.surfaceAlt,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: b.shown ? b.color : 'transparent',
                  borderWidth: 2,
                  borderColor: b.color,
                }}
              />
              <Text
                style={{ color: b.shown ? th.text : th.muted, fontSize: th.font.small, fontWeight: '500' }}
                numberOfLines={1}
              >
                {b.name}
              </Text>
              {b.shown ? <Icon name="check" size={14} color={th.text} strokeWidth={2.5} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {saveError ? <Banner tone="danger" text={saveError} /> : null}
      {totals.map((x) => (
        <Small key={x.currency}>
          {t('calendar.coming_in')} {fmtMoney(String(x.in), x.currency)} · {t('calendar.going_out')}{' '}
          {fmtMoney(String(x.out), x.currency)}
        </Small>
      ))}
      {data.data && days.length === 0 ? (
        <Body muted>{data.data.items.length === 0 ? t('calendar.empty') : t('calendar.empty_shown')}</Body>
      ) : null}
      {days.map(([date, items]) => (
        <Card key={date} testID="calendar-day">
          <Small>{fmtDate(date)}</Small>
          {items.map((i, n) => {
            const book = filtered && i.entityId ? colorOf.get(i.entityId) : undefined;
            const amount = BigInt(i.amount);
            return (
              <View
                key={n}
                accessible
                accessibilityLabel={[
                  i.name,
                  t(`calendar.kind_${i.kind}`),
                  book ? t('calendar.in_book', { name: book.name }) : null,
                  amount !== 0n ? fmtMoney(i.amount, i.currency) : null,
                  i.status !== 'upcoming' ? t(`calendar.status_${i.status}`) : null,
                ]
                  .filter(Boolean)
                  .join(', ')}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  gap: th.space(2),
                  borderLeftWidth: book ? 4 : 0,
                  borderLeftColor: book?.color,
                  paddingLeft: book ? th.space(2) : 0,
                }}
              >
                <View style={{ flexShrink: 1 }}>
                  <Body>{i.name}</Body>
                  <Small>{t(`calendar.kind_${i.kind}`)}</Small>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {amount !== 0n ? (
                    <Body style={{ color: amount > 0n ? th.success : th.danger }}>
                      {fmtMoney(i.amount, i.currency)}
                    </Body>
                  ) : null}
                  {i.status !== 'upcoming' ? (
                    <Small color={i.status === 'paid' ? th.success : th.danger}>
                      {t(`calendar.status_${i.status}`)}
                    </Small>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Card>
      ))}
    </Screen>
  );
}
