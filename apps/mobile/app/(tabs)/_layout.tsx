/**
 * Tabs (08 §3): Home, Transactions, centre Add, Budget, More (the review count shows on More). The centre + opens the
 * Add wheel (ADR-0048) instead of a screen: a transaction, a receipt, a statement, a bill or a payslip.
 */
import { useState } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { t } from '../../src/i18n';
import { useAbilities } from '../../src/session/SessionProvider';
import { useSync } from '../../src/sync/SyncProvider';
import { wheelChoices, wheelRoute } from '../../src/features/add-wheel';
import { AddWheel } from '../../src/ui/AddWheel';
import { haptic } from '../../src/ui/haptics';
import { Icon, type IconName } from '../../src/ui/icons';
import { useTheme } from '../../src/ui/theme';

const icon = (name: IconName) =>
  function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
    // The tint colours set below are plain strings.
    return <Icon name={name} size={22} color={String(color)} strokeWidth={focused ? 2.4 : 1.8} />;
  };

/** The centre Add: a raised round button, the app's most frequent action. */
function AddIcon() {
  const th = useTheme();
  return (
    <View
      style={{
        width: 52,
        height: 52,
        borderRadius: 26,
        marginTop: -18,
        backgroundColor: th.primary,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 4,
        borderColor: th.bg,
        ...th.raised,
        elevation: 6,
      }}
    >
      <Icon name="add" size={26} color={th.onPrimary} strokeWidth={2.6} />
    </View>
  );
}

export default function TabsLayout() {
  const th = useTheme();
  const { state } = useSync();
  // A viewer, or a login with only read-only books, has nothing to add or review (AUTH-18).
  const can = useAbilities();
  const { record } = can;
  const review = record ? (state?.reviewCount ?? 0) : 0;
  const router = useRouter();
  const [wheel, setWheel] = useState(false);
  const choices = wheelChoices(can);
  return (
    <>
      <Tabs
        screenListeners={{ tabPress: () => haptic.select() }}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: th.primary,
          tabBarInactiveTintColor: th.muted,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          tabBarStyle: { backgroundColor: th.surface, borderTopColor: th.border },
        }}
      >
        <Tabs.Screen name="index" options={{ title: t('mobile.tab.home'), tabBarIcon: icon('home') }} />
        <Tabs.Screen
          name="transactions"
          options={{ title: t('mobile.tab.transactions'), tabBarIcon: icon('transactions') }}
        />
        <Tabs.Screen
          name="capture"
          options={{
            title: t('mobile.tab.capture'),
            tabBarIcon: AddIcon,
            tabBarLabel: () => null,
            tabBarAccessibilityLabel: t('mobile.add.open'),
            tabBarButtonTestID: 'tab-add',
            href: record ? undefined : null,
          }}
          listeners={{
            // The + opens the wheel; quick add is its first choice.
            tabPress: (e) => {
              e.preventDefault();
              setWheel(true);
            },
          }}
        />
        <Tabs.Screen name="budget" options={{ title: t('mobile.tab.budget'), tabBarIcon: icon('budget') }} />
        <Tabs.Screen
          name="more"
          options={{
            title: t('mobile.tab.more'),
            tabBarIcon: icon('more'),
            tabBarBadge: review > 0 ? (review > 99 ? '99+' : review) : undefined,
            tabBarBadgeStyle: {
              backgroundColor: th.danger,
              color: th.dark ? th.bg : th.surface,
              fontSize: 10,
            },
          }}
        />
      </Tabs>
      <AddWheel
        open={wheel}
        choices={choices}
        onClose={() => setWheel(false)}
        onPick={(c) => router.navigate(wheelRoute(c) as never)}
      />
    </>
  );
}
