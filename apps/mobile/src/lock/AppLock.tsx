/**
 * Biometric app lock (PLT-07): Face ID / fingerprint (with the OS passcode as fallback) on launch and after the
 * inactivity timeout, plus a blur over the app while it is in the background so the app switcher snapshot shows
 * no balances.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { t } from '../i18n';
import { Body, Button, Title } from '../ui/components';
import { useTheme } from '../ui/theme';
import { shouldLock, type LockTimeout } from './policy';
import { ENABLED_KEY, lockStartup, TIMEOUT_KEY } from './startup';

interface LockSettings {
  enabled: boolean;
  timeout: LockTimeout;
  available: boolean;
  setEnabled(v: boolean): Promise<void>;
  setTimeout(v: LockTimeout): Promise<void>;
}

const Ctx = createContext<LockSettings>({
  enabled: false,
  timeout: '5m',
  available: false,
  setEnabled: async () => undefined,
  setTimeout: async () => undefined,
});
export const useLockSettings = () => useContext(Ctx);

export function AppLock({ children }: { children: ReactNode }) {
  const th = useTheme();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabledState] = useState(true);
  const [timeout, setTimeoutState] = useState<LockTimeout>('5m');
  const [available, setAvailable] = useState(false);
  const [locked, setLocked] = useState(true);
  const [background, setBackground] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastActive = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    setError(null);
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: t('mobile.lock.prompt'),
      disableDeviceFallback: false,
    });
    if (res.success) {
      lastActive.current = Date.now();
      setLocked(false);
    } else setError(t('mobile.lock.failed'));
  }, []);

  useEffect(() => {
    void (async () => {
      // Bounded: a check that throws or never answers can't leave the app on a blank screen.
      const s = await lockStartup({
        hasHardware: () => LocalAuthentication.hasHardwareAsync(),
        isEnrolled: () => LocalAuthentication.isEnrolledAsync(),
        hasAnySecurity: async () =>
          (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE,
        read: (key) => SecureStore.getItemAsync(key),
      });
      setAvailable(s.available);
      setEnabledState(s.enabled);
      setTimeoutState(s.timeout);
      const lock = shouldLock({
        enabled: s.enabled,
        coldStart: true,
        lastActiveAt: null,
        now: Date.now(),
        timeout: '5m',
      });
      setLocked(lock);
      setReady(true);
      if (s.error) setError(s.error);
      else if (lock) void unlock();
    })();
  }, [unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        setBackground(false);
        if (
          shouldLock({
            enabled,
            coldStart: false,
            lastActiveAt: lastActive.current,
            now: Date.now(),
            timeout,
          })
        ) {
          setLocked(true);
          void unlock();
        } else lastActive.current = Date.now();
      } else {
        setBackground(true);
        if (!locked) lastActive.current = Date.now();
      }
    });
    return () => sub.remove();
  }, [enabled, timeout, locked, unlock]);

  const settings: LockSettings = {
    enabled,
    timeout,
    available,
    async setEnabled(v) {
      if (v) {
        const res = await LocalAuthentication.authenticateAsync({ promptMessage: t('mobile.lock.prompt') });
        if (!res.success) return;
      }
      await SecureStore.setItemAsync(ENABLED_KEY, String(v));
      setEnabledState(v);
    },
    async setTimeout(v) {
      await SecureStore.setItemAsync(TIMEOUT_KEY, v);
      setTimeoutState(v);
    },
  };

  if (!ready) {
    return (
      <View
        style={{ flex: 1, backgroundColor: th.bg, alignItems: 'center', justifyContent: 'center' }}
        testID="starting"
      >
        <Body muted>{t('mobile.starting')}</Body>
      </View>
    );
  }
  return (
    <Ctx.Provider value={settings}>
      {children}
      {locked ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: th.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
          ]}
        >
          <Title>{t('mobile.lock.title')}</Title>
          {error ? <Body muted>{error}</Body> : null}
          <Button label={t('mobile.lock.unlock')} onPress={() => void unlock()} testID="unlock" />
        </View>
      ) : null}
      {background && !locked ? (
        <BlurView
          intensity={80}
          tint={th.dark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
          accessibilityElementsHidden
        />
      ) : null}
    </Ctx.Provider>
  );
}
