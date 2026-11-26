import type { ExpoConfig } from 'expo/config';

/**
 * Montra mobile (PLT-02, ADR-0009). Runtime settings come from the environment at build time and are read in
 * the app through `expo-constants` (src/config.ts):
 *   MONTRA_API_URL     API origin, e.g. https://api.montra.app (dev: http://10.0.2.2:4000 on the Android emulator)
 *   MONTRA_KRATOS_URL  The auth gateway in front of Ory Kratos (AUTH_MODE=kratos, ADR-0042)
 *   MONTRA_AUTH_MODE   'dev' | 'kratos'
 *   EAS_PROJECT_ID     EAS project (push tokens, updates); optional in development
 * iOS builds signed with a free Apple "Personal Team" (docs/runbooks/ios.md), which has no App Groups or push:
 *   MONTRA_IOS_SHARE_EXTENSION=off  leave out the share extension (expo-share-intent, needs an App Group)
 *   MONTRA_IOS_PUSH=off             leave out the push entitlement (expo-notifications remote notifications)
 *   MONTRA_IOS_BUNDLE_ID            another bundle identifier, when app.montra.mobile is taken by another team
 */
/** The app config for these build-time settings (`process.env` for the real build; tests pass their own). */
export function makeConfig(env: Record<string, string | undefined>): ExpoConfig {
  const projectId = env.EAS_PROJECT_ID;
  const apiUrl = env.MONTRA_API_URL ?? 'http://localhost:4000';
  // Plain http only when the API is (a computer on a local network: docs/runbooks/android-apk.md, docs/runbooks/ios.md).
  // An https build leaves Android's cleartext setting and iOS App Transport Security as they are.
  const plainHttp = apiUrl.startsWith('http://');
  const iosShareExtension = env.MONTRA_IOS_SHARE_EXTENSION !== 'off';
  const iosPush = env.MONTRA_IOS_PUSH !== 'off';

  return {
    name: 'Montra',
    slug: 'montra',
    scheme: 'montra',
    version: '0.5.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    runtimeVersion: { policy: 'appVersion' },
    ...(projectId
      ? { updates: { url: `https://u.expo.dev/${projectId}`, checkAutomatically: 'ON_LOAD' } }
      : {}),
    ios: {
      bundleIdentifier: env.MONTRA_IOS_BUNDLE_ID || 'app.montra.mobile',
      supportsTablet: true,
      infoPlist: {
        NSFaceIDUsageDescription: 'Montra uses Face ID to unlock your finances.',
        NSCameraUsageDescription: 'Montra uses the camera to scan receipts and paper statements.',
        ITSAppUsesNonExemptEncryption: false,
        // App Transport Security refuses plain http, and its local-networking exception doesn't cover an IP address.
        ...(plainHttp
          ? {
              NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
              NSLocalNetworkUsageDescription: 'Montra connects to the Montra server on your local network.',
            }
          : {}),
      },
      config: { usesNonExemptEncryption: false },
    },
    android: {
      package: 'app.montra.mobile',
      // RECORD_AUDIO is for "Say it" (TXN-07). It used to be blocked, from before voice entry, and Android then refused
      // the microphone without asking.
      permissions: [
        'android.permission.USE_BIOMETRIC',
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
      ],
    },
    plugins: [
      'expo-router',
      'expo-dev-client',
      'expo-secure-store',
      'expo-local-authentication',
      ['expo-sqlite', { useSQLCipher: true }],
      ['expo-camera', { cameraPermission: 'Montra uses the camera to scan receipts and paper statements.' }],
      // ADR-0047: the phone's document scanner (ML Kit on Android, VisionKit on iOS) for receipts.
      [
        'react-native-document-scanner-plugin',
        { cameraPermission: 'Montra uses the camera to scan receipts and paper statements.' },
      ],
      // A free Personal Team can't sign the push entitlement (MONTRA_IOS_PUSH=off).
      iosPush ? 'expo-notifications' : ['expo-notifications', { enableRemoteNotifications: false }],
      [
        'expo-speech-recognition',
        {
          microphonePermission: 'Montra uses the microphone when you speak a transaction.',
          speechRecognitionPermission: 'Montra turns what you say into text to fill in a transaction.',
        },
      ],
      [
        'expo-build-properties',
        // Minimum OS versions (PLT-02): iOS 17+, Android 11+ (API 30).
        // Expo SDK 58's iOS template already uses the UIScene life cycle that Xcode 27 requires, so no
        // `ios.enableSceneSupport` (that switch is for SDK 57 only).
        {
          ios: { deploymentTarget: '17.0' },
          android: { minSdkVersion: 30, usesCleartextTraffic: plainHttp },
        },
      ],
      [
        'expo-share-intent',
        {
          // The share extension needs an App Group, which a free Personal Team can't have (MONTRA_IOS_SHARE_EXTENSION=off).
          disableIOS: !iosShareExtension,
          iosActivationRules: { NSExtensionActivationSupportsFileWithMaxCount: 1 },
          androidIntentFilters: [
            'text/csv',
            'text/comma-separated-values',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/pdf',
            'application/qif',
            'application/x-qif',
            'application/x-ofx',
            'application/vnd.intu.qfx',
          ],
        },
      ],
    ],
    experiments: { typedRoutes: false },
    extra: {
      apiUrl,
      kratosUrl: env.MONTRA_KRATOS_URL ?? null,
      webUrl: env.MONTRA_WEB_URL ?? 'http://localhost:3000',
      authMode: env.MONTRA_AUTH_MODE ?? 'dev',
      minIos: '17.0',
      minAndroidSdk: 30,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
}

export default makeConfig(process.env);
