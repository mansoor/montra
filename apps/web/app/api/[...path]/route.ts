/**
 * Backend-for-frontend proxy (docs/design/08 §2): the browser calls /api/v1/…, and this handler forwards to
 * the API with the session's credentials: the dev bearer, or only the `ory_kratos_session` cookie in kratos
 * mode (never the browser's other cookies). Session values are never readable by browser scripts.
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
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return problem(401, 'Unauthorized', 'unauthenticated', 'Sign in required');
  const headers: Record<string, string> = { ...authHeaders(session) };
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
      // Streamed through unchanged (multipart uploads are binary; nothing here parses bodies).
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      cache: 'no-store',
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit);
  } catch {
    return problem(502, 'Bad gateway', 'api_unreachable', 'The API is unreachable');
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

function problem(status: number, title: string, code: string, detail: string) {
  return NextResponse.json(
    { type: 'about:blank', title, status, code, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
