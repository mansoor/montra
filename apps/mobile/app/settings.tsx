/** Settings: app lock (PLT-07), notifications, workspace, AI mode (read-only), sign out (wipes, BAK-10), version. */
import { useEffect, useState } from 'react';
import { Alert, Pressable, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { config } from '../src/config';
import { t } from '../src/i18n';
import { LOCK_TIMEOUTS } from '../src/lock/policy';
import { useLockSettings } from '../src/lock/AppLock';
import { registerForPush, type PushStatus } from '../src/push/register';
import { useSession } from '../src/session/SessionProvider';
import { Body, Button, Card, Row, Screen, Small } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

export default function Settings() {
  const th = useTheme();
  const router = useRouter();
  const lock = useLockSettings();
  const session = useSession();
  const { state, api } = session;
  const [ai, setAi] = useState<string | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);

  useEffect(() => {
    if (state.status !== 'signed_in') return;
    void api.aiSettings(state.workspace.id).then(
      (s) => setAi(s.mode),
      () => undefined,
    );
    void registerForPush(api, false).then(setPush, () => setPush('unavailable'));
  }, [api, state]);

  const signOut = () =>
    Alert.alert(t('mobile.settings.sign_out'), t('mobile.settings.sign_out_note'), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.settings.sign_out'), style: 'destructive', onPress: () => void session.signOut() },
    ]);

  return (
    <Screen testID="settings">
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Body>{t('mobile.settings.lock')}</Body>
          <Switch
            value={lock.enabled}
            disabled={!lock.available}
            onValueChange={(v) => void lock.setEnabled(v)}
            accessibilityLabel={t('mobile.settings.lock')}
          />
        </View>
        {lock.enabled ? (
          <>
            <Small>{t('mobile.settings.lock_after')}</Small>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }}>
              {LOCK_TIMEOUTS.map((o) => (
                <Pressable
                  key={o}
                  onPress={() => void lock.setTimeout(o)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: lock.timeout === o }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 16,
                    backgroundColor: lock.timeout === o ? th.primary : th.bg,
                  }}
                >
                  <Body style={{ color: lock.timeout === o ? th.onPrimary : th.text }}>
                    {t(`mobile.settings.lock.${o}`)}
                  </Body>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </Card>

      <Card>
        <Small>{t('mobile.settings.notifications')}</Small>
        {push === 'registered' ? (
          <Body>{t('mobile.settings.notifications_on')}</Body>
        ) : (
          <Button
            kind="secondary"
            label={t('mobile.settings.notifications_enable')}
            disabled={push === 'unavailable'}
            onPress={() => void registerForPush(api, true).then(setPush)}
          />
        )}
      </Card>

      {state.status === 'signed_in' ? (
        <Card>
          <Small>{t('mobile.settings.workspace')}</Small>
          {state.workspaces.map((w) => (
            <Row
              key={w.id}
              title={w.name}
              subtitle={w.id === state.workspace.id ? '✓' : undefined}
              onPress={() => void session.chooseWorkspace(w.id)}
            />
          ))}
          {ai ? <Small>{t('mobile.settings.ai_mode', { mode: ai })}</Small> : null}
        </Card>
      ) : null}

      <Button kind="danger" label={t('mobile.settings.sign_out')} onPress={signOut} testID="sign-out" />
      <Small>{t('mobile.settings.sign_out_note')}</Small>
      <Row title={t('mobile.settings.developer')} onPress={() => router.push('/developer/camera')} />
      <Small>{t('mobile.settings.version', { version: config.version })}</Small>
    </Screen>
  );
}
