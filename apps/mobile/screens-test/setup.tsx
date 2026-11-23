/**
 * Mocks for every screen test (jest.config.js `setupFilesAfterEnv`). jest-expo already mocks the Expo native modules
 * (expo-device, expo-notifications, expo-local-authentication and the rest); this adds what the screens need to run
 * off the phone:
 *
 * - expo-router: the hooks the screens call, with a router to assert navigation on (harness/router.ts);
 * - expo-secure-store: in memory, where the session keeps its token (harness/secure-store.ts);
 * - the API client at its module boundary: `createApi` returns `jest.fn`s (harness/api.ts);
 * - the sync layer: an in-memory store instead of SQLite, sockets and NetInfo (harness/sync.tsx);
 * - the build-time config: dev sign-in, no push project;
 * - Lucide's icons (decorative) and safe-area insets;
 * - Gesture Handler's swipeable row and the receipt zoom viewer (Reanimated worklets).
 */
import type { ReactNode } from 'react';
import { resetApi } from './harness/api';
import { resetRouter } from './harness/router';
import { resetSecureStore } from './harness/secure-store';
import { resetSync } from './harness/sync';

jest.mock(
  'expo-router',
  () => jest.requireActual<typeof import('./harness/router')>('./harness/router').expoRouterMock,
);
jest.mock('expo-secure-store', () => jest.requireActual('./harness/secure-store'));
jest.mock('../src/api/client', () => ({
  ...jest.requireActual<typeof import('../src/api/client')>('../src/api/client'),
  createApi: () => jest.requireActual<typeof import('./harness/api')>('./harness/api').api,
}));
jest.mock('../src/sync/SyncProvider', () => jest.requireActual('./harness/sync'));
jest.mock('../src/config', () => ({
  config: {
    apiUrl: 'http://api.test',
    kratosUrl: null,
    webUrl: 'http://web.test',
    authMode: 'dev',
    projectId: null,
    version: '1.0.0',
  },
}));
// The icons are decorative (the control around one carries the label), and loading Lucide's ~1,600 modules takes
// longer than the tests. Every icon draws nothing.
jest.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      { get: (_target, name) => (name === '__esModule' ? true : name === 'then' ? undefined : () => null) },
    ),
);
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual<{ default: object }>('react-native-safe-area-context/jest/mock').default,
);
// The two places that use Gesture Handler and Reanimated, whose worklets need the phone's UI thread: the transaction
// row's swipe actions keep their row, and the full-screen receipt zoom shows nothing.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../src/ui/ReceiptViewer', () => ({ ReceiptViewer: () => null }));

beforeEach(() => {
  resetApi();
  resetRouter();
  resetSecureStore();
  resetSync();
});

// A test that fakes the clock (toasts, list batching) hands the real one back, even when it fails.
afterEach(() => {
  jest.useRealTimers();
});
