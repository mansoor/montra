import Link from 'next/link';
import type { ReactNode } from 'react';
import { getPublicI18n } from '@/lib/i18n-public';
import { I18nProvider } from './i18n';

/** Help, legal and status pages: they open for anyone, signed in or not. */
export function PublicShell({ children }: { children: ReactNode }) {
  const { t, locale } = getPublicI18n();
  return (
    <I18nProvider locale={locale} dateFormat={null}>
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="font-display text-lg font-semibold">
            Montra
          </Link>
          <nav aria-label={t('public.nav')} className="flex flex-wrap gap-4 text-sm">
            <Link className="underline" href="/help">
              {t('help.title')}
            </Link>
            <Link className="underline" href="/status">
              {t('status.title')}
            </Link>
          </nav>
        </header>
        <main id="main" className="flex-1 space-y-6">
          {children}
        </main>
        <footer className="mt-10 flex flex-wrap gap-4 border-t border-line pt-4 text-xs text-muted">
          <Link className="underline" href="/legal/terms">
            {t('legal.terms')}
          </Link>
          <Link className="underline" href="/legal/privacy">
            {t('legal.privacy')}
          </Link>
          <Link className="underline" href="/legal/cookies">
            {t('legal.cookies')}
          </Link>
          <Link className="underline" href="/legal/subprocessors">
            {t('legal.subprocessors')}
          </Link>
        </footer>
      </div>
    </I18nProvider>
  );
}
