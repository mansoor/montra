/**
 * src/sync/SyncProvider.tsx without the device: the offline store is @montra/sync's `MemoryStore` (the reference
 * semantics of the SQLite store), the engine's writes are `jest.fn`s, and nothing syncs. `useLocal` reads the store as
 * the real hook does.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { MemoryStore, type SyncEngine, type SyncStore } from '@montra/sync';

export let store = new MemoryStore();

export const engine = {
  acceptReview: jest.fn(async () => undefined),
  resolveReview: jest.fn(async () => undefined),
  updateTransaction: jest.fn(async () => undefined),
  deleteTransaction: jest.fn(async () => undefined),
  createTransaction: jest.fn(async () => undefined),
};

/** The receipt upload queue: empty. One object, as the provider's is, so screens' effects don't re-run. */
const receipts = { list: async () => [] };

export const refresh = jest.fn(async () => undefined);
export const touch = jest.fn();

/** A new, empty store and fresh engine calls: run before each test. */
export function resetSync(): void {
  store = new MemoryStore();
  for (const fn of Object.values(engine)) fn.mockClear();
  refresh.mockClear();
  touch.mockClear();
}

export function useSync() {
  return {
    engine: engine as unknown as SyncEngine,
    store: store as SyncStore,
    receipts: receipts as never,
    state: null,
    version: 0,
    refresh,
    touch,
  };
}

export function useLocal<T>(read: (s: SyncStore) => Promise<T>, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    void read(store).then((v) => alive && setValue(v));
    return () => {
      alive = false;
    };
  }, deps);
  return value;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
