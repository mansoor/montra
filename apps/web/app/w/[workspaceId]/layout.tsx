import Link from 'next/link';
import type { ReactNode } from 'react';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { API_URL } from '@/lib/session';
import { NavLinks } from '@/components/nav-links';
import { Realtime } from '@/components/realtime';
import { I18nProvider } from '@/components/i18n';

export const dynamic = 'force-dynamic';

/** Browser WebSocket endpoint: NEXT_PUBLIC_API_WS_URL, else derived from the API URL at runtime. */
const wsUrl = () => process.env.NEXT_PUBLIC_API_WS_URL ?? `${API_URL.replace(/^http/, 'ws')}/v1/ws`;

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [workspace, { me, t }] = await Promise.all([load((api) => api.getWorkspace(workspaceId)), getI18n()]);
  const base = `/w/${workspace.id}`;
  return (
    <I18nProvider locale={me.locale} dateFormat={me.dateFormat}>
      <div className="min-h-screen">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href={base} className="text-lg font-semibold">
              Montra
            </Link>
            <span className="text-sm text-muted" aria-label={t('shell.workspace')}>
              {workspace.name}
            </span>
            <NavLinks
              label={t('shell.nav')}
              links={[
                { href: base, label: t('nav.home'), exact: true },
                { href: `${base}/transactions`, label: t('nav.transactions') },
                { href: `${base}/upcoming`, label: t('nav.upcoming') },
                { href: `${base}/recurring`, label: t('nav.recurring') },
                { href: `${base}/journal`, label: t('nav.journal') },
                { href: `${base}/accounts/new`, label: t('nav.add_account') },
                { href: `${base}/settings`, label: t('nav.settings') },
              ]}
            />
            <div className="ml-auto flex items-center gap-3">
              <Realtime workspaceId={workspace.id} wsUrl={wsUrl()} />
              <form action="/sign-out" method="post">
                <button type="submit" className="btn-secondary">
                  {t('shell.sign_out')}
                </button>
              </form>
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-6">
          {children}
        </main>
      </div>
    </I18nProvider>
  );
}
