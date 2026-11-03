/** Bills and paydays as an agenda (FLOW-05, UP-14): a month grid doesn't fit a phone, so days are listed. */
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { addMonths, calendarDate, endOfMonth, startOfMonth } from '@montra/domain';
import type { CalendarDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../src/i18n';
import { todayLocal } from '../src/features/home';
import { useCached } from '../src/features/use-cached';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Screen, Small } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

export default function Calendar() {
  const th = useTheme();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [month, setMonth] = useState(() => startOfMonth(todayLocal()));
  const data = useCached(
    ws,
    `calendar.${month}`,
    () => api.calendar(ws, month, endOfMonth(month)),
    Boolean(ws),
  );
  const days = useMemo(() => {
    const m = new Map<string, CalendarDto['items']>();
    for (const i of data.data?.items ?? []) m.set(i.date, [...(m.get(i.date) ?? []), i]);
    return [...m.entries()];
  }, [data.data]);
  const tone = (kind: CalendarDto['items'][number]['kind']) =>
    kind === 'payday' ? th.success : kind === 'goal_due' ? th.warning : th.text;
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
      {data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {data.data && days.length === 0 ? <Body muted>{t('calendar.empty')}</Body> : null}
      {days.map(([date, items]) => (
        <Card key={date} testID="calendar-day">
          <Small>{fmtDate(date)}</Small>
          {items.map((i, n) => (
            <View key={n} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
              <Body style={{ flexShrink: 1, color: tone(i.kind) }}>{i.name}</Body>
              <View style={{ alignItems: 'flex-end' }}>
                <Body>{fmtMoney(i.amount, i.currency)}</Body>
                {i.status !== 'upcoming' ? (
                  <Small color={i.status === 'paid' ? th.success : th.danger}>
                    {t(`calendar.status_${i.status}`)}
                  </Small>
                ) : null}
              </View>
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}
