import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AUTH_MODE, DEV_COOKIE, isValidEmail } from '@/lib/session';
import { fetchFlow, flowInitUrl, KRATOS_ORIGIN, safeReturnTo } from '@/lib/kratos';
import { toRenderModel } from '@/lib/kratos-ui';
import { staticT as t } from '@/lib/i18n-static';
import { AuthShell } from '@/components/kratos/auth-shell';
import { FlowForm } from '@/components/kratos/flow-form';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

/** Keeps post-sign-in redirects on this site. */
const safeNext = (next: unknown): string =>
  typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';

async function devSignIn(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const next = safeNext(formData.get('next'));
  if (!isValidEmail(email)) redirect(`/sign-in?error=email&next=${encodeURIComponent(next)}`);
  (await cookies()).set(DEV_COOKIE, email, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  redirect(next);
}

type Params = Record<string, string | undefined>;

export default async function SignInPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return AUTH_MODE === 'kratos' ? <KratosSignIn params={params} /> : <DevSignIn params={params} />;
}

/** Kratos login flow (AUTH-01, AUTH-04): password, passkeys, social sign-in, and AAL2 step-up. */
async function KratosSignIn({ params }: { params: Params }) {
  const returnTo = safeReturnTo(params.return_to ?? (params.next ? safeNext(params.next) : undefined));
  const init = { aal: params.aal, refresh: params.refresh, return_to: returnTo };
  if (!params.flow) redirect(flowInitUrl('login', init));
  const flow = await fetchFlow('login', params.flow, init);
  const stepUp = flow.requested_aal === 'aal2';
  return (
    <AuthShell
      title={
        stepUp ? t('auth.step_up_title') : flow.refresh ? t('auth.reauth_title') : t('auth.sign_in_title')
      }
      intro={stepUp ? t('auth.step_up_intro') : flow.refresh ? t('auth.reauth_intro') : undefined}
    >
      <FlowForm
        model={toRenderModel(flow.ui, { kratosOrigin: KRATOS_ORIGIN })}
        label={t('auth.sign_in_title')}
      />
      {!stepUp && !flow.refresh && (
        <p className="flex justify-between text-sm">
          <Link href="/sign-up" className="text-brand-600 underline">
            {t('auth.create_account')}
          </Link>
          <Link href="/auth/recovery" className="text-brand-600 underline">
            {t('auth.forgot_password')}
          </Link>
        </p>
      )}
    </AuthShell>
  );
}

/** Development sign-in: any email, no password (refused in production by the API). */
function DevSignIn({ params }: { params: Params }) {
  const { error, next } = params;
  return (
    <AuthShell title={t('auth.sign_in_title')} intro={t('auth.dev_intro')}>
      <form action={devSignIn} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={safeNext(next)} />
        <div>
          <label htmlFor="email" className="field-label">
            {t('auth.email')}
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
              {t('auth.email_invalid')}
            </p>
          )}
        </div>
        <button type="submit" className="btn-primary w-full">
          {t('auth.continue')}
        </button>
      </form>
    </AuthShell>
  );
}
