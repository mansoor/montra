/**
 * Who is signed in and which workspace is open. The session token lives in SecureStore (Keychain/Keystore);
 * sign-out wipes the offline store and its key, removes the push token and ends the Kratos session (BAK-10).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import {
  photoUploadSettings,
  type MeDto,
  type PhotoUploadSettings,
  type WorkspaceDto,
} from '@montra/schemas';
import { AppState, Platform } from 'react-native';
import { config } from '../config';
import { createApi, type Api } from '../api/client';
import { nativeUpload } from '../api/file-upload';
import { KratosClient, devToken, type LoginResult } from '../auth/kratos';
import { abilitiesOf, NO_ABILITIES, type Abilities } from '../features/roles';
import { closedFrom, closedOf, strongerClosed, type Closed } from '../features/account-state';
import { checksVersion, refused, updateNeeded, type UpdateNeeded } from '../features/app-update';

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
  /** The second sign-in step with a recovery code instead of the authenticator (AUTH-06). */
  submitRecoveryCode(code: string): Promise<void>;
  /** Signs in with a token from sign-up or a password reset (AUTH-01, AUTH-05). */
  adopt(token: string): Promise<void>;
  /** Kratos, for sign-up, recovery and two-step settings; null in development sign-in. */
  kratos: KratosClient | null;
  chooseWorkspace(id: string): Promise<void>;
  /** Reads you and your workspaces again, staying in this one: after a change in Settings (a name, new books). */
  refresh(): Promise<void>;
  /** Registered by the sync layer: runs before the token is dropped (wipe store, unregister push). */
  setSignOutHook(fn: (() => Promise<void>) | null): void;
  signOut(): Promise<void>;
  /** The server says this version is too old (OPS-04). */
  updateRequired: boolean;
  /** Then: the oldest version it serves (when known) and where to get a newer app. */
  update: UpdateNeeded | null;
  /** The open workspace needs two-step verification this session hasn't used (ADR-0044). */
  twoStepRequired: boolean;
  /** After the second factor: reload the workspace with the stronger session. */
  clearTwoStepRequired(): void;
  /**
   * ADR-0049 §4, BAK-09: the server refused the account (suspended, being deleted) or the open workspace (its owner is
   * suspended). Nothing else is shown, and nothing is sent, until the person tries again, switches or signs out.
   */
  closed: Closed | null;
  /** From the API client or the sync engine: a refusal in `CLOSED_CODES`. */
  reportClosed(code: string, message: string): void;
  /** Ask again: the refusal may have been lifted (restored by support, or the deletion cancelled). */
  reopen(): Promise<void>;
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

/** BAK-08: how photos are compressed before upload, and whether this person keeps originals (works offline). */
export function usePhotoSettings(): PhotoUploadSettings {
  const { state } = useSession();
  const me = state.status === 'signed_in' ? state.me : null;
  return useMemo(() => photoUploadSettings(me), [me]);
}

/** What the signed-in login may change in the open workspace (AUTH-18); nothing until signed in. */
export function useAbilities(): Abilities {
  const { state } = useSession();
  const workspace = state.status === 'signed_in' ? state.workspace : null;
  return useMemo(() => (workspace ? abilitiesOf(workspace) : NO_ABILITIES), [workspace]);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [hook, setHook] = useState<{ fn: (() => Promise<void>) | null }>({ fn: null });
  const token = useCallback(() => SecureStore.getItemAsync(TOKEN_KEY), []);
  const [update, setUpdate] = useState<UpdateNeeded | null>(null);
  const [twoStepRequired, setTwoStepRequired] = useState(false);
  const [closed, setClosed] = useState<Closed | null>(null);
  // Signing out after asking for deletion: the last calls on the way out are refused, and that's expected.
  const signingOut = useRef(false);
  const reportClosed = useCallback((code: string, message: string) => {
    const next = closedOf(code, message);
    if (signingOut.current) return;
    if (next) setClosed((current) => strongerClosed(current, next));
  }, []);
  const api = useMemo(
    () =>
      createApi({
        baseUrl: config.apiUrl,
        token,
        app: { version: config.version, platform: Platform.OS },
        uploadFile: nativeUpload,
        onUpdateRequired: () => {
          setUpdate(refused);
          setRecheck((n) => n + 1);
        },
        onTwoStepRequired: () => setTwoStepRequired(true),
        onClosed: reportClosed,
      }),
    [token, reportClosed],
  );
  const kratos = useMemo(() => (config.kratosUrl ? new KratosClient(config.kratosUrl) : null), []);

  // OPS-04: is this app new enough for the server? Asked before anyone signs in, again on coming back to the app (the
  // server may have been upgraded meanwhile), and after a 426. A failed check changes nothing.
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    const os = Platform.OS;
    if (!checksVersion(os)) return;
    const check = () =>
      api
        .appRequirements(os)
        .then((req) =>
          setUpdate((current) => updateNeeded(config.version, req) ?? (current?.minVersion ? null : current)),
        )
        .catch(() => undefined);
    void check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });
    return () => sub.remove();
  }, [api, recheck]);

  const load = useCallback(async () => {
    try {
      if (!(await token())) return setState({ status: 'signed_out' });
      const [me, workspaces] = await Promise.all([api.me(), api.workspaces()]);
      const saved = await SecureStore.getItemAsync(WORKSPACE_KEY);
      const ws =
        workspaces.find((w) => w.id === saved) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
      if (ws) await remember(me, ws);
      setState(
        ws
          ? { status: 'signed_in', me, workspace: ws, workspaces }
          : { status: 'choose_workspace', me, workspaces },
      );
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        return setState({ status: 'signed_out' });
      }
      // Refused (the client has reported it): the closed screen shows. The last workspace is kept only so that
      // signing out from there still wipes its offline copy; nothing is synced while closed.
      const refused = closedFrom(e) !== null;
      // Offline at launch: keep the last workspace so the offline store still opens.
      const saved = await SecureStore.getItemAsync(WORKSPACE_KEY);
      const cached = await SecureStore.getItemAsync(`${WORKSPACE_KEY}.dto`);
      if (saved && cached) {
        const ws = JSON.parse(cached) as WorkspaceDto;
        const me = JSON.parse((await SecureStore.getItemAsync(`${WORKSPACE_KEY}.me`)) ?? '{}') as MeDto;
        return setState({ status: 'signed_in', me, workspace: ws, workspaces: [ws] });
      }
      setState({ status: 'signed_out', error: refused ? undefined : err.message });
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
      updateRequired: update !== null,
      update,
      twoStepRequired,
      clearTwoStepRequired: () => {
        setTwoStepRequired(false);
        void load();
      },
      closed,
      reportClosed,
      async reopen() {
        setClosed(null);
        await load();
      },
      api,
      token,
      kratos,
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
      async submitRecoveryCode(code) {
        if (state.status !== 'needs_totp' || !kratos) return;
        const r = await kratos.recoveryCode(state.token, state.flowId, code);
        if (r.kind === 'error') return setState({ ...state, error: r.message });
        await finish(r);
      },
      async adopt(t) {
        await finish({ kind: 'signed_in', token: t });
      },
      async chooseWorkspace(id) {
        if (state.status !== 'choose_workspace' && state.status !== 'signed_in') return;
        const ws = state.workspaces.find((w) => w.id === id);
        if (!ws) return;
        // Another workspace may open when only this one is closed; a closed account stays closed.
        if (closed?.kind === 'workspace') setClosed(null);
        await remember(state.me, ws);
        setState({ status: 'signed_in', me: state.me, workspace: ws, workspaces: state.workspaces });
      },
      async refresh() {
        if (state.status !== 'signed_in') return;
        const id = state.workspace.id;
        // Offline or refused: keep what's shown; the next launch reads it again.
        const fresh = await Promise.all([api.me(), api.workspaces()]).catch(() => null);
        const ws = fresh?.[1].find((w) => w.id === id);
        if (!fresh || !ws) return;
        await remember(fresh[0], ws);
        setState((s) =>
          s.status === 'signed_in' && s.workspace.id === id
            ? { status: 'signed_in', me: fresh[0], workspace: ws, workspaces: fresh[1] }
            : s,
        );
      },
      setSignOutHook(fn) {
        setHook({ fn });
      },
      async signOut() {
        signingOut.current = true;
        try {
          const t = await token();
          await hook.fn?.().catch(() => undefined);
          if (t && kratos && !t.startsWith('dev:')) await kratos.logout(t);
          for (const k of [TOKEN_KEY, WORKSPACE_KEY, `${WORKSPACE_KEY}.dto`, `${WORKSPACE_KEY}.me`])
            await SecureStore.deleteItemAsync(k);
          setClosed(null);
          setState({ status: 'signed_out' });
        } finally {
          signingOut.current = false;
        }
      },
    }),
    [update, twoStepRequired, closed, reportClosed, state, api, token, kratos, finish, hook, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
