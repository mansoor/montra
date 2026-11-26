import { describe, expect, it } from 'vitest';
import { makeConfig } from '../app.config';

type PluginEntry = string | [string, Record<string, unknown>];

function pluginOptions(env: Record<string, string>, name: string): Record<string, unknown> | undefined {
  const entry = (makeConfig(env).plugins as PluginEntry[]).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  if (entry === undefined) throw new Error(`no ${name} plugin`);
  return Array.isArray(entry) ? entry[1] : undefined;
}

const LAN = { MONTRA_API_URL: 'http://10.10.11.45:4040', MONTRA_WEB_URL: 'http://10.10.11.45:3030' };
const PROD = { MONTRA_API_URL: 'https://api.montra.app', MONTRA_AUTH_MODE: 'kratos' };

describe('app config: plain http only for a local-network build', () => {
  it('lets iOS and Android use http when the API is on http', () => {
    const plist = makeConfig(LAN).ios?.infoPlist ?? {};
    expect(plist.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true });
    expect(plist.NSLocalNetworkUsageDescription).toBeTypeOf('string');
    expect(pluginOptions(LAN, 'expo-build-properties')).toMatchObject({ android: { usesCleartextTraffic: true } });
  });

  it('leaves App Transport Security and Android cleartext alone for an https API', () => {
    const plist = makeConfig(PROD).ios?.infoPlist ?? {};
    expect(plist).not.toHaveProperty('NSAppTransportSecurity');
    expect(plist).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(pluginOptions(PROD, 'expo-build-properties')).toMatchObject({ android: { usesCleartextTraffic: false } });
  });

  it('bakes the addresses and sign-in mode into extra', () => {
    const kratos = { ...LAN, MONTRA_AUTH_MODE: 'kratos', MONTRA_KRATOS_URL: 'http://10.10.11.45:4455' };
    expect(makeConfig(kratos).extra).toMatchObject({
      apiUrl: LAN.MONTRA_API_URL,
      webUrl: LAN.MONTRA_WEB_URL,
      authMode: 'kratos',
      kratosUrl: 'http://10.10.11.45:4455',
    });
  });
});

describe('app config: iOS switches for a free Personal Team', () => {
  it('keeps the share extension, push and bundle id by default', () => {
    expect(pluginOptions(PROD, 'expo-share-intent')).toMatchObject({ disableIOS: false });
    expect(pluginOptions(PROD, 'expo-notifications')).toBeUndefined();
    expect(makeConfig(PROD).ios?.bundleIdentifier).toBe('app.montra.mobile');
  });

  it('drops them only when asked', () => {
    const personal = {
      ...LAN,
      MONTRA_IOS_SHARE_EXTENSION: 'off',
      MONTRA_IOS_PUSH: 'off',
      MONTRA_IOS_BUNDLE_ID: 'com.example.montra',
    };
    expect(pluginOptions(personal, 'expo-share-intent')).toMatchObject({ disableIOS: true });
    expect(pluginOptions(personal, 'expo-notifications')).toEqual({ enableRemoteNotifications: false });
    expect(makeConfig(personal).ios?.bundleIdentifier).toBe('com.example.montra');
    expect(makeConfig(personal).android?.package).toBe('app.montra.mobile');
  });
});
