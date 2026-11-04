import Link from 'next/link';
import type { ReactNode } from 'react';
import { getPublicI18n } from '@/lib/i18n-public';

/** Centered card layout shared by the sign-in, sign-up and self-service pages. */
export function AuthShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  const { t } = getPublicI18n();
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="page-title mb-1">{title}</h1>
      {intro && <p className="mb-6 text-sm text-muted">{intro}</p>}
      <div className="card space-y-4">{children}</div>
      <p className="mt-4 flex flex-wrap justify-center gap-3 text-xs text-muted">
        <Link className="underline" href="/help">
          {t('help.title')}
        </Link>
        <Link className="underline" href="/legal/terms">
          {t('legal.terms')}
        </Link>
        <Link className="underline" href="/legal/privacy">
          {t('legal.privacy')}
        </Link>
        <Link className="underline" href="/status">
          {t('status.title')}
        </Link>
      </p>
    </main>
  );
}
