/**
 * The Add wheel (ADR-0048): the centre + opens a fan of what can be added, on an arc above the button: a transaction,
 * a receipt, a statement, a bill and a payslip. The + turns into a ×; tapping it, the dimmed screen or Android's back
 * closes the wheel. Choices the login can't use (AUTH-18) are left out, and the rest spread over the same arc.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, Text, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../i18n';
import { wheelLayout, type WheelChoice } from '../features/add-wheel';
import { haptic } from './haptics';
import { Icon } from './icons';
import { useTheme } from './theme';

/** Height of the tab bar above the safe area (react-navigation's default), and how far the + rises out of it. */
const TAB_BAR = 49;
const ADD_SIZE = 52;
const ITEM_SIZE = 56;

export function AddWheel({
  open,
  choices,
  onPick,
  onClose,
}: {
  open: boolean;
  choices: readonly WheelChoice[];
  onPick: (choice: WheelChoice) => void;
  onClose: () => void;
}) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!open) return;
    progress.setValue(0);
    Animated.spring(progress, { toValue: 1, useNativeDriver: true, friction: 7, tension: 70 }).start();
  }, [open, progress]);

  const close = (then?: () => void) => {
    Animated.timing(progress, {
      toValue: 0,
      duration: 140,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      onClose();
      then?.();
    });
  };

  // The + sits centred, half out of the top of the tab bar.
  const centre = { x: width / 2, y: insets.bottom + TAB_BAR / 2 + 9 };
  const radius = Math.min(132, width / 2 - ITEM_SIZE / 2 - 12);
  const spots = wheelLayout(choices.length, radius);
  const turn = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '135deg'] });

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={() => close()}
      statusBarTranslucent
    >
      <Pressable
        style={{ flex: 1 }}
        onPress={() => close()}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.add.close')}
      >
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: th.scrim,
            opacity: progress,
          }}
        />
      </Pressable>
      {choices.map((c, i) => {
        const spot = spots[i]!;
        const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, spot.x] });
        const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -spot.y] });
        const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
        return (
          <Animated.View
            key={c}
            style={{
              position: 'absolute',
              left: centre.x - ITEM_SIZE,
              bottom: centre.y - ITEM_SIZE / 2,
              width: ITEM_SIZE * 2,
              alignItems: 'center',
              opacity: progress,
              transform: [{ translateX }, { translateY }, { scale }],
            }}
          >
            <Pressable
              testID={`add-${c}`}
              accessibilityRole="button"
              accessibilityLabel={t(`mobile.add.${c}`)}
              onPress={() => {
                haptic.tap();
                close(() => onPick(c));
              }}
              style={({ pressed }) => ({
                width: ITEM_SIZE,
                height: ITEM_SIZE,
                borderRadius: ITEM_SIZE / 2,
                backgroundColor: th.surface,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: th.border,
                opacity: pressed ? 0.7 : 1,
                ...th.raised,
                elevation: 4,
              })}
            >
              <Icon name={WHEEL_ICONS[c]} size={24} color={th.primary} strokeWidth={2.2} />
            </Pressable>
            <Text
              style={{
                color: th.text,
                backgroundColor: th.surface,
                fontSize: th.font.small,
                fontWeight: '600',
                marginTop: 4,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 10,
                overflow: 'hidden',
              }}
              numberOfLines={1}
            >
              {t(`mobile.add.${c}`)}
            </Text>
          </Animated.View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('mobile.add.close')}
        testID="add-close"
        onPress={() => close()}
        style={{
          position: 'absolute',
          left: centre.x - ADD_SIZE / 2,
          bottom: centre.y - ADD_SIZE / 2,
          width: ADD_SIZE,
          height: ADD_SIZE,
          borderRadius: ADD_SIZE / 2,
          backgroundColor: th.primary,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 4,
          borderColor: th.bg,
          ...th.raised,
          elevation: 6,
        }}
      >
        <Animated.View style={{ transform: [{ rotate: turn }] }}>
          <Icon name="add" size={26} color={th.onPrimary} strokeWidth={2.6} />
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const WHEEL_ICONS = {
  transaction: 'transactions',
  receipt: 'receipt',
  statement: 'import',
  bill: 'bill',
  payslip: 'payslips',
} as const;
