import 'server-only';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ApiClient, ApiError } from '@montra/api-client';
import { API_URL, authHeaders, SESSION_COOKIE, stepUpHref } from './session';

/** API client for server components: talks to the API directly with the session's credentials. */
export async function serverApi(): Promise<ApiClient> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) redirect('/sign-in');
  return new ApiClient({ baseUrl: API_URL, headers: () => authHeaders(session) });
}

/**
 * Runs a server-side read. 401 signs out; 403 asking for MFA, re-authentication or a verified email sends the
 * user to the matching step (AUTH-03/04/09); other 403/404 show the 404 page (no existence leak).
 */
export async function load<T>(fn: (api: ApiClient) => Promise<T>): Promise<T> {
  const api = await serverApi();
  try {
    return await fn(api);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/sign-in');
    if (err instanceof ApiError && err.status === 403) {
      const path = (await headers()).get('x-montra-path') ?? '/';
      const step = stepUpHref(err.code, path);
      if (step) redirect(step);
    }
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) notFound();
    throw err;
  }
}
