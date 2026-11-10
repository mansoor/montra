/** Tabs (08 §3): Home, Transactions, centre Add, Budget, More (the review count shows on More). */
import { Tabs } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { t } from '../../src/i18n';
import { useSync } from '../../src/sync/SyncProvider';
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
  const review = state?.reviewCount ?? 0;
  return (
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
          tabBarAccessibilityLabel: t('mobile.capture.title'),
          tabBarButtonTestID: 'tab-add',
        }}
      />
      <Tabs.Screen name="budget" options={{ title: t('mobile.tab.budget'), tabBarIcon: icon('budget') }} />
      <Tabs.Screen
        name="more"
        options={{
          title: t('mobile.tab.more'),
          tabBarIcon: icon('more'),
          tabBarBadge: review > 0 ? (review > 99 ? '99+' : review) : undefined,
          tabBarBadgeStyle: { backgroundColor: th.danger, color: th.dark ? th.bg : th.surface, fontSize: 10 },
        }}
      />
    </Tabs>
  );
}
