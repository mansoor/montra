/**
 * The period Home's four numbers are for (FLOW-01): the date range under the title, with a down arrow, opens the
 * periods the server offers (newest first, the current one at the top). Picking the current one clears the choice.
 */
import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { fmtDate, t } from '../i18n';
import { haptic } from './haptics';
import { Icon } from './icons';
import { Button, Row, Title } from './components';
import { useTheme } from './theme';

type Period = { start: string; end: string };

const range = (p: Period) => `${fmtDate(p.start)} – ${fmtDate(p.end)}`;

export function PeriodPicker({
  shown,
  periods,
  warn,
  onPick,
}: {
  shown: Period;
  /** Newest first; the first is the current period. */
  periods: readonly Period[];
  /** Not the current period: the range shows in the warning colour. */
  warn: boolean;
  /** null for the current period. */
  onPick: (start: string | null) => void;
}) {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  const color = warn ? th.warning : th.muted;
  return (
    <>
      <Pressable
        onPress={() => {
          haptic.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${t('home.period_nav')}: ${range(shown)}`}
        hitSlop={8}
        testID="home-period-pick"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: 4,
          paddingVertical: 4,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color, fontSize: th.font.small, fontWeight: warn ? '700' : '400' }}>
          {range(shown)}
        </Text>
        <Icon name="expand" size={16} color={color} />
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => setOpen(false)}
        presentationStyle="pageSheet"
      >
        <View style={{ flex: 1, backgroundColor: th.bg, padding: th.pad, gap: th.space(2) }}>
          <Title>{t('home.period_nav')}</Title>
          <FlatList
            data={periods}
            keyExtractor={(p) => p.start}
            testID="home-period-list"
            renderItem={({ item, index }) => {
              const picked = item.start === shown.start;
              return (
                <Row
                  title={range(item)}
                  subtitle={index === 0 ? t('home.period_current') : undefined}
                  right={picked ? <Icon name="check" size={18} color={th.primary} /> : <View />}
                  last={index === periods.length - 1}
                  onPress={() => {
                    haptic.select();
                    setOpen(false);
                    onPick(index === 0 ? null : item.start);
                  }}
                  testID={`home-period-${item.start}`}
                />
              );
            }}
          />
          <Button kind="secondary" label={t('mobile.common.cancel')} onPress={() => setOpen(false)} />
        </View>
      </Modal>
    </>
  );
}
