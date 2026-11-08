/**
 * What the app lock knows at launch (PLT-07). Reading it touches the OS (biometrics, the keystore), and a call that throws or
 * never answers used to leave the app on a blank screen. Now it's bounded, and a failure means the lock can't be used,
 * like a phone without biometrics, unless the user had turned it on. Then it stays locked and says why.
 */
import { parseTimeout, type LockTimeout } from './policy';

export interface LockProbe {
  hasHardware(): Promise<boolean>;
  isEnrolled(): Promise<boolean>;
  /** True when a passcode or biometrics is set, as `getEnrolledLevelAsync() !== NONE` reports it. */
  hasAnySecurity(): Promise<boolean>;
  read(key: string): Promise<string | null>;
}

export const ENABLED_KEY = 'montra.lock.enabled';
export const TIMEOUT_KEY = 'montra.lock.timeout';

export interface LockStartup {
  available: boolean;
  enabled: boolean;
  timeout: LockTimeout;
  /** Set when the OS couldn't be asked: shown on the lock screen when it stays locked. */
  error: string | null;
}

/** Rejects if the call hasn't answered within `ms`. */
export function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function lockStartup(probe: LockProbe, ms = 5000): Promise<LockStartup> {
  // Read the user's own choice first and on its own: if only the biometric check fails, it still counts.
  let stored: string | null = null;
  let storedRead = false;
  try {
    stored = await within(ms, probe.read(ENABLED_KEY));
    storedRead = true;
  } catch {
    // Unknown: treated below as not explicitly turned on.
  }
  try {
    const hasHardware = await within(ms, probe.hasHardware());
    const enrolled = hasHardware && (await within(ms, probe.isEnrolled()));
    const usable = enrolled || (await within(ms, probe.hasAnySecurity()));
    const timeout = parseTimeout(await within(ms, probe.read(TIMEOUT_KEY)));
    return { available: usable, enabled: stored !== 'false' && usable, timeout, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Turned on by the user: stay locked and say why. Otherwise the lock just isn't available on this phone.
    const explicitlyOn = storedRead && stored === 'true';
    return { available: false, enabled: explicitlyOn, timeout: '5m', error: explicitlyOn ? error : null };
  }
}
