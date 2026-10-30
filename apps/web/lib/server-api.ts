import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ApiClient, ApiError } from '@montra/api-client';
import { API_URL, authHeaders, SESSION_COOKIE } from './session';

/** API client for server components: talks to the API directly with the session's credentials. */
export async function serverApi(): Promise<ApiClient> {
  const email = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!email) redirect('/sign-in');
  return new ApiClient({ baseUrl: API_URL, headers: () => authHeaders(email) });
}

/** Runs a server-side read; signs out on 401 and shows the 404 page on 403/404 (no existence leak). */
export async function load<T>(fn: (api: ApiClient) => Promise<T>): Promise<T> {
  const api = await serverApi();
  try {
    return await fn(api);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/sign-in');
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) notFound();
    throw err;
  }
}
