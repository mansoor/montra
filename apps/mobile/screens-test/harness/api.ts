/**
 * The API client at its module boundary: `createApi` (src/api/client.ts) returns this object. Every method is a
 * `jest.fn`; one a test hasn't given an answer never settles, as if the request were still on its way, so a screen
 * shows what it shows before the server answers and nothing throws.
 */
import type { Api } from '../../src/api/client';

const fns = new Map<string, jest.Mock>();

const method = (name: string): jest.Mock => {
  let fn = fns.get(name);
  if (!fn) {
    fn = jest.fn(() => new Promise<never>(() => undefined));
    fns.set(name, fn);
  }
  return fn;
};

export const api = new Proxy({} as Record<string, unknown>, {
  // `then` stays undefined so the object is never taken for a promise.
  get: (_target, name) => (typeof name === 'string' && name !== 'then' ? method(name) : undefined),
}) as unknown as jest.Mocked<Api>;

/** Forget every answer and call: run before each test. */
export function resetApi(): void {
  fns.clear();
}
