/**
 * The count of tax forms to check (ADR-0052 §7.2), for the Review badge on the tab bar and in More. The sync feed's
 * `reviewCount` counts transactions only: a form's checks are worked out on read, which is too costly for every sync
 * pull, so the phone adds `GET tax-forms/review`'s count as the web's badge does. Read when sync runs, at most once a
 * minute, and at once after an action on a form. Only in US-dollar workspaces, not for viewers.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../session/SessionProvider';
import { useSync } from '../sync/SyncProvider';
import { showsTaxForms, taxFormsToCheckFor, type TaxFormsToCheck } from './tax-forms';

const none = () => () => undefined;

export interface TaxFormsCount {
  /** Forms to check, or null where tax forms aren't shown or the count hasn't loaded. */
  count: number | null;
  /** Reads the count again now: after confirming, accepting, matching or recording on a form. */
  refresh(): Promise<void>;
  /** Sets the count from a list read anyway (Review's). */
  set(count: number): void;
}

export function useTaxFormsToCheck(): TaxFormsCount {
  const { state: session, api } = useSession();
  const { version } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const userId = session.status === 'signed_in' ? session.me.id : '';
  const on = ws !== null && showsTaxForms(ws);
  const wsId = ws?.id ?? '';
  const counter: TaxFormsToCheck | null = useMemo(
    () => (on ? taxFormsToCheckFor(`${userId}:${wsId}`) : null),
    [on, userId, wsId],
  );
  const count = useSyncExternalStore(counter?.subscribe ?? none, () => counter?.get() ?? null);
  const read = useCallback(async () => (await api.taxFormsToCheck(wsId)).length, [api, wsId]);

  // Every sync (foreground, pull-to-refresh, realtime changes, local writes) may look again; the counter throttles.
  useEffect(() => {
    void counter?.refresh(read);
  }, [counter, read, version]);

  return {
    count: counter ? count : null,
    refresh: useCallback(async () => counter?.refresh(read, true), [counter, read]),
    set: useCallback((n: number) => counter?.set(n), [counter]),
  };
}
