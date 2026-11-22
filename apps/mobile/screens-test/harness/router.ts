/** expo-router as the screens use it: the router (navigation is asserted on it), route params, focus effects. */
import { useEffect, type EffectCallback } from 'react';

export const router = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  navigate: jest.fn(),
  dismiss: jest.fn(),
  canGoBack: jest.fn(() => true),
  setParams: jest.fn(),
};

/** The open route's params (`useLocalSearchParams`); a test sets them before rendering. */
export const params: { current: Record<string, string> } = { current: {} };

export function resetRouter(): void {
  for (const fn of Object.values(router)) fn.mockClear();
  params.current = {};
}

export const expoRouterMock = {
  useRouter: () => router,
  useLocalSearchParams: () => params.current,
  useGlobalSearchParams: () => params.current,
  useSegments: () => [],
  usePathname: () => '/',
  // A screen in a test is always the focused one: run the effect as a mount effect.
  useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
  router,
};
