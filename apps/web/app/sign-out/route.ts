import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

/** POST-only sign-out (a GET link could be triggered cross-site). Phase 1b: Kratos session — also revoke it. */
export function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL('/sign-in', req.url), 303);
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
