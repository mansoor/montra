/** Tabs (08 §3): Home, Transactions, centre Add, Review, More. */
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { t } from '../../src/i18n';
import { useSync } from '../../src/sync/SyncProvider';
import { useTheme } from '../../src/ui/theme';

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return (
      <Text style={{ color, fontSize: 20 }} accessibilityElementsHidden importantForAccessibility="no">
        {glyph}
      </Text>
    );
  };

export default function TabsLayout() {
  const th = useTheme();
  const { state } = useSync();
  const review = state?.reviewCount ?? 0;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: th.primary,
        tabBarInactiveTintColor: th.muted,
        tabBarStyle: { backgroundColor: th.surface, borderTopColor: th.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('mobile.tab.home'), tabBarIcon: icon('⌂') }} />
      <Tabs.Screen name="transactions" options={{ title: t('mobile.tab.transactions'), tabBarIcon: icon('≡') }} />
      <Tabs.Screen
        name="capture"
        options={{ title: t('mobile.tab.capture'), tabBarIcon: icon('＋'), tabBarAccessibilityLabel: t('mobile.capture.title') }}
      />
      <Tabs.Screen
        name="review"
        options={{
          title: t('mobile.tab.review'),
          tabBarIcon: icon('✓'),
          tabBarBadge: review > 0 ? (review > 99 ? '99+' : review) : undefined,
        }}
      />
      <Tabs.Screen name="more" options={{ title: t('mobile.tab.more'), tabBarIcon: icon('…') }} />
    </Tabs>
  );
}
