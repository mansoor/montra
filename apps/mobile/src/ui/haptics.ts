/**
 * Small physical confirmations: a light tap on presses, a tick on selections, a success pulse when something is saved.
 * Fire-and-forget: a phone without haptics, or with them turned off in system settings, simply feels nothing.
 */
import * as Haptics from 'expo-haptics';

const quietly = (p: Promise<void>) => void p.catch(() => undefined);

export const haptic = {
  tap: () => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  select: () => quietly(Haptics.selectionAsync()),
  success: () => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};
