/** Root: providers (session, app lock, toasts, share intent, sync) and the auth gate. */
import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { SessionProvider, useSession } from '../src/session/SessionProvider';
import { AppLock } from '../src/lock/AppLock';
import { SyncProvider } from '../src/sync/SyncProvider';
import { ToastHost } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';
import { t } from '../src/i18n';

function Gate() {
  const { state } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const th = useTheme();
  const share = useShareIntentContext();
  const signedIn = state.status === 'signed_in';

  useEffect(() => {
    if (state.status === 'loading') return;
    const onSignIn = segments[0] === 'sign-in';
    if (!signedIn && !onSignIn) router.replace('/sign-in');
    else if (signedIn && onSignIn) router.replace('/');
  }, [state.status, signedIn, segments, router]);

  // Files shared from another app (or "Open in Montra") go straight to the import flow (PLT-04, IMP-02).
  useEffect(() => {
    if (signedIn && share.hasShareIntent && share.shareIntent.files?.length) router.push('/import');
  }, [signedIn, share.hasShareIntent, share.shareIntent.files, router]);

  const stack = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: th.surface },
        headerTintColor: th.text,
        contentStyle: { backgroundColor: th.bg },
        headerBackTitle: t('mobile.common.back'),
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="transaction/[id]" options={{ title: t('mobile.txn.detail') }} />
      <Stack.Screen name="accounts/index" options={{ title: t('mobile.more.accounts') }} />
      <Stack.Screen name="accounts/[id]" options={{ title: t('mobile.accounts.register') }} />
      <Stack.Screen name="import" options={{ title: t('mobile.import.title') }} />
      <Stack.Screen name="activity" options={{ title: t('mobile.activity.title') }} />
      <Stack.Screen name="settings" options={{ title: t('mobile.settings.title') }} />
      <Stack.Screen name="developer/camera" options={{ title: t('mobile.spike.title') }} />
    </Stack>
  );
  return signedIn ? <SyncProvider workspaceId={state.workspace.id}>{stack}</SyncProvider> : stack;
}

export default function RootLayout() {
  const th = useTheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ShareIntentProvider options={{ resetOnBackground: false }}>
          <ToastHost>
            <SessionProvider>
              <AppLock>
                <StatusBar style={th.dark ? 'light' : 'dark'} />
                <Gate />
              </AppLock>
            </SessionProvider>
          </ToastHost>
        </ShareIntentProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
