/**
 * One sync engine per signed-in workspace (PLT-05, ADR-0013): the encrypted store, `FetchTransport`, connectivity
 * from NetInfo, sync on foreground / pull-to-refresh / local writes / WebSocket `changes`, and conflict toasts.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { FetchTransport, SyncEngine, type SyncState, type SyncStore } from '@montra/sync';
import { config } from '../config';
import { t } from '../i18n';
import { useSession } from '../session/SessionProvider';
import { openDeviceStore } from '../store/expo-driver';
import { useToast } from '../ui/components';
import { unregisterPush } from '../push/register';
import { RealtimeClient, wsUrl } from './realtime';

interface SyncCtx {
  engine: SyncEngine;
  store: SyncStore;
  state: SyncState | null;
  /** Bumped after every local write or sync, so screens re-read the store. */
  version: number;
  refresh(): Promise<void>;
  touch(): void;
}

const Ctx = createContext<SyncCtx | null>(null);

export function useSync(): SyncCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSync outside SyncProvider');
  return v;
}

/** Re-runs `read` against the local store whenever sync state changes. */
export function useLocal<T>(read: (store: SyncStore) => Promise<T>, deps: unknown[] = []): T | undefined {
  const { store, version } = useSync();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    void read(store).then((v) => alive && setValue(v));
    return () => {
      alive = false;
    };
  }, [store, version, ...deps]);
  return value;
}

export function SyncProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const session = useSession();
  const toast = useToast();
  const [ctx, setCtx] = useState<{ engine: SyncEngine; store: SyncStore } | null>(null);
  const [state, setState] = useState<SyncState | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const engineRef = useRef<SyncEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    let realtime: RealtimeClient | null = null;
    const subs: Array<() => void> = [];
    void (async () => {
      const store = await openDeviceStore(workspaceId);
      const engine = new SyncEngine({
        store,
        transport: new FetchTransport({ baseUrl: config.apiUrl, workspaceId, token: session.token }),
        newId: () => Crypto.randomUUID(),
        onEvent: (e) => {
          if (e.type === 'state') setState(e.state);
          if (e.type === 'conflict') toast.show(t('mobile.home.attention', { count: e.notice.conflicts.length }));
          if (e.type === 'pulled' || e.type === 'pushed' || e.type === 'conflict') bump();
        },
      });
      if (cancelled) return;
      engineRef.current = engine;
      setCtx({ engine, store });
      setState(await engine.state());
      session.setSignOutHook(async () => {
        realtime?.stop();
        await unregisterPush(session.api);
        await engine.signOut();
      });

      const net = await NetInfo.fetch();
      engine.setOnline(Boolean(net.isConnected));
      const sync = () => void engine.sync().catch(() => undefined).finally(bump);
      if (!(await store.getMeta('latestSeq')) && net.isConnected)
        await engine.bootstrap().catch(() => undefined);
      bump();
      sync();

      subs.push(
        NetInfo.addEventListener((s) => {
          engine.setOnline(Boolean(s.isConnected));
          if (s.isConnected) sync();
        }),
      );
      const app = AppState.addEventListener('change', (s) => {
        if (s === 'active') {
          sync();
          realtime?.start();
        } else realtime?.stop();
      });
      subs.push(() => app.remove());
      realtime = new RealtimeClient({
        url: wsUrl(config.apiUrl),
        workspaceId,
        token: session.token,
        onChanges: sync,
      });
      realtime.start();
    })();
    return () => {
      cancelled = true;
      realtime?.stop();
      for (const s of subs) s();
      session.setSignOutHook(null);
    };
    // The engine is per workspace; session callbacks are stable.
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    await engineRef.current?.sync().catch(() => undefined);
    bump();
  }, [bump]);

  if (!ctx) return null;
  return (
    <Ctx.Provider value={{ ...ctx, state, version, refresh, touch: bump }}>{children}</Ctx.Provider>
  );
}
