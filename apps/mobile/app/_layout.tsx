/** Root: providers (session, app lock, toasts, share intent, sync) and the auth gate. */
import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { SessionProvider, useSession } from '../src/session/SessionProvider';
import { AppLock } from '../src/lock/AppLock';
import { SyncProvider } from '../src/sync/SyncProvider';
import { Body, Button, Title, ToastHost } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';
import { t } from '../src/i18n';

function Gate() {
  const { state, updateRequired } = useSession();
  const router = useRouter();
  const th = useTheme();
  const share = useShareIntentContext();
  const signedIn = state.status === 'signed_in';

  // Files shared from another app (or "Open in Montra") go straight to the import flow (PLT-04, IMP-02).
  useEffect(() => {
    if (signedIn && share.hasShareIntent && share.shareIntent.files?.length) router.push('/import');
  }, [signedIn, share.hasShareIntent, share.shareIntent.files, router]);

  // OPS-04: nothing else works until it's updated, so nothing else is shown.
  if (updateRequired) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: th.space(4),
          gap: th.space(2),
          backgroundColor: th.bg,
        }}
        testID="update-required"
      >
        <Title>{t('mobile.update.title')}</Title>
        <Body>{t('mobile.update.body')}</Body>
      </View>
    );
  }

  const stack = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: th.surface },
        headerTintColor: th.text,
        contentStyle: { backgroundColor: th.bg },
        headerBackTitle: t('mobile.common.back'),
      }}
    >
      {/* Signed-in screens need the sync engine, which exists only after sign-in. Guarded, the router never draws
          them signed out (a fresh install started on Home and threw "useSync outside SyncProvider"). */}
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="transaction/[id]" options={{ title: t('mobile.txn.detail') }} />
        <Stack.Screen name="accounts/index" options={{ title: t('mobile.more.accounts') }} />
        <Stack.Screen name="accounts/[id]" options={{ title: t('mobile.accounts.register') }} />
        <Stack.Screen name="import" options={{ title: t('mobile.import.title') }} />
        <Stack.Screen name="receipt-capture" options={{ title: t('mobile.receipts.capture_title') }} />
        <Stack.Screen name="receipts/index" options={{ title: t('mobile.receipts.title') }} />
        <Stack.Screen name="receipts/[id]" options={{ title: t('mobile.receipts.review_title') }} />
        <Stack.Screen name="business/index" options={{ title: t('nav.business') }} />
        <Stack.Screen name="business/mileage" options={{ title: t('business.tab_mileage') }} />
        <Stack.Screen name="business/settings" options={{ title: t('mobile.business.settings') }} />
        <Stack.Screen name="notifications" options={{ title: t('notifications.title') }} />
        <Stack.Screen name="notification-settings" options={{ title: t('notifications.settings') }} />
        <Stack.Screen name="your-data" options={{ title: t('settings.tab.data') }} />
        <Stack.Screen name="rentals/index" options={{ title: t('nav.rentals') }} />
        <Stack.Screen name="rentals/log" options={{ title: t('rentals.record_payment') }} />
        <Stack.Screen name="payslips/index" options={{ title: t('nav.payslips') }} />
        <Stack.Screen name="payslips/capture" options={{ title: t('mobile.payslips.capture_title') }} />
        <Stack.Screen name="payslips/[id]" options={{ title: t('mobile.payslips.review_title') }} />
        <Stack.Screen name="review" options={{ title: t('mobile.tab.review') }} />
        <Stack.Screen name="goals" options={{ title: t('nav.goals') }} />
        <Stack.Screen name="cash-flow" options={{ title: t('nav.cash_flow') }} />
        <Stack.Screen name="explore" options={{ title: t('nav.explore') }} />
        <Stack.Screen name="month" options={{ title: t('nav.month') }} />
        <Stack.Screen name="calendar" options={{ title: t('nav.calendar') }} />
        <Stack.Screen name="suggestions" options={{ title: t('nav.suggestions') }} />
        <Stack.Screen name="activity" options={{ title: t('mobile.activity.title') }} />
        <Stack.Screen name="settings" options={{ title: t('mobile.settings.title') }} />
        <Stack.Screen name="developer/camera" options={{ title: t('mobile.spike.title') }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
  return signedIn ? <SyncProvider workspaceId={state.workspace.id}>{stack}</SyncProvider> : stack;
}

/**
 * Anything that fails while the app renders shows here, with what went wrong, instead of a blank screen. A release build
 * has no other way to say.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const th = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: th.space(4),
        gap: th.space(2),
        backgroundColor: th.bg,
      }}
      testID="app-error"
    >
      <Title>{t('mobile.error.title')}</Title>
      <Body muted>{error.message}</Body>
      <Button label={t('mobile.error.retry')} onPress={() => void retry()} />
    </View>
  );
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
