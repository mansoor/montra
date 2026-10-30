import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, wsToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Token for the realtime WebSocket's subscribe message (PLT-06). In dev mode it is `dev:<email>`, read from
 * the HttpOnly cookie; in kratos mode it is null because the socket authenticates with the session cookie.
 */
export async function GET() {
  const token = wsToken((await cookies()).get(SESSION_COOKIE)?.value);
  return NextResponse.json({ token }, { headers: { 'cache-control': 'no-store' } });
}
