/** Small accessible building blocks shared by the screens (Dynamic Type friendly: no fixed heights on text). */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { sparkline, thin } from '../features/planning';
import { haptic } from './haptics';
import { Icon, type IconName } from './icons';
import { useTheme } from './theme';

export function Screen({
  children,
  scroll = true,
  testID,
}: {
  children: ReactNode;
  scroll?: boolean;
  testID?: string;
}) {
  const th = useTheme();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ padding: th.pad, gap: th.space(2) }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1, padding: th.pad, gap: th.space(2) }}>{children}</View>
  );
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: th.bg }}
      edges={['top', 'left', 'right']}
      testID={testID}
    >
      {body}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const th = useTheme();
  return (
    <Text accessibilityRole="header" style={{ color: th.text, fontSize: th.font.title, fontWeight: '700' }}>
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const th = useTheme();
  return (
    <Text style={[{ color: muted ? th.muted : th.text, fontSize: th.font.body }, style]}>{children}</Text>
  );
}

export function Small({ children, color }: { children: ReactNode; color?: string }) {
  const th = useTheme();
  return <Text style={{ color: color ?? th.muted, fontSize: th.font.small }}>{children}</Text>;
}

export function Card({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: ViewStyle;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: th.surface,
          borderRadius: th.radiusLg,
          padding: th.space(3),
          gap: th.space(2),
          ...th.raised,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  busy,
  testID,
  hint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  hint?: string;
}) {
  const th = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const bg = kind === 'primary' ? th.primary : kind === 'danger' ? th.danger : th.surfaceAlt;
  const fg = kind === 'secondary' ? th.text : th.onPrimary;
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
        disabled={disabled || busy}
        onPressIn={() => springTo(0.97)}
        onPressOut={() => springTo(1)}
        onPress={() => {
          haptic.tap();
          onPress();
        }}
        style={{
          backgroundColor: bg,
          opacity: disabled ? 0.45 : 1,
          borderRadius: th.radius,
          paddingVertical: th.space(2),
          paddingHorizontal: th.space(4),
          minHeight: th.tap,
          flexDirection: 'row',
          gap: th.space(2),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {busy ? (
          <ActivityIndicator color={fg} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={18} color={fg} /> : null}
            <Text style={{ color: fg, fontSize: th.font.body, fontWeight: '600' }}>{label}</Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

export function Field({
  label,
  icon,
  hideLabel,
  ...props
}: TextInputProps & {
  label: string;
  /** A leading icon inside the box, such as search. */
  icon?: IconName;
  /** For a box whose purpose is plain from its icon: the label becomes the placeholder (still read out). */
  hideLabel?: boolean;
}) {
  const th = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: th.space(1) }}>
      {hideLabel ? null : <Text style={{ color: th.muted, fontSize: th.font.small }}>{label}</Text>}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: th.space(2),
          backgroundColor: th.surfaceAlt,
          borderRadius: th.radius,
          borderWidth: 1.5,
          borderColor: focused ? th.primary : 'transparent',
          paddingHorizontal: th.space(3),
          minHeight: th.tap,
        }}
      >
        {icon ? <Icon name={icon} size={18} color={th.muted} /> : null}
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={th.muted}
          {...(hideLabel && !props.placeholder ? { placeholder: label } : {})}
          {...props}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
          style={[
            {
              flex: 1,
              color: th.text,
              paddingVertical: th.space(2),
              fontSize: th.font.body,
            },
            props.style,
          ]}
        />
      </View>
    </View>
  );
}

export function Row({
  title,
  subtitle,
  right,
  icon,
  last,
  onPress,
  testID,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  /** A leading icon in a tinted circle. */
  icon?: IconName;
  /** The last row of a group: no rule under it. */
  last?: boolean;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? [title, subtitle].filter(Boolean).join(', ')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space(3),
        paddingVertical: th.space(2),
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: th.border,
        opacity: pressed ? 0.6 : 1,
        minHeight: th.tap,
      })}
    >
      {icon ? <IconBadge name={icon} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: th.text, fontSize: th.font.body }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Small>{subtitle}</Small> : null}
      </View>
      {right}
      {onPress && !right ? <Icon name="next" size={18} color={th.muted} /> : null}
    </Pressable>
  );
}

/** An icon in a tinted circle: leads a row, or marks a section. */
export function IconBadge({
  name,
  tone = 'primary',
}: {
  name: IconName;
  tone?: 'primary' | 'warning' | 'danger';
}) {
  const th = useTheme();
  const [bg, fg] =
    tone === 'danger'
      ? [th.dangerSoft, th.danger]
      : tone === 'warning'
        ? [th.warningSoft, th.warning]
        : [th.primarySoft, th.primary];
  return (
    <View
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={name} size={18} color={fg} />
    </View>
  );
}

/** A quiet heading over a group of rows. */
export function SectionLabel({ children }: { children: string }) {
  const th = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: th.muted,
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        marginTop: th.space(3),
        marginBottom: th.space(1),
      }}
    >
      {children}
    </Text>
  );
}

export function Banner({
  text,
  tone = 'info',
  onPress,
}: {
  text: string;
  tone?: 'info' | 'warning' | 'danger';
  onPress?: () => void;
}) {
  const th = useTheme();
  const [bg, fg, icon]: [string, string, IconName] =
    tone === 'danger'
      ? [th.dangerSoft, th.danger, 'warning']
      : tone === 'warning'
        ? [th.warningSoft, th.warning, 'warning']
        : [th.primarySoft, th.primary, 'info'];
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLiveRegion="polite"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space(2),
        backgroundColor: bg,
        paddingVertical: th.space(2),
        paddingHorizontal: th.space(3),
        borderRadius: th.radius,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={18} color={fg} />
      <Text style={{ flex: 1, color: th.text, fontSize: th.font.small }}>{text}</Text>
      {onPress ? <Icon name="next" size={16} color={fg} /> : null}
    </Pressable>
  );
}

/** Merchant monogram (AI-07): no third-party logo fetches. */
/** A thin bar: spent against budget, with an optional marker for where you should be today (FLOW-04). */
export function ProgressBar({
  percent,
  marker,
  tone = 'primary',
  label,
}: {
  percent: number;
  marker?: number | null;
  tone?: 'primary' | 'danger' | 'warning' | 'success';
  label: string;
}) {
  const th = useTheme();
  const color = { primary: th.primary, danger: th.danger, warning: th.warning, success: th.success }[tone];
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.trunc(percent) }}
      style={{ height: 6, borderRadius: 3, backgroundColor: th.border, overflow: 'hidden' }}
    >
      <View style={{ height: 6, width: `${percent}%`, backgroundColor: color, borderRadius: 3 }} />
      {marker != null ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: 2,
            left: `${marker}%`,
            backgroundColor: th.text,
          }}
        />
      ) : null}
    </View>
  );
}

/** A small trend drawn with plain views (no chart dependency); screen readers get the label only. */
export function Sparkline({
  values,
  label,
  height = 48,
  color,
}: {
  values: readonly string[];
  label: string;
  height?: number;
  color?: string;
}) {
  const th = useTheme();
  const bars = sparkline(thin(values, 32));
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height }}
    >
      {bars.map((h, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: Math.max(2, h * height),
            borderRadius: 2,
            backgroundColor: color ?? th.primary,
            opacity: i === bars.length - 1 ? 1 : 0.55,
          }}
        />
      ))}
    </View>
  );
}

/** A row of mutually exclusive choices. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const th = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        backgroundColor: th.surfaceAlt,
        borderRadius: th.radius,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => {
              if (!on) haptic.select();
              onChange(o.value);
            }}
            style={{
              flex: 1,
              minHeight: 38,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: th.radius - 3,
              // Raised above the track: lighter than it in both themes.
              backgroundColor: on ? (th.dark ? th.border : th.surface) : 'transparent',
              ...(on ? th.raised : {}),
            }}
          >
            <Text style={{ color: on ? th.text : th.muted, fontWeight: '600', fontSize: th.font.small }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Monogram({ name }: { name: string }) {
  const th = useTheme();
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <View
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: th.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: th.primary, fontWeight: '700' }}>{letters || '·'}</Text>
    </View>
  );
}

/** A checkbox mark. The row around it carries the role and state for screen readers. */
export function Checkbox({ checked, mixed }: { checked: boolean; mixed?: boolean }) {
  const th = useTheme();
  const on = checked || mixed;
  return (
    <View
      importantForAccessibility="no"
      accessibilityElementsHidden
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: on ? th.primary : th.muted,
        backgroundColor: on ? th.primary : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {mixed ? (
        <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: th.onPrimary }} />
      ) : checked ? (
        <Icon name="check" size={15} color={th.onPrimary} strokeWidth={3} />
      ) : null}
    </View>
  );
}

/** A tappable row with a checkbox: one choice in a multi-select list. */
export function CheckRow({
  title,
  subtitle,
  checked,
  mixed,
  onPress,
  strong,
  testID,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  mixed?: boolean;
  onPress: () => void;
  /** A group heading that selects everything under it. */
  strong?: boolean;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: mixed ? 'mixed' : checked }}
      accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')}
      testID={testID}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space(3),
        minHeight: th.tap,
        paddingVertical: th.space(1),
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Checkbox checked={checked} mixed={mixed} />
      <View style={{ flex: 1 }}>
        <Text
          style={{ color: th.text, fontSize: th.font.body, fontWeight: strong ? '600' : '400' }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? <Small>{subtitle}</Small> : null}
      </View>
    </Pressable>
  );
}

/** A section that opens and closes, with a one-line summary of what's chosen inside it. */
export function Disclosure({
  title,
  summary,
  open,
  onToggle,
  children,
  testID,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderColor: th.border }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${summary}`}
        testID={testID}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: th.tap + 8,
          gap: th.space(2),
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: th.text, fontSize: th.font.body, fontWeight: '600' }}>{title}</Text>
          <Small color={summary ? th.primary : undefined}>{summary}</Small>
        </View>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="next" size={18} color={th.muted} />
        </View>
      </Pressable>
      {open ? <View style={{ paddingBottom: th.space(2) }}>{children}</View> : null}
    </View>
  );
}

/** A removable chip for an active filter. */
export function FilterChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={removeLabel}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space(1),
        paddingLeft: th.space(3),
        paddingRight: th.space(2),
        paddingVertical: th.space(1),
        borderRadius: 16,
        backgroundColor: th.primarySoft,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: th.text, fontSize: th.font.small, fontWeight: '500' }} numberOfLines={1}>
        {label}
      </Text>
      <Icon name="close" size={14} color={th.primary} strokeWidth={2.5} />
    </Pressable>
  );
}

// ----- Toasts --------------------------------------------------------------------------------------------

interface ToastCtx {
  show: (text: string) => void;
}
const ToastContext = createContext<ToastCtx>({ show: () => undefined });
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const th = useTheme();
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 3500);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {text ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={{
            position: 'absolute',
            left: th.space(4),
            right: th.space(4),
            bottom: th.space(24),
            backgroundColor: th.text,
            paddingVertical: th.space(3),
            paddingHorizontal: th.space(4),
            borderRadius: th.radiusLg,
          }}
        >
          <Text style={{ color: th.bg, fontSize: th.font.body }}>{text}</Text>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

/**
 * The moment something is saved: a check that springs in over the screen, holds, and fades, with a success pulse.
 * Shown while `label` is set; calls `onDone` when it has faded so the caller can clear it.
 */
export function SuccessBurst({ label, onDone }: { label: string | null; onDone: () => void }) {
  const th = useTheme();
  const scale = useRef(new Animated.Value(0.6)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!label) return;
    haptic.success();
    scale.setValue(0.6);
    opacity.setValue(0);
    const run = Animated.sequence([
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 10 }),
        Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }),
      ]),
      Animated.delay(650),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 220,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    run.start(({ finished }) => finished && onDone());
    return () => run.stop();
  }, [label]);
  if (!label) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
      accessibilityLabel={label}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        alignItems: 'center',
        justifyContent: 'center',
        opacity,
      }}
    >
      <Animated.View
        style={{
          alignItems: 'center',
          gap: th.space(3),
          paddingVertical: th.space(6),
          paddingHorizontal: th.space(8),
          borderRadius: th.radiusLg * 1.5,
          backgroundColor: th.surface,
          transform: [{ scale }],
          ...th.raised,
          elevation: 8,
        }}
      >
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: th.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="check" size={40} color={th.onPrimary} strokeWidth={3} />
        </View>
        <Text
          style={{
            color: th.text,
            fontSize: th.font.body,
            fontWeight: '600',
            maxWidth: 220,
            textAlign: 'center',
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}
