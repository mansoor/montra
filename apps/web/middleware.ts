import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/session';

/** Sends signed-out visitors to /sign-in. Phase 1b: Kratos session — check the Kratos cookie instead. */
export function middleware(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        code: 'unauthenticated',
        detail: 'Sign in required',
      },
      { status: 401, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = '/sign-in';
  url.search = req.nextUrl.pathname === '/' ? '' : `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!sign-in|_next/static|_next/image|favicon.ico).*)'],
};
