/**
 * Which notifications come by push and email (NOT-01, OPS-13). Each switch saves on its own, so nothing here can undo a change made on
 * another device. Quiet hours and the daily cap (NOT-03) save together with their own button, sending only those three
 * values; times are typed (22:00), as the phone has no time picker without a native module. The digest day, the alert
 * amounts and the email unsubscribe stay on the web. Texts (ADR-0049 §6) show only where this service sends them, and
 * switch only for a confirmed number.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Switch, View } from 'react-native';
import type { NotificationPrefsDto, NotificationType } from '@montra/schemas';
import { NOTIFICATION_ROWS, toggleChannel } from '../src/features/data-settings';
import { errorText, minutesToTime, QUIET_DEFAULT, timingRequest } from '../src/features/settings-edit';
import { textsView } from '../src/features/texts';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  Field,
  Row,
  Screen,
  SectionLabel,
  Small,
  useToast,
} from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { useTheme } from '../src/ui/theme';

/** Quiet hours and the daily cap, as on the web's "Timing and limits". */
function Timing({
  prefs,
  onSaved,
}: {
  prefs: NotificationPrefsDto;
  onSaved: (p: NotificationPrefsDto) => void;
}) {
  const th = useTheme();
  const { api } = useSession();
  const toast = useToast();
  const [quiet, setQuiet] = useState(prefs.quietStart !== null);
  const [start, setStart] = useState(minutesToTime(prefs.quietStart ?? QUIET_DEFAULT.start));
  const [end, setEnd] = useState(minutesToTime(prefs.quietEnd ?? QUIET_DEFAULT.end));
  const [cap, setCap] = useState(String(prefs.dailyCap));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const built = timingRequest({ quiet, start, end, cap });
    if (!built.ok) return setError(t(built.error));
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateNotificationPrefs(built.value));
      haptic.success();
      toast.show(t('notify.saved'));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="notify-timing">
      <SectionLabel>{t('notify.timing')}</SectionLabel>
      {error ? <Banner tone="danger" text={error} /> : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: th.space(2),
        }}
      >
        <View style={{ flex: 1 }}>
          <Small>{t('notify.quiet_on')}</Small>
        </View>
        <Switch
          value={quiet}
          onValueChange={setQuiet}
          accessibilityLabel={t('notify.quiet_on')}
          testID="notify-quiet"
        />
      </View>
      {quiet ? (
        <View style={{ flexDirection: 'row', gap: th.space(2) }}>
          <View style={{ flex: 1 }}>
            <Field
              label={t('notify.quiet_start')}
              value={start}
              onChangeText={setStart}
              placeholder="22:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              testID="notify-quiet-start"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label={t('notify.quiet_end')}
              value={end}
              onChangeText={setEnd}
              placeholder="07:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              testID="notify-quiet-end"
            />
          </View>
        </View>
      ) : null}
      <Field
        label={t('notify.daily_cap')}
        value={cap}
        onChangeText={setCap}
        keyboardType="number-pad"
        maxLength={2}
        testID="notify-cap"
      />
      <Small>{t('notify.daily_cap_hint')}</Small>
      <Button label={t('common.save')} busy={busy} onPress={() => void save()} testID="notify-timing-save" />
    </Card>
  );
}

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
          <Timing prefs={prefs} onSaved={setPrefs} />
          <Small>{t('mobile.notify.more_on_web')}</Small>
          {texts ? (
            <Card testID="notify-texts">
              <SectionLabel>{t('notify.texts')}</SectionLabel>
              <Small>{t(texts.line.key, texts.line.values)}</Small>
              {texts.addNumber ? (
                <Row
                  title={t('phone.title')}
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
