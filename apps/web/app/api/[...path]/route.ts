/**
 * Backend-for-frontend proxy (docs/design/08 §2): the browser calls /api/v1/…, and this handler forwards to
 * the API with the session's credentials. The session cookie never reaches the API or browser scripts.
 */
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, authHeaders, SESSION_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'idempotency-key', 'if-match'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'etag', 'idempotent-replay', 'location', 'retry-after'];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  // Only the versioned API is reachable through the proxy.
  if (path[0] !== 'v1' || path.some((s) => s === '..' || s === '.')) {
    return NextResponse.json({ status: 404, code: 'not_found', title: 'Not found' }, { status: 404 });
  }
  // Phase 1b: Kratos session — forward the Kratos session token here instead of the dev bearer.
  const email = (await cookies()).get(SESSION_COOKIE)?.value;
  const headers: Record<string, string> = { ...authHeaders(email) };
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const target = `${API_URL}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return NextResponse.json(
      {
        type: 'about:blank',
        title: 'Bad gateway',
        status: 502,
        code: 'api_unreachable',
        detail: 'The API is unreachable',
      },
      { status: 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  const out = new Headers();
  for (const h of FORWARDED_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: out,
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
