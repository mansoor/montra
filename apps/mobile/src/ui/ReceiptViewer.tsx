/**
 * Full-screen receipt pages with pinch-to-zoom (RCP-14): pinch to zoom around the fingers, drag to move around a
 * zoomed page, double-tap to zoom in on a spot or back out. Pages change with the arrows; each page opens unzoomed.
 */
import { Image, Modal, Pressable, Text, View, type ImageURISource } from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clampOffset, clampZoom, MIN_ZOOM, offsetForZoom, TAP_ZOOM } from '../features/zoom';
import { t } from '../i18n';
import { Icon, type IconName } from './icons';
import { useTheme } from './theme';

export function ReceiptViewer({
  pages,
  page,
  onPage,
  onClose,
}: {
  pages: ImageURISource[];
  /** The page showing, or null when the viewer is closed. */
  page: number | null;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const showing = page !== null && pages[page] ? page : null;
  return (
    <Modal visible={showing !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A modal is its own window on Android, so it needs its own gesture root. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: th.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingTop: insets.top + th.space(2),
            paddingHorizontal: th.pad,
            paddingBottom: th.space(2),
            gap: th.space(2),
          }}
        >
          <Text style={{ flex: 1, color: th.muted, fontSize: th.font.small }}>
            {t('mobile.receipts.zoom_help')}
          </Text>
          <ViewerButton
            icon="close"
            label={t('mobile.receipts.zoom_close')}
            onPress={onClose}
            testID="viewer-close"
          />
        </View>
        {showing !== null ? <ZoomableImage key={showing} source={pages[showing]!} label={showing} /> : null}
        {pages.length > 1 && showing !== null ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: th.space(4),
              paddingTop: th.space(2),
              paddingBottom: insets.bottom + th.space(3),
            }}
          >
            <ViewerButton
              icon="back"
              label={t('mobile.receipts.zoom_previous')}
              disabled={showing === 0}
              onPress={() => onPage(showing - 1)}
            />
            <Text style={{ color: th.text, fontSize: th.font.body }}>
              {t('mobile.receipts.zoom_page', { n: showing + 1, total: pages.length })}
            </Text>
            <ViewerButton
              icon="next"
              label={t('mobile.receipts.zoom_next')}
              disabled={showing === pages.length - 1}
              onPress={() => onPage(showing + 1)}
            />
          </View>
        ) : (
          <View style={{ height: insets.bottom + th.space(3) }} />
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

function ViewerButton({
  icon,
  label,
  onPress,
  disabled,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      testID={testID}
      style={{
        width: th.tap,
        height: th.tap,
        borderRadius: th.tap / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: th.surfaceAlt,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon name={icon} size={22} color={th.text} />
    </Pressable>
  );
}

function ZoomableImage({ source, label }: { source: ImageURISource; label: number }) {
  const th = useTheme();
  // The view's size, and the zoom and offset now and when the current gesture began.
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(MIN_ZOOM);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const start = useSharedValue({ scale: MIN_ZOOM, x: 0, y: 0 });

  const remember = () => {
    'worklet';
    start.value = { scale: scale.value, x: x.value, y: y.value };
  };

  const pinch = usePinchGesture({
    onBegin: remember,
    onUpdate: (e) => {
      'worklet';
      const s = clampZoom(start.value.scale * e.scale);
      const fx = e.focalX - width.value / 2;
      const fy = e.focalY - height.value / 2;
      scale.value = s;
      x.value = clampOffset(offsetForZoom(fx, start.value.x, start.value.scale, s), width.value, s);
      y.value = clampOffset(offsetForZoom(fy, start.value.y, start.value.scale, s), height.value, s);
    },
  });

  // Moves by each step's change rather than from where the drag began, so it carries on smoothly when a pinch
  // (which sets the offset itself) starts or ends mid-drag.
  const pan = usePanGesture({
    onUpdate: (e) => {
      'worklet';
      x.value = clampOffset(x.value + e.changeX, width.value, scale.value);
      y.value = clampOffset(y.value + e.changeY, height.value, scale.value);
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (e) => {
      'worklet';
      const to = scale.value > MIN_ZOOM ? MIN_ZOOM : TAP_ZOOM;
      const fx = e.x - width.value / 2;
      const fy = e.y - height.value / 2;
      const nx =
        to === MIN_ZOOM ? 0 : clampOffset(offsetForZoom(fx, x.value, scale.value, to), width.value, to);
      const ny =
        to === MIN_ZOOM ? 0 : clampOffset(offsetForZoom(fy, y.value, scale.value, to), height.value, to);
      scale.value = withTiming(to);
      x.value = withTiming(nx);
      y.value = withTiming(ny);
    },
  });

  const gesture = useExclusiveGestures(doubleTap, useSimultaneousGestures(pinch, pan));

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={{ flex: 1, overflow: 'hidden' }}
        onLayout={(e) => {
          width.value = e.nativeEvent.layout.width;
          height.value = e.nativeEvent.layout.height;
        }}
        testID="viewer-page"
      >
        <Animated.View style={[{ flex: 1 }, style]}>
          <Image
            source={source}
            accessibilityLabel={t('mobile.receipts.page_n', { n: label + 1 })}
            resizeMode="contain"
            style={{ flex: 1, backgroundColor: th.surface }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
