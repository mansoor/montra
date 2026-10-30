import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/session';

/**
 * Sends signed-out visitors to /sign-in (dev cookie, or the Kratos session cookie in kratos mode) and passes
 * the current path to server components so they can build step-up links (AUTH-04, AUTH-09).
 */
export function middleware(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    const headers = new Headers(req.headers);
    headers.set('x-montra-path', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.next({ request: { headers } });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/sign-in';
  url.search = req.nextUrl.pathname === '/' ? '' : `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Sign-in, sign-up and the Kratos self-service pages work without a session. The /api proxy checks the
  // session itself: middleware buffers request bodies (10 MB cap), which would truncate statement uploads.
  matcher: ['/((?!api/|sign-in|sign-up|auth/|_next/static|_next/image|favicon.ico).*)'],
};
