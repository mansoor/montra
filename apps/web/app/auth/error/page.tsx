import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchFlowError } from '@/lib/kratos';
import { AUTH_MODE } from '@/lib/session';
import { staticT as t } from '@/lib/i18n-static';
import { AuthShell } from '@/components/kratos/auth-shell';

export const metadata: Metadata = { title: 'Sign-in problem' };
export const dynamic = 'force-dynamic';

/** Kratos error page; the message comes from Kratos and is rendered as text only. */
export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, reason } = await searchParams;
  const error = AUTH_MODE === 'kratos' && id ? await fetchFlowError(id) : null;
  const detail =
    reason === 'unavailable'
      ? t('auth.unavailable')
      : (error?.error?.reason ?? error?.error?.message ?? t('auth.error_generic'));
  return (
    <AuthShell title={t('auth.error_title')}>
      <p role="alert" className="text-sm">
        {detail}
      </p>
      <Link href="/sign-in" className="btn-primary">
        {t('auth.back_to_sign_in')}
      </Link>
    </AuthShell>
  );
}
