/**
 * Which notifications come by push and email (NOT-01, OPS-13). Each switch saves on its own, so nothing here can undo a change made on
 * another device. Quiet hours and the daily cap are shown, and set on the web, where a time picker doesn't need a native module.
 * Texts (ADR-0049 §6) show only where this service sends them, and switch only for a confirmed number.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Switch, View } from 'react-native';
import type { NotificationPrefsDto, NotificationType } from '@montra/schemas';
import { NOTIFICATION_ROWS, toggleChannel } from '../src/features/data-settings';
import { textsView } from '../src/features/texts';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Card, Row, Screen, SectionLabel, Small } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

const clock = (m: number | null) =>
  m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export default function NotificationSettings() {
  const th = useTheme();
  const router = useRouter();
  const { api } = useSession();
  const [prefs, setPrefs] = useState<NotificationPrefsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read again on coming back from the number screen, where it may have been added or confirmed.
  useFocusEffect(
    useCallback(() => {
      api
        .notificationPrefs()
        .then(setPrefs)
        .catch((err: Error) => setError(err.message));
    }, [api]),
  );
  const texts = textsView(prefs?.texts);

  const changeText = async (kind: 'security' | 'reminders', on: boolean) => {
    try {
      setPrefs(await api.updateNotificationPrefs({ texts: { [kind]: on } }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const change = async (type: NotificationType, channel: 'email' | 'push', on: boolean) => {
    if (!prefs) return;
    try {
      setPrefs(
        await api.updateNotificationPrefs({ channels: toggleChannel(prefs.channels, type, channel, on) }),
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Screen testID="notification-settings">
      {error ? <Banner tone="danger" text={error} /> : null}
      {prefs ? (
        <>
          {NOTIFICATION_ROWS.map((type) => (
            <Card key={type} testID="notification-pref">
              <Body>{t(`notify.type_${type}`)}</Body>
              {(['push', 'email'] as const).map((channel) => (
                <View
                  key={channel}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: th.space(2),
                  }}
                >
                  <Small>{t(`notify.channel_${channel}`)}</Small>
                  <Switch
                    value={prefs.channels[type]?.[channel] ?? false}
                    onValueChange={(v) => void change(type, channel, v)}
                    accessibilityLabel={t('notify.toggle', {
                      type: t(`notify.type_${type}`),
                      channel: t(`notify.channel_${channel}`),
                    })}
                  />
                </View>
              ))}
            </Card>
          ))}
          <Card>
            <Small>
              {prefs.quietStart !== null
                ? t('mobile.notify.quiet_hours', {
                    start: clock(prefs.quietStart),
                    end: clock(prefs.quietEnd),
                  })
                : t('mobile.notify.no_quiet_hours')}
            </Small>
            <Small>{t('mobile.notify.cap', { count: prefs.dailyCap })}</Small>
            <Small>{t('mobile.notify.on_web')}</Small>
          </Card>
          {texts ? (
            <Card testID="notify-texts">
              <SectionLabel>{t('notify.texts')}</SectionLabel>
              <Small>{t(texts.line.key, texts.line.values)}</Small>
              {texts.addNumber ? (
                <Row
                  title={t('mobile.phone.label')}
                  icon="phone"
                  last
                  onPress={() => router.push('/mobile-number')}
                  testID="notify-texts-add-phone"
                />
              ) : null}
              {texts.optedOut ? <Banner tone="warning" text={t('notify.texts_opted_out')} /> : null}
              {(['security', 'reminders'] as const).map((kind) => (
                <View
                  key={kind}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: th.space(2),
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Small>{t(`notify.texts_${kind}`)}</Small>
                  </View>
                  <Switch
                    value={prefs.texts[kind]}
                    disabled={!texts.canSwitch}
                    onValueChange={(v) => void changeText(kind, v)}
                    accessibilityLabel={t(`notify.texts_${kind}`)}
                    testID={`notify-texts-${kind}`}
                  />
                </View>
              ))}
              <Small>{t('notify.texts_hint')}</Small>
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
