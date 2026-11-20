/**
 * The count of bank feed imports waiting in Review (ADR-0055 §10), for the Review badge on the tab bar and in More, as
 * the web's badge adds them: read when sync runs, at most once a minute, and at once after one is imported. Not for
 * viewers.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../session/SessionProvider';
import { useSync } from '../sync/SyncProvider';
import { feedImportsFor, showsFeedImports } from './bank-feeds';
import type { TaxFormsToCheck } from './tax-forms';
import type { TaxFormsCount } from './use-tax-forms';

const none = () => () => undefined;

export function useFeedImports(): TaxFormsCount {
  const { state: session, api } = useSession();
  const { version } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const userId = session.status === 'signed_in' ? session.me.id : '';
  const on = ws !== null && showsFeedImports(ws.role);
  const wsId = ws?.id ?? '';
  const counter: TaxFormsToCheck | null = useMemo(
    () => (on ? feedImportsFor(`${userId}:${wsId}`) : null),
    [on, userId, wsId],
  );
  const count = useSyncExternalStore(counter?.subscribe ?? none, () => counter?.get() ?? null);
  const read = useCallback(async () => (await api.feedImportsWaiting(wsId)).length, [api, wsId]);

  useEffect(() => {
    void counter?.refresh(read);
  }, [counter, read, version]);

  return {
    count: counter ? count : null,
    refresh: useCallback(async () => counter?.refresh(read, true), [counter, read]),
    set: useCallback((n: number) => counter?.set(n), [counter]),
  };
}
