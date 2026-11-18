/**
 * The count of files to provide again (ADR-0054 §5a), for the Review badge on the tab bar and in More, as tax forms'
 * count: the sync feed's `reviewCount` counts transactions only, so the phone adds `GET missing-files`'s count as the
 * web's badge does. Read when sync runs, at most once a minute, and at once after an upload. Not for viewers.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../session/SessionProvider';
import { useSync } from '../sync/SyncProvider';
import { missingFilesFor, showsMissingFiles } from './missing-files';
import type { TaxFormsToCheck } from './tax-forms';
import type { TaxFormsCount } from './use-tax-forms';

const none = () => () => undefined;

export function useMissingFiles(): TaxFormsCount {
  const { state: session, api } = useSession();
  const { version } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const userId = session.status === 'signed_in' ? session.me.id : '';
  const on = ws !== null && showsMissingFiles(ws.role);
  const wsId = ws?.id ?? '';
  const counter: TaxFormsToCheck | null = useMemo(
    () => (on ? missingFilesFor(`${userId}:${wsId}`) : null),
    [on, userId, wsId],
  );
  const count = useSyncExternalStore(counter?.subscribe ?? none, () => counter?.get() ?? null);
  const read = useCallback(async () => (await api.listMissingFiles(wsId)).length, [api, wsId]);

  useEffect(() => {
    void counter?.refresh(read);
  }, [counter, read, version]);

  return {
    count: counter ? count : null,
    refresh: useCallback(async () => counter?.refresh(read, true), [counter, read]),
    set: useCallback((n: number) => counter?.set(n), [counter]),
  };
}
