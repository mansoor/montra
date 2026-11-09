/** A panel that slides in from the right over a dimmed screen: tap outside, the close button or Back to dismiss. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';

export function SidePanel({
  visible,
  title,
  closeLabel,
  onClose,
  headerAction,
  footer,
  children,
  testID,
}: {
  visible: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** A small action beside the title, such as "Clear all". */
  headerAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panel = Math.min(width * 0.88, 400);
  const x = useRef(new Animated.Value(panel)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      x.setValue(panel);
      Animated.timing(x, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      Animated.timing(x, {
        toValue: panel,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setMounted(false));
    }
    // Animates on open and close only.
  }, [visible]);

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: th.scrim,
            opacity: x.interpolate({ inputRange: [0, panel], outputRange: [1, 0] }),
          }}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          testID={testID}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            right: 0,
            width: panel,
            backgroundColor: th.bg,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            borderTopLeftRadius: th.radius * 1.6,
            borderBottomLeftRadius: th.radius * 1.6,
            transform: [{ translateX: x }],
            elevation: 12,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: th.pad,
              minHeight: th.tap + 12,
              gap: th.space(2),
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ flex: 1, color: th.text, fontSize: th.font.title, fontWeight: '700' }}
            >
              {title}
            </Text>
            {headerAction}
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              hitSlop={8}
              style={{ minWidth: th.tap, minHeight: th.tap, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: th.muted, fontSize: 24 }}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: th.pad, paddingBottom: th.space(4) }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={{ padding: th.pad }}>{footer}</View> : null}
        </Animated.View>
      </View>
    </Modal>
  );
}
