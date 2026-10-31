import type { ExpoConfig } from 'expo/config';

/**
 * Montra mobile (PLT-02, ADR-0009). Runtime settings come from the environment at build time and are read in
 * the app through `expo-constants` (src/config.ts):
 *   MONTRA_API_URL     API origin, e.g. https://api.montra.app (dev: http://10.0.2.2:4000 on the Android emulator)
 *   MONTRA_KRATOS_URL  Ory Kratos public URL (AUTH_MODE=kratos)
 *   MONTRA_AUTH_MODE   'dev' | 'kratos'
 *   EAS_PROJECT_ID     EAS project (push tokens, updates); optional in development
 */
const projectId = process.env.EAS_PROJECT_ID;

const config: ExpoConfig = {
  name: 'Montra',
  slug: 'montra',
  scheme: 'montra',
  version: '0.5.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  runtimeVersion: { policy: 'appVersion' },
  ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}`, checkAutomatically: 'ON_LOAD' } } : {}),
  ios: {
    bundleIdentifier: 'app.montra.mobile',
    supportsTablet: true,
    infoPlist: {
      NSFaceIDUsageDescription: 'Montra uses Face ID to unlock your finances.',
      NSCameraUsageDescription: 'Montra uses the camera to scan receipts and paper statements.',
      ITSAppUsesNonExemptEncryption: false,
    },
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: 'app.montra.mobile',
    permissions: ['android.permission.USE_BIOMETRIC', 'android.permission.CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-local-authentication',
    ['expo-sqlite', { useSQLCipher: true }],
    ['expo-camera', { cameraPermission: 'Montra uses the camera to scan receipts and paper statements.' }],
    'expo-notifications',
    [
      'expo-build-properties',
      // Minimum OS versions (PLT-02): iOS 17+, Android 11+ (API 30).
      { ios: { deploymentTarget: '17.0' }, android: { minSdkVersion: 30 } },
    ],
    [
      'expo-share-intent',
      {
        iosActivationRules: { NSExtensionActivationSupportsFileWithMaxCount: 1 },
        androidIntentFilters: [
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/pdf',
        ],
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl: process.env.MONTRA_API_URL ?? 'http://localhost:4000',
    kratosUrl: process.env.MONTRA_KRATOS_URL ?? null,
    authMode: process.env.MONTRA_AUTH_MODE ?? 'dev',
    minIos: '17.0',
    minAndroidSdk: 30,
    ...(projectId ? { eas: { projectId } } : {}),
  },
};

export default config;
