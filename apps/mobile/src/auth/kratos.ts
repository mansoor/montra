/**
 * Sign-in for the mobile app (AUTH-01/02, ADR-0006). Ory Kratos native API flows return a session token instead of
 * a cookie; the token is sent as `Authorization: Bearer` (the API's Kratos adapter accepts it). Dev mode signs in
 * with `dev:<email>`, which the API accepts only with AUTH_MODE=dev. Pure over an injected fetch.
 */
export type AuthMode = 'dev' | 'kratos';

export type LoginResult =
  | { kind: 'signed_in'; token: string }
  | { kind: 'needs_totp'; token: string; flowId: string }
  | { kind: 'error'; message: string };

interface KratosUiMessage {
  id?: number;
  text: string;
  type?: string;
}
interface KratosNode {
  group?: string;
  attributes?: {
    name?: string;
    id?: string;
    src?: string;
    text?: { text?: string; context?: { secret?: string; secrets?: Array<{ text?: string }> } };
  };
  messages?: KratosUiMessage[];
}
interface KratosFlow {
  id: string;
  state?: string;
  ui?: { messages?: KratosUiMessage[]; nodes?: KratosNode[] };
  continue_with?: Array<{ action: string; ory_session_token?: string; flow?: { id: string } }>;
  error?: { id?: string; message?: string; reason?: string };
}

/** A step that worked, or why it didn't. `reauth`: the session is too old to change security settings. */
export type StepResult = { kind: 'ok' } | { kind: 'error'; message: string } | { kind: 'reauth' };
export type SignUpResult =
  | { kind: 'signed_up'; token: string; verificationFlowId: string | null }
  | { kind: 'error'; message: string };
export type SentResult = { kind: 'sent'; flowId: string } | { kind: 'error'; message: string };
/**
 * After a recovery code, `secondStepFlowId` is set when the account has a second factor: it must be entered (an
 * authenticator or recovery code) before a new password can be set (AUTH-05).
 */
export type RecoveryResult =
  | { kind: 'recovered'; token: string; settingsFlowId: string | null; secondStepFlowId: string | null }
  | { kind: 'error'; message: string };
export type TotpSetup =
  | { kind: 'setup'; flowId: string; secret: string; qr: string | null }
  | { kind: 'already_linked' }
  | { kind: 'error'; message: string }
  | { kind: 'reauth' };
export type RecoveryCodes =
  | { kind: 'codes'; flowId: string; codes: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'reauth' };
export interface TwoStepStatus {
  authenticator: boolean;
  recoveryCodes: boolean;
}

const nodeOf = (flow: KratosFlow | undefined, key: string) =>
  flow?.ui?.nodes?.find((n) => (n.attributes?.id ?? n.attributes?.name) === key);
const next = (flow: KratosFlow | undefined, action: string) =>
  flow?.continue_with?.find((c) => c.action === action);
/** Settings changes need a recent sign-in (10 minutes, AUTH-09); Kratos says so with this error. */
const needsReauth = (status: number, flow: KratosFlow) =>
  status === 403 && flow.error?.id === 'session_refresh_required';

export function devToken(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Enter a valid email address');
  return `dev:${e}`;
}

const firstMessage = (flow: KratosFlow | undefined, fallback: string): string =>
  flow?.ui?.messages?.find((m) => m.type === 'error')?.text ??
  flow?.ui?.nodes?.flatMap((n) => n.messages ?? []).find((m) => m.type === 'error')?.text ??
  fallback;

export class KratosClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly publicUrl: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  }

  private async json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`${this.publicUrl}${path}`, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  /** Password step of the native login flow. AAL2 accounts (owners, accountants) continue with TOTP. */
  async login(identifier: string, password: string): Promise<LoginResult> {
    const flow = await this.json<KratosFlow>('/self-service/login/api');
    if (flow.status !== 200) return { kind: 'error', message: 'Sign-in is unavailable right now' };
    const res = await this.json<
      KratosFlow & { session_token?: string; session?: { authenticator_assurance_level?: string } }
    >(`/self-service/login?flow=${encodeURIComponent(flow.body.id)}`, {
      method: 'POST',
      body: JSON.stringify({ method: 'password', identifier, password }),
    });
    if (res.status !== 200 || !res.body.session_token)
      return { kind: 'error', message: firstMessage(res.body, 'Email or password is incorrect') };
    const token = res.body.session_token;
    const flowId = await this.secondStep(token);
    return flowId ? { kind: 'needs_totp', token, flowId } : { kind: 'signed_in', token };
  }

  async totp(token: string, flowId: string, code: string): Promise<LoginResult> {
    const res = await this.json<KratosFlow & { session_token?: string }>(
      `/self-service/login?flow=${encodeURIComponent(flowId)}`,
      {
        method: 'POST',
        headers: { 'x-session-token': token },
        body: JSON.stringify({ method: 'totp', totp_code: code.replace(/\s/g, '') }),
      },
    );
    if (res.status !== 200)
      return { kind: 'error', message: firstMessage(res.body, 'That code did not work') };
    return { kind: 'signed_in', token: res.body.session_token ?? token };
  }

  /**
   * The second sign-in step, when the account has a second factor: an `aal=aal2` login flow offers an authenticator
   * code or a recovery code then, and nothing otherwise. (`whoami` can't say: it accepts a one-factor session.)
   */
  async secondStep(token: string): Promise<string | null> {
    const res = await this.json<KratosFlow>('/self-service/login/api?aal=aal2', {
      headers: { 'x-session-token': token },
    });
    if (res.status !== 200) return null;
    const offered = res.body.ui?.nodes?.some(
      (n) => n.attributes?.name === 'totp_code' || n.attributes?.name === 'lookup_secret',
    );
    return offered ? res.body.id : null;
  }

  /** Signs up with email, name and password (AUTH-01/02); Kratos emails a code to verify the address (AUTH-03). */
  async signUp(input: {
    email: string;
    first: string;
    last: string;
    password: string;
  }): Promise<SignUpResult> {
    const flow = await this.json<KratosFlow>('/self-service/registration/api');
    if (flow.status !== 200) return { kind: 'error', message: 'Sign-up is unavailable right now' };
    const res = await this.json<KratosFlow & { session_token?: string }>(
      `/self-service/registration?flow=${encodeURIComponent(flow.body.id)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          method: 'password',
          password: input.password,
          traits: { email: input.email.trim(), name: { first: input.first.trim(), last: input.last.trim() } },
        }),
      },
    );
    if (res.status !== 200 || !res.body.session_token)
      return {
        kind: 'error',
        message: firstMessage(res.body, 'That didn’t work. Check the details and try again'),
      };
    return {
      kind: 'signed_up',
      token: res.body.session_token,
      verificationFlowId: next(res.body, 'show_verification_ui')?.flow?.id ?? null,
    };
  }

  async verifyEmail(flowId: string, code: string): Promise<StepResult> {
    const res = await this.json<KratosFlow>(`/self-service/verification?flow=${encodeURIComponent(flowId)}`, {
      method: 'POST',
      body: JSON.stringify({ method: 'code', code: code.replace(/\s/g, '') }),
    });
    if (res.status === 200 && res.body.state === 'passed_challenge') return { kind: 'ok' };
    return { kind: 'error', message: firstMessage(res.body, 'That code didn’t work. Ask for a new one') };
  }

  /** A new verification code to this address. */
  sendVerification(email: string): Promise<SentResult> {
    return this.sendCode('verification', email);
  }

  /** Forgot password (AUTH-05): a single-use code to the address, the same answer whether or not it has an account. */
  startRecovery(email: string): Promise<SentResult> {
    return this.sendCode('recovery', email);
  }

  /** The emailed code signs in, for 10 minutes, to set a new password (and signs out every other device). */
  async finishRecovery(flowId: string, code: string): Promise<RecoveryResult> {
    const res = await this.json<KratosFlow>(`/self-service/recovery?flow=${encodeURIComponent(flowId)}`, {
      method: 'POST',
      body: JSON.stringify({ method: 'code', code: code.replace(/\s/g, '') }),
    });
    const token = next(res.body, 'set_ory_session_token')?.ory_session_token;
    if (res.status !== 200 || !token)
      return { kind: 'error', message: firstMessage(res.body, 'That code didn’t work. Ask for a new one') };
    const secondStepFlowId = await this.secondStep(token);
    return {
      kind: 'recovered',
      token,
      // A settings flow started before the second factor can't be used after it.
      settingsFlowId: secondStepFlowId ? null : (next(res.body, 'show_settings_ui')?.flow?.id ?? null),
      secondStepFlowId,
    };
  }

  async setPassword(token: string, password: string, flowId?: string | null): Promise<StepResult> {
    return this.settings(token, flowId ?? null, { method: 'password', password });
  }

  /** What two-step verification the account has, from its settings form. */
  async twoStepStatus(token: string): Promise<TwoStepStatus | null> {
    const flow = await this.settingsFlow(token);
    if (flow.status !== 200) return null;
    return {
      authenticator: Boolean(nodeOf(flow.body, 'totp_unlink')),
      recoveryCodes: Boolean(nodeOf(flow.body, 'lookup_secret_reveal')),
    };
  }

  /** The key (and QR code) for an authenticator app (AUTH-04). Confirmed with a code from the app. */
  async startAuthenticator(token: string): Promise<TotpSetup> {
    const flow = await this.settingsFlow(token);
    if (needsReauth(flow.status, flow.body)) return { kind: 'reauth' };
    if (flow.status !== 200)
      return { kind: 'error', message: firstMessage(flow.body, 'Settings are unavailable') };
    if (nodeOf(flow.body, 'totp_unlink')) return { kind: 'already_linked' };
    const secret = nodeOf(flow.body, 'totp_secret_key')?.attributes?.text?.context?.secret;
    if (!secret) return { kind: 'error', message: 'Authenticator apps aren’t available right now' };
    return {
      kind: 'setup',
      flowId: flow.body.id,
      secret,
      qr: nodeOf(flow.body, 'totp_qr')?.attributes?.src ?? null,
    };
  }

  confirmAuthenticator(token: string, flowId: string, code: string): Promise<StepResult> {
    return this.settings(token, flowId, { method: 'totp', totp_code: code.replace(/\s/g, '') });
  }

  /** New single-use recovery codes (AUTH-04/06). They replace any old ones once confirmed. */
  async newRecoveryCodes(token: string): Promise<RecoveryCodes> {
    const flow = await this.settingsFlow(token);
    if (needsReauth(flow.status, flow.body)) return { kind: 'reauth' };
    if (flow.status !== 200)
      return { kind: 'error', message: firstMessage(flow.body, 'Settings are unavailable') };
    const res = await this.json<KratosFlow>(
      `/self-service/settings?flow=${encodeURIComponent(flow.body.id)}`,
      {
        method: 'POST',
        headers: { 'x-session-token': token },
        body: JSON.stringify({ method: 'lookup_secret', lookup_secret_regenerate: true }),
      },
    );
    if (needsReauth(res.status, res.body)) return { kind: 'reauth' };
    const codes = (nodeOf(res.body, 'lookup_secret_codes')?.attributes?.text?.context?.secrets ?? [])
      .map((s) => s.text ?? '')
      .filter(Boolean);
    if (res.status !== 200 || codes.length === 0)
      return { kind: 'error', message: firstMessage(res.body, 'Recovery codes aren’t available right now') };
    return { kind: 'codes', flowId: res.body.id, codes };
  }

  confirmRecoveryCodes(token: string, flowId: string): Promise<StepResult> {
    return this.settings(token, flowId, { method: 'lookup_secret', lookup_secret_confirm: true });
  }

  /** The second sign-in step with a recovery code instead of the authenticator (AUTH-06). */
  async recoveryCode(token: string, flowId: string, code: string): Promise<LoginResult> {
    const res = await this.json<KratosFlow & { session_token?: string }>(
      `/self-service/login?flow=${encodeURIComponent(flowId)}`,
      {
        method: 'POST',
        headers: { 'x-session-token': token },
        body: JSON.stringify({ method: 'lookup_secret', lookup_secret: code.trim() }),
      },
    );
    if (res.status !== 200)
      return { kind: 'error', message: firstMessage(res.body, 'That code didn’t work') };
    return { kind: 'signed_in', token: res.body.session_token ?? token };
  }

  /** Proves the password again, so security settings can be changed (AUTH-09). The token stays the same. */
  async reauthenticate(token: string, identifier: string, password: string): Promise<StepResult> {
    const flow = await this.json<KratosFlow>('/self-service/login/api?refresh=true', {
      headers: { 'x-session-token': token },
    });
    if (flow.status !== 200) return { kind: 'error', message: 'Sign-in is unavailable right now' };
    const res = await this.json<KratosFlow>(`/self-service/login?flow=${encodeURIComponent(flow.body.id)}`, {
      method: 'POST',
      headers: { 'x-session-token': token },
      body: JSON.stringify({ method: 'password', identifier, password }),
    });
    return res.status === 200
      ? { kind: 'ok' }
      : { kind: 'error', message: firstMessage(res.body, 'Email or password is incorrect') };
  }

  private async sendCode(kind: 'verification' | 'recovery', email: string): Promise<SentResult> {
    const flow = await this.json<KratosFlow>(`/self-service/${kind}/api`);
    if (flow.status !== 200) return { kind: 'error', message: 'Email is unavailable right now' };
    const res = await this.json<KratosFlow>(
      `/self-service/${kind}?flow=${encodeURIComponent(flow.body.id)}`,
      {
        method: 'POST',
        body: JSON.stringify({ method: 'code', email: email.trim() }),
      },
    );
    if (res.status !== 200)
      return { kind: 'error', message: firstMessage(res.body, 'That didn’t work. Try again') };
    return { kind: 'sent', flowId: flow.body.id };
  }

  private settingsFlow(token: string) {
    return this.json<KratosFlow>('/self-service/settings/api', { headers: { 'x-session-token': token } });
  }

  private async settings(
    token: string,
    flowId: string | null,
    body: Record<string, unknown>,
  ): Promise<StepResult> {
    let id = flowId;
    if (!id) {
      const flow = await this.settingsFlow(token);
      if (needsReauth(flow.status, flow.body)) return { kind: 'reauth' };
      if (flow.status !== 200)
        return { kind: 'error', message: firstMessage(flow.body, 'Settings are unavailable') };
      id = flow.body.id;
    }
    const res = await this.json<KratosFlow>(`/self-service/settings?flow=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'x-session-token': token },
      body: JSON.stringify(body),
    });
    if (needsReauth(res.status, res.body)) return { kind: 'reauth' };
    if (res.status === 200 && res.body.state === 'success') return { kind: 'ok' };
    return { kind: 'error', message: firstMessage(res.body, 'That didn’t work. Try again') };
  }

  async logout(token: string): Promise<void> {
    await this.fetchImpl(`${this.publicUrl}/self-service/logout/api`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_token: token }),
    }).catch(() => undefined);
  }
}
