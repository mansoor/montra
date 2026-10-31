/** Small accessible building blocks shared by the screens (Dynamic Type friendly: no fixed heights on text). */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
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
      contentContainerStyle={{ padding: th.space(4), gap: th.space(3) }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1, padding: th.space(4), gap: th.space(3) }}>{children}</View>
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
          borderRadius: th.radius,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: th.border,
          padding: th.space(4),
          gap: th.space(2),
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
  disabled,
  busy,
  testID,
  hint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  hint?: string;
}) {
  const th = useTheme();
  const bg = kind === 'primary' ? th.primary : kind === 'danger' ? th.danger : th.surface;
  const fg = kind === 'secondary' ? th.text : th.onPrimary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: bg,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        borderRadius: th.radius,
        borderWidth: kind === 'secondary' ? StyleSheet.hairlineWidth : 0,
        borderColor: th.border,
        paddingVertical: th.space(3),
        paddingHorizontal: th.space(4),
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: th.font.body, fontWeight: '600' }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space(1) }}>
      <Text style={{ color: th.muted, fontSize: th.font.small }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={th.muted}
        {...props}
        style={[
          {
            color: th.text,
            backgroundColor: th.surface,
            borderColor: th.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: th.radius,
            paddingHorizontal: th.space(3),
            paddingVertical: th.space(3),
            fontSize: th.font.body,
            minHeight: 48,
          },
          props.style,
        ]}
      />
    </View>
  );
}

export function Row({
  title,
  subtitle,
  right,
  onPress,
  testID,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
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
        paddingVertical: th.space(3),
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: th.border,
        opacity: pressed ? 0.7 : 1,
        minHeight: 48,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: th.text, fontSize: th.font.body }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Small>{subtitle}</Small> : null}
      </View>
      {right}
    </Pressable>
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
  const color = tone === 'danger' ? th.danger : tone === 'warning' ? th.warning : th.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLiveRegion="polite"
      style={{
        borderLeftWidth: 4,
        borderColor: color,
        backgroundColor: th.surface,
        padding: th.space(3),
        borderRadius: 6,
      }}
    >
      <Text style={{ color: th.text, fontSize: th.font.small }}>{text}</Text>
    </Pressable>
  );
}

/** Merchant monogram (AI-07): no third-party logo fetches. */
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
        backgroundColor: th.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: th.text, fontWeight: '700' }}>{letters || '·'}</Text>
    </View>
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
            padding: th.space(3),
            borderRadius: th.radius,
          }}
        >
          <Text style={{ color: th.bg, fontSize: th.font.body }}>{text}</Text>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}
