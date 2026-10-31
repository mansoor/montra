/**
 * Who is signed in and which workspace is open. The session token lives in SecureStore (Keychain/Keystore);
 * sign-out wipes the offline store and its key, removes the push token and ends the Kratos session (BAK-10).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import type { MeDto, WorkspaceDto } from '@montra/schemas';
import { config } from '../config';
import { createApi, type Api } from '../api/client';
import { KratosClient, devToken, type LoginResult } from '../auth/kratos';

const TOKEN_KEY = 'montra.session.v1';
const WORKSPACE_KEY = 'montra.workspace.v1';
const secure = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out'; error?: string }
  | { status: 'needs_totp'; token: string; flowId: string; error?: string }
  | { status: 'choose_workspace'; me: MeDto; workspaces: WorkspaceDto[] }
  | { status: 'signed_in'; me: MeDto; workspace: WorkspaceDto; workspaces: WorkspaceDto[] };

interface SessionApi {
  state: SessionState;
  api: Api;
  token: () => Promise<string | null>;
  signIn(email: string, password?: string): Promise<void>;
  submitTotp(code: string): Promise<void>;
  chooseWorkspace(id: string): Promise<void>;
  /** Registered by the sync layer: runs before the token is dropped (wipe store, unregister push). */
  setSignOutHook(fn: (() => Promise<void>) | null): void;
  signOut(): Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

/** Kept so the app opens offline on the last workspace (PLT-05). */
async function remember(me: MeDto, ws: WorkspaceDto): Promise<void> {
  await SecureStore.setItemAsync(WORKSPACE_KEY, ws.id, secure);
  await SecureStore.setItemAsync(`${WORKSPACE_KEY}.dto`, JSON.stringify(ws), secure);
  await SecureStore.setItemAsync(`${WORKSPACE_KEY}.me`, JSON.stringify(me), secure);
}

export function useSession(): SessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [hook, setHook] = useState<{ fn: (() => Promise<void>) | null }>({ fn: null });
  const token = useCallback(() => SecureStore.getItemAsync(TOKEN_KEY), []);
  const api = useMemo(() => createApi({ baseUrl: config.apiUrl, token }), [token]);
  const kratos = useMemo(() => (config.kratosUrl ? new KratosClient(config.kratosUrl) : null), []);

  const load = useCallback(async () => {
    try {
      if (!(await token())) return setState({ status: 'signed_out' });
      const [me, workspaces] = await Promise.all([api.me(), api.workspaces()]);
      const saved = await SecureStore.getItemAsync(WORKSPACE_KEY);
      const ws = workspaces.find((w) => w.id === saved) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
      if (ws) await remember(me, ws);
      setState(ws ? { status: 'signed_in', me, workspace: ws, workspaces } : { status: 'choose_workspace', me, workspaces });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        return setState({ status: 'signed_out' });
      }
      // Offline at launch: keep the last workspace so the offline store still opens.
      const saved = await SecureStore.getItemAsync(WORKSPACE_KEY);
      const cached = await SecureStore.getItemAsync(`${WORKSPACE_KEY}.dto`);
      if (saved && cached) {
        const ws = JSON.parse(cached) as WorkspaceDto;
        const me = JSON.parse((await SecureStore.getItemAsync(`${WORKSPACE_KEY}.me`)) ?? '{}') as MeDto;
        return setState({ status: 'signed_in', me, workspace: ws, workspaces: [ws] });
      }
      setState({ status: 'signed_out', error: err.message });
    }
  }, [api, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = useCallback(
    async (result: LoginResult) => {
      if (result.kind === 'error') return setState({ status: 'signed_out', error: result.message });
      if (result.kind === 'needs_totp')
        return setState({ status: 'needs_totp', token: result.token, flowId: result.flowId });
      await SecureStore.setItemAsync(TOKEN_KEY, result.token, secure);
      await load();
    },
    [load],
  );

  const value = useMemo<SessionApi>(
    () => ({
      state,
      api,
      token,
      async signIn(email, password) {
        if (config.authMode === 'dev' || !kratos) {
          try {
            return await finish({ kind: 'signed_in', token: devToken(email) });
          } catch (e) {
            return setState({ status: 'signed_out', error: (e as Error).message });
          }
        }
        await finish(await kratos.login(email.trim(), password ?? ''));
      },
      async submitTotp(code) {
        if (state.status !== 'needs_totp' || !kratos) return;
        const r = await kratos.totp(state.token, state.flowId, code);
        if (r.kind === 'error') return setState({ ...state, error: r.message });
        await finish(r);
      },
      async chooseWorkspace(id) {
        if (state.status !== 'choose_workspace' && state.status !== 'signed_in') return;
        const ws = state.workspaces.find((w) => w.id === id);
        if (!ws) return;
        await remember(state.me, ws);
        setState({ status: 'signed_in', me: state.me, workspace: ws, workspaces: state.workspaces });
      },
      setSignOutHook(fn) {
        setHook({ fn });
      },
      async signOut() {
        const t = await token();
        await hook.fn?.().catch(() => undefined);
        if (t && kratos && !t.startsWith('dev:')) await kratos.logout(t);
        for (const k of [TOKEN_KEY, WORKSPACE_KEY, `${WORKSPACE_KEY}.dto`, `${WORKSPACE_KEY}.me`])
          await SecureStore.deleteItemAsync(k);
        setState({ status: 'signed_out' });
      },
    }),
    [state, api, token, kratos, finish, hook],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
