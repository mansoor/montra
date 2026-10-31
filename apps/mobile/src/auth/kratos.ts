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
interface KratosFlow {
  id: string;
  ui?: { messages?: KratosUiMessage[]; nodes?: Array<{ messages?: KratosUiMessage[] }> };
}

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
    const res = await this.json<KratosFlow & { session_token?: string; session?: { authenticator_assurance_level?: string } }>(
      `/self-service/login?flow=${encodeURIComponent(flow.body.id)}`,
      { method: 'POST', body: JSON.stringify({ method: 'password', identifier, password }) },
    );
    if (res.status !== 200 || !res.body.session_token)
      return { kind: 'error', message: firstMessage(res.body, 'Email or password is incorrect') };
    const token = res.body.session_token;
    if (await this.needsSecondFactor(token)) {
      const aal2 = await this.json<KratosFlow>('/self-service/login/api?aal=aal2', {
        headers: { 'x-session-token': token },
      });
      return { kind: 'needs_totp', token, flowId: aal2.body.id };
    }
    return { kind: 'signed_in', token };
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
    if (res.status !== 200) return { kind: 'error', message: firstMessage(res.body, 'That code did not work') };
    return { kind: 'signed_in', token: res.body.session_token ?? token };
  }

  /** whoami says 403 session_aal2_required when the identity has a second factor the session lacks. */
  private async needsSecondFactor(token: string): Promise<boolean> {
    const res = await this.json<{ error?: { id?: string } }>('/sessions/whoami', {
      headers: { 'x-session-token': token },
    });
    return res.status === 403 && res.body.error?.id === 'session_aal2_required';
  }

  async logout(token: string): Promise<void> {
    await this.fetchImpl(`${this.publicUrl}/self-service/logout/api`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_token: token }),
    }).catch(() => undefined);
  }
}
