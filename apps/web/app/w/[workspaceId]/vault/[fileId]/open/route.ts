import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, authHeaders, SESSION_COOKIE } from '@/lib/session';
import { isPersonOpening, vaultOpenOutcome, vaultOpenProblemHref, type VaultOpenMode } from '@/lib/vault';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADR-0054 §9 "Open in the vault". A person's click lands here; the API makes a single-use link for it and answers with
 * a redirect, which this sends straight on to the browser. The link isn't read, stored, logged, cached or rendered into
 * a page: it passes through in one `Location` header. A prefetch, or a request from another site, makes no link.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ workspaceId: string; fileId: string }> },
): Promise<Response> {
  const { workspaceId, fileId } = await ctx.params;
  if (!UUID.test(workspaceId) || !UUID.test(fileId)) return new NextResponse(null, { status: 404 });
  if (!isPersonOpening(req.headers)) return new NextResponse(null, { status: 204, headers: NO_STORE });
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session)
    return NextResponse.redirect(new URL('/sign-in', req.url), { status: 303, headers: NO_STORE });
  const mode: VaultOpenMode = req.nextUrl.searchParams.get('mode') === 'download' ? 'download' : 'view';

  let answer: { status: number; location: string | null; retryAfter: string | null; code: string | null };
  try {
    const res = await fetch(
      `${API_URL}/v1/workspaces/${workspaceId}/family-vault/files/${fileId}/open?mode=${mode}`,
      {
        method: 'POST',
        headers: { ...authHeaders(session), accept: 'application/json' },
        cache: 'no-store',
        redirect: 'manual',
      },
    );
    let code: string | null = null;
    if (res.status !== 303)
      code = ((await res.json().catch(() => null)) as { code?: string } | null)?.code ?? null;
    answer = {
      status: res.status,
      location: res.headers.get('location'),
      retryAfter: res.headers.get('retry-after'),
      code,
    };
  } catch {
    answer = { status: 502, location: null, retryAfter: null, code: null };
  }
  if (answer.status === 401)
    return NextResponse.redirect(new URL('/sign-in', req.url), { status: 303, headers: NO_STORE });
  const outcome = vaultOpenOutcome(answer);
  if ('go' in outcome) return NextResponse.redirect(outcome.go, { status: 303, headers: NO_STORE });
  return NextResponse.redirect(
    new URL(vaultOpenProblemHref(workspaceId, fileId, outcome.problem, outcome.minutes), req.url),
    { status: 303, headers: NO_STORE },
  );
}

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
