import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { UiContainer, UiText } from './kratos-ui';
import { APP_URL, KRATOS_BROWSER_URL, KRATOS_PUBLIC_URL } from './session';

export type FlowKind = 'login' | 'registration' | 'recovery' | 'verification' | 'settings';

export interface Flow {
  id: string;
  ui: UiContainer;
  return_to?: string;
  state?: string;
  requested_aal?: string;
  refresh?: boolean;
}

export interface FlowError {
  id: string;
  error?: { code?: number; message?: string; reason?: string; status?: string };
}

/** Browser URL that starts a flow; Kratos sets its CSRF cookie and redirects back with `?flow=<id>`. */
export function flowInitUrl(kind: FlowKind, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const query = q.toString();
  return `${KRATOS_BROWSER_URL}/self-service/${kind}/browser${query ? `?${query}` : ''}`;
}

/** Only return_to URLs on this app are passed through (Kratos enforces its own allow-list as well). */
export function safeReturnTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, APP_URL);
    return url.origin === new URL(APP_URL).origin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function kratosGet(path: string): Promise<Response> {
  const cookie = (await headers()).get('cookie') ?? '';
  return fetch(`${KRATOS_PUBLIC_URL}${path}`, {
    headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
    cache: 'no-store',
    redirect: 'manual',
  });
}

/**
 * Fetches a self-service flow with the browser's cookies forwarded. Expired or foreign flows restart;
 * Kratos' own redirect instructions (e.g. "sign in first", "step up to AAL2") are followed.
 */
export async function fetchFlow(
  kind: FlowKind,
  id: string,
  restart: Record<string, string | undefined> = {},
): Promise<Flow> {
  let res: Response;
  try {
    res = await kratosGet(`/self-service/${kind}/flows?id=${encodeURIComponent(id)}`);
  } catch {
    redirect('/auth/error?reason=unavailable');
  }
  if (res.ok) return (await res.json()) as Flow;
  const body = (await res.json().catch(() => ({}))) as {
    redirect_browser_to?: string;
    error?: { id?: string };
  };
  if (typeof body.redirect_browser_to === 'string' && /^https?:\/\//.test(body.redirect_browser_to)) {
    redirect(body.redirect_browser_to);
  }
  if (res.status === 401) redirect('/sign-in');
  if (res.status === 403 || res.status === 404 || res.status === 410) redirect(flowInitUrl(kind, restart));
  redirect('/auth/error?reason=unavailable');
}

export async function fetchFlowError(id: string): Promise<FlowError | null> {
  try {
    const res = await kratosGet(`/self-service/errors?id=${encodeURIComponent(id)}`);
    return res.ok ? ((await res.json()) as FlowError) : null;
  } catch {
    return null;
  }
}

export const KRATOS_ORIGIN = KRATOS_BROWSER_URL;
export type { UiText };
