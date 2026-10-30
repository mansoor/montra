import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/session';
import { AcceptInvite } from '@/components/accept-invite';

export const metadata: Metadata = { title: 'Accept invite' };
export const dynamic = 'force-dynamic';

/** Invite acceptance (AUTH-10). Signed-out visitors are sent to /sign-in and returned here by middleware. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const email = (await cookies()).get(SESSION_COOKIE)?.value ?? '';
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-2 text-2xl font-semibold">You’ve been invited</h1>
      <p className="mb-6 text-sm text-muted">
        Accept to join the workspace as <strong>{email}</strong>. The invite must have been sent to this
        address.
      </p>
      <AcceptInvite token={token} />
    </main>
  );
}
