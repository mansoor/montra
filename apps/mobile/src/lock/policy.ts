/** App lock (PLT-07): when to ask for Face ID / fingerprint again. Pure; the screen lives in AppLock.tsx. */

export type LockTimeout = 'immediately' | '1m' | '5m' | '15m' | 'never';

export const LOCK_TIMEOUTS: readonly LockTimeout[] = ['immediately', '1m', '5m', '15m', 'never'];
export const DEFAULT_LOCK_TIMEOUT: LockTimeout = '5m';

const MS: Record<LockTimeout, number> = {
  immediately: 0,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  never: Number.POSITIVE_INFINITY,
};

export const timeoutMs = (t: LockTimeout): number => MS[t];

export function parseTimeout(value: string | null | undefined): LockTimeout {
  return (LOCK_TIMEOUTS as readonly string[]).includes(value ?? '') ? (value as LockTimeout) : DEFAULT_LOCK_TIMEOUT;
}

/**
 * Lock on cold start (when enabled) and when the app returns to the foreground after being inactive for longer
 * than the timeout. Background time counts as inactive.
 */
export function shouldLock(s: {
  enabled: boolean;
  coldStart: boolean;
  lastActiveAt: number | null;
  now: number;
  timeout: LockTimeout;
}): boolean {
  if (!s.enabled) return false;
  if (s.coldStart || s.lastActiveAt === null) return true;
  if (s.timeout === 'never') return false;
  return s.now - s.lastActiveAt >= timeoutMs(s.timeout);
}
