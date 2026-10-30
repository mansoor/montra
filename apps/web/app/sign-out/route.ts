import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_MODE, DEV_COOKIE, KRATOS_PUBLIC_URL } from '@/lib/session';

/**
 * POST-only sign-out (a GET link could be triggered cross-site). In kratos mode we ask Kratos for a logout
 * URL (it carries a one-time token) and send the browser there; Kratos clears its session cookie.
 */
export async function POST(req: NextRequest) {
  if (AUTH_MODE === 'kratos') {
    try {
      const res = await fetch(`${KRATOS_PUBLIC_URL}/self-service/logout/browser`, {
        headers: { accept: 'application/json', cookie: req.headers.get('cookie') ?? '' },
        cache: 'no-store',
      });
      if (res.ok) {
        const { logout_url } = (await res.json()) as { logout_url?: string };
        if (logout_url && /^https?:\/\//.test(logout_url)) return NextResponse.redirect(logout_url, 303);
      }
    } catch {
      // fall through to the sign-in page; the session may already be gone
    }
    return NextResponse.redirect(new URL('/sign-in', req.url), 303);
  }
  const res = NextResponse.redirect(new URL('/sign-in', req.url), 303);
  res.cookies.set(DEV_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
