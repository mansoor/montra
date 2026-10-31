/**
 * Push registration (NOT-01 transport, ADR-0013 §5): Expo push token → `POST /v1/me/push-devices`; removed on
 * sign-out. Without an EAS project id (local development) registration is skipped.
 */
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import type { Api } from '../api/client';
import { config } from '../config';

const PUSH_KEY = 'montra.push.token';

export type PushStatus = 'registered' | 'denied' | 'unavailable';

export async function registerForPush(api: Api, ask: boolean): Promise<PushStatus> {
  if (!Device.isDevice || !config.projectId || (Platform.OS !== 'ios' && Platform.OS !== 'android'))
    return 'unavailable';
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'denied';
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Montra',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: config.projectId });
  await api.registerPushDevice({
    token,
    platform: Platform.OS,
    deviceName: Device.deviceName ?? undefined,
    appVersion: config.version,
  });
  await SecureStore.setItemAsync(PUSH_KEY, token);
  return 'registered';
}

export async function unregisterPush(api: Api): Promise<void> {
  const token = await SecureStore.getItemAsync(PUSH_KEY);
  if (!token) return;
  await api.removePushDevice(token).catch(() => undefined);
  await SecureStore.deleteItemAsync(PUSH_KEY);
}
