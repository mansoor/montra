import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isValidEmail, SESSION_COOKIE } from '@/lib/session';

export const metadata: Metadata = { title: 'Sign in' };

/** Keeps post-sign-in redirects on this site. */
const safeNext = (next: unknown): string =>
  typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';

async function signIn(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const next = safeNext(formData.get('next'));
  if (!isValidEmail(email)) redirect(`/sign-in?error=email&next=${encodeURIComponent(next)}`);
  // Phase 1b: Kratos session — replace with the Kratos login flow.
  (await cookies()).set(SESSION_COOKIE, email, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  redirect(next);
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { error, next } = await searchParams;
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold">Sign in to Montra</h1>
      <p className="mb-6 text-sm text-muted">
        Development sign-in: enter any email. Production uses passwords, passkeys and MFA.
      </p>
      <form action={signIn} className="card space-y-4" noValidate>
        <input type="hidden" name="next" value={safeNext(next)} />
        <div>
          <label htmlFor="email" className="field-label">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="input"
            aria-invalid={error === 'email' ? 'true' : undefined}
            aria-describedby={error === 'email' ? 'email-error' : undefined}
          />
          {error === 'email' && (
            <p id="email-error" className="field-error">
              Enter a valid email address.
            </p>
          )}
        </div>
        <button type="submit" className="btn-primary w-full">
          Continue
        </button>
      </form>
    </main>
  );
}
