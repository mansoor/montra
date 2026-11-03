/**
 * Planning screens read through this: the last good answer comes from the encrypted local store right away, then
 * the API refreshes it. Offline the screen keeps showing the saved copy, marked as such, and writes are disabled.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSync } from '../sync/SyncProvider';
import { cacheKey } from './planning';

export interface Cached<T> {
  data: T | null;
  /** Showing the saved copy because the server couldn't be reached. */
  stale: boolean;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
  /** Replaces the data with a fresher answer (a write returned it). */
  set(next: T): void;
}

export function useCached<T>(
  workspaceId: string,
  name: string,
  fetcher: () => Promise<T>,
  enabled = true,
): Cached<T> {
  const { store, version } = useSync();
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const key = cacheKey(workspaceId, name);

  useEffect(() => {
    let alive = true;
    setData(null);
    void store.getMeta(key).then((raw) => {
      if (alive && raw) setData((cur) => cur ?? (JSON.parse(raw) as T));
    });
    return () => {
      alive = false;
    };
  }, [store, key]);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const fresh = await fetchRef.current();
      setData(fresh);
      setStale(false);
      setError(null);
      await store.setMeta(key, JSON.stringify(fresh));
    } catch (err) {
      const e = err as { offline?: boolean; message: string };
      if (e.offline) setStale(true);
      else setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [store, key, enabled]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload, version]),
  );

  const set = useCallback(
    (next: T) => {
      setData(next);
      setStale(false);
      void store.setMeta(key, JSON.stringify(next));
    },
    [store, key],
  );

  return { data, stale, error, loading, reload, set };
}
