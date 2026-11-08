import { describe, expect, it } from 'vitest';
import { ENABLED_KEY, lockStartup, within, type LockProbe } from '../src/lock/startup';

const never = <T>() => new Promise<T>(() => undefined);
const probe = (over: Partial<LockProbe> = {}, store: Record<string, string> = {}): LockProbe => ({
  hasHardware: async () => true,
  isEnrolled: async () => true,
  hasAnySecurity: async () => true,
  read: async (k) => store[k] ?? null,
  ...over,
});

describe('lockStartup (PLT-07)', () => {
  it('locks by default on a phone with biometrics', async () => {
    expect(await lockStartup(probe())).toEqual({
      available: true,
      enabled: true,
      timeout: '5m',
      error: null,
    });
  });

  it('follows the user turning it off, and their timeout', async () => {
    expect(
      await lockStartup(probe({}, { [ENABLED_KEY]: 'false', 'montra.lock.timeout': 'immediately' })),
    ).toMatchObject({ enabled: false, timeout: 'immediately' });
  });

  it('isn’t available on a phone with no security at all', async () => {
    const r = await lockStartup(probe({ hasHardware: async () => false, hasAnySecurity: async () => false }));
    expect(r).toMatchObject({ available: false, enabled: false, error: null });
  });

  // The blank screen: a call that throws used to leave the app waiting forever.
  it('treats a failing check as no lock, rather than never starting', async () => {
    const r = await lockStartup(
      probe({
        isEnrolled: async () => {
          throw new Error('Keystore unavailable');
        },
      }),
    );
    expect(r).toEqual({ available: false, enabled: false, timeout: '5m', error: null });
  });

  it('gives up on a check that never answers', async () => {
    const r = await lockStartup(probe({ hasHardware: never }), 20);
    expect(r).toMatchObject({ available: false, enabled: false });
  });

  it('stays locked, and says why, when the user had turned the lock on', async () => {
    const r = await lockStartup(
      probe(
        {
          hasHardware: async () => {
            throw new Error('Biometrics unavailable');
          },
        },
        { [ENABLED_KEY]: 'true' },
      ),
    );
    expect(r).toEqual({ available: false, enabled: true, timeout: '5m', error: 'Biometrics unavailable' });
  });
});

describe('within', () => {
  it('passes an answer through, and refuses a late one', async () => {
    expect(await within(50, Promise.resolve(3))).toBe(3);
    await expect(within(10, never())).rejects.toThrow('No answer within 10 ms');
  });
});
